// Workspace on git worktrees. One worktree per session (item) and target, on branch factory/s<item>-<target>,
// off the target's base branch (or a dependency's session branch). Spike R2: concurrent commits corrupted the repo only while git's auto-gc ran, and
// `git add` + commit swept in other agents' files — so auto-gc is off here and commits are path-scoped and
// serialised.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ConflictMarkerFound, MergeRefused, PublishConflict, type BranchMerger, type ShipCheck, type Workspace } from "../../application/ports/workspace.ts";
import { hasRemote } from "../../domain/target.ts";
import { setupCommands, type FactoryConfig, type Target } from "../config/file-config.ts";

const run = promisify(execFile);
// A local-only target (no origin) works from its local base branch and never fetches or pushes.
const baseRef = (t: Target) => (hasRemote(t) ? `origin/${t.baseBranch}` : t.baseBranch);
const refresh = async (t: Target) => {
  if (hasRemote(t)) await git(t.repo, "fetch", "origin", t.baseBranch);
};
const git = (cwd: string, ...args: string[]) => run("git", ["-C", cwd, ...args], { maxBuffer: 64 * 1024 * 1024 });
const succeeds = (p: Promise<unknown>) => p.then(() => true, () => false);
const refExists = (repo: string, ref: string) => succeeds(git(repo, "rev-parse", "--verify", "--quiet", ref));
// Tracked text files among `paths` (all when omitted) holding a conflict block: a `<<<<<<<` line and a `>>>>>>>`
// line (a lone `=======` is legal, e.g. a markdown heading). Returns `file:line` of the first `<<<<<<<` of each.
async function conflictMarkers(worktree: string, paths?: string[]): Promise<string[]> {
  if (paths && !paths.length) return [];
  let out = "";
  try {
    out = (await git(worktree, "grep", "-nIE", "^(<{7}|={7}|>{7})( |$)", "--", ...(paths ?? []))).stdout;
  } catch (e) {
    if ((e as { code?: number }).code === 1) return []; // no match
    throw e;
  }
  const byFile = new Map<string, { open?: number; close: boolean }>();
  for (const l of out.split("\n").filter(Boolean)) {
    const m = /^(.*?):(\d+):(.)/.exec(l);
    if (!m) continue;
    const f = byFile.get(m[1]) ?? { close: false };
    if (m[3] === "<" && f.open === undefined) f.open = Number(m[2]);
    if (m[3] === ">") f.close = true;
    byFile.set(m[1], f);
  }
  return [...byFile].filter(([, f]) => f.open !== undefined && f.close).map(([file, f]) => `${file}:${f.open}`);
}
const markerMessage = (hits: string[]) =>
  `conflict markers in ${hits.slice(0, 5).join(", ")}${hits.length > 5 ? ` (+${hits.length - 5} more)` : ""}`;

export const sessionBranch = (itemId: number, target: string) => `factory/s${itemId}-${target}`;

export class GitWorkspace implements Workspace, BranchMerger {
  private locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly config: FactoryConfig,
    private readonly root: string, // where worktrees live, e.g. runs/worktrees
  ) {}

  async prepare(itemId: number, target: string, from?: number): Promise<string> {
    const t = this.config.targets[target];
    if (!t) throw new Error(`unknown target ${target}`);
    const dir = join(this.root, `s${itemId}`);
    mkdirSync(dir, { recursive: true });
    // Canonical path, so agents and the policy hook agree on what "inside the worktree" means.
    const wt = join(realpathSync(dir), target);
    if (existsSync(join(wt, ".git"))) return wt; // a later turn, or reopened after a crash
    // Sessions start in parallel, but fetch, worktree add and config all write the main repo's .git (refs,
    // .git/config): serialise those per repo. Setup commands (npm ci etc.) still run in parallel.
    await this.serialised(t.repo, async () => {
      await refresh(t);
      await git(t.repo, "worktree", "prune"); // a deleted directory otherwise keeps its branch "checked out"
      const branch = sessionBranch(itemId, target);
      // The worktree directory can be gone while the branch survives (cleaned up between turns): reattach, never
      // reset, or the session's earlier turns are lost.
      const exists = await refExists(t.repo, `refs/heads/${branch}`);
      if (exists) await git(t.repo, "worktree", "add", wt, branch);
      else await git(t.repo, "worktree", "add", "--no-track", "-b", branch, wt, from === undefined ? baseRef(t) : sessionBranch(from, target));
      await git(wt, "config", "gc.auto", "0");
      await git(wt, "config", "maintenance.auto", "false");
    });
    await this.setup(t, wt);
    return wt;
  }

  private async setup(t: Target, wt: string): Promise<void> {
    for (const cmd of setupCommands(t)) await run("sh", ["-c", cmd], { cwd: wt, maxBuffer: 64 * 1024 * 1024 });
  }

  async changedFiles(worktree: string): Promise<string[]> {
    const { stdout } = await git(worktree, "status", "--porcelain=v1", "-z", "--untracked-files=all");
    const parts = stdout.split("\0").filter(Boolean);
    const files: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      const code = parts[i].slice(0, 2);
      files.push(parts[i].slice(3));
      if (code.startsWith("R") || code.startsWith("C")) i++; // the next entry is the rename source
    }
    return files;
  }

  commit(worktree: string, itemId: number, message: string, paths: string[]): Promise<string | null> {
    return this.serialised(worktree, async () => {
      if (!paths.length) return null;
      await git(worktree, "add", "-A", "--", ...paths);
      const { stdout: staged } = await git(worktree, "diff", "--cached", "--name-only", "--", ...paths);
      if (!staged.trim()) return null;
      const hits = await conflictMarkers(worktree, staged.split("\n").filter(Boolean));
      if (hits.length) {
        await git(worktree, "reset", "-q", "--", ...paths).catch(() => {});
        throw new ConflictMarkerFound(`refusing to commit: ${markerMessage(hits)}`);
      }
      // The runner's gate is the check; repo hooks (husky etc.) may need tooling the worktree lacks.
      await git(worktree, "commit", "--no-verify", "-m", message, "--trailer", `Factory-Item: ${itemId}`, "--", ...paths);
      return (await git(worktree, "rev-parse", "HEAD")).stdout.trim();
    });
  }

  async sessionDiff(itemId: number, target: string): Promise<string> {
    const t = this.config.targets[target];
    if (!t) throw new Error(`unknown target ${target}`);
    const range = `${baseRef(t)}...${sessionBranch(itemId, target)}`;
    const [{ stdout: stat }, { stdout: diff }] = await Promise.all([git(t.repo, "diff", "--stat", range), git(t.repo, "diff", range)]);
    return `${stat}\n${diff}`;
  }

  async fileDiff(itemId: number, target: string, path: string): Promise<string> {
    const t = this.config.targets[target];
    if (!t) throw new Error(`unknown target ${target}`);
    const session = sessionBranch(itemId, target);
    const exists = await git(t.repo, "rev-parse", "--verify", "--quiet", `refs/heads/${session}`).then(() => true, () => false);
    if (!exists) return "";
    const { stdout } = await git(t.repo, "diff", `${baseRef(t)}...${session}`, "--", path);
    return stdout;
  }

  async snapshot(target: string, sha: string): Promise<{ worktree: string; dispose(): Promise<void> }> {
    const t = this.config.targets[target];
    if (!t) throw new Error(`unknown target ${target}`);
    const wt = join(realpathSync(mkdtempSync(join(tmpdir(), "sf-base-"))), "wt");
    await this.serialised(t.repo, () => git(t.repo, "worktree", "add", "--detach", wt, sha));
    const dispose = () => this.serialised(t.repo, () => git(t.repo, "worktree", "remove", "--force", wt)).then(() => {}, () => {});
    try {
      await this.setup(t, wt);
    } catch (e) {
      await dispose();
      throw e;
    }
    return { worktree: wt, dispose };
  }

  async publishBranch(itemId: number, target: string, branch: string, verify?: ShipCheck): Promise<{ pushed: boolean }> {
    const t = this.config.targets[target];
    if (!t) throw new Error(`unknown target ${target}`);
    const session = sessionBranch(itemId, target);
    await this.serialised(t.repo, () => refresh(t));
    // Session-branch commits, oldest first: this item's own, plus any stacked dependency's it was cut from.
    const { stdout } = await git(t.repo, "log", "--reverse", "--format=%H %(trailers:key=Factory-Item,valueonly,separator=)", `${baseRef(t)}..${session}`);
    const commits = stdout.trim().split("\n").filter(Boolean).map((l) => l.trim().split(/\s+/));
    if (!commits.some(([, item]) => Number(item) === itemId)) throw new Error(`no commits for row ${itemId} on ${session}`);
    const picks = commits.map(([sha]) => sha);

    // Cut the branch in a throwaway worktree so the session worktree is never disturbed. `-b`, never `-B`: a branch
    // of that name may be Nat's own, and is refused rather than reset — so the cleanup below only deletes ours.
    const tmp = join(realpathSync(mkdtempSync(join(tmpdir(), "sf-publish-"))), "wt");
    await this.serialised(t.repo, () => git(t.repo, "worktree", "add", "--no-track", "-b", branch, tmp, baseRef(t)));
    try {
      for (const sha of picks) {
        try {
          await git(tmp, "cherry-pick", "-x", "--allow-empty", sha);
        } catch (e) {
          await git(tmp, "cherry-pick", "--abort").catch(() => {});
          throw new PublishConflict(`cherry-pick of ${sha.slice(0, 8)} conflicts on ${t.baseBranch}: ${String(e).split("\n").find((l) => /CONFLICT/.test(l)) ?? "conflict"}`);
        }
      }
      if (verify) {
        const baseSha = (await git(t.repo, "rev-parse", baseRef(t))).stdout.trim();
        const changed = (await git(tmp, "diff", "--name-only", baseSha, "HEAD")).stdout.split("\n").filter(Boolean);
        const hits = await conflictMarkers(tmp, changed);
        if (hits.length) throw new PublishConflict(markerMessage(hits));
        await this.setup(t, tmp);
        await verify(tmp, { baseSha, changed });
      }
      if (hasRemote(t)) await git(tmp, "push", "-u", "origin", branch);
    } catch (e) {
      await git(t.repo, "worktree", "remove", "--force", tmp).catch(() => {});
      await git(t.repo, "branch", "-D", branch).catch(() => {});
      throw e;
    }
    await git(t.repo, "worktree", "remove", "--force", tmp);
    return { pushed: hasRemote(t) };
  }

  async branchesLike(target: string, prefix: string): Promise<Set<string>> {
    const t = this.config.targets[target];
    if (!t) throw new Error(`unknown target ${target}`);
    const [local, remote] = await Promise.all([
      git(t.repo, "for-each-ref", "--format=%(refname:short)", `refs/heads/${prefix}*`),
      hasRemote(t) ? git(t.repo, "ls-remote", "--heads", "origin", `refs/heads/${prefix}*`) : { stdout: "" },
    ]);
    const names = [...local.stdout.split("\n"), ...remote.stdout.split("\n").map((l) => l.split("\trefs/heads/")[1])];
    return new Set(names.filter(Boolean));
  }

  checkoutPath(target: string): string {
    const t = this.config.targets[target];
    if (!t) throw new Error(`unknown target ${target}`);
    return t.repo;
  }

  async checkoutChanges(target: string): Promise<string[]> {
    const t = this.config.targets[target];
    if (!t) throw new Error(`unknown target ${target}`);
    return (await git(t.repo, "status", "--porcelain")).stdout.split("\n").filter(Boolean);
  }

  async mergeBranch(target: string, branch: string, verify?: ShipCheck): Promise<{ sha: string; fastForward: boolean }> {
    const t = this.config.targets[target];
    if (!t) throw new Error(`unknown target ${target}`);
    if (hasRemote(t)) throw new MergeRefused(`${target} is a ${t.host} target: merge its MR on the host`);
    // The checkout must be clean and on the base branch, both now and again right before the base moves.
    const checkMain = async () => {
      if ((await git(t.repo, "status", "--porcelain")).stdout.trim()) throw new MergeRefused(`the main checkout of ${target} has uncommitted changes`);
      const head = (await git(t.repo, "rev-parse", "--abbrev-ref", "HEAD")).stdout.trim();
      if (head !== t.baseBranch) throw new MergeRefused(`the main checkout of ${target} is on ${head}, not ${t.baseBranch}`);
    };
    const tmp = join(realpathSync(mkdtempSync(join(tmpdir(), "sf-merge-"))), "wt");
    const dispose = () => this.serialised(t.repo, () => git(t.repo, "worktree", "remove", "--force", tmp)).then(() => {}, () => {});
    let baseSha = "";
    let sha = "";
    let fastForward = false;
    let changed: string[] = [];
    try {
      // The git steps hold the repo lock; the gate does not (it takes the lock itself to measure a baseline).
      await this.serialised(t.repo, async () => {
        await checkMain();
        if (!(await refExists(t.repo, `refs/heads/${branch}`))) throw new MergeRefused(`branch ${branch} does not exist in ${target}`);
        baseSha = (await git(t.repo, "rev-parse", `refs/heads/${t.baseBranch}`)).stdout.trim();
        await git(t.repo, "worktree", "add", "--detach", tmp, baseSha);
        fastForward = await succeeds(git(tmp, "merge-base", "--is-ancestor", baseSha, `refs/heads/${branch}`));
        if (fastForward) {
          sha = (await git(t.repo, "rev-parse", `refs/heads/${branch}`)).stdout.trim();
          await git(tmp, "checkout", "--detach", sha);
        } else {
          try {
            await git(tmp, "merge", "--no-ff", "--no-edit", "-m", `Merge ${branch} into ${t.baseBranch}`, `refs/heads/${branch}`);
          } catch {
            const files = (await git(tmp, "diff", "--name-only", "--diff-filter=U").catch(() => ({ stdout: "" }))).stdout.split("\n").filter(Boolean);
            await git(tmp, "merge", "--abort").catch(() => {});
            throw new MergeRefused(`merge conflicts: ${files.join(", ") || "see git merge"}`);
          }
          sha = (await git(tmp, "rev-parse", "HEAD")).stdout.trim();
        }
        changed = (await git(tmp, "diff", "--name-only", baseSha, sha)).stdout.split("\n").filter(Boolean);
        const hits = await conflictMarkers(tmp, changed);
        if (hits.length) throw new MergeRefused(markerMessage(hits));
      });
      if (verify) {
        await this.setup(t, tmp);
        await verify(tmp, { baseSha, changed });
      }
      await this.serialised(t.repo, async () => {
        await checkMain();
        const now = (await git(t.repo, "rev-parse", `refs/heads/${t.baseBranch}`)).stdout.trim();
        if (now !== baseSha) throw new MergeRefused(`${t.baseBranch} moved while the gate ran — merge again`);
        await git(t.repo, "merge", "--ff-only", sha).catch((e) => {
          throw new MergeRefused(`could not fast-forward ${t.baseBranch}: ${String(e.stderr ?? e).trim().split("\n")[0]}`);
        });
      });
      return { sha, fastForward };
    } finally {
      await dispose();
    }
  }

  private serialised<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.locks.set(key, next.catch(() => {}));
    return next;
  }
}
