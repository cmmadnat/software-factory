import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRun, Item, SessionTurn } from "../src/domain/batch.ts";
import { nextStage, planProblems } from "../src/domain/pipeline.ts";
import { columnOf, stageOf } from "../src/domain/board.ts";
import { parseReply, PlanSchema, ReviewSchema } from "../src/application/structured-reply.ts";
import { failureSignatures, judge } from "../src/domain/gate.ts";
import { batchSettled, startable, waitReason } from "../src/domain/scheduler.ts";

let next = 1;
const item = (p: Partial<Item>): Item => ({
  id: next, batch_id: "b", source_kind: "text", source_ref: "p", title: "t", type: "bug", target_repo: "app", role: "coder",
  model: "m", complexity: 1, depends_on: "[]", claimed_paths: `["src/${next}/**"]`, question: null, notes: "", brief: "", pause_reason: null, extra_budget_usd: 0, run: 1,
  status: "approved", branch: null, mr_url: null, merged_at: null, position: next++, ...p,
});

test("startable respects maxParallel and what's already running", () => {
  next = 1;
  const items = [item({}), item({}), item({}), item({ status: "running" })];
  assert.deepEqual(startable(items, 3).map((i) => i.id), [1, 2]);
  assert.deepEqual(startable(items, 1), []);
});

test("startable waits for dependencies to be done, and skips unticked or unapproved rows", () => {
  next = 1;
  const a = item({});
  const b = item({ depends_on: "[1]" });
  const c = item({ run: 0 });
  const d = item({ status: "proposed" });
  assert.deepEqual(startable([a, b, c, d], 5).map((i) => i.id), [1]);
  a.status = "done";
  assert.deepEqual(startable([a, b, c, d], 5).map((i) => i.id), [2]);
});

test("overlapping claims run in parallel: each session has its own worktree", () => {
  next = 1;
  const a = item({ claimed_paths: '["src/app/supplier/**"]', status: "running" });
  const b = item({ claimed_paths: '["src/app/supplier/list.ts"]' });
  assert.deepEqual(startable([a, b], 5).map((i) => i.id), [2]);
});

test("a batch settles when nothing is running or waiting to run", () => {
  next = 1;
  assert.equal(batchSettled([item({ status: "done" }), item({ status: "failed" }), item({ status: "dropped" })]), true);
  assert.equal(batchSettled([item({ status: "done" }), item({ status: "paused" })]), false);
  assert.equal(batchSettled([item({ status: "done" }), item({})]), false);
  assert.equal(batchSettled([item({ status: "planned" })]), false, "a plan waiting for Nat keeps the batch open");
});

test("judge: only new failures turn the gate red; pre-existing ones are tolerated, fixes reported", () => {
  const base = { exitOk: false, failures: ["pytest:a", "pytest:b"], output: "" };
  assert.deepEqual(judge(base, { exitOk: false, failures: ["pytest:a", "pytest:b"], output: "" }), { green: true, newFailures: [], fixed: [] });
  assert.deepEqual(judge(base, { exitOk: false, failures: ["pytest:a", "pytest:c"], output: "" }), { green: false, newFailures: ["pytest:c"], fixed: ["pytest:b"] });
});

test("judge: an unexplained crash is red unless the baseline crashed too", () => {
  const ok = { exitOk: true, failures: [], output: "" };
  const crash = { exitOk: false, failures: [], output: "SyntaxError" };
  assert.equal(judge(ok, crash).green, false);
  assert.equal(judge(crash, crash).green, true);
});

test("failureSignatures parses TAP (node --test) failures", () => {
  assert.deepEqual(failureSignatures("ok 1 - adds\n    not ok 2 - legacy is broken\nnot ok 3 - math # SKIP"), ["tap:legacy is broken", "tap:math"]);
});

test("failureSignatures parses pytest summaries and TypeScript build errors", () => {
  const out = [
    "FAILED tests/test_saq.py::test_answer - assert 401 == 200",
    "ERROR tests/services/test_x.py",
    "Error: src/app/risk/risk.component.ts:42:7 - error TS2339: Property 'lastReviewedAt' does not exist",
    "passed 10",
  ].join("\n");
  assert.deepEqual(failureSignatures(out), [
    "pytest:tests/services/test_x.py",
    "pytest:tests/test_saq.py::test_answer",
    "tsc:src/app/risk/risk.component.ts:TS2339",
  ]);
});

const PLAN = JSON.stringify({ rootCause: "r", approach: "a", files: ["x"], testFiles: [], testPlan: "", risks: "" });
const st = (p: Partial<SessionTurn> = {}): SessionTurn => ({ id: 1, item_id: 1, n: 1, trigger: "intake", comment: null, plan_json: null, plan_status: "none", created_at: "", ...p });
let runId = 0;
const run = (role: AgentRun["role"], p: Partial<AgentRun> = {}): AgentRun => ({
  id: ++runId, session_turn_id: 1, item_id: 1, role, subtask: null, model: "m", sdk_session_id: null, status: "done", verdict: null, summary: null, started_at: "", ended_at: null, ...p,
});

test("nextStage walks planner → approval → coders → tester → reviewer, and reworks with one whole-card coder", () => {
  const approved = st({ plan_status: "approved", plan_json: PLAN });
  const coder = (p: Partial<AgentRun> = {}) => run("coder", { subtask: "main", ...p });
  assert.deepEqual(nextStage(st(), [], 2), { role: "planner" });
  assert.deepEqual(nextStage(st({ plan_status: "proposed" }), [run("planner")], 2), { wait: "plan_approval" });
  assert.deepEqual(nextStage(approved, [run("planner")], 2), { coders: ["main"] }, "a plan without subtasks is one subtask");
  assert.deepEqual(nextStage(approved, [run("planner"), coder()], 2), { role: "tester" });
  assert.deepEqual(nextStage(approved, [run("planner"), coder(), run("tester")], 2), { role: "reviewer" });
  assert.deepEqual(nextStage(approved, [run("planner"), coder(), run("tester"), run("reviewer", { verdict: "approve" })], 2), { done: true });
  const bounce = () => [run("coder"), run("tester"), run("reviewer", { verdict: "changes_requested", summary: "fix x" })];
  assert.deepEqual(nextStage(approved, [run("planner"), coder(), run("tester"), run("reviewer", { verdict: "changes_requested" })], 2), { coders: [null] });
  assert.deepEqual(nextStage(approved, [run("planner"), ...bounce(), ...bounce()], 2), { coders: [null] });
  assert.match((nextStage(approved, [run("planner"), ...bounce(), ...bounce(), ...bounce()], 2) as { stuck: string }).stuck, /3 times: fix x/);
});

test("nextStage runs independent subtasks in one wave and dependants in the next", () => {
  const plan = JSON.stringify({
    rootCause: "r", approach: "a", files: [], testFiles: [], testPlan: "", risks: "",
    subtasks: [
      { id: "api", title: "API", files: ["api/**"], dependsOn: [] },
      { id: "ui", title: "UI", files: ["ui/**"], dependsOn: [] },
      { id: "export", title: "Export", files: ["ui/export.ts"], dependsOn: ["api", "ui"] },
    ],
  });
  const t = st({ plan_status: "approved", plan_json: plan });
  const coder = (sub: string, p: Partial<AgentRun> = {}) => run("coder", { subtask: sub, ...p });
  assert.deepEqual(nextStage(t, [run("planner")], 2), { coders: ["api", "ui"] });
  assert.deepEqual(nextStage(t, [run("planner"), coder("api")], 2), { coders: ["ui"] }, "export waits for ui");
  assert.deepEqual(nextStage(t, [run("planner"), coder("api"), coder("ui", { status: "paused" })], 2), { coders: ["ui"] }, "a paused sibling rejoins");
  assert.deepEqual(nextStage(t, [run("planner"), coder("api"), coder("ui")], 2), { coders: ["export"] });
  assert.deepEqual(nextStage(t, [run("planner"), coder("api"), coder("ui"), coder("export")], 2), { role: "tester" });
});

test("nextStage resumes an open read-only or tester run first and ignores other session turns' runs", () => {
  const approved = st({ id: 2, plan_status: "approved", plan_json: PLAN });
  assert.deepEqual(nextStage(approved, [run("planner", { session_turn_id: 2 }), run("coder", { session_turn_id: 2, subtask: "main" }), run("tester", { session_turn_id: 2, status: "paused" })], 2), { role: "tester" });
  assert.deepEqual(nextStage(st({ id: 2 }), [run("planner"), run("coder")], 2), { role: "planner" }, "turn 1's runs do not count for turn 2");
});

test("planProblems rejects overlapping siblings, unknown deps and cycles; dependants may share files", () => {
  const plan = (subtasks: { id: string; files: string[]; dependsOn: string[] }[]) =>
    ({ rootCause: "", approach: "", files: [], testFiles: [], testPlan: "", risks: "", subtasks: subtasks.map((t) => ({ title: t.id, ...t })) });
  assert.deepEqual(planProblems(plan([{ id: "a", files: ["src/a/**"], dependsOn: [] }, { id: "b", files: ["src/b.ts"], dependsOn: [] }])), []);
  assert.match(planProblems(plan([{ id: "a", files: ["src/**"], dependsOn: [] }, { id: "b", files: ["src/b.ts"], dependsOn: [] }]))[0], /subtasks a and b both write src\/\*\* ~ src\/b\.ts/);
  assert.deepEqual(planProblems(plan([{ id: "a", files: ["src/**"], dependsOn: [] }, { id: "b", files: ["src/b.ts"], dependsOn: ["a"] }])), [], "b runs after a, so sharing is safe");
  assert.match(planProblems(plan([{ id: "a", files: ["x"], dependsOn: ["zz"] }])).join(), /unknown subtask zz/);
  assert.match(planProblems(plan([{ id: "a", files: ["x"], dependsOn: ["b"] }, { id: "b", files: ["y"], dependsOn: ["a"] }])).join(), /cycle/);
});

test("parseReply takes the last JSON fence (or bare object) and validates it", () => {
  const plan = { rootCause: "r", approach: "a", files: ["x"], testFiles: [], testPlan: "t", risks: "-" };
  assert.deepEqual(parseReply(`thinking...\n\`\`\`json\n{"draft":1}\n\`\`\`\nfinal:\n\`\`\`json\n${JSON.stringify(plan)}\n\`\`\``, PlanSchema), { ok: true, value: plan });
  assert.deepEqual(parseReply(`Verdict below.\n{"verdict":"approve","comments":"fine"}`, ReviewSchema), { ok: true, value: { verdict: "approve", comments: "fine" } });
  assert.match((parseReply('```json\n{"verdict":"maybe","comments":""}\n```', ReviewSchema) as { error: string }).error, /verdict/);
  assert.deepEqual(parseReply("no json here", ReviewSchema), { ok: false, error: "no JSON object found in the reply" });
});

test("columnOf / stageOf place a card from its status, branch and running agent", () => {
  const at = (status: Item["status"], branch: string | null = null) => ({ status, branch });
  assert.deepEqual(
    (["proposed", "planned", "approved", "running", "paused", "gate_red", "done", "failed", "dropped"] as const).map((s) => columnOf(at(s))),
    ["intake", "plan", "running", "running", "running", "running", "review", "closed", "closed"],
  );
  assert.equal(columnOf(at("done", "fix/x")), "shipped");
  const merged = { status: "done" as const, branch: "fix/x", merged_at: "2026-01-01T00:00:00Z" };
  assert.equal(columnOf(merged), "merged");
  assert.equal(stageOf(merged, []), "merged");
  assert.equal(stageOf(at("running"), [run("planner", { status: "done" }), run("tester", { status: "running" })]), "testing");
  assert.equal(stageOf(at("approved"), []), "queued");
  assert.equal(stageOf(at("gate_red"), []), "needs you");
  assert.equal(stageOf(at("done"), []), "ready to review");
});

test("waitReason names unfinished dependencies or a full slot set, only for queued rows", () => {
  next = 1;
  const a = item({ depends_on: "[2]" });
  const b = item({ depends_on: "[1]" });
  assert.equal(waitReason(a, [a, b], 3), "waiting on #2 (approved)");
  assert.equal(waitReason(a, [a, b], 3, () => "queued"), "waiting on #2 (queued)");
  const free = item({});
  const r1 = item({ status: "running" });
  assert.equal(waitReason(free, [free, r1], 1), "waiting for a free slot");
  assert.equal(waitReason(free, [free, r1], 2), null);
  assert.equal(waitReason(r1, [free, r1], 1), null);
});

test("a cyclic pair never starts until one is nudged (deps cleared)", () => {
  next = 1;
  const a = item({ depends_on: "[2]" });
  const b = item({ depends_on: "[1]" });
  assert.deepEqual(startable([a, b], 3), []);
  const cleared = { ...a, depends_on: "[]" };
  assert.deepEqual(startable([cleared, b], 3).map((i) => i.id), [1]);
});
