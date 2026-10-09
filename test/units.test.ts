import assert from "node:assert/strict";
import { test } from "node:test";
import { StructuredClassifier } from "../src/adapters/classifier/structured.ts";
import { lookaheadFor } from "../src/domain/routing.ts";
import { EXAMPLE_CONFIG_PATH, gateCommands, loadConfig, setupCommands } from "../src/adapters/config/file-config.ts";
import { usageFromEvent } from "../src/adapters/copilot/runtime.ts";
import { checkTool, withGateGitEnv } from "../src/domain/tool-policy.ts";
import type { AgentRuntime } from "../src/application/ports/agent-runtime.ts";
import { zeroUsage } from "../src/domain/usage.ts";

const WT = "/tmp/wt";

test("policy: blocks pushes, merges, destructive git, secrets", () => {
  for (const command of [
    "git push --force origin x",
    "git push origin fix/a",
    "glab mr merge 12",
    "git reset --hard HEAD~1",
    "git clean -fd",
    "cat .env",
    "source .env.local && npm test",
    "printenv",
  ]) {
    assert.equal(checkTool("bash", { command }, WT).allow, false, command);
  }
});

test("policy: read-only roles may search and run tests but not write or mutate", () => {
  for (const c of ["grep -rn foo src", "git log --oneline -5", "git diff Staging...HEAD", "node --test test/ 2>&1 | tail", "npm test", "ls >/dev/null 2>&1"])
    assert.equal(checkTool("bash", { command: c }, "/wt", [], true).allow, true, c);
  for (const c of ["cat a > b", "echo x >> f.txt", "sed -i '' s/a/b/ f", "rm -f x", "git checkout -- .", "git commit -m x", "npm install", "mkdir -p x", "touch f"])
    assert.equal(checkTool("bash", { command: c }, "/wt", [], true).allow, false, c);
  assert.equal(checkTool("str_replace_editor", { path: "a.ts" }, "/wt", [], true).allow, false);
  assert.equal(checkTool("str_replace_editor", { path: "a.ts" }, "/wt", [], false).allow, true);
});

test("policy: rm/mv only inside the worktree", () => {
  assert.equal(checkTool("bash", { command: "rm -rf build dist" }, WT).allow, true);
  assert.equal(checkTool("bash", { command: "rm -rf /tmp/wt/build" }, WT).allow, true);
  assert.equal(checkTool("bash", { command: "rm -rf ../other" }, WT).allow, false);
  assert.equal(checkTool("bash", { command: "rm -rf ~/x" }, WT).allow, false);
  assert.equal(checkTool("bash", { command: "npm test && rm /etc/hosts" }, WT).allow, false);
});

test("policy: writes stay in the worktree, reads may leave it", () => {
  assert.equal(checkTool("create", { path: "src/a.ts" }, WT).allow, true);
  assert.equal(checkTool("edit", { path: "/Users/x/other/a.ts" }, WT).allow, false);
  assert.equal(checkTool("view", { path: "/Users/x/work/acme-api/README.md" }, WT).allow, true);
  assert.equal(checkTool("view", { path: "/tmp/wt/.env" }, WT).allow, false);
  assert.equal(checkTool("bash", { command: "npm run build" }, WT).allow, true);
});

test("policy: /private/var and /var are the same place on macOS", () => {
  const wt = "/var/folders/x/T/wt";
  assert.equal(checkTool("create", { path: "/private/var/folders/x/T/wt/src/a.ts" }, wt, ["src/**"]).allow, true);
  assert.equal(checkTool("create", { path: "/var/folders/x/T/wt/src/a.ts" }, "/private" + wt, ["src/**"]).allow, true);
  assert.equal(checkTool("create", { path: "/private/var/folders/x/T/other/a.ts" }, wt).allow, false);
});

test("policy: writes must stay inside the row's claimed paths when it has claims", () => {
  const claims = ["src/app/supplier/**", "README.md"];
  assert.equal(checkTool("create", { path: "src/app/supplier/list.ts" }, WT, claims).allow, true);
  assert.equal(checkTool("edit", { path: "/tmp/wt/README.md" }, WT, claims).allow, true);
  const d = checkTool("edit", { path: "src/app/buyer/x.ts" }, WT, claims);
  assert.equal(d.allow, false);
  assert.match((d as { reason: string }).reason, /outside this row's claimed paths/);
  assert.equal(checkTool("edit", { path: "anything.ts" }, WT, []).allow, true);
});

test("config: loads targets and expands gate placeholders", () => {
  const cfg = loadConfig(EXAMPLE_CONFIG_PATH);
  const api = cfg.targets["acme-api"];
  assert.ok(!api.repo.startsWith("~"));
  assert.deepEqual(gateCommands(api, "quick", { tests: ["tests/test_a.py"] }), [".venv/bin/pytest -q --maxfail=100000 tests/test_a.py"]);
  assert.deepEqual(gateCommands(api, "quick"), [".venv/bin/pytest -q --maxfail=100000 tests"]);
  assert.deepEqual(setupCommands(api), [`ln -sfn ${api.repo}/.venv .venv`]);
  const app = cfg.targets["acme-app"];
  assert.equal(gateCommands(app, "full", { specs: ["src/app/x/**/*.spec.ts"] })[1], "npx ng test --watch=false --browsers=ChromeHeadless --include=src/app/x/**/*.spec.ts");
});

test("usage: maps assistant.usage event to dollars", () => {
  const u = usageFromEvent({ inputTokens: 10, outputTokens: 2, cost: 1, copilotUsage: { totalNanoAiu: 2e9 } }, 0.1);
  assert.deepEqual(u, { tokensIn: 10, tokensOut: 2, premiumRequests: 1, nanoAiu: 2e9, costUsd: 0.2 });
});

test("sqlite: opening a database created by an older version adds the new columns", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { DatabaseSync } = await import("node:sqlite");
  const { SqliteBatchRepository } = await import("../src/adapters/sqlite/batch-repo.ts");
  const path = join(mkdtempSync(join(tmpdir(), "sf-mig-")), "old.db");
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE batch (id TEXT PRIMARY KEY, created_at TEXT NOT NULL DEFAULT (datetime('now')), status TEXT NOT NULL DEFAULT 'planning', budget_usd REAL NOT NULL, spent_usd REAL NOT NULL DEFAULT 0);
    CREATE TABLE item (id INTEGER PRIMARY KEY, batch_id TEXT NOT NULL, source_kind TEXT NOT NULL, source_ref TEXT NOT NULL, title TEXT NOT NULL, type TEXT NOT NULL,
      target_repo TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'coder', model TEXT NOT NULL, complexity INTEGER NOT NULL, depends_on TEXT NOT NULL DEFAULT '[]',
      claimed_paths TEXT NOT NULL DEFAULT '[]', run INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'proposed', branch TEXT, mr_url TEXT, position INTEGER NOT NULL DEFAULT 0);
    INSERT INTO batch (id, budget_usd) VALUES ('old', 5);
    INSERT INTO item (batch_id, source_kind, source_ref, title, type, target_repo, model, complexity) VALUES ('old', 'text', 'p', 'kept', 'bug', 'app', 'm', 1);`);
  old.close();
  const repo = new SqliteBatchRepository(path);
  const [it] = repo.items("old");
  assert.deepEqual([it.title, it.notes, it.brief, it.extra_budget_usd, it.merged_at], ["kept", "", "", 0, null]);
  repo.updateItem(it.id, { merged_at: "2026-01-01T00:00:00Z" });
  assert.equal(repo.item(it.id)!.merged_at, "2026-01-01T00:00:00Z");
  repo.addItem({ batch_id: "old", source_kind: "text", source_ref: "q", title: "new", type: "bug", target_repo: "app", role: "coder", model: "m", complexity: 1, depends_on: "[]", claimed_paths: "[]", brief: "b" });
  assert.equal(repo.items("old")[1].brief, "b");
  repo.close();
});

test("sqlite: rows that ran before sessions existed become one-turn sessions that still resume", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { DatabaseSync } = await import("node:sqlite");
  const { SqliteBatchRepository } = await import("../src/adapters/sqlite/batch-repo.ts");
  const path = join(mkdtempSync(join(tmpdir(), "sf-mig-")), "m7.db");
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE batch (id TEXT PRIMARY KEY, created_at TEXT NOT NULL DEFAULT (datetime('now')), status TEXT NOT NULL DEFAULT 'planning', worktree TEXT, budget_usd REAL NOT NULL, spent_usd REAL NOT NULL DEFAULT 0);
    CREATE TABLE item (id INTEGER PRIMARY KEY, batch_id TEXT NOT NULL, source_kind TEXT NOT NULL, source_ref TEXT NOT NULL, title TEXT NOT NULL, type TEXT NOT NULL,
      target_repo TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'coder', model TEXT NOT NULL, complexity INTEGER NOT NULL, depends_on TEXT NOT NULL DEFAULT '[]',
      claimed_paths TEXT NOT NULL DEFAULT '[]', session_id TEXT, run INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'proposed', branch TEXT, mr_url TEXT, position INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE turn (id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL, n INTEGER NOT NULL, plan TEXT, started_at TEXT NOT NULL DEFAULT (datetime('now')), ended_at TEXT,
      tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0, premium_requests REAL NOT NULL DEFAULT 0, nano_aiu INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0, gate_result TEXT, UNIQUE (item_id, n));
    INSERT INTO batch (id, budget_usd) VALUES ('old', 5);
    INSERT INTO item (batch_id, source_kind, source_ref, title, type, target_repo, model, complexity, session_id, status) VALUES ('old', 'text', 'p', 'paused one', 'bug', 'app', 'm', 1, 'sdk-7', 'paused');
    INSERT INTO item (batch_id, source_kind, source_ref, title, type, target_repo, model, complexity, status) VALUES ('old', 'text', 'q', 'never ran', 'bug', 'app', 'm', 1, 'approved');
    INSERT INTO turn (item_id, n, cost_usd) VALUES (1, 1, 0.1), (1, 2, 0.2);`);
  old.close();
  for (let open = 0; open < 2; open++) { // idempotent across restarts
    const repo = new SqliteBatchRepository(path);
    assert.deepEqual(repo.sessionTurns(1).map((t) => [t.n, t.trigger]), [[1, "intake"]]);
    assert.deepEqual(repo.agentRuns(1).map((r) => [r.role, r.sdk_session_id, r.status]), [["coder", "sdk-7", "paused"]]);
    assert.equal(repo.runSpendUsd(repo.agentRuns(1)[0].id).toFixed(2), "0.30");
    assert.deepEqual([repo.sessionTurns(2), repo.agentRuns(2)], [[], []], "a row that never ran gets its session turn when it starts");
    repo.close();
  }
});

test("classifier: derives model + lookahead from complexity and sanitises indices", async () => {
  const fake = {
    structured: async () => ({
      value: {
        rows: [
          { intakeIndex: 0, title: "a", type: "bug", targetRepo: "acme-app", complexity: "1", dependsOn: [0, 7], claimedPaths: [], question: null },
          { intakeIndex: 1.0, title: "b", type: "feature", targetRepo: "acme-api", complexity: "4", dependsOn: [0], claimedPaths: ["src/**"], question: "" },
          { intakeIndex: 9, title: "ghost", type: "spike", targetRepo: "unknown", complexity: "2", dependsOn: [], claimedPaths: [], question: null },
        ],
      },
      usage: zeroUsage(),
    }),
  } as unknown as AgentRuntime;
  const c = new StructuredClassifier(fake, () => ["acme-api", "acme-app"], { small: "haiku", large: "sonnet" });
  const { rows } = await c.classify([
    { kind: "text", ref: "a", body: "a" },
    { kind: "text", ref: "b", body: "b" },
  ]);
  assert.equal(rows.length, 2);
  assert.deepEqual([rows[0].model, rows[0].lookahead, rows[0].dependsOn], ["haiku", 1, []]);
  assert.deepEqual([rows[1].model, rows[1].lookahead, rows[1].dependsOn, rows[1].question], ["sonnet", 4, [0], null]);
  assert.deepEqual([1, 2, 3, 4, 5].map(lookaheadFor), [1, 1, 2, 4, 4]);
});

test("classifier: mutual dependencies keep only the edge to the earlier row", async () => {
  const row = (i: number, dependsOn: number[]) => ({ intakeIndex: i, title: `t${i}`, type: "bug", targetRepo: "unknown", complexity: "1", dependsOn, claimedPaths: [], question: null });
  const fake = { structured: async () => ({ value: { rows: [row(0, [1]), row(1, [0])] }, usage: zeroUsage() }) } as unknown as AgentRuntime;
  const c = new StructuredClassifier(fake, () => [], { small: "haiku", large: "sonnet" });
  const { rows } = await c.classify([
    { kind: "text", ref: "a", body: "a" },
    { kind: "text", ref: "b", body: "b" },
  ]);
  assert.deepEqual(rows[0].dependsOn, []);
  assert.deepEqual(rows[1].dependsOn, [0]);
});

test("withGateGitEnv: unsets git config injection, keeps command, ignores non-shell args", () => {
  const out = withGateGitEnv({ command: "git status", x: 1 }) as { command: string; x: number };
  assert.match(out.command, /^unset GIT_CONFIG_COUNT\b.*; git status$/);
  assert.equal(out.x, 1);
  const noCmd = { path: "a" };
  assert.equal(withGateGitEnv(noCmd), noCmd);
  assert.equal(withGateGitEnv(undefined), undefined);
  assert.deepEqual(withGateGitEnv({ command: 5 }), { command: 5 });
});
