// One behavioural contract, run against every BatchRepository: the SQLite adapter and the in-memory fake
// that application tests rely on. If the fake drifts from the real thing, this fails.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { SqliteBatchRepository } from "../src/adapters/sqlite/batch-repo.ts";
import type { BatchRepository } from "../src/application/ports/batch-repo.ts";
import { zeroUsage } from "../src/domain/usage.ts";
import { MemoryBatchRepository } from "./fakes/memory-batch-repo.ts";

const impls: [string, () => BatchRepository][] = [
  ["sqlite", () => new SqliteBatchRepository(":memory:")],
  ["memory", () => new MemoryBatchRepository()],
];

for (const [name, make] of impls) {
  describe(`BatchRepository contract: ${name}`, () => {
    const seeded = () => {
      const s = make();
      s.createBatch("b", 20);
      const id = s.addItem({
        batch_id: "b", source_kind: "jira", source_ref: "ACME-1", title: "t", type: "bug", target_repo: "acme-api",
        role: "coder", model: "m", complexity: 2, depends_on: "[]", claimed_paths: "[]",
      });
      return { s, id };
    };

    test("dismissing a Jira key is idempotent and case-insensitive", () => {
      const s = make();
      assert.equal(s.dismissedJira().size, 0);
      s.dismissJira("ACME-9");
      s.dismissJira("acme-9");
      assert.deepEqual([...s.dismissedJira()], ["ACME-9"]);
    });

    test("new items are proposed, runnable, and positioned in insertion order", () => {
      const { s, id } = seeded();
      const id2 = s.addItem({ ...s.items("b")[0], source_ref: "ACME-2", run: 0 });
      assert.deepEqual(s.items("b").map((i) => [i.id, i.status, i.run, i.position]), [[id, "proposed", 1, 0], [id2, "proposed", 0, 1]]);
    });

    test("turn spend rolls up to item and batch", () => {
      const { s, id } = seeded();
      for (const cost of [0.25, 0.5]) {
        const t = s.startTurn(id, null);
        s.endTurn(t.id, { ...zeroUsage(), costUsd: cost }, "green");
      }
      assert.deepEqual(s.turns(id).map((t) => t.n), [1, 2]);
      assert.equal(s.itemSpendUsd(id), 0.75);
      assert.equal(s.batch("b")!.spent_usd, 0.75);
    });

    test("reconcile pauses orphaned running items and closes their turns", () => {
      const { s, id } = seeded();
      s.startTurn(id, null);
      s.updateItem(id, { status: "running" });
      assert.deepEqual(s.reconcile("b"), [id]);
      assert.equal(s.items("b")[0].status, "paused");
      assert.equal(s.items("b")[0].pause_reason, "the factory restarted mid-turn — Continue resumes the same agent run");
      assert.ok(s.turns(id)[0].ended_at);
    });

    test("reconcile leaves non-running items' pause_reason untouched", () => {
      const { s, id } = seeded();
      s.updateItem(id, { status: "gate_red", pause_reason: "gate red" });
      assert.deepEqual(s.reconcile("b"), []);
      assert.equal(s.items("b")[0].pause_reason, "gate red");
    });

    test("batches list newest first and accept status updates; questions persist", () => {
      const s = make();
      s.createBatch("b1", 5);
      s.createBatch("b2", 5);
      s.updateBatch("b1", { status: "approved" });
      assert.deepEqual(s.listBatches(10).map((b) => [b.id, b.status]), [["b2", "planning"], ["b1", "approved"]]);
      const id = s.addItem({
        batch_id: "b1", source_kind: "text", source_ref: "p", title: "t", type: "spike", target_repo: "unknown",
        role: "coder", model: "m", complexity: 1, depends_on: "[]", claimed_paths: "[]", question: "Which page?", run: 0,
      });
      assert.deepEqual([s.items("b1")[0].question, s.items("b1")[0].notes], ["Which page?", ""]);
      s.updateItem(id, { notes: "A: the supplier list" });
      assert.equal(s.items("b1")[0].notes, "A: the supplier list");
    });

    test("baselines persist per session and target", () => {
      const { s, id } = seeded();
      assert.equal(s.baseline(id, "acme-api"), undefined);
      s.saveBaseline(id, "acme-api", { exitOk: false, failures: ["pytest:a"], output: "x" });
      assert.deepEqual(s.baseline(id, "acme-api"), { exitOk: false, failures: ["pytest:a"], output: "x" });
      assert.equal(s.baseline(id, "acme-app"), undefined);
    });

    test("a session holds numbered turns; agent runs own their model turns and spend", () => {
      const { s, id } = seeded();
      const t1 = s.startSessionTurn(id, "intake", null);
      const t2 = s.startSessionTurn(id, "comment", "use the date pipe");
      assert.deepEqual(s.sessionTurns(id).map((t) => [t.n, t.trigger, t.comment, t.plan_status]), [[1, "intake", null, "none"], [2, "comment", "use the date pipe", "none"]]);
      s.updateSessionTurn(t1.id, { plan_json: '{"files":[]}', plan_status: "proposed" });
      assert.deepEqual([s.sessionTurns(id)[0].plan_json, s.sessionTurns(id)[0].plan_status], ['{"files":[]}', "proposed"]);
      const r1 = s.startAgentRun(t1.id, "coder", "m");
      const r2 = s.startAgentRun(t2.id, "coder", "m", "api");
      assert.deepEqual([r1.subtask, r2.subtask], [null, "api"]);
      assert.deepEqual([r1.item_id, r1.status, r1.sdk_session_id, r1.ended_at], [id, "running", null, null]);
      s.updateAgentRun(r1.id, { sdk_session_id: "sdk-1" });
      s.updateAgentRun(r1.id, { status: "done", verdict: "approve", summary: "looks right" });
      for (const [run, cost] of [[r1.id, 0.25], [r2.id, 0.5]] as const) s.endTurn(s.startTurn(id, null, run).id, { ...zeroUsage(), costUsd: cost }, null);
      assert.deepEqual([s.runSpendUsd(r1.id), s.runSpendUsd(r2.id), s.itemSpendUsd(id)], [0.25, 0.5, 0.75]);
      const runs = s.agentRuns(id);
      assert.deepEqual(runs.map((r) => [r.session_turn_id, r.sdk_session_id, r.status]), [[t1.id, "sdk-1", "done"], [t2.id, null, "running"]]);
      assert.ok(runs[0].ended_at);
      assert.deepEqual([runs[0].verdict, runs[0].summary, runs[1].verdict], ["approve", "looks right", null]);
      assert.deepEqual(s.turns(id).map((t) => t.agent_run_id), [r1.id, r2.id]);
    });

    test("reconcile pauses running agent runs too", () => {
      const { s, id } = seeded();
      const run = s.startAgentRun(s.startSessionTurn(id, "intake", null).id, "coder", "m");
      s.updateItem(id, { status: "running" });
      s.reconcile("b");
      assert.equal(s.agentRuns(id)[0].status, "paused");
      assert.equal(run.status, "running");
    });

    test("full-gate baselines persist by key", () => {
      const { s } = seeded();
      assert.equal(s.gateBaseline("app@abc#"), undefined);
      s.saveGateBaseline("app@abc#", { exitOk: true, failures: [], output: "ok" });
      assert.deepEqual(s.gateBaseline("app@abc#"), { exitOk: true, failures: [], output: "ok" });
    });

    test("itemEvents returns a row's newest events, oldest first", () => {
      const { s, id } = seeded();
      for (const n of [1, 2, 3]) s.logEvent(id, `k${n}`, { n });
      s.logEvent(null, "batch.x", {});
      assert.deepEqual(s.itemEvents(id, 2).map((e) => [e.kind, e.payload.n]), [["k2", 2], ["k3", 3]]);
    });

    test("merged_at starts null and can be set", () => {
      const { s, id } = seeded();
      assert.equal(s.item(id)!.merged_at, null);
      s.updateItem(id, { merged_at: "2026-01-01T00:00:00Z" });
      assert.equal(s.item(id)!.merged_at, "2026-01-01T00:00:00Z");
    });

    test("updateItem rejects non-editable columns", () => {
      const { s, id } = seeded();
      assert.throws(() => s.updateItem(id, { batch_id: "x" } as never), /not an editable/);
    });
  });
}

test("sqlite: a dismissed Jira key survives reopening the database", () => {
  const dir = mkdtempSync(join(tmpdir(), "dismiss-"));
  const file = join(dir, "factory.db");
  try {
    const first = new SqliteBatchRepository(file);
    first.dismissJira("ACME-5");
    first.close();
    const second = new SqliteBatchRepository(file);
    assert.deepEqual([...second.dismissedJira()], ["ACME-5"]);
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
