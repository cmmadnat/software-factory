// Use case: drive an approved batch until it settles. Each row is a session in its own worktree. Its current
// session turn runs the role pipeline (domain/pipeline.ts): the planner proposes a plan and the row waits for Nat;
// once he approves, coder → tester → reviewer run unattended. Writing roles end at the quick gate against the
// session's baseline — red goes back to the agent as its next turn, green commits the row's files. Every limit
// pauses only that row, with a reason; the rest keep going. Safe to call again after a crash (reconcile first),
// after Nat presses Continue or approves a plan, or after his comment opens another session turn.
import type { AgentRun, Item, Role, SessionTurn } from "../domain/batch.ts";
import { judge, type GateRun } from "../domain/gate.ts";
import { withinClaims } from "../domain/path-claims.ts";
import { claimsFromPlan, nextStage, planProblems, ROLE_SPECS, subtasksOf, type Plan, type Review, type Subtask } from "../domain/pipeline.ts";
import { lookaheadFor } from "../domain/routing.ts";
import { batchSettled, startable } from "../domain/scheduler.ts";
import { BoardError } from "./edit-board.ts";
import {
  coderPrompt, gateFeedback, jsonRetry, plannerPrompt, RESUME_PROMPT, reviewerPrompt, reviewFeedback, roleInstructions, testerPrompt,
} from "./prompts.ts";
import { parseReply, PlanSchema, ReviewSchema } from "./structured-reply.ts";
import type { AgentRuntime, AgentSession } from "./ports/agent-runtime.ts";
import type { BatchRepository } from "./ports/batch-repo.ts";
import type { EventSink } from "./ports/events.ts";
import type { GateRunner } from "./ports/gate.ts";
import type { Workspace } from "./ports/workspace.ts";

export interface RunLimits {
  maxParallel: number;
  maxTurnsPerAgent: number;
  perTurnUsd: number;
  perAgentUsd: number;
  perBatchUsd: number;
  maxRedGates: number;
  maxReviewRounds: number; // "changes requested" bounces back to the coder before the row pauses
  maxAgentsPerCard: number; // coders of one card running at once
  smallModel: string; // for roles whose spec says model: "small"
}

const claimsOf = (i: Item): string[] => JSON.parse(i.claimed_paths);
const depsOf = (i: Item): number[] => JSON.parse(i.depends_on);
const open = (r: AgentRun) => r.status === "running" || r.status === "paused";
const planOf = (st: SessionTurn): Plan => JSON.parse(st.plan_json!);
type RoleOutcome = "next" | "stop"; // stop = the row paused, waits, or was killed

export class RunBatch {
  private readonly loops = new Map<string, Promise<void>>();
  private readonly agents = new Map<number, AgentSession>(); // by agent run id
  private readonly inflight = new Map<number, { itemId: number; claims: string[] }>(); // writing runs, by run id
  private readonly wakes = new Map<string, () => void>(); // wakes a loop waiting on its workers
  private readonly worktrees = new Map<string, Promise<string>>();

  constructor(
    private readonly repo: BatchRepository,
    private readonly runtime: AgentRuntime,
    private readonly workspace: Workspace,
    private readonly gate: GateRunner,
    private readonly events: EventSink,
    private readonly limits: RunLimits,
  ) {}

  // Start (or rejoin) the batch loop. Returns the loop's promise; calling twice never runs two loops.
  kick(batchId: string): Promise<void> {
    const existing = this.loops.get(batchId);
    if (existing) {
      this.wakes.get(batchId)?.(); // a row became runnable while others run: don't wait for a worker to end
      return existing;
    }
    const loop: Promise<void> = this.loop(batchId).finally(() => {
      if (this.loops.get(batchId) === loop) this.loops.delete(batchId);
    });
    this.loops.set(batchId, loop);
    return loop;
  }

  // Nat approved more spend (or resumed after a crash): the row becomes runnable again.
  continue(itemId: number, extraUsd: number): Promise<void> {
    const item = this.mustItem(itemId);
    if (!["paused", "gate_red"].includes(item.status)) throw new Error(`row ${itemId} is ${item.status}, not paused`);
    this.repo.updateItem(itemId, { status: "approved", pause_reason: null, extra_budget_usd: item.extra_budget_usd + extraUsd });
    this.emit(item, "item.continued", { extraUsd });
    return this.kick(item.batch_id);
  }

  // "Start now": drop a queued row's dependencies (a stuck or cyclic wait). startable() still enforces maxParallel.
  nudge(itemId: number): Promise<void> {
    const item = this.mustItem(itemId);
    if (item.status !== "approved") throw new BoardError(`row ${itemId} is ${item.status}; only a queued row can be started now`);
    this.repo.updateItem(itemId, { depends_on: "[]" });
    this.emit(item, "item.nudged", { clearedDependsOn: JSON.parse(item.depends_on) });
    if (this.repo.batch(item.batch_id)?.status === "waiting") this.repo.updateBatch(item.batch_id, { status: "running" });
    return this.kick(item.batch_id);
  }

  // Nat's comment on a finished card opens the session's next turn, on top of the previous turns' commits.
  async anotherTurn(itemId: number, comment: string): Promise<void> {
    const item = this.mustItem(itemId);
    if (item.status !== "done") throw new BoardError(`row ${itemId} is ${item.status}; another turn needs a finished row`);
    if (item.branch) throw new BoardError(`row ${itemId} is already published as ${item.branch}`);
    if (!comment.trim()) throw new BoardError("another turn needs a comment");
    const st = this.repo.startSessionTurn(itemId, "comment", comment.trim());
    this.repo.updateItem(itemId, { status: "approved", pause_reason: null, extra_budget_usd: 0, run: 1 });
    this.emit(item, "session.turn", { n: st.n, comment: st.comment });
    return this.kick(item.batch_id);
  }

  // Nat's plain-text comment on a proposed plan: the draft is set aside and the planner re-runs with the comment.
  async commentOnPlan(itemId: number, comment: string): Promise<void> {
    const item = this.mustItem(itemId);
    const old = this.repo.sessionTurns(itemId).at(-1);
    if (item.status !== "planned" || old?.plan_status !== "proposed") throw new BoardError(`row ${itemId} has no plan waiting for approval`);
    if (!comment.trim()) throw new BoardError("a plan comment can't be empty");
    this.repo.updateSessionTurn(old.id, { plan_status: "superseded" });
    const st = this.repo.startSessionTurn(itemId, "comment", comment.trim());
    this.repo.updateItem(itemId, { status: "approved", pause_reason: null });
    this.emit(item, "plan.commented", { sessionTurn: st.n, comment: st.comment });
    return this.kick(item.batch_id);
  }

  // Checkpoint 1: Nat approves the planner's plan, optionally edited. Its files become the row's claimed paths.
  async approvePlan(itemId: number, edited?: unknown): Promise<void> {
    const item = this.mustItem(itemId);
    const st = this.repo.sessionTurns(itemId).at(-1);
    if (item.status !== "planned" || st?.plan_status !== "proposed") throw new BoardError(`row ${itemId} has no plan waiting for approval`);
    let plan = planOf(st);
    if (edited !== undefined) {
      const r = PlanSchema.safeParse(edited);
      if (!r.success) throw new BoardError(`the edited plan is not valid: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
      plan = r.data;
    }
    const problems = planProblems(plan);
    if (problems.length) throw new BoardError(`the plan's subtasks don't fit together: ${problems.join("; ")}`);
    this.repo.updateSessionTurn(st.id, { plan_json: JSON.stringify(plan), plan_status: "approved" });
    const claims = claimsFromPlan(plan);
    this.repo.updateItem(itemId, { status: "approved", pause_reason: null, ...(claims.length ? { claimed_paths: JSON.stringify(claims) } : {}) });
    this.emit(item, "plan.approved", { sessionTurn: st.n, edited: edited !== undefined, claims });
    return this.kick(item.batch_id);
  }

  async kill(itemId: number): Promise<void> {
    const item = this.mustItem(itemId);
    this.repo.updateItem(itemId, { status: "failed", pause_reason: "killed by Nat", run: 0 });
    for (const r of this.repo.agentRuns(itemId).filter(open)) this.repo.updateAgentRun(r.id, { status: "failed" });
    for (const r of this.repo.agentRuns(itemId)) await this.agents.get(r.id)?.abort();
    this.emit(item, "item.killed", {});
  }

  private async loop(batchId: string): Promise<void> {
    await null; // let kick() register this loop before anything can finish it
    this.repo.updateBatch(batchId, { status: "running" });
    this.events.emit({ batchId, itemId: null, kind: "batch.running", data: {} });
    const workers = new Map<number, Promise<void>>();
    for (;;) {
      const batch = this.repo.batch(batchId)!;
      const items = this.repo.items(batchId);
      if (batch.spent_usd < this.limits.perBatchUsd) {
        for (const item of startable(items, this.limits.maxParallel)) {
          this.repo.updateItem(item.id, { status: "running" });
          const w = this.work(this.mustItem(item.id))
            .catch((e) => this.pause(item, `runner error: ${e instanceof Error ? e.message : String(e)}`))
            .finally(() => workers.delete(item.id));
          workers.set(item.id, w);
        }
      }
      if (!workers.size) break;
      const woken = new Promise<void>((r) => this.wakes.set(batchId, r));
      await Promise.race([...workers.values(), woken]);
      this.wakes.delete(batchId);
    }
    this.loops.delete(batchId); // no await since the last startable(): a later kick() starts a fresh loop
    const items = this.repo.items(batchId);
    const settled = batchSettled(items);
    this.repo.updateBatch(batchId, { status: settled ? "done" : "waiting" });
    this.events.emit({
      batchId, itemId: null, kind: settled ? "batch.settled" : "batch.waiting",
      data: {
        done: items.filter((i) => i.status === "done").length,
        planned: items.filter((i) => i.status === "planned").length,
        waiting: items.filter((i) => ["paused", "gate_red", "approved"].includes(i.status)).length,
      },
    });
  }

  // Run the session turn's pipeline until it waits for Nat, pauses, or finishes.
  private async work(item: Item): Promise<void> {
    const worktree = await this.worktree(item);
    for (;;) {
      const fresh = this.mustItem(item.id);
      if (fresh.status === "failed") return; // killed
      const st = this.currentSessionTurn(fresh);
      const stage = nextStage(st, this.repo.agentRuns(item.id), this.limits.maxReviewRounds);
      if ("wait" in stage) {
        this.repo.updateItem(item.id, { status: "planned" });
        return this.emit(item, "plan.ready", { sessionTurn: st.n, plan: planOf(st) });
      }
      if ("done" in stage) {
        this.repo.updateItem(item.id, { status: "done" });
        return this.emit(item, "item.done", { sessionTurn: st.n });
      }
      if ("stuck" in stage) return this.pause(item, stage.stuck);
      if ("role" in stage) {
        if ((await this.runRole(fresh, st, stage.role, worktree)) === "stop") return;
        continue;
      }
      // A wave: every ready subtask's coder at once, in the shared worktree, each writing only its own files.
      // A sibling that stops (a limit, a red gate) doesn't interrupt the others; the card stops after the wave.
      const wave = stage.coders.slice(0, this.limits.maxAgentsPerCard);
      if (wave.length > 1) this.emit(item, "wave.started", { subtasks: wave });
      const outcomes = await Promise.all(
        wave.map((sub) =>
          this.runRole(fresh, st, "coder", worktree, sub).catch((e) => {
            const run = this.repo.agentRuns(item.id).find((r) => r.session_turn_id === st.id && r.role === "coder" && r.subtask === sub && open(r));
            return this.stop(item, `runner error${sub ? ` in subtask ${sub}` : ""}: ${e instanceof Error ? e.message : String(e)}`, run);
          }),
        ),
      );
      if (outcomes.includes("stop")) return;
    }
  }

  // One agent run of one role, turn by turn, resumed if it was left open. A coder with a subtask writes only
  // that subtask's files; subtask null is a whole-card coder (review rework).
  private async runRole(item: Item, st: SessionTurn, role: Role, worktree: string, subtask: string | null = null): Promise<RoleOutcome> {
    const spec = ROLE_SPECS[role];
    const sub: Subtask | undefined = subtask ? subtasksOf(planOf(st)).find((t) => t.id === subtask) : undefined;
    const prior = this.repo.agentRuns(item.id).find((r) => r.session_turn_id === st.id && r.role === role && (role !== "coder" || r.subtask === subtask) && open(r));
    const run = prior ?? this.repo.startAgentRun(st.id, role, spec.model === "small" ? this.limits.smallModel : item.model, subtask);
    if (prior) this.repo.updateAgentRun(run.id, { status: "running" });
    // A plan with one subtask keeps the whole card's claims (its test files included).
    const claims = sub && subtasksOf(planOf(st)).length > 1 ? sub.files : claimsOf(item);
    const opts = {
      model: run.model,
      workingDirectory: worktree,
      writablePaths: claims,
      readOnly: spec.readOnly,
      instructions: roleInstructions(role, { ...item, claimed_paths: JSON.stringify(claims) }, lookaheadFor(item.complexity)),
      onUsage: (u: { costUsd: number }) => u.costUsd <= this.limits.perTurnUsd,
      onEvent: (e: { kind: string; data: unknown }) => this.agentEvent(item, e),
    };
    const resumed = !!run.sdk_session_id;
    const agent = resumed ? await this.runtime.resumeAgent(run.sdk_session_id!, opts) : await this.runtime.startAgent(opts);
    this.agents.set(run.id, agent);
    if (!spec.readOnly) this.inflight.set(run.id, { itemId: item.id, claims });
    if (!resumed) this.repo.updateAgentRun(run.id, { sdk_session_id: agent.id });
    this.emit(item, "item.started", { resumed, worktree, sessionTurn: st.n, agentRun: run.id, role, subtask });
    // What was already dirty, so a read-only role is only blamed for files it changed itself.
    const before = new Set(await this.workspace.changedFiles(worktree));

    try {
      let prompt = resumed
        ? spec.readOnly ? `${RESUME_PROMPT.split(".")[0]}. Finish, and end your reply with the JSON object as instructed.` : RESUME_PROMPT
        : await this.firstPrompt(item, st, role, sub);
      let reds = 0;
      let retriedJson = false;
      for (;;) {
        const limit = this.limitReached(item, run);
        if (limit) return this.stop(item, sub ? `subtask ${sub.id}: ${limit}` : limit, run);

        const turn = this.repo.startTurn(item.id, prompt.slice(0, 400), run.id);
        this.emit(item, "turn.started", { n: turn.n, role, subtask });
        const res = await agent.send(prompt);
        if (this.mustItem(item.id).status === "failed") return (this.repo.endTurn(turn.id, res.usage, null), "stop"); // killed
        if (res.outcome !== "idle") {
          this.repo.endTurn(turn.id, res.usage, null);
          const why = res.outcome === "budget" ? `hit the $${this.limits.perTurnUsd} turn budget` : `agent ${res.outcome}${res.error ? `: ${res.error}` : ""}`;
          return this.stop(item, sub ? `subtask ${sub.id}: ${why}` : why, run);
        }

        if (spec.readOnly) {
          this.repo.endTurn(turn.id, res.usage, null);
          const touched = (await this.workspace.changedFiles(worktree)).filter((f) => !before.has(f));
          if (touched.length) return this.stop(item, `the read-only ${role} changed files: ${touched.slice(0, 5).join(", ")}`, run);
          const parsed = role === "planner" ? parseReply(res.reply, PlanSchema) : parseReply(res.reply, ReviewSchema);
          if (!parsed.ok) {
            if (retriedJson) return this.stop(item, `the ${role}'s reply had no valid JSON: ${parsed.error}`, run);
            retriedJson = true;
            prompt = jsonRetry(parsed.error);
            continue;
          }
          if (role === "planner") {
            const problems = planProblems(parsed.value as Plan);
            if (problems.length) {
              if (retriedJson) return this.stop(item, `the planner's subtasks don't fit together: ${problems.join("; ")}`, run);
              retriedJson = true;
              prompt = `The subtasks in your plan don't fit together: ${problems.join("; ")}. Fix the split and reply again with only the JSON object in a \`\`\`json fence.`;
              continue;
            }
            this.repo.updateSessionTurn(st.id, { plan_json: JSON.stringify(parsed.value), plan_status: "proposed" });
            this.repo.updateAgentRun(run.id, { status: "done", summary: (parsed.value as Plan).approach.slice(0, 2000) });
          } else {
            const review = parsed.value as Review;
            this.repo.updateAgentRun(run.id, { status: "done", verdict: review.verdict, summary: review.comments.slice(0, 4000) });
            this.emit(item, "review.verdict", { verdict: review.verdict, comments: review.comments.slice(0, 500) });
          }
          return "next";
        }

        const changed = (await this.workspace.changedFiles(worktree)).filter((f) => withinClaims(f, claims));
        if (!changed.length) {
          this.repo.endTurn(turn.id, res.usage, null);
          // A tester may find the existing tests already prove the change; a coder must change something.
          if (role === "tester") return this.finishRun(item, run, res.reply, null, []);
          return this.stop(item, `${sub ? `subtask ${sub.id} ` : ""}finished without changing any claimed file — agent said: ${(res.reply ?? "").slice(0, 300)}`, run);
        }

        const gateRun = this.withoutSiblingsFailures(run.id, item.id, await this.gate.run(item.target_repo, worktree, "quick", changed));
        const verdict = judge(this.repo.baseline(item.id, item.target_repo)!, gateRun);
        this.repo.endTurn(turn.id, res.usage, verdict.green ? "green" : "red");
        this.emit(item, verdict.green ? "gate.green" : "gate.red", { newFailures: verdict.newFailures, fixed: verdict.fixed, turn: turn.n, role, subtask });

        if (verdict.green) {
          const subject = `${item.title}${st.n > 1 ? ` (turn ${st.n})` : ""}${role === "coder" ? (sub && subtasksOf(planOf(st)).length > 1 ? ` [${sub.id}: ${sub.title}]` : "") : ` [${role}]`}`;
          const body = [`${item.source_kind} ${item.source_ref}`, ...(st.comment ? [`Review comment: ${st.comment}`] : [])].join("\n");
          const sha = await this.workspace.commit(worktree, item.id, `${subject}\n\n${body}`, changed);
          return this.finishRun(item, run, res.reply, sha, changed);
        }
        if (++reds >= this.limits.maxRedGates) {
          this.repo.updateAgentRun(run.id, { status: "paused" });
          this.repo.updateItem(item.id, { status: "gate_red", pause_reason: `${sub ? `subtask ${sub.id}: ` : ""}gate red ${reds} times: ${verdict.newFailures.slice(0, 5).join(", ")}` });
          this.emit(item, "item.paused", { reason: "gate_red" });
          return "stop";
        }
        prompt = gateFeedback(verdict, gateRun);
      }
    } finally {
      this.agents.delete(run.id);
      this.inflight.delete(run.id);
      await agent.close().catch(() => {});
    }
  }

  private finishRun(item: Item, run: AgentRun, reply: string | undefined, sha: string | null, files: string[]): RoleOutcome {
    const summary = (reply ?? "").slice(0, 2000);
    this.repo.updateAgentRun(run.id, { status: "done", summary });
    this.emit(item, "role.done", { role: run.role, subtask: run.subtask, sha, files, summary: summary.slice(0, 500) });
    return "next";
  }

  private async firstPrompt(item: Item, st: SessionTurn, role: Role, sub?: Subtask): Promise<string> {
    const runs = this.repo.agentRuns(item.id);
    switch (role) {
      case "planner": {
        const earlier = this.repo.sessionTurns(item.id).filter((t) => t.n < st.n && (t.plan_status === "approved" || t.plan_status === "superseded")).at(-1);
        return plannerPrompt(item, st.comment, earlier ? planOf(earlier) : null, earlier?.plan_status === "superseded" ? "draft" : "approved");
      }
      case "coder": {
        // After "changes requested", the new coder run gets the reviewer's comments on top of the task.
        const review = runs.filter((r) => r.session_turn_id === st.id && r.role === "reviewer" && r.status === "done").at(-1);
        const base = coderPrompt(item, planOf(st), st.comment, sub);
        return review?.verdict === "changes_requested" ? `${base}\n\n${reviewFeedback(review.summary ?? "")}` : base;
      }
      case "tester":
        return testerPrompt(item, planOf(st));
      case "reviewer": {
        const notes = runs
          .filter((r) => r.session_turn_id === st.id && (r.role === "coder" || r.role === "tester") && r.summary)
          .map((r) => `${r.role}${r.subtask ? ` (${r.subtask})` : ""}: ${r.summary}`);
        return reviewerPrompt(item, planOf(st), st.comment, await this.workspace.sessionDiff(item.id, item.target_repo), notes);
      }
    }
  }

  // Turn and spend limits are per agent run, so a later session turn starts with a fresh allowance.
  private limitReached(item: Item, run: AgentRun): string | null {
    const fresh = this.mustItem(item.id);
    if (this.repo.turns(item.id).filter((t) => t.agent_run_id === run.id).length >= this.limits.maxTurnsPerAgent) return `reached ${this.limits.maxTurnsPerAgent} turns`;
    const cap = this.limits.perAgentUsd + fresh.extra_budget_usd;
    if (this.repo.runSpendUsd(run.id) >= cap) return `spent its $${cap.toFixed(2)} budget`;
    if (this.repo.batch(item.batch_id)!.spent_usd >= this.limits.perBatchUsd) return `batch reached its $${this.limits.perBatchUsd} budget`;
    return null;
  }

  private stop(item: Item, reason: string, run?: AgentRun): RoleOutcome {
    this.pause(item, reason, run);
    return "stop";
  }

  // Parallel coders share the tree: failures in files a sibling is still writing are its work in progress.
  private withoutSiblingsFailures(runId: number, itemId: number, gateRun: GateRun): GateRun {
    const others = [...this.inflight].filter(([id, f]) => id !== runId && f.itemId === itemId).map(([, f]) => f.claims);
    if (!others.length) return gateRun;
    const failureFile = (sig: string) => sig.replace(/^\w+:/, "").split("::")[0].replace(/:TS\d+$/, "");
    const failures = gateRun.failures.filter((f) => !others.some((c) => c.length && withinClaims(failureFile(f), c)));
    // If every failure was a sibling's, the failing exit status was theirs too — not an unexplained crash.
    const exitOk = gateRun.exitOk || (gateRun.failures.length > 0 && failures.length === 0);
    return { ...gateRun, failures, exitOk };
  }

  // The session turn being worked: the latest one, or turn 1 for a row that has never run.
  private currentSessionTurn(item: Item): SessionTurn {
    return this.repo.sessionTurns(item.id).at(-1) ?? this.repo.startSessionTurn(item.id, "intake", null);
  }

  // One worktree + baseline per (session, target). A row that depends on a same-target row starts from that
  // row's session branch, so the dependency's commits are present. The baseline is measured on the clean tree
  // before any agent edits, and persisted, so a resume or a later turn reuses it.
  private worktree(item: Item): Promise<string> {
    const key = `${item.id}/${item.target_repo}`;
    let p = this.worktrees.get(key);
    if (!p) {
      p = (async () => {
        const from = depsOf(item).map((d) => this.repo.item(d)).find((d) => d?.target_repo === item.target_repo)?.id;
        const wt = await this.workspace.prepare(item.id, item.target_repo, from);
        if (!this.repo.baseline(item.id, item.target_repo)) {
          this.emit(item, "baseline.started", { target: item.target_repo });
          const run = await this.gate.run(item.target_repo, wt, "quick", []);
          this.repo.saveBaseline(item.id, item.target_repo, run);
          this.emit(item, "baseline.done", { target: item.target_repo, failures: run.failures.length, exitOk: run.exitOk });
        }
        return wt;
      })();
      this.worktrees.set(key, p);
      p.catch(() => this.worktrees.delete(key));
    }
    return p;
  }

  // Pauses one agent run (siblings in the same wave keep going) and stops the card for Nat. Without a run —
  // a stuck pipeline — only the card stops.
  private pause(item: Item, reason: string, run?: AgentRun): void {
    if (this.mustItem(item.id).status === "failed") return;
    if (run) this.repo.updateAgentRun(run.id, { status: "paused" });
    this.repo.updateItem(item.id, { status: "paused", pause_reason: reason });
    this.emit(item, "item.paused", { reason });
  }

  private agentEvent(item: Item, e: { kind: string; data: unknown }) {
    const d = (e.data ?? {}) as Record<string, unknown>;
    if (e.kind === "tool.execution_start") this.emit(item, "agent.tool", { tool: d.toolName });
    else if (e.kind === "policy.denied") this.emit(item, "agent.denied", d);
    else if (e.kind === "assistant.message" && typeof d.content === "string" && d.content) this.emit(item, "agent.message", { text: d.content.slice(0, 300) });
  }

  private emit(item: Item, kind: string, data: unknown) {
    this.events.emit({ batchId: item.batch_id, itemId: item.id, kind, data });
  }

  private mustItem(id: number): Item {
    const i = this.repo.item(id);
    if (!i) throw new Error(`no row ${id}`);
    return i;
  }
}
