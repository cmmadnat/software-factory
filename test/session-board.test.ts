import assert from "node:assert/strict";
import { test } from "node:test";
import { InFlight } from "../src/application/in-flight.ts";
import { SessionBoard } from "../src/application/session-board.ts";
import type { NewItem } from "../src/domain/batch.ts";
import { zeroUsage } from "../src/domain/usage.ts";
import { MemoryBatchRepository } from "./fakes/memory-batch-repo.ts";

function setup() {
  const repo = new MemoryBatchRepository();
  const add = (batch: string, p: Partial<NewItem> = {}) =>
    repo.addItem({ batch_id: batch, source_kind: "jira", source_ref: "ACME-1", title: "t", type: "bug", target_repo: "app", role: "coder", model: "m", complexity: 1, depends_on: "[]", claimed_paths: "[]", ...p });
  repo.createBatch("b1", 5);
  repo.createBatch("b2", 5);
  return { repo, add, board: new SessionBoard(repo, () => ["app"]) };
}

test("the board shows cards from every recent batch in their columns, with spend", () => {
  const { repo, add, board } = setup();
  const a = add("b1");
  const b = add("b2", { title: "second" });
  repo.updateItem(b, { status: "done", branch: "fix/second", mr_url: "https://mr/1" });
  const run = repo.startAgentRun(repo.startSessionTurn(a, "intake", null).id, "planner", "m");
  repo.updateItem(a, { status: "running" });
  repo.endTurn(repo.startTurn(a, null, run.id).id, { ...zeroUsage(), costUsd: 0.25 }, null);
  const snap = board.board();
  assert.deepEqual(snap.columns.running.map((c) => [c.id, c.stage, c.sessionTurn, c.spentUsd, c.lastGate, c.plan]), [[a, "planning", 1, 0.25, null, null]]);
  assert.deepEqual(snap.columns.shipped.map((c) => [c.id, c.mrUrl]), [[b, "https://mr/1"]]);
  assert.equal(snap.spentUsd, 0.25);
});

test("a card reconciled after a factory restart shows why it paused", () => {
  const { repo, add, board } = setup();
  const running = add("b1");
  const proposed = add("b1", { title: "not started" });
  repo.updateItem(running, { status: "running" });
  repo.reconcile("b1");
  const reason = "the factory restarted mid-turn — Continue resumes the same agent run";
  assert.equal(repo.items("b1").find((i) => i.id === running)!.pause_reason, reason);
  assert.equal(board.card(running).card.pauseReason, reason);
  assert.equal(repo.items("b1").find((i) => i.id === proposed)!.pause_reason, null);
  assert.equal(board.card(proposed).card.pauseReason, null);
});

test("starting an Intake card checks repo, question and dependencies", () => {
  const { repo, add, board } = setup();
  const dropped = add("b1");
  repo.updateItem(dropped, { status: "dropped" });
  const c = add("b1", { target_repo: "unknown", question: "Which page?", depends_on: JSON.stringify([dropped]) });
  assert.deepEqual(board.card(c).startBlockers, ["pick a repo", "answer the question first", `depends on card ${dropped}, which won't run`]);
  assert.throws(() => board.start(c), /pick a repo; answer the question first/);
  repo.updateItem(c, { target_repo: "app", question: null, depends_on: "[]" });
  assert.equal(board.start(c).status, "approved");
  assert.throws(() => board.start(c), /already started/);
});

test("card detail groups agent runs by session turn with their spend and gates", () => {
  const { repo, add, board } = setup();
  const id = add("b1");
  const t1 = repo.startSessionTurn(id, "intake", null);
  repo.updateSessionTurn(t1.id, { plan_json: JSON.stringify({ rootCause: "r", approach: "a", files: ["x"], testFiles: [], testPlan: "", risks: "" }), plan_status: "approved" });
  const coder = repo.startAgentRun(t1.id, "coder", "m");
  repo.endTurn(repo.startTurn(id, null, coder.id).id, { ...zeroUsage(), costUsd: 0.1 }, "red");
  repo.endTurn(repo.startTurn(id, null, coder.id).id, { ...zeroUsage(), costUsd: 0.1 }, "green");
  repo.startSessionTurn(id, "comment", "again");
  repo.logEvent(id, "item.done", { batchId: "b1" });
  assert.deepEqual([board.board().columns.intake[0].lastGate, board.board().columns.intake[0].plan], ["green", null], "the plan shown is the current (second) turn's");
  const d = board.card(id);
  assert.deepEqual(d.turns.map((t) => [t.turn.n, t.plan?.approach ?? null, t.runs.map((r) => [r.role, r.modelTurns, r.gates, r.spentUsd.toFixed(2)])]), [
    [1, "a", [["coder", 2, ["red", "green"], "0.20"]]],
    [2, null, []],
  ]);
  assert.deepEqual(d.events.map((e) => e.kind), ["item.done"]);
});

test("the board has a Merged column after Shipped, and reports a running Ship or Merge as busy", () => {
  const { repo, add } = setup();
  const inFlight = new InFlight();
  const board = new SessionBoard(repo, () => ["app"], inFlight);
  const a = add("b1");
  const b = add("b1");
  repo.updateItem(a, { status: "done", branch: "fix/a" });
  repo.updateItem(b, { status: "done", branch: "fix/b", merged_at: "2026-01-01T00:00:00Z" });
  const snap = board.board();
  assert.deepEqual(Object.keys(snap.columns), ["intake", "plan", "running", "review", "shipped", "merged"]);
  assert.deepEqual(snap.columns.merged.map((c) => c.id), [b]);
  assert.equal(snap.columns.shipped[0].busy, null);
  inFlight.begin(a, "merge");
  assert.equal(board.board().columns.shipped[0].busy, "merge");
  inFlight.end(a);
  inFlight.begin(a, "resolve");
  assert.equal(board.board().columns.shipped[0].busy, "resolve");
  assert.throws(() => inFlight.begin(a, "merge"), /already resolving/);
  inFlight.end(a);
  inFlight.begin(a, "ship");
  assert.equal(board.card(a).card.busy, "ship");
  assert.throws(() => inFlight.begin(a, "merge"), /already shipping/);
});

test("queued cards say why they wait: unfinished dependency or no free slot", () => {
  const repo = new MemoryBatchRepository();
  repo.createBatch("b", 5);
  const add = (p: Partial<NewItem> = {}) =>
    repo.addItem({ batch_id: "b", source_kind: "text", source_ref: "p", title: "t", type: "bug", target_repo: "app", role: "coder", model: "m", complexity: 1, depends_on: "[]", claimed_paths: "[]", ...p });
  const a = add();
  const b = add({ depends_on: JSON.stringify([a]) });
  repo.updateItem(a, { depends_on: JSON.stringify([b]) });
  for (const id of [a, b]) repo.updateItem(id, { status: "approved", run: 1 });
  const board = new SessionBoard(repo, () => ["app"], undefined, 1);
  const cards = board.board().columns;
  const wait = (id: number) => Object.values(cards).flat().find((c) => c.id === id)!.waitingFor;
  assert.equal(wait(a), `waiting on #${b} (queued)`);
  assert.equal(wait(b), `waiting on #${a} (queued)`);
  const c = add();
  repo.updateItem(c, { status: "approved", run: 1 });
  const d = add();
  repo.updateItem(d, { status: "running" });
  const after = Object.values(board.board().columns).flat();
  assert.equal(after.find((x) => x.id === c)!.waitingFor, "waiting for a free slot");
  assert.equal(after.find((x) => x.id === d)!.waitingFor, null);
});
