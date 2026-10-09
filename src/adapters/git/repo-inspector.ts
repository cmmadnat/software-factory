// RepoInspector: reads a local checkout (read-only) and suggests a target — remote, host, base branch, and
// setup/gate commands from what the project declares. Every suggestion is editable before it is saved.
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { RepoInspection, RepoInspector } from "../../application/ports/targets.ts";

const run = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await run("git", ["-C", cwd, ...args])).stdout.trim();

// Preferred base branches, in order: the bug-fix workflow lands on Staging first.
const BASE_PREFERENCE = ["Staging", "staging", "develop", "main", "master"];

export class GitRepoInspector implements RepoInspector {
  async inspect(input: string): Promise<RepoInspection> {
    const path = resolve(input.trim().replace(/^~(?=\/|$)/, homedir()));
    if (!existsSync(path)) throw new Error(`${path} does not exist`);
    const repo = await git(path, "rev-parse", "--show-toplevel").catch(() => {
      throw new Error(`${path} is not a git repository`);
    });
    const notes: string[] = [];
    const remoteUrl = await git(repo, "remote", "get-url", "origin").catch(() => null);
    if (!remoteUrl) notes.push('no "origin" remote: runs locally, and publishing creates local branches only (no push, no MR)');
    const host = !remoteUrl ? "local" : /github\.com/i.test(remoteUrl) ? "github" : /gitlab/i.test(remoteUrl) ? "gitlab" : null;
    if (remoteUrl && !host) notes.push("host not recognised from the remote URL — pick one");

    const branches = remoteUrl
      ? (await git(repo, "for-each-ref", "--format=%(refname:lstrip=3)", "refs/remotes/origin").catch(() => ""))
          .split("\n").filter((b) => b && b !== "HEAD")
      : [];
    const localBranches = (await git(repo, "for-each-ref", "--format=%(refname:short)", "refs/heads").catch(() => "")).split("\n").filter(Boolean);
    const originHead = (await git(repo, "symbolic-ref", "--short", "refs/remotes/origin/HEAD").catch(() => "")).replace(/^origin\//, "");
    const pool = remoteUrl ? branches : localBranches;
    const current = await git(repo, "branch", "--show-current").catch(() => "");
    const baseBranch = BASE_PREFERENCE.find((b) => pool.includes(b)) ?? (remoteUrl ? originHead : current) ?? pool[0] ?? null;

    const { setup, gate } = suggestCommands(repo, notes);
    return { repo, name: basename(repo), remoteUrl, host, branches, localBranches, baseBranch: baseBranch || pool[0] || null, setup, gate, notes };
  }
}

// What the project itself declares. Commands run inside the worktree; {repo} is the main checkout.
export function suggestCommands(repo: string, notes: string[]): Pick<RepoInspection, "setup" | "gate"> {
  const has = (f: string) => existsSync(join(repo, f));
  if (has("package.json")) {
    const scripts: Record<string, string> = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).scripts ?? {};
    const install = has("package-lock.json") ? "npm ci --no-audit --no-fund" : "npm install --no-audit --no-fund";
    const build = scripts.build ? ["npm run build"] : [];
    const test = scripts.test ? ["npm test"] : [];
    notes.push(`package.json scripts: ${Object.keys(scripts).join(", ") || "none"}`);
    const quick = build.length ? build : test.length ? test : ["true"];
    if (!build.length && !test.length) notes.push("no build or test script — the gate only checks that the tree exists; edit it");
    return { setup: [install], gate: { quick, full: [...build, ...test].length ? [...build, ...test] : ["true"] } };
  }
  if (has("pyproject.toml") || has("requirements.txt") || has("pytest.ini")) {
    const venv = has(".venv/bin/pytest");
    notes.push(venv ? "Python project with .venv (symlinked into worktrees)" : "Python project without .venv/bin/pytest — install it, or edit the commands");
    const pytest = venv ? ".venv/bin/pytest" : "python -m pytest";
    const tests = has("tests") ? " tests" : "";
    return {
      setup: venv ? ["ln -sfn {repo}/.venv .venv"] : [],
      gate: { quick: [`${pytest} -q --maxfail=100000 {changedTests}`], full: [`${pytest} -q --maxfail=100000${tests}`] },
    };
  }
  if (has("Makefile")) {
    notes.push("Makefile found — using `make test`");
    return { setup: [], gate: { quick: ["make test"], full: ["make test"] } };
  }
  notes.push("no package.json, Python project or Makefile found — enter the gate commands");
  return { setup: [], gate: { quick: [], full: [] } };
}
