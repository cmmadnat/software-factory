import assert from "node:assert/strict";
import { test } from "node:test";
import { CardFileDiff } from "../src/application/card-file-diff.ts";
import { BoardError } from "../src/application/edit-board.ts";
import { RunBatch, type RunLimits } from "../src/application/run-batch.ts";
import type { AgentOptions, AgentRuntime, AgentSession, TurnResult } from "../src/application/ports/agent-runtime.ts";
import type { EventSink, RunEvent } from "../src/application/ports/events.ts";
import type { GateRunner } from "../src/application/ports/gate.ts";
import type { Workspace } from "../src/application/ports/workspace.ts";
import type { NewItem, Role } from "../src/domain/batch.ts";
import type { GateRun } from "../src/domain/gate.ts";
import type { Plan, Review } from "../src/domain/pipeline.ts";
import { zeroUsage } from "../src/domain/usage.ts";
import { MemoryBatchRepository } from "./fakes/memory-batch-repo.ts";

// ---- fakes ----
type Reply = Partial<TurnResult> & { write?: string[]; slowMs?: number };
// A row's script per role; n counts that role's sends for the row. Unscripted roles behave well: the planner
// plans the row's claims, the tester finds the existing tests enough, the reviewer approves.
type Script = (prompt: string, n: number) => Reply;
interface RowScript { coder: Script; planner?: Script; tester?: Script; reviewer?: Script }

const json = (v: unknown) => `Here you go.\n\`\`\`json\n${JSON.stringify(v)}\n\`\`\``;
const planFor = (files: string[], p: Partial<Plan> = {}): Plan => ({ rootCause: "rc", approach: "do it", files, testFiles: [], testPlan: "tp", risks: "none", ...p });
const review = (verdict: Review["verdict"], comments = "ok") => ({ reply: json({ verdict, comments }) });

class FakeWorkspace implements Workspace {
  dirty = new Set<string>();
  commits: { itemId: number; paths: string[]; message: string }[] = [];
  prepared: [number, string, number | undefined][] = [];
  async prepare(itemId: number, target: string, from?: number) { this.prepared.push([itemId, target, from]); return `/wt/s${itemId}`; }
  async changedFiles() { return [...this.dirty]; }
  async commit(_wt: string, itemId: number, message: string, paths: string[]) {
    paths.forEach((p) => this.dirty.delete(p));
    this.commits.push({ itemId, paths, message });
    return `sha${this.commits.length}`;
  }
  async sessionDiff(itemId: number) {
    return `diff for s${itemId}: ${this.commits.filter((c) => c.itemId === itemId).flatMap((c) => c.paths).join(", ")}`;
  }
  async fileDiff(itemId: number, _target: string, path: string) {
    return `diff of ${path} for s${itemId}`;
  }
  async branchesLike() {
    return new Set<string>();
  }
  async publishBranch() {
    return { pushed: true };
  }
  async snapshot() {
    return { worktree: "/wt/base", dispose: async () => {} };
  }
}

class FakeRuntime implements AgentRuntime {
  readonly backend = "copilot" as const;
  sends: { key: string; role: Role; prompt: string }[] = [];
  started: { key: string; role: Role; model: string; readOnly: boolean }[] = [];
  resumed: string[] = [];
  activeCoders = 0;
  maxActiveCoders = 0;
  private n = 0;
  constructor(private readonly ws: FakeWorkspace, private readonly scripts: Record<string, RowScript>) {}
  async start() {}
  async stop() {}
  async models() { return []; }
  async structured(): Promise<never> { throw new Error("unused"); }
  startAgent(opts: AgentOptions) { return Promise.resolve(this.session(`s${++this.n}`, opts)); }
  resumeAgent(id: string, opts: AgentOptions) { this.resumed.push(id); return Promise.resolve(this.session(id, opts)); }
  prompts(key: string, role: Role = "coder") { return this.sends.filter((s) => s.key === key && s.role === role).map((s) => s.prompt); }
  private session(id: string, opts: AgentOptions): AgentSession {
    const key = opts.writablePaths?.[0] ?? "";
    const role = /You are the (\w+)/.exec(opts.instructions ?? "")![1].toLowerCase() as Role;
    this.started.push({ key, role, model: opts.model, readOnly: !!opts.readOnly });
    return {
      id,
      send: async (prompt) => {
        this.sends.push({ key, role, prompt });
        if (role === "coder") this.maxActiveCoders = Math.max(this.maxActiveCoders, ++this.activeCoders);
        await new Promise((r) => setTimeout(r, role === "coder" ? 10 : 2));
        if (role === "coder") this.activeCoders--;
        const s = this.scripts[key];
        const n = this.prompts(key, role).length;
        const r: Reply =
          s[role]?.(prompt, n) ??
          (role === "planner" ? { reply: json(planFor([key])) } : role === "reviewer" ? review("approve") : role === "tester" ? { reply: "existing tests prove it" } : s.coder(prompt, n));
        r.write?.forEach((f) => this.ws.dirty.add(f));
        if (r.slowMs) await new Promise((ok) => setTimeout(ok, r.slowMs));
        return { reply: r.reply ?? "done", usage: { ...zeroUsage(), costUsd: 0.01, ...r.usage }, outcome: r.outcome ?? "idle", error: r.error };
      },
      abort: async () => {},
      close: async () => {},
    };
  }
}

const gateFrom = (fn: (changed: string[], call: number) => GateRun): GateRunner & { calls: number } => {
  const g = { calls: 0, run: async (_t: string, _w: string, _l: string, changed: string[]) => fn(changed, g.calls++) };
  return g;
};
const green: GateRun = { exitOk: true, failures: [], output: "ok" };

const LIMITS: RunLimits = { maxParallel: 3, maxTurnsPerAgent: 10, perTurnUsd: 0.5, perAgentUsd: 5, perBatchUsd: 20, maxRedGates: 3, maxReviewRounds: 2, maxAgentsPerCard: 3, smallModel: "small" };

function setup(scripts: Record<string, RowScript>, gate: GateRunner, rows: Partial<NewItem>[], limits = LIMITS) {
  const repo = new MemoryBatchRepository();
  repo.createBatch("b", 20);
  repo.updateBatch("b", { status: "approved" });
  const ids = rows.map((r, i) => {
    const id = repo.addItem({
      batch_id: "b", source_kind: "text", source_ref: `p${i}`, title: `row ${i}`, type: "bug", target_repo: "app", role: "coder",
      model: "m", complexity: 1, depends_on: "[]", claimed_paths: `["src/${i}/**"]`, ...r,
    });
    repo.updateItem(id, { status: "approved" });
    return id;
  });
  const ws = new FakeWorkspace();
  const rt = new FakeRuntime(ws, scripts);
  const events: RunEvent[] = [];
  const sink: EventSink = { emit: (e) => events.push({ ...e, ts: "" }) };
  const runner = new RunBatch(repo, rt, ws, gate, sink, limits);
  // Nat's part of a session turn: approve every plan that waits, until nothing does.
  const drive = async (start: () => Promise<void> = () => runner.kick("b")) => {
    await start();
    for (let planned; (planned = repo.items("b").filter((i) => i.status === "planned")).length; ) await Promise.all(planned.map((i) => runner.approvePlan(i.id)));
  };
  return { repo, ws, rt, events, ids, runner, drive };
}
const kinds = (events: RunEvent[], itemId?: number) => events.filter((e) => itemId === undefined || e.itemId === itemId).map((e) => e.kind);
const coderOnly = (coder: Script): RowScript => ({ coder });

// ---- the role pipeline ----
test("a row goes planner → waits for plan approval → coder → tester → reviewer → done", async () => {
  const { repo, ws, rt, events, ids, runner } = setup(
    {
      "src/0/**": {
        planner: () => ({ reply: json(planFor(["src/0/**"], { testFiles: ["test/0.test.ts"], rootCause: "off by one" })) }),
        coder: () => ({ write: ["src/0/a.ts"] }),
        tester: () => ({ write: ["test/0.test.ts"], reply: "added a boundary test" }),
      },
    },
    gateFrom(() => green),
    [{}],
  );
  await runner.kick("b");
  const [st] = repo.sessionTurns(ids[0]);
  assert.equal(repo.item(ids[0])!.status, "planned", "the row waits for Nat after planning");
  assert.equal(st.plan_status, "proposed");
  assert.equal(JSON.parse(st.plan_json!).rootCause, "off by one");
  assert.equal(repo.batch("b")!.status, "waiting");
  assert.equal(ws.commits.length, 0, "nothing is written before the plan is approved");

  await runner.approvePlan(ids[0]);
  assert.deepEqual(JSON.parse(repo.item(ids[0])!.claimed_paths), ["src/0/**", "test/0.test.ts"], "the plan's files become the claims");
  assert.equal(repo.item(ids[0])!.status, "done");
  assert.deepEqual(repo.agentRuns(ids[0]).map((r) => [r.role, r.model, r.status, r.verdict]), [
    ["planner", "m", "done", null], ["coder", "m", "done", null], ["tester", "small", "done", null], ["reviewer", "m", "done", "approve"],
  ]);
  assert.deepEqual(rt.started.map((s) => [s.role, s.readOnly]), [["planner", true], ["coder", false], ["tester", false], ["reviewer", true]]);
  assert.deepEqual(ws.commits.map((c) => [c.paths, c.message.split("\n")[0]]), [[["src/0/a.ts"], "row 0"], [["test/0.test.ts"], "row 0 [tester]"]]);
  assert.match(rt.prompts("src/0/**")[0], /Approved plan:\nRoot cause: off by one/);
  const reviewerPrompt = rt.prompts("src/0/**", "reviewer")[0];
  assert.match(reviewerPrompt, /diff for s1: src\/0\/a\.ts, test\/0\.test\.ts/);
  assert.match(reviewerPrompt, /tester: added a boundary test/);
  assert.deepEqual(kinds(events, ids[0]).filter((k) => /^(plan|review|role|item)\./.test(k)), [
    "item.started", "plan.ready", "plan.approved", "item.started", "role.done", "item.started", "role.done", "item.started", "review.verdict", "item.done",
  ]);
});

test("an edited plan replaces the planner's; an invalid one or a row without a waiting plan is refused", async () => {
  const { repo, ids, runner } = setup({ "src/0/**": coderOnly(() => ({ write: ["src/0/a.ts"] })) }, gateFrom(() => green), [{}]);
  await assert.rejects(runner.approvePlan(ids[0]), /no plan waiting/);
  await runner.kick("b");
  await assert.rejects(runner.approvePlan(ids[0], { files: "nope" }), /edited plan is not valid/);
  await runner.approvePlan(ids[0], planFor(["src/0/**", "src/0b/**"], { approach: "Nat's way" }));
  assert.equal(JSON.parse(repo.sessionTurns(ids[0])[0].plan_json!).approach, "Nat's way");
  assert.deepEqual(JSON.parse(repo.item(ids[0])!.claimed_paths), ["src/0/**", "src/0b/**"]);
});

test("a plain-text comment on a proposed plan supersedes it and re-plans with the comment", async () => {
  const { repo, rt, events, ids, runner } = setup(
    {
      "src/0/**": {
        planner: (_p, n) => ({ reply: json(planFor(["src/0/**"], { approach: n === 1 ? "first draft" : "second draft" })) }),
        coder: () => ({ write: ["src/0/a.ts"] }),
      },
    },
    gateFrom(() => green),
    [{}],
  );
  await assert.rejects(runner.commentOnPlan(ids[0], "x"), /no plan waiting/);
  await runner.kick("b");
  await assert.rejects(runner.commentOnPlan(ids[0], "  "), /can't be empty/);
  await runner.commentOnPlan(ids[0], "  also cover the empty case ");

  const turns = repo.sessionTurns(ids[0]);
  assert.deepEqual(turns.map((t) => [t.trigger, t.comment, t.plan_status]), [["intake", null, "superseded"], ["comment", "also cover the empty case", "proposed"]]);
  assert.equal(repo.item(ids[0])!.status, "planned");
  assert.equal(JSON.parse(turns[1].plan_json!).approach, "second draft");
  const second = rt.prompts("src/0/**", "planner")[1];
  assert.match(second, /previous draft plan was:[\s\S]*first draft/);
  assert.match(second, /also cover the empty case/);
  assert.ok(kinds(events, ids[0]).includes("plan.commented"));

  await runner.approvePlan(ids[0]);
  assert.equal(repo.item(ids[0])!.status, "done");
  await assert.rejects(runner.commentOnPlan(ids[0], "late"), /no plan waiting/);
});

test("changes requested goes back to a new coder run with the reviewer's comments, then through tester and reviewer again", async () => {
  const { repo, rt, ids, drive } = setup(
    {
      "src/0/**": {
        coder: (_p, n) => ({ write: [`src/0/a${n}.ts`] }),
        reviewer: (_p, n) => (n === 1 ? review("changes_requested", "handle the empty list") : review("approve")),
      },
    },
    gateFrom(() => green),
    [{}],
  );
  await drive();
  assert.equal(repo.item(ids[0])!.status, "done");
  assert.deepEqual(repo.agentRuns(ids[0]).map((r) => r.role), ["planner", "coder", "tester", "reviewer", "coder", "tester", "reviewer"]);
  assert.match(rt.prompts("src/0/**")[1], /The reviewer requested changes:\nhandle the empty list/);
});

test("the reviewer bouncing more than maxReviewRounds times pauses the row with its comments", async () => {
  const { repo, ids, drive } = setup(
    { "src/0/**": { coder: (_p, n) => ({ write: [`src/0/a${n}.ts`] }), reviewer: () => review("changes_requested", "still wrong") } },
    gateFrom(() => green),
    [{}],
  );
  await drive();
  assert.equal(repo.item(ids[0])!.status, "paused");
  assert.match(repo.item(ids[0])!.pause_reason!, /requested changes 3 times: still wrong/);
  assert.equal(repo.agentRuns(ids[0]).filter((r) => r.role === "coder").length, 3);
});

test("a planner reply without valid JSON gets one retry, then pauses", async () => {
  const { repo, rt, ids, runner } = setup(
    { "src/0/**": { coder: () => ({}), planner: (_p, n) => (n === 1 ? { reply: "I think we should fix it." } : { reply: "```json\n{\"rootCause\": 1}\n```" }) } },
    gateFrom(() => green),
    [{}],
  );
  await runner.kick("b");
  assert.match(rt.prompts("src/0/**", "planner")[1], /did not end with a valid JSON object \(no JSON object found/);
  assert.equal(repo.item(ids[0])!.status, "paused");
  assert.match(repo.item(ids[0])!.pause_reason!, /planner's reply had no valid JSON: rootCause/);
});

test("a read-only role that changes files pauses the row", async () => {
  const { repo, ids, runner } = setup(
    { "src/0/**": { coder: () => ({}), planner: () => ({ write: ["src/0/sneaky.ts"], reply: json(planFor(["src/0/**"])) }) } },
    gateFrom(() => green),
    [{}],
  );
  await runner.kick("b");
  assert.equal(repo.item(ids[0])!.status, "paused");
  assert.match(repo.item(ids[0])!.pause_reason!, /read-only planner changed files: src\/0\/sneaky\.ts/);
});

// ---- runner behaviour carried over from M6/M8 ----
test("two independent rows run in parallel, pass the gate, and each commits only its own files", async () => {
  const { repo, ws, events, drive } = setup(
    { "src/0/**": coderOnly(() => ({ write: ["src/0/a.ts"] })), "src/1/**": coderOnly(() => ({ write: ["src/1/b.ts", "README.md"] })) },
    gateFrom(() => green),
    [{}, {}],
  );
  await drive();
  assert.deepEqual(repo.items("b").map((i) => i.status), ["done", "done"]);
  assert.deepEqual(ws.commits.map((c) => c.paths).sort(), [["src/0/a.ts"], ["src/1/b.ts"]]);
  assert.ok(ws.dirty.has("README.md"), "unclaimed change is left uncommitted");
  assert.equal(repo.batch("b")!.status, "done");
  assert.equal(kinds(events).at(-1), "batch.settled");
});

test("a red gate goes back to the agent with the new failures; baseline failures are tolerated", async () => {
  const baseline: GateRun = { exitOk: false, failures: ["pytest:tests/old.py::t"], output: "" };
  const { repo, rt, drive } = setup(
    { "src/0/**": coderOnly(() => ({ write: ["src/0/a.py"] })) },
    gateFrom((_c, call) =>
      call === 0 ? baseline
        : call === 1 ? { exitOk: false, failures: ["pytest:tests/old.py::t", "pytest:tests/new.py::t"], output: "AssertionError boom" }
        : { exitOk: false, failures: ["pytest:tests/old.py::t"], output: "" }),
    [{}],
  );
  await drive();
  const prompts = rt.prompts("src/0/**");
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /gate is RED[\s\S]*pytest:tests\/new\.py::t[\s\S]*AssertionError boom/);
  assert.doesNotMatch(prompts[1], /old\.py/);
  assert.equal(repo.items("b")[0].status, "done");
  assert.deepEqual(repo.turns(repo.items("b")[0].id).map((t) => t.gate_result).filter(Boolean), ["red", "green"]);
});

test("a turn-budget hit pauses only that row; Continue resumes the same agent run to done", async () => {
  let first = true;
  const { repo, rt, runner, ids, drive } = setup(
    {
      "src/0/**": coderOnly(() => (first ? ((first = false), { outcome: "budget" as const }) : { write: ["src/0/a.ts"] })),
      "src/1/**": coderOnly(() => ({ write: ["src/1/b.ts"] })),
    },
    gateFrom(() => green),
    [{}, {}],
  );
  await drive();
  const [a, b] = repo.items("b");
  assert.equal(a.status, "paused");
  assert.match(a.pause_reason!, /\$0\.5 turn budget/);
  assert.equal(b.status, "done");
  assert.equal(repo.batch("b")!.status, "waiting", "not settled while a row waits for Nat");

  await runner.continue(ids[0], 0.5);
  assert.equal(repo.item(ids[0])!.status, "done");
  assert.equal(repo.item(ids[0])!.extra_budget_usd, 0.5);
  const coders = repo.agentRuns(ids[0]).filter((r) => r.role === "coder");
  assert.equal(coders.length, 1, "the paused agent run is resumed, not replaced");
  assert.deepEqual(rt.resumed, [coders[0].sdk_session_id]);
  assert.match(rt.prompts("src/0/**").at(-1)!, /You were interrupted/);
  assert.equal(repo.batch("b")!.status, "done");
});

test("a dependent row waits for its dependency to be done and starts from its branch", async () => {
  const order: string[] = [];
  const { repo, ids, ws, drive } = setup(
    { "src/0/**": coderOnly(() => (order.push("a"), { write: ["src/0/a.ts"] })), "src/1/**": coderOnly(() => (order.push("b"), { write: ["src/1/b.ts"] })) },
    gateFrom(() => green),
    [{}, {}],
  );
  repo.updateItem(ids[1], { depends_on: JSON.stringify([ids[0]]) });
  await drive();
  assert.deepEqual(order, ["a", "b"]);
  assert.deepEqual(ws.prepared, [[ids[0], "app", undefined], [ids[1], "app", ids[0]]]);
});

test("a coder finishing without touching a claimed file pauses with the agent's words instead of passing", async () => {
  const { repo, drive } = setup({ "src/0/**": coderOnly(() => ({ reply: "BLOCKED: which endpoint?" })) }, gateFrom(() => green), [{}]);
  await drive();
  const [a] = repo.items("b");
  assert.equal(a.status, "paused");
  assert.match(a.pause_reason!, /BLOCKED: which endpoint\?/);
});

test("repeated red gates stop at maxRedGates as gate_red", async () => {
  const { repo, drive } = setup(
    { "src/0/**": coderOnly(() => ({ write: ["src/0/a.ts"] })) },
    gateFrom((_c, call) => (call === 0 ? green : { exitOk: false, failures: ["tsc:src/0/a.ts:TS2339"], output: "" })),
    [{}],
  );
  await drive();
  const [a] = repo.items("b");
  assert.equal(a.status, "gate_red");
  assert.match(a.pause_reason!, /gate red 3 times: tsc:src\/0\/a\.ts:TS2339/);
});

test("a comment on a done row opens another session turn: re-plan, re-approve, then rework in the same worktree", async () => {
  const { repo, rt, ws, runner, ids, events, drive } = setup({ "src/0/**": coderOnly(() => ({ write: ["src/0/a.ts"] })) }, gateFrom(() => green), [{}]);
  await drive();
  await assert.rejects(runner.anotherTurn(ids[0], "  "), /needs a comment/);
  await runner.anotherTurn(ids[0], "use the existing date pipe");
  assert.equal(repo.item(ids[0])!.status, "planned", "turn 2 waits for its plan to be approved too");
  assert.match(rt.prompts("src/0/**", "planner")[1], /The previous turn's approved plan was:[\s\S]*Nat reviewed it and asks for this change:\nuse the existing date pipe/);
  await drive(async () => {});

  assert.equal(repo.item(ids[0])!.status, "done");
  assert.deepEqual(repo.sessionTurns(ids[0]).map((t) => [t.n, t.trigger, t.comment, t.plan_status]), [
    [1, "intake", null, "approved"], [2, "comment", "use the existing date pipe", "approved"],
  ]);
  assert.deepEqual(repo.agentRuns(ids[0]).map((r) => [r.session_turn_id, r.role]), [
    [1, "planner"], [1, "coder"], [1, "tester"], [1, "reviewer"], [2, "planner"], [2, "coder"], [2, "tester"], [2, "reviewer"],
  ]);
  assert.deepEqual(rt.resumed, []);
  assert.match(rt.prompts("src/0/**").at(-1)!, /Nat reviewed it and asks for this change:\nuse the existing date pipe/);
  assert.deepEqual(ws.prepared.map(([id]) => id), [ids[0]], "turn 2 reuses the session's worktree");
  assert.match(ws.commits[1].message, /^row 0 \(turn 2\)\n\ntext p0\nReview comment: use the existing date pipe$/);
  assert.equal(kinds(events, ids[0]).filter((k) => k === "baseline.done").length, 1, "the baseline is measured once per session");
});

test("another turn is refused for unfinished or published rows", async () => {
  const { repo, runner, ids, drive } = setup({ "src/0/**": coderOnly(() => ({ outcome: "budget" as const })) }, gateFrom(() => green), [{}]);
  await drive();
  await assert.rejects(runner.anotherTurn(ids[0], "x"), /is paused/);
  repo.updateItem(ids[0], { status: "done", branch: "fix/x" });
  await assert.rejects(runner.anotherTurn(ids[0], "x"), /already published/);
});

test("turn and spend limits are per agent run, so a later session turn starts fresh", async () => {
  const { repo, runner, ids, drive } = setup(
    { "src/0/**": coderOnly(() => ({ write: ["src/0/a.ts"], usage: { ...zeroUsage(), costUsd: 0.4 } })) },
    gateFrom(() => green),
    [{}],
    { ...LIMITS, perAgentUsd: 0.5 },
  );
  await drive();
  await drive(() => runner.anotherTurn(ids[0], "again"));
  assert.equal(repo.item(ids[0])!.status, "done", "turn 1's coder spend does not count against turn 2's coder");
  assert.equal(repo.agentRuns(ids[0]).filter((r) => r.role === "coder").length, 2);
});

test("kill stops a row for good and the batch still settles", async () => {
  const { repo, runner, ids, drive } = setup({ "src/0/**": coderOnly(() => ({ outcome: "budget" as const })) }, gateFrom(() => green), [{}]);
  await drive();
  await runner.kill(ids[0]);
  assert.equal(repo.item(ids[0])!.status, "failed");
  assert.ok(repo.agentRuns(ids[0]).every((r) => r.status !== "running" && r.status !== "paused"));
  await runner.kick("b");
  assert.equal(repo.batch("b")!.status, "done");
});

// ---- parallel coders inside one card (M12) ----
const splitPlan = (p: Partial<Plan> = {}) =>
  json(planFor(["src/0/**"], {
    subtasks: [
      { id: "a", title: "part A", files: ["src/0/a/**"], dependsOn: [] },
      { id: "b", title: "part B", files: ["src/0/b/**"], dependsOn: [] },
      { id: "c", title: "glue", files: ["src/0/c.ts"], dependsOn: ["a", "b"] },
    ],
    ...p,
  }));

test("a split card runs independent subtasks' coders at the same time, then the dependant, then tester and reviewer", async () => {
  const order: string[] = [];
  const { repo, rt, ws, ids, events, drive } = setup(
    {
      "src/0/**": { planner: () => ({ reply: splitPlan() }), coder: () => ({}) },
      "src/0/a/**": coderOnly(() => (order.push("a"), { write: ["src/0/a/x.ts"] })),
      "src/0/b/**": coderOnly(() => (order.push("b"), { write: ["src/0/b/y.ts"] })),
      "src/0/c.ts": coderOnly(() => (order.push("c"), { write: ["src/0/c.ts"] })),
    },
    gateFrom(() => green),
    [{}],
  );
  await drive();
  assert.equal(repo.item(ids[0])!.status, "done");
  assert.equal(rt.maxActiveCoders, 2, "a and b overlapped in time; c ran alone");
  assert.equal(order.at(-1), "c");
  assert.deepEqual(repo.agentRuns(ids[0]).map((r) => `${r.role}${r.subtask ? `:${r.subtask}` : ""}`).sort(), ["coder:a", "coder:b", "coder:c", "planner", "reviewer", "tester"]);
  assert.deepEqual(ws.commits.map((c) => [c.paths.join(), c.message.split("\n")[0]]).sort(), [
    ["src/0/a/x.ts", "row 0 [a: part A]"], ["src/0/b/y.ts", "row 0 [b: part B]"], ["src/0/c.ts", "row 0 [c: glue]"],
  ]);
  assert.match(rt.prompts("src/0/a/**")[0], /YOUR SUBTASK \(a\): part A\nChange only: src\/0\/a\/\*\*\.[\s\S]*- b: part B/);
  assert.deepEqual(kinds(events, ids[0]).filter((k) => k === "wave.started").length, 1, "only the a+b wave is parallel");
});

test("one subtask pausing doesn't stop its running sibling; Continue resumes only what is unfinished", async () => {
  let failB = true;
  const { repo, rt, ws, ids, runner, drive } = setup(
    {
      "src/0/**": { planner: () => ({ reply: splitPlan() }), coder: () => ({}) },
      "src/0/a/**": coderOnly(() => ({ write: ["src/0/a/x.ts"] })),
      "src/0/b/**": coderOnly(() => (failB ? ((failB = false), { outcome: "budget" as const }) : { write: ["src/0/b/y.ts"] })),
      "src/0/c.ts": coderOnly(() => ({ write: ["src/0/c.ts"] })),
    },
    gateFrom(() => green),
    [{}],
  );
  await drive();
  assert.equal(repo.item(ids[0])!.status, "paused");
  assert.match(repo.item(ids[0])!.pause_reason!, /^subtask b: hit the \$0\.5 turn budget/);
  const runs = () => Object.fromEntries(repo.agentRuns(ids[0]).filter((r) => r.subtask).map((r) => [r.subtask!, r.status]));
  assert.deepEqual(runs(), { a: "done", b: "paused" }, "a finished and committed although b stopped");
  assert.deepEqual(ws.commits.map((c) => c.paths.join()), ["src/0/a/x.ts"]);

  await drive(() => runner.continue(ids[0], 0));
  assert.equal(repo.item(ids[0])!.status, "done");
  assert.deepEqual(runs(), { a: "done", b: "done", c: "done" });
  assert.equal(rt.prompts("src/0/a/**").length, 1, "a was not run again");
  assert.equal(rt.resumed.length, 1, "b's paused run was resumed");
});

test("the gate doesn't blame a coder for failures in a running sibling's files", async () => {
  const held: { ws?: FakeWorkspace } = {};
  let blamedRuns = 0;
  const { repo, ids, ws, drive } = setup(
    {
      "src/0/**": { planner: () => ({ reply: splitPlan() }), coder: () => ({}) },
      "src/0/a/**": coderOnly(() => ({ write: ["src/0/a/x.ts"] })),
      "src/0/b/**": coderOnly(() => ({ write: ["src/0/b/y.ts"], slowMs: 60 })), // still half-written while a gates
      "src/0/c.ts": coderOnly(() => ({ write: ["src/0/c.ts"] })),
    },
    // Until b commits, its half-written file breaks every gate in the shared tree.
    gateFrom((changed) => {
      const bUnfinished = !held.ws!.commits.some((c) => c.paths.includes("src/0/b/y.ts"));
      if (changed.includes("src/0/a/x.ts") && bUnfinished) return (blamedRuns++, { exitOk: false, failures: ["tsc:src/0/b/y.ts:TS1005"], output: "" });
      return green;
    }),
    [{}],
  );
  held.ws = ws;
  await drive();
  assert.ok(blamedRuns > 0, "a's gate really ran while b was unfinished");
  assert.equal(repo.item(ids[0])!.status, "done");
  assert.deepEqual(repo.turns(ids[0]).filter((t) => t.gate_result === "red"), [], "no red gate for a");
});

test("a plan whose parallel subtasks overlap is sent back to the planner, and refused at approval", async () => {
  const overlapping = planFor(["src/0/**"], {
    subtasks: [{ id: "a", title: "A", files: ["src/0/**"], dependsOn: [] }, { id: "b", title: "B", files: ["src/0/b.ts"], dependsOn: [] }],
  });
  const { repo, rt, ids, runner } = setup(
    { "src/0/**": { planner: (_p, n) => ({ reply: n === 1 ? json(overlapping) : splitPlan() }), coder: () => ({}) } },
    gateFrom(() => green),
    [{}],
  );
  await runner.kick("b");
  assert.match(rt.prompts("src/0/**", "planner")[1], /subtasks a and b both write src\/0\/\*\* ~ src\/0\/b\.ts/);
  assert.equal(repo.item(ids[0])!.status, "planned");
  await assert.rejects(runner.approvePlan(ids[0], overlapping), /subtasks don't fit together: subtasks a and b both write/);
});

test("approving a second row while the first runs starts it at once, without a second loop", async () => {
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  const { repo, rt, ids, runner, drive } = setup(
    { "src/0/**": { coder: () => ({ slowMs: 0, write: ["src/0/a.ts"] }) }, "src/1/**": { coder: () => ({ write: ["src/1/b.ts"] }) } },
    gateFrom(() => green),
    [{}, {}],
  );
  repo.updateItem(ids[1], { status: "planned" });
  const send = rt.startAgent.bind(rt);
  rt.startAgent = (opts) => {
    const s = send(opts);
    if (opts.writablePaths?.[0] !== "src/0/**") return s;
    return s.then((sess) => ({ ...sess, send: async (p: string) => (await hold, sess.send(p)) }));
  };
  const first = runner.kick("b");
  await new Promise((r) => setTimeout(r, 20));
  repo.updateItem(ids[1], { status: "approved" });
  const again = runner.kick("b");
  assert.equal(again, first, "still one loop");
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(rt.started.some((s) => s.key === "src/1/**"), "row 1 started while row 0 is held");
  release();
  await first;
  await drive(() => Promise.resolve());
  assert.deepEqual(repo.items("b").map((i) => i.status), ["done", "done"]);
  assert.equal(repo.batch("b")!.status, "done");
});

test("a kick after the batch settled starts a fresh loop that runs a newly approved row", async () => {
  const { repo, rt, ids, runner, drive } = setup(
    { "src/0/**": coderOnly(() => ({ write: ["src/0/a.ts"] })), "src/1/**": coderOnly(() => ({ write: ["src/1/b.ts"] })) },
    gateFrom(() => green),
    [{}, {}],
  );
  repo.updateItem(ids[1], { status: "planned" });
  await runner.kick("b");
  assert.equal(repo.batch("b")!.status, "waiting");
  repo.updateItem(ids[1], { status: "approved" });
  const second = runner.kick("b");
  await second;
  assert.ok(rt.started.some((s) => s.key === "src/1/**"), "row 1 ran on the second kick");
  await drive(() => Promise.resolve());
  assert.deepEqual(repo.items("b").map((i) => i.status), ["done", "done"]);
  assert.equal(repo.batch("b")!.status, "done");
});

test("nudge clears a cyclic pair's wait: both rows run, an item.nudged event is logged, a waiting batch resumes", async () => {
  const { repo, events, ids, runner, drive } = setup(
    { "src/0/**": coderOnly(() => ({ write: ["src/0/a.ts"] })), "src/1/**": coderOnly(() => ({ write: ["src/1/b.ts"] })) },
    gateFrom(() => green),
    [{}, {}],
  );
  repo.updateItem(ids[0], { depends_on: JSON.stringify([ids[1]]) });
  repo.updateItem(ids[1], { depends_on: JSON.stringify([ids[0]]) });
  await runner.kick("b");
  assert.equal(repo.batch("b")!.status, "waiting");
  assert.deepEqual(repo.items("b").map((i) => i.status), ["approved", "approved"]);
  await drive(() => runner.nudge(ids[0]));
  assert.equal(repo.item(ids[0])!.depends_on, "[]");
  assert.deepEqual(repo.items("b").map((i) => i.status), ["done", "done"]);
  assert.ok(kinds(events, ids[0]).includes("item.nudged"));
});

test("nudge flips a waiting batch back to running before the kick, and persists the cleared deps", async () => {
  const { repo, ids, runner } = setup(
    { "src/0/**": coderOnly(() => ({ write: ["src/0/a.ts"] })), "src/1/**": coderOnly(() => ({ write: ["src/1/b.ts"] })) },
    gateFrom(() => green),
    [{}, {}],
  );
  repo.updateItem(ids[0], { depends_on: JSON.stringify([ids[1]]) });
  repo.updateItem(ids[1], { depends_on: JSON.stringify([ids[0]]) });
  await runner.kick("b");
  assert.equal(repo.batch("b")!.status, "waiting");
  const pending = runner.nudge(ids[0]);
  assert.equal(repo.batch("b")!.status, "running");
  assert.equal(repo.item(ids[0])!.depends_on, "[]");
  await pending;
  assert.notEqual(repo.item(ids[0])!.status, "approved", "the nudged row left the queue");
});

test("nudge is refused for a row that is not queued", async () => {
  const { repo, ids, runner } = setup({}, gateFrom(() => green), [{}]);
  repo.updateItem(ids[0], { status: "planned" });
  assert.throws(() => runner.nudge(ids[0]), /only a queued row/);
  assert.throws(() => runner.nudge(999));
});

test("nudge respects maxParallel", async () => {
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  const { repo, rt, ids, runner } = setup(
    { "src/0/**": coderOnly(() => ({ write: ["src/0/a.ts"] })), "src/1/**": coderOnly(() => ({ write: ["src/1/b.ts"] })) },
    gateFrom(() => green),
    [{}, {}],
    { ...LIMITS, maxParallel: 1 },
  );
  repo.updateItem(ids[1], { depends_on: JSON.stringify([ids[0] + 100]) });
  const send = rt.startAgent.bind(rt);
  rt.startAgent = (opts) => send(opts).then((sess) => ({ ...sess, send: async (p: string) => (await hold, sess.send(p)) }));
  const loop = runner.kick("b");
  await new Promise((r) => setTimeout(r, 20));
  void runner.nudge(ids[1]);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(repo.item(ids[1])!.status, "approved", "no free slot, so the nudged row still waits");
  assert.equal(repo.item(ids[1])!.depends_on, "[]");
  release();
  await loop;
});

test("a card file's diff is served only for files its plan names; unknown cards and files are refused", async () => {
  const repo = new MemoryBatchRepository();
  repo.createBatch("b", 20);
  const id = repo.addItem({
    batch_id: "b", source_kind: "text", source_ref: "p", title: "t", type: "bug", target_repo: "app", role: "coder",
    model: "m", complexity: 1, depends_on: "[]", claimed_paths: "[]",
  });
  const turn = repo.startSessionTurn(id, "intake", null);
  repo.updateSessionTurn(turn.id, {
    plan_json: JSON.stringify(planFor(["src/api/a.ts"], { testFiles: ["test/a.test.ts"], subtasks: [{ id: "ui", title: "ui", files: ["src/ui/deep/b.ts"], dependsOn: [] }] })),
    plan_status: "approved",
  });
  const diffs = new CardFileDiff(repo, new FakeWorkspace());

  assert.deepEqual(await diffs.execute(id, "src/api/a.ts"), { file: "src/api/a.ts", diff: "diff of src/api/a.ts for s1" });
  assert.equal((await diffs.execute(id, "test/a.test.ts")).file, "test/a.test.ts");
  assert.equal((await diffs.execute(id, "src/ui/deep/b.ts")).file, "src/ui/deep/b.ts", "a path with slashes round-trips");
  await assert.rejects(diffs.execute(id, "src/other.ts"), BoardError, "a file outside the plan is refused");
  await assert.rejects(diffs.execute(999, "src/api/a.ts"), BoardError, "an unknown card is refused");
});

test("a card file's diff: a card with no plan yet is refused, and an oversized diff is capped", async () => {
  const repo = new MemoryBatchRepository();
  repo.createBatch("b", 21);
  const planless = repo.addItem({
    batch_id: "b", source_kind: "text", source_ref: "p", title: "t", type: "bug", target_repo: "app", role: "coder",
    model: "m", complexity: 1, depends_on: "[]", claimed_paths: "[]",
  });
  await assert.rejects(new CardFileDiff(repo, new FakeWorkspace()).execute(planless, "src/a.ts"), BoardError, "no plan means no file is in the plan");

  const id = repo.addItem({
    batch_id: "b", source_kind: "text", source_ref: "q", title: "t", type: "bug", target_repo: "app", role: "coder",
    model: "m", complexity: 1, depends_on: "[]", claimed_paths: "[]",
  });
  const turn = repo.startSessionTurn(id, "intake", null);
  repo.updateSessionTurn(turn.id, { plan_json: JSON.stringify(planFor(["src/big.ts"])), plan_status: "approved" });
  const huge = new CardFileDiff(repo, { fileDiff: async () => "+x\n".repeat(30_000) });
  const { diff } = await huge.execute(id, "src/big.ts");
  assert.ok(diff.length < 41_000, "the diff is capped near the reviewer prompt's 40k");
  assert.match(diff, /diff truncated/);
});
