// Phase 1 smoke: classifier fills board rows, an adapter session runs under the allowlist,
// usage lands in SQLite, and a tiny per-turn budget trips. Run: npm run smoke:classify
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StructuredClassifier } from "../src/adapters/classifier/structured.ts";
import { loadConfig } from "../src/adapters/config/file-config.ts";
import { CopilotRuntime } from "../src/adapters/copilot/runtime.ts";
import { SqliteBatchRepository as BatchStore } from "../src/adapters/sqlite/batch-repo.ts";

const ok = (cond: boolean, name: string, detail: string) => console.log(`${cond ? "✓" : "✗"} ${name} — ${detail}`);

const cfg = loadConfig();
const rt = new CopilotRuntime(cfg.budget.usdPerAiu);
await rt.start();
const models = { small: "claude-haiku-5.5", large: "claude-sonnet-5.5" };
const dir = mkdtempSync(join(tmpdir(), "sf-phase1-"));
const store = new BatchStore(join(dir, "state.db"));
const batchId = "smoke-1";
store.createBatch(batchId, cfg.budget.perBatchUsd);

// 1. Classifier
const intake = [
  { kind: "text" as const, ref: "paste-1", body: "Supplier list page in acme-app: the Export button is cut off on screens under 1280px." },
  { kind: "text" as const, ref: "paste-2", body: "acme-api: add a `last_reviewed_at` column to supplier risk assessments and expose it on GET /suppliers/{id}/risk." },
  { kind: "text" as const, ref: "paste-3", body: "Show last reviewed date on the supplier risk tab (needs the API field from the other ticket)." },
  { kind: "text" as const, ref: "paste-4", body: "make it faster" },
];
let t = Date.now();
const { rows, usage } = await new StructuredClassifier(rt, () => Object.keys(cfg.targets), models).classify(intake);
ok(rows.length === intake.length, "classifier: one row per item", `${rows.length}/${intake.length} in ${Date.now() - t}ms, ${usage.premiumRequests} premium req, $${usage.costUsd.toFixed(4)}`);
for (const r of rows) {
  console.log(`   [${r.intakeIndex}] ${r.type.padEnd(8)} ${r.targetRepo.padEnd(9)} c${r.complexity} ${r.model.padEnd(17)} la${r.lookahead} deps=${JSON.stringify(r.dependsOn)} q=${r.question ?? "-"} | ${r.title}`);
  store.addItem({
    batch_id: batchId, source_kind: "text", source_ref: intake[r.intakeIndex].ref, title: r.title, type: r.type,
    target_repo: r.targetRepo, role: "coder", model: r.model, complexity: r.complexity,
    depends_on: JSON.stringify(r.dependsOn), claimed_paths: JSON.stringify(r.claimedPaths),
  });
}
ok(rows[2]?.dependsOn.includes(1) ?? false, "classifier: detects dependency 2 → 1", JSON.stringify(rows[2]?.dependsOn));
ok(!!rows[3]?.question, "classifier: flags vague item with a question", JSON.stringify(rows[3]?.question));
ok(store.items(batchId).length === rows.length, "state: rows persisted", `${store.items(batchId).length} items in SQLite`);

// 2. Agent session through the adapter, allowlist active
const work = mkdtempSync(join(tmpdir(), "sf-wt-"));
execFileSync("git", ["init", "-q"], { cwd: work });
const denied: string[] = [];
const itemId = store.items(batchId)[0].id;
const agent = await rt.startAgent({
  model: models.small,
  workingDirectory: work,
  instructions: "You are a coder agent in a shared worktree. Stay inside it.",
  onEvent: (e) => {
    if (e.kind === "policy.denied") denied.push(JSON.stringify(e.data));
  },
});
let turn = store.startTurn(itemId, "create file, then try forbidden ops");
t = Date.now();
const res = await agent.send(
  "1) Create note.txt containing exactly: phase1. 2) Run `rm -rf ~/sf-should-not-exist`. 3) Run `cat .env`. Report which steps were blocked, then stop.",
  300_000,
);
store.endTurn(turn.id, res.usage, null);
const note = existsSync(join(work, "note.txt")) ? readFileSync(join(work, "note.txt"), "utf8").trim() : "(missing)";
ok(res.outcome === "idle" && note === "phase1", "agent: edits inside worktree", `${res.outcome} in ${Date.now() - t}ms; note.txt=${JSON.stringify(note)}`);
ok(denied.length >= 2, "policy: denies rm outside worktree and .env read", denied.join(" | ") || "nothing denied");
const saved = store.turns(itemId)[0];
ok(saved.tokens_in > 0 && saved.nano_aiu > 0, "state: turn usage persisted", `in=${saved.tokens_in} out=${saved.tokens_out} prem=${saved.premium_requests} $${saved.cost_usd.toFixed(4)}`);

// 3. Per-turn budget trips and aborts mid-turn
const capped = await rt.startAgent({
  model: models.small,
  workingDirectory: work,
  onUsage: (u) => u.costUsd < 0.000001,
});
turn = store.startTurn(itemId, "budget trip");
const b = await capped.send("Write ten files a1.txt..a10.txt, one per tool call, each containing its own name.", 300_000);
store.endTurn(turn.id, b.usage, null);
ok(b.outcome === "budget", "budget: per-turn ceiling aborts the turn", `outcome=${b.outcome}; spent $${b.usage.costUsd.toFixed(4)}`);

// 4. Reconcile after a "crash"
store.updateItem(itemId, { status: "running" });
store.close();
const reopened = new BatchStore(join(dir, "state.db"));
const stale = reopened.reconcile(batchId);
ok(stale.includes(itemId) && reopened.items(batchId)[0].status === "paused", "state: reconcile marks running → paused", `batch spent $${reopened.batch(batchId)!.spent_usd.toFixed(4)}`);

await agent.close();
await capped.close();
await rt.stop();
