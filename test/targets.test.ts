import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/adapters/config/file-config.ts";
import { FileTargetCatalog } from "../src/adapters/config/file-target-catalog.ts";
import { GitRepoInspector, suggestCommands } from "../src/adapters/git/repo-inspector.ts";
import { ghArgs, HostRouter } from "../src/adapters/github/gh-pr-host.ts";
import { EditBoard } from "../src/application/edit-board.ts";
import { ManageTargets } from "../src/application/manage-targets.ts";
import { targetProblems, type TargetSpec } from "../src/domain/target.ts";
import { MemoryBatchRepository } from "./fakes/memory-batch-repo.ts";

const sh = (cwd: string, cmd: string) => execFileSync("sh", ["-c", cmd], { cwd, encoding: "utf8" });
const spec = (p: Partial<TargetSpec> = {}): TargetSpec => ({
  name: "web-shop", repo: "/abs/repo", host: "github", baseBranch: "main", setup: [], gate: { quick: ["npm run build"], full: ["npm test"] }, ...p,
});

test("targetProblems: names, reserved words, duplicates, paths and gates", () => {
  assert.deepEqual(targetProblems(spec(), []), []);
  assert.match(targetProblems(spec({ name: "unknown" }), []).join(), /reserved/);
  assert.match(targetProblems(spec({ name: "has space" }), []).join(), /letters, digits/);
  assert.match(targetProblems(spec(), ["web-shop"]).join(), /already exists/);
  assert.match(targetProblems(spec({ repo: "rel/path" }), []).join(), /absolute/);
  assert.match(targetProblems(spec({ gate: { quick: [" "], full: ["x"] } }), []).join(), /quick gate/);
});

test("suggestCommands reads package.json scripts, Python projects and Makefiles", () => {
  const dir = mkdtempSync(join(tmpdir(), "sf-sug-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { build: "tsc", test: "vitest" } }));
  writeFileSync(join(dir, "package-lock.json"), "{}");
  assert.deepEqual(suggestCommands(dir, []), { setup: ["npm ci --no-audit --no-fund"], gate: { quick: ["npm run build"], full: ["npm run build", "npm test"] } });
  const py = mkdtempSync(join(tmpdir(), "sf-sug-"));
  writeFileSync(join(py, "requirements.txt"), "");
  mkdirSync(join(py, ".venv/bin"), { recursive: true });
  writeFileSync(join(py, ".venv/bin/pytest"), "");
  mkdirSync(join(py, "tests"));
  assert.deepEqual(suggestCommands(py, []), {
    setup: ["ln -sfn {repo}/.venv .venv"],
    gate: { quick: [".venv/bin/pytest -q --maxfail=100000 {changedTests}"], full: [".venv/bin/pytest -q --maxfail=100000 tests"] },
  });
  const notes: string[] = [];
  assert.deepEqual(suggestCommands(mkdtempSync(join(tmpdir(), "sf-sug-")), notes).gate, { quick: [], full: [] });
  assert.match(notes[0], /enter the gate commands/);
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "sf-tgt-"));
  sh(dir, "git init -q --bare -b main origin.git && git clone -q origin.git shop 2>/dev/null");
  const repo = join(dir, "shop");
  sh(repo, "git config user.email t@t && git config user.name t && git checkout -q -b main");
  writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { build: "echo built" } }));
  sh(repo, "git add -A && git commit -qm init && git push -q origin main && git push -q origin main:Staging && git fetch -q");
  sh(repo, "git remote set-url origin https://github.com/acme/shop.git"); // looks like GitHub; refs already fetched
  const configPath = join(dir, "factory.config.json");
  writeFileSync(configPath, readFileSync(new URL("../factory.config.example.json", import.meta.url)));
  const config = loadConfig(configPath);
  const targets = new ManageTargets(new FileTargetCatalog(config, configPath), new GitRepoInspector());
  return { dir, repo, configPath, config, targets };
}

test("inspect suggests name, host, base branch and commands from a real checkout", async () => {
  const { repo, targets } = fixture();
  const found = await targets.inspect(join(repo, "."));
  assert.equal(found.name, "shop");
  assert.equal(found.host, "github");
  assert.deepEqual(found.branches.sort(), ["Staging", "main"]);
  assert.equal(found.baseBranch, "Staging", "Staging is preferred when origin has it");
  assert.deepEqual(found.gate.quick, ["npm run build"]);
  await assert.rejects(targets.inspect(join(repo, "nope")), /does not exist/);
  await assert.rejects(targets.inspect(tmpdir()), /not a git repository/);
});

test("add validates against the checkout, persists to the config file, and is live for the board", async () => {
  const { repo, configPath, config, targets } = fixture();
  await assert.rejects(targets.add(spec({ name: "shop", repo, baseBranch: "release" })), /origin has no branch "release"/);
  await targets.add(spec({ name: "shop", repo, baseBranch: "main", setup: ["npm ci", " "] }));

  const saved = JSON.parse(readFileSync(configPath, "utf8"));
  assert.deepEqual(saved.targets.shop.setup, ["npm ci"]);
  assert.ok(saved.targets["acme-api"], "existing targets are kept");
  assert.equal(saved.budget.perBatchUsd, config.budget.perBatchUsd, "other settings are kept");
  assert.equal(config.targets.shop.baseBranch, "main", "in-memory config updated for the adapters");
  assert.ok(targets.names().includes("shop"));
  await assert.rejects(targets.add(spec({ name: "shop", repo, baseBranch: "main" })), /already exists/);

  const repoState = new MemoryBatchRepository();
  repoState.createBatch("b", 5);
  const id = repoState.addItem({ batch_id: "b", source_kind: "text", source_ref: "p", title: "t", type: "bug", target_repo: "unknown", role: "coder", model: "m", complexity: 1, depends_on: "[]", claimed_paths: "[]" });
  new EditBoard(repoState, () => targets.names(), ["m"]).edit(id, { target_repo: "shop" });
  assert.equal(repoState.item(id)!.target_repo, "shop");
});

test("HostRouter sends GitHub targets to gh and GitLab targets to glab; gh never merges", async () => {
  const { config } = fixture();
  config.targets.shop = { repo: "/x", host: "github", baseBranch: "main", setup: [], gate: { quick: ["true"], full: ["true"] } };
  const calls: string[] = [];
  const router = new HostRouter(config, { gitlab: { open: async () => (calls.push("glab"), "gl") }, github: { open: async () => (calls.push("gh"), "gh") } });
  await router.open({ target: "shop", sourceBranch: "a", targetBranch: "main", title: "t", description: "d" });
  await router.open({ target: "acme-api", sourceBranch: "a", targetBranch: "Staging", title: "t", description: "d" });
  assert.deepEqual(calls, ["gh", "glab"]);
  assert.deepEqual(ghArgs({ target: "shop", sourceBranch: "a", targetBranch: "main", title: "t", description: "d" }).slice(0, 2), ["pr", "create"]);
});

test("a repo without a remote is inspected as local, added against its local branches, and gated + published locally", async () => {
  const { GitWorkspace } = await import("../src/adapters/git/workspace.ts");
  const { PublishBatch } = await import("../src/application/publish-batch.ts");
  const dir = mkdtempSync(join(tmpdir(), "sf-local-"));
  const repo = join(dir, "notes-app");
  sh(dir, "git init -q -b main notes-app");
  sh(repo, "git config user.email t@t && git config user.name t && mkdir src && echo 'v1' > src/a.txt && git add -A && git commit -qm init");
  const configPath = join(dir, "factory.config.json");
  writeFileSync(configPath, readFileSync(new URL("../factory.config.example.json", import.meta.url)));
  const config = loadConfig(configPath);
  const targets = new ManageTargets(new FileTargetCatalog(config, configPath), new GitRepoInspector());

  const found = await targets.inspect(repo);
  assert.deepEqual([found.host, found.remoteUrl, found.branches, found.localBranches, found.baseBranch], ["local", null, [], ["main"], "main"]);
  assert.match(found.notes.join(), /no "origin" remote/);
  await assert.rejects(targets.add(spec({ name: "notes", repo, host: "gitlab", baseBranch: "main" })), /choose host "local"/);
  await assert.rejects(targets.add(spec({ name: "notes", repo, host: "local", baseBranch: "develop" })), /no local branch "develop"/);
  await targets.add(spec({ name: "notes", repo, host: "local", baseBranch: "main", gate: { quick: ["true"], full: ["true"] } }));
  assert.equal(JSON.parse(readFileSync(configPath, "utf8")).targets.notes.host, "local");

  // Run + publish without any remote: the worktree comes off local main; the branch stays local; no MR.
  const ws = new GitWorkspace(config, join(dir, "worktrees"));
  const repoState = new MemoryBatchRepository();
  repoState.createBatch("b", 5);
  const id = repoState.addItem({ batch_id: "b", source_kind: "jira", source_ref: "N-1", title: "Bump a", type: "bug", target_repo: "notes", role: "coder", model: "m", complexity: 1, depends_on: "[]", claimed_paths: "[]" });
  repoState.updateItem(id, { status: "done" });
  const wt = await ws.prepare(id, "notes");
  sh(wt, "git config user.email t@t && git config user.name t && echo 'v2' > src/a.txt");
  await ws.commit(wt, id, "bump", ["src/a.txt"]);
  const comments: string[] = [];
  const mrs: string[] = [];
  const green = { run: async () => ({ exitOk: true, failures: [], output: "" }) };
  const results = await new PublishBatch(repoState, ws, { open: async () => (mrs.push("x"), "u") }, { comment: async (k, b) => void comments.push(`${k}: ${b}`) }, { emit: () => {} }, () => "main", green).execute("b");
  assert.deepEqual(results, [{ itemId: id, branch: "fix/N-1-bump-a", warning: undefined }]);
  assert.deepEqual(mrs, [], "no MR without a remote");
  assert.equal(sh(repo, "git show fix/N-1-bump-a:src/a.txt").trim(), "v2");
  assert.equal(repoState.item(id)!.branch, "fix/N-1-bump-a");
  assert.equal(repoState.item(id)!.mr_url, null);
  assert.deepEqual(comments, ["N-1: Local branch ready: fix/N-1-bump-a (notes, not pushed) — Bump a"]);
  assert.deepEqual(await new PublishBatch(repoState, ws, { open: async () => "u" }, { comment: async () => {} }, { emit: () => {} }, () => "main", green).execute("b"), [], "not published twice");
});
