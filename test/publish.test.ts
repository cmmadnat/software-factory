import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { FactoryConfig } from "../src/adapters/config/file-config.ts";
import { GitWorkspace } from "../src/adapters/git/workspace.ts";
import { ShellGate } from "../src/adapters/gate/shell-gate.ts";
import { glabArgs } from "../src/adapters/gitlab/glab-mr-host.ts";
import { PublishBatch } from "../src/application/publish-batch.ts";
import type { MergeRequest } from "../src/application/ports/merge-request-host.ts";
import type { Item, NewItem } from "../src/domain/batch.ts";
import { branchName, slug, stackFor } from "../src/domain/branch.ts";
import { MemoryBatchRepository } from "./fakes/memory-batch-repo.ts";

const item = (p: Partial<Item>): Item => ({
  id: 1, batch_id: "b", source_kind: "text", source_ref: "p", title: "Fix Export button overflow", type: "bug", target_repo: "app",
  role: "coder", model: "m", complexity: 1, depends_on: "[]", claimed_paths: "[]", question: null, notes: "", brief: "",
  pause_reason: null, extra_budget_usd: 0, run: 1, status: "done", branch: null, mr_url: null, merged_at: null, position: 0, ...p,
});

test("branchName follows fix/<KEY>-<slug>, feat/ for features, and never collides", () => {
  assert.equal(branchName(item({ source_kind: "jira", source_ref: "ACME-1482" })), "fix/ACME-1482-fix-export-button-overflow");
  assert.equal(branchName(item({ type: "feature", title: "Add last_reviewed_at to risk!" })), "feat/add-last-reviewed-at-to-risk");
  assert.equal(branchName(item({ id: 9 }), new Set(["fix/fix-export-button-overflow"])), "fix/fix-export-button-overflow-r9");
  assert.equal(branchName(item({ id: 9 }), new Set(["fix/fix-export-button-overflow", "fix/fix-export-button-overflow-r9"])), "fix/fix-export-button-overflow-r9-2");
  assert.equal(slug("ระบบ"), "change");
});

test("stackFor returns transitive dependencies in board order", () => {
  const a = item({ id: 1, position: 0 });
  const b = item({ id: 2, position: 1, depends_on: "[1]" });
  const c = item({ id: 3, position: 2, depends_on: "[2]" });
  assert.deepEqual(stackFor(c, [c, b, a]).map((i) => i.id), [1, 2]);
  assert.deepEqual(stackFor(a, [a, b, c]), []);
});

test("glabArgs never prompts and never merges", () => {
  const args = glabArgs({ target: "t", sourceBranch: "fix/x", targetBranch: "Staging", title: "T", description: "D" });
  assert.ok(args.includes("--yes"));
  assert.deepEqual(args.slice(0, 2), ["mr", "create"]);
  assert.ok(!args.some((a) => /merge$/.test(a) && a !== "--target-branch"));
});

// ---- PublishBatch on a real git sandbox with a local bare origin ----
const sh = (cwd: string, cmd: string) => execFileSync("sh", ["-c", cmd], { cwd, encoding: "utf8" });

async function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "sf-pub-"));
  const repo = join(dir, "repo");
  sh(dir, "git init -q --bare -b Staging origin.git && git clone -q origin.git repo 2>/dev/null");
  sh(repo, "git config user.email t@t && git config user.name t && git checkout -q -b Staging");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src/shared.ts"), "export const v = 1;\n");
  sh(repo, "git add -A && git commit -qm base && git push -q origin Staging");
  const config = {
    budget: { perTurnUsd: 1, perAgentUsd: 1, perBatchUsd: 1, usdPerAiu: 0.1 }, maxParallel: 3, maxTurnsPerAgent: 5,
    jira: { site: "x", mcpUrl: "https://x" },
    // The full gate fails (pytest-style) whenever a tree contains src/broken.ts, and counts its runs.
    targets: { app: { repo, host: "gitlab", baseBranch: "Staging", setup: [], gate: { quick: ["true"], full: [`echo run >> ${dir}/full-runs; if [ -f src/broken.ts ]; then echo "FAILED tests/test_b.py::test_broken - boom"; exit 1; fi`] } } },
  } as FactoryConfig;
  const ws = new GitWorkspace(config, join(dir, "worktrees"));
  const repoState = new MemoryBatchRepository();
  repoState.createBatch("b", 20);
  const add = (p: Partial<NewItem>) => {
    const id = repoState.addItem({ batch_id: "b", source_kind: "text", source_ref: "p", title: "t", type: "bug", target_repo: "app", role: "coder", model: "m", complexity: 1, depends_on: "[]", claimed_paths: "[]", ...p });
    repoState.updateItem(id, { status: "done" });
    return id;
  };
  // Each row is a session with its own worktree; `from` starts it on a dependency's session branch.
  const write = async (id: number, file: string, body: string, from?: number) => {
    const wt = await ws.prepare(id, "app", from);
    mkdirSync(join(wt, file, ".."), { recursive: true });
    writeFileSync(join(wt, file), body);
    await ws.commit(wt, id, `row ${id}`, [file]);
  };
  const opened: MergeRequest[] = [];
  const events: string[] = [];
  const comments: string[] = [];
  let failComment = false;
  const publish = new PublishBatch(
    repoState, ws,
    { open: async (mr) => (opened.push(mr), `https://gitlab.example/mr/${opened.length}`) },
    { comment: async (key, body) => { if (failComment) throw new Error("mcp down"); comments.push(`${key}: ${body}`); } },
    { emit: (e) => void events.push(e.kind) },
    () => "Staging",
    new ShellGate(config),
  );
  return { dir, repo, ws, events, add, write, publish, opened, comments, repoState, origin: join(dir, "origin.git"), setFailComment: (v: boolean) => (failComment = v) };
}

const filesOn = (origin: string, branch: string) => sh(origin, `git diff --name-only Staging ${branch}`).trim().split("\n").filter(Boolean).sort();

test("PublishBatch: one pushed branch and MR per done row, containing only that row's commits (plus its stack)", async () => {
  const s = await sandbox();
  const a = s.add({ title: "Add API field", type: "feature", source_kind: "jira", source_ref: "ACME-1" });
  const b = s.add({ title: "Show the field", type: "feature", source_kind: "jira", source_ref: "ACME-1", depends_on: JSON.stringify([]) });
  const c = s.add({ title: "Fix button", depends_on: "[]" });
  s.repoState.updateItem(b, { depends_on: JSON.stringify([a]) });
  await s.write(a, "api/field.py", "x = 1\n");
  await s.write(c, "src/button.ts", "b\n");
  await s.write(b, "src/field.ts", "f\n", a);

  const results = await s.publish.execute("b");
  assert.deepEqual(results.map((r) => [r.itemId, r.branch, r.error ?? null]), [
    [a, "feat/ACME-1-add-api-field", null],
    [b, "feat/ACME-1-show-the-field", null],
    [c, "fix/fix-button", null],
  ]);
  assert.deepEqual(filesOn(s.origin, "feat/ACME-1-add-api-field"), ["api/field.py"]);
  assert.deepEqual(filesOn(s.origin, "feat/ACME-1-show-the-field"), ["api/field.py", "src/field.ts"], "stacked on its dependency");
  assert.deepEqual(filesOn(s.origin, "fix/fix-button"), ["src/button.ts"]);
  assert.match(s.opened[1].description, /Includes the changes of row\(s\) #1 Add API field \(https:\/\/gitlab\.example\/mr\/1\)/);
  assert.equal(s.opened[0].title, "ACME-1: Add API field");
  assert.deepEqual(s.comments, ["ACME-1: MR: https://gitlab.example/mr/1 — Add API field", "ACME-1: MR: https://gitlab.example/mr/2 — Show the field"]);
  assert.equal(s.repoState.item(c)!.mr_url, "https://gitlab.example/mr/3");
  assert.deepEqual(await s.publish.execute("b"), [], "already published rows are skipped");
});

test("PublishBatch: a cherry-pick conflict with a moved base fails only that row and leaves no branch behind", async () => {
  const s = await sandbox();
  const a = s.add({ title: "Edit other" });
  const b = s.add({ title: "Edit shared again" });
  await s.write(a, "src/other.ts", "o\n");
  await s.write(b, "src/shared.ts", "export const v = 3;\n");
  // Staging moves on underneath b's session.
  sh(s.repo, "git checkout -q Staging && echo 'export const v = 9;' > src/shared.ts && git commit -qam moved && git push -q origin Staging");
  const results = await s.publish.execute("b");
  assert.equal(results[0].error, undefined);
  assert.match(results[1].error!, /conflicts on Staging/);
  assert.equal(sh(s.origin, "git branch --list 'fix/edit-shared-again'").trim(), "");
  assert.equal(s.repoState.item(b)!.mr_url, null);
});

test("PublishBatch: a failed Jira comment is a warning; the MR still counts", async () => {
  const s = await sandbox();
  const a = s.add({ title: "Thing", source_kind: "jira", source_ref: "ACME-9" });
  await s.write(a, "src/thing.ts", "t\n");
  s.setFailComment(true);
  const [r] = await s.publish.execute("b");
  assert.equal(r.mrUrl, "https://gitlab.example/mr/1");
  assert.match(r.warning!, /Jira comment failed: mcp down/);
});

test("PublishBatch: a red full gate blocks the ship — nothing pushed, no MR, the reason stays on the card", async () => {
  const s = await sandbox();
  const a = s.add({ title: "Breaks the suite" });
  await s.write(a, "src/broken.ts", "x\n");
  const [r] = await s.publish.execute("b");
  assert.match(r.error!, /full gate red — new failures: pytest:tests\/test_b\.py::test_broken/);
  assert.equal(sh(s.origin, "git branch --list 'fix/breaks-the-suite'").trim(), "", "nothing pushed");
  assert.equal(s.opened.length, 0);
  const item = s.repoState.item(a)!;
  assert.deepEqual([item.status, item.branch], ["done", null], "still in Review, shippable after a fix");
  assert.match(item.pause_reason!, /^ship blocked: full gate red/);
  assert.ok(s.events.includes("ship.gate_red"));
});

test("PublishBatch: the full gate runs on the rebased tree against a baseline on the same base commit, measured once", async () => {
  const s = await sandbox();
  const a = s.add({ title: "Fine change" });
  await s.write(a, "src/fine.ts", "f\n");
  const [r1] = await s.publish.execute("b");
  assert.equal(r1.error, undefined);
  assert.equal(execFileSync("sh", ["-c", `wc -l < ${s.dir}/full-runs`], { encoding: "utf8" }).trim(), "2", "baseline + change");
  assert.deepEqual(s.events.filter((k) => k.startsWith("ship.")), ["ship.gate", "ship.gate", "ship.gate_green"]);
  // A blocked ship clears its reason once it ships.
  s.repoState.updateItem(a, { branch: null, pause_reason: "ship blocked: earlier" });
  sh(s.origin, "git branch -D fix/fine-change");
  await s.publish.execute("b");
  assert.equal(execFileSync("sh", ["-c", `wc -l < ${s.dir}/full-runs`], { encoding: "utf8" }).trim(), "3", "same base and scope: the baseline is reused");
  assert.equal(s.repoState.item(a)!.pause_reason, null);
});

test("PublishBatch: Ship never resets or deletes an existing branch of the same name — local or on origin — it takes a free one", async () => {
  const s = await sandbox();
  // Nat's own branch, named by the same convention, with work only he has.
  sh(s.repo, "git checkout -q -b fix/thing && echo mine > mine.txt && git add mine.txt && git commit -qm mine && git checkout -q Staging");
  const mine = sh(s.repo, "git rev-parse fix/thing").trim();
  const a = s.add({ title: "Thing" });
  // The first fallback name is taken on origin only.
  sh(s.repo, `git push -q origin Staging:refs/heads/fix/thing-r${a}`);
  await s.write(a, "src/thing.ts", "t\n");
  const [r] = await s.publish.execute("b");
  assert.equal(r.error, undefined);
  assert.equal(r.branch, `fix/thing-r${a}-2`);
  assert.equal(s.repoState.item(a)!.branch, `fix/thing-r${a}-2`);
  assert.equal(s.opened[0].sourceBranch, `fix/thing-r${a}-2`);
  assert.deepEqual(filesOn(s.origin, `fix/thing-r${a}-2`), ["src/thing.ts"]);
  assert.equal(sh(s.repo, "git rev-parse fix/thing").trim(), mine, "Nat's branch is untouched");

  // A red gate deletes only the branch Ship created, never his.
  const b = s.add({ title: "Thing" });
  await s.write(b, "src/broken.ts", "x\n");
  const [red] = await s.publish.execute("b");
  assert.match(red.error!, /full gate red/);
  assert.equal(sh(s.repo, "git rev-parse fix/thing").trim(), mine);
});
