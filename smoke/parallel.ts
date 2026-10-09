// M12 live smoke: one card whose work splits into independent pieces, on a SYNTHETIC sandbox. The planner
// should propose subtasks; their coders must run at the same time. Run: npm run smoke:parallel
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type FactoryConfig } from "../src/adapters/config/file-config.ts";
import { createApp } from "../src/main.ts";

const sh = (cwd: string, cmd: string) => execFileSync("sh", ["-c", cmd], { cwd, encoding: "utf8" });
const dir = mkdtempSync(join(tmpdir(), "sf-m12-"));
const repo = join(dir, "sandbox");
sh(dir, "git init -q -b main sandbox");
sh(repo, "git config user.email factory@local && git config user.name factory");
const files: Record<string, string> = {
  "package.json": '{ "name": "sandbox", "type": "module" }\n',
  "src/math/add.js": "export const add = (a, b) => a + b;\n",
  "test/add.test.js": 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "../src/math/add.js";\ntest("add", () => assert.equal(add(2, 3), 5));\n',
};
for (const [f, c] of Object.entries(files)) {
  mkdirSync(join(repo, f, ".."), { recursive: true });
  writeFileSync(join(repo, f), c);
}
sh(repo, "git add -A && git commit -qm base");
const config: FactoryConfig = {
  ...loadConfig(),
  targets: { sandbox: { repo, host: "local", baseBranch: "main", setup: [], gate: { quick: ["node --test --test-reporter=tap test/"], full: ["node --test --test-reporter=tap test/"] } } },
};
const app = await createApp(join(dir, "factory.db"), config, join(dir, "worktrees"));
const batchId = "smoke-m12";
app.repo.createBatch(batchId, config.budget.perBatchUsd);
const id = app.repo.addItem({
  batch_id: batchId, source_kind: "text", source_ref: "smoke", title: "Add a small string toolkit", type: "feature", target_repo: "sandbox", role: "coder",
  model: "claude-haiku-5.5", complexity: 2, depends_on: "[]", claimed_paths: "[]",
  brief: "Add three independent helpers, each in its own file with its own node:test file: src/text/slugify.js (slugify(s): lowercase, non-alphanumerics to single dashes, trimmed), src/text/titleCase.js (titleCase(s)), and src/text/truncate.js (truncate(s, n) adds an ellipsis when cut). Tests go in test/slugify.test.js, test/titleCase.test.js, test/truncate.test.js.",
});
app.repo.updateItem(id, { status: "approved" });

const t0 = Date.now();
const at = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6);
app.events.subscribe(batchId, (e) => {
  if (["agent.tool", "turn.started", "agent.message"].includes(e.kind)) return;
  console.log(`${at()}s ${e.kind} ${JSON.stringify(e.data).slice(0, 170)}`);
});
await app.runner.kick(batchId);
const st = app.repo.sessionTurns(id).at(-1)!;
console.log("\nplanned subtasks:", JSON.stringify(JSON.parse(st.plan_json ?? "{}").subtasks ?? []));
if (app.repo.item(id)!.status === "planned") await app.runner.approvePlan(id);

const runs = app.repo.agentRuns(id);
const coders = runs.filter((r) => r.role === "coder");
// Coders overlapped if one started before another ended.
const overlap = coders.some((a) => coders.some((b) => a.id !== b.id && a.started_at <= b.started_at && (!a.ended_at || b.started_at < a.ended_at)));
console.log(`\n#${id} ${app.repo.item(id)!.status} · ${runs.map((r) => `${r.role}${r.subtask && r.subtask !== "main" ? `:${r.subtask}` : ""}`).join(", ")}`);
console.log(`coders: ${coders.length}, overlapped in time: ${overlap} · $${app.repo.itemSpendUsd(id).toFixed(3)} · ${at()}s`);
console.log(sh(join(dir, "worktrees", `s${id}`, "sandbox"), "git log --format='%h %s' main..HEAD"));
await app.close();
process.exit(app.repo ? 0 : 1);
