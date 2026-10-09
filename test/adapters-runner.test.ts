// Real git and real shell, against a synthetic repo in a temp dir (never a real project).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { FactoryConfig } from "../src/adapters/config/file-config.ts";
import { AtlassianMcpIssueTracker, COMMENT_TOOLS, READ_TOOLS, SEARCH_TOOLS } from "../src/adapters/atlassian/mcp-issue-tracker.ts";
import type { CopilotRuntime } from "../src/adapters/copilot/runtime.ts";
import { scopeFromChanged, ShellGate } from "../src/adapters/gate/shell-gate.ts";
import { GitWorkspace } from "../src/adapters/git/workspace.ts";

const sh = (cwd: string, cmd: string) => execFileSync("sh", ["-c", cmd], { cwd, encoding: "utf8" });

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "sf-ws-"));
  const origin = join(dir, "origin.git");
  const repo = join(dir, "repo");
  sh(dir, `git init -q --bare -b Staging ${origin} && git clone -q ${origin} repo`);
  sh(repo, "git config user.email t@t && git config user.name t && git checkout -q -b Staging");
  mkdirSync(join(repo, "src/a"), { recursive: true });
  mkdirSync(join(repo, "src/b"), { recursive: true });
  writeFileSync(join(repo, "src/a/one.ts"), "export const one = 1;\n");
  writeFileSync(join(repo, "src/b/two.ts"), "export const two = 2;\n");
  writeFileSync(join(repo, "src/b/old.ts"), "old\n");
  sh(repo, "git add -A && git commit -qm base && git push -q origin Staging");
  const config = {
    budget: { perTurnUsd: 1, perAgentUsd: 1, perBatchUsd: 1, usdPerAiu: 0.1 }, maxParallel: 3, maxTurnsPerAgent: 5,
    jira: { site: "x", mcpUrl: "https://x" },
    targets: {
      sandbox: {
        repo, host: "gitlab", baseBranch: "Staging", setup: ["touch .setup-ran"],
        gate: { quick: ["echo 'FAILED tests/test_x.py::test_y - boom'; exit 1", "echo fine"], full: ["true"] },
      },
    },
  } as FactoryConfig;
  return { dir, repo, config, ws: new GitWorkspace(config, join(dir, "worktrees")) };
}

test("GitWorkspace: prepare makes a worktree on a factory branch off the base, runs setup, is idempotent", async () => {
  const { ws } = sandbox();
  const wt = await ws.prepare(1, "sandbox");
  assert.equal(sh(wt, "git rev-parse --abbrev-ref HEAD").trim(), "factory/s1-sandbox");
  assert.equal(sh(wt, "git config gc.auto").trim(), "0");
  assert.equal(sh(wt, "test -f .setup-ran && echo yes").trim(), "yes");
  assert.equal(await ws.prepare(1, "sandbox"), wt);
});

test("GitWorkspace: a session worktree reattaches to its branch after its directory is removed; a dependent starts from its dependency", async () => {
  const { ws } = sandbox();
  const wt = await ws.prepare(1, "sandbox");
  writeFileSync(join(wt, "src/a/one.ts"), "turn 1\n");
  await ws.commit(wt, 1, "turn 1", ["src/a/one.ts"]);
  rmSync(wt, { recursive: true, force: true });
  const again = await ws.prepare(1, "sandbox");
  assert.equal(sh(again, "cat src/a/one.ts").trim(), "turn 1", "the session's earlier commits survive");
  const dep = await ws.prepare(2, "sandbox", 1);
  assert.equal(sh(dep, "git rev-parse --abbrev-ref HEAD").trim(), "factory/s2-sandbox");
  assert.equal(sh(dep, "cat src/a/one.ts").trim(), "turn 1");
});

test("GitWorkspace: sessions prepared in parallel on one repo do not race on .git/config", async () => {
  const { ws } = sandbox();
  const wts = await Promise.all([1, 2, 3, 4, 5, 6].map((id) => ws.prepare(id, "sandbox")));
  assert.deepEqual(wts.map((wt) => sh(wt, "git rev-parse --abbrev-ref HEAD").trim()), [1, 2, 3, 4, 5, 6].map((id) => `factory/s${id}-sandbox`));
});

test("GitWorkspace: fileDiff returns only the named file's session change; '' for an unchanged file or no session branch", async () => {
  const { ws } = sandbox();
  const wt = await ws.prepare(1, "sandbox");
  writeFileSync(join(wt, "src/a/one.ts"), "export const one = 11;\n");
  writeFileSync(join(wt, "src/b/two.ts"), "export const two = 22;\n");
  await ws.commit(wt, 1, "turn 1", ["src/a/one.ts", "src/b/two.ts"]);
  const one = await ws.fileDiff(1, "sandbox", "src/a/one.ts");
  assert.match(one, /one = 11/);
  assert.doesNotMatch(one, /two = 22/, "the other changed file is not in this diff");
  assert.equal(await ws.fileDiff(1, "sandbox", "src/b/old.ts"), "", "an unchanged file has an empty diff");
  assert.equal(await ws.fileDiff(99, "sandbox", "src/a/one.ts"), "", "a session with no branch yet has an empty diff");
});

test("GitWorkspace: changedFiles sees new, modified, deleted and renamed files; commit takes only the given paths", async () => {
  const { ws } = sandbox();
  const wt = await ws.prepare(1, "sandbox");
  writeFileSync(join(wt, "src/a/one.ts"), "export const one = 11;\n");
  writeFileSync(join(wt, "src/a/new.ts"), "new\n");
  rmSync(join(wt, "src/b/two.ts"));
  renameSync(join(wt, "src/b/old.ts"), join(wt, "src/b/renamed.ts"));
  const changed = (await ws.changedFiles(wt)).sort();
  assert.deepEqual(changed, [".setup-ran", "src/a/new.ts", "src/a/one.ts", "src/b/old.ts", "src/b/renamed.ts", "src/b/two.ts"]);

  const sha = await ws.commit(wt, 7, "row 7", ["src/a/one.ts", "src/a/new.ts"]);
  assert.match(sha!, /^[0-9a-f]{40}$/);
  assert.equal(sh(wt, "git show --name-only --format= HEAD").trim().split("\n").sort().join(","), "src/a/new.ts,src/a/one.ts");
  assert.match(sh(wt, "git log -1 --format=%B"), /Factory-Item: 7/);
  assert.equal(await ws.commit(wt, 7, "nothing", ["src/a/one.ts"]), null, "nothing left to commit for those paths");
  const sha2 = await ws.commit(wt, 8, "row 8", ["src/b/two.ts", "src/b/old.ts", "src/b/renamed.ts"]);
  assert.ok(sha2);
  assert.deepEqual((await ws.changedFiles(wt)), [".setup-ran"]);
});

test("GitWorkspace: concurrent path-scoped commits never mix rows", async () => {
  const { ws } = sandbox();
  const wt = await ws.prepare(2, "sandbox");
  const rounds = 8;
  await Promise.all(["a", "b"].map(async (row, r) => {
    for (let i = 0; i < rounds; i++) {
      writeFileSync(join(wt, `src/${row}/f${i}.ts`), `${row}${i}\n`);
      await ws.commit(wt, r + 1, `row ${row} ${i}`, [`src/${row}/f${i}.ts`]);
    }
  }));
  const log = sh(wt, "git log --format='%(trailers:key=Factory-Item,valueonly)' --name-only Staging..HEAD");
  const blocks = log.trim().split(/\n(?=\d+\n)/);
  assert.equal(blocks.length, rounds * 2);
  for (const b of blocks) {
    const [item, ...files] = b.split("\n").filter(Boolean);
    const row = item.trim() === "1" ? "a" : "b";
    assert.ok(files.every((f) => f.startsWith(`src/${row}/`)), `commit for item ${item} touched ${files}`);
  }
  assert.equal(sh(wt, "git fsck --no-progress 2>&1; echo ok").trim().split("\n").at(-1), "ok");
});

test("ShellGate: runs every command, reports exit and failure signatures", async () => {
  const { ws, config } = sandbox();
  const wt = await ws.prepare(3, "sandbox");
  const run = await new ShellGate(config).run("sandbox", wt, "quick", []);
  assert.equal(run.exitOk, false);
  assert.deepEqual(run.failures, ["pytest:tests/test_x.py::test_y"]);
  assert.match(run.output, /\$ echo fine\nfine\n\[exit 0\]/);
});

test("scopeFromChanged picks changed pytest files and spec globs for changed src folders", () => {
  assert.deepEqual(scopeFromChanged(["tests/test_a.py", "fastapi_app/x.py", "src/app/risk/risk.component.ts", "src/app/risk/risk.service.ts"]), {
    tests: ["tests/test_a.py"],
    specs: ["src/app/risk/**/*.spec.ts"],
  });
});

test("Jira search tools are read-only: no edit or transition tool", () => {
  for (const t of [...READ_TOOLS, ...SEARCH_TOOLS]) assert.doesNotMatch(t, /edit|transition|addComment|create/i);
  assert.ok(SEARCH_TOOLS.includes("mcp:atlassian-searchJiraIssuesUsingJql"));
  assert.ok(COMMENT_TOOLS.length === 2);
});

test("listAssigned searches with the read-only tools and caps the list at 50", async () => {
  const calls: { allowTools?: string[] }[] = [];
  const issues = Array.from({ length: 60 }, (_, i) => ({ key: `ACME-${i + 1}`, summary: "s", status: "To Do" }));
  const runtime = {
    oneShot: async (opts: { allowTools?: string[] }) => (calls.push(opts), { value: { issues }, usage: {} }),
  } as unknown as CopilotRuntime;
  const tracker = new AtlassianMcpIssueTracker(runtime, "m", "https://mcp.example");
  const out = await tracker.listAssigned();
  assert.equal(out.length, 50);
  assert.equal(out[0].key, "ACME-1");
  assert.deepEqual(calls[0].allowTools, SEARCH_TOOLS);
});
