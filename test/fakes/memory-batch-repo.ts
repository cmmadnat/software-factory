// In-memory BatchRepository for application tests. Mirrors the SQLite adapter's observable behaviour.
import type { BatchRepository, LoggedEvent } from "../../src/application/ports/batch-repo.ts";
import type { AgentRun, AgentRunPatch, Batch, Item, ItemPatch, NewItem, Role, SessionTurn, SessionTurnPatch, Turn } from "../../src/domain/batch.ts";
import type { GateRun } from "../../src/domain/gate.ts";
import type { Usage } from "../../src/domain/usage.ts";

export class MemoryBatchRepository implements BatchRepository {
  private batches = new Map<string, Batch>();
  private itemRows: Item[] = [];
  private turnRows: Turn[] = [];
  private sessionTurnRows: SessionTurn[] = [];
  private runRows: AgentRun[] = [];
  readonly events: { itemId: number | null; kind: string; payload: unknown }[] = [];

  createBatch(id: string, budgetUsd: number) {
    this.batches.set(id, { id, created_at: new Date().toISOString(), status: "planning", worktree: null, budget_usd: budgetUsd, spent_usd: 0 });
  }
  batch(id: string) {
    return this.batches.get(id);
  }
  listBatches(limit: number) {
    return [...this.batches.values()].reverse().slice(0, limit);
  }
  updateBatch(id: string, patch: Partial<Pick<Batch, "status" | "worktree">>) {
    Object.assign(this.batches.get(id)!, patch);
  }
  addItem(item: NewItem) {
    const id = this.itemRows.length + 1;
    const position = this.itemRows.filter((i) => i.batch_id === item.batch_id).length;
    this.itemRows.push({ ...item, id, notes: item.notes ?? "", question: item.question ?? null, brief: item.brief ?? "", pause_reason: null, extra_budget_usd: 0, run: item.run ?? 1, status: "proposed", branch: null, mr_url: null, merged_at: null, position });
    return id;
  }
  item(id: number) {
    return this.itemRows.find((i) => i.id === id);
  }
  items(batchId: string) {
    return this.itemRows.filter((i) => i.batch_id === batchId).sort((a, b) => a.position - b.position);
  }
  updateItem(id: number, patch: ItemPatch) {
    for (const k of Object.keys(patch)) if (k === "id" || k === "batch_id") throw new Error(`not an editable item column: ${k}`);
    Object.assign(this.itemRows.find((i) => i.id === id)!, patch);
  }
  startSessionTurn(itemId: number, trigger: SessionTurn["trigger"], comment: string | null) {
    const n = this.sessionTurnRows.filter((t) => t.item_id === itemId).length + 1;
    const st: SessionTurn = { id: this.sessionTurnRows.length + 1, item_id: itemId, n, trigger, comment, plan_json: null, plan_status: "none", created_at: new Date().toISOString() };
    this.sessionTurnRows.push(st);
    return { ...st };
  }
  sessionTurns(itemId: number) {
    return this.sessionTurnRows.filter((t) => t.item_id === itemId).map((t) => ({ ...t }));
  }
  updateSessionTurn(id: number, patch: SessionTurnPatch) {
    Object.assign(this.sessionTurnRows.find((t) => t.id === id)!, patch);
  }
  startAgentRun(sessionTurnId: number, role: Role, model: string, subtask: string | null = null) {
    const st = this.sessionTurnRows.find((t) => t.id === sessionTurnId)!;
    const run: AgentRun = {
      id: this.runRows.length + 1, session_turn_id: sessionTurnId, item_id: st.item_id, role, subtask, model, sdk_session_id: null,
      status: "running", verdict: null, summary: null, started_at: new Date().toISOString(), ended_at: null,
    };
    this.runRows.push(run);
    return { ...run };
  }
  agentRuns(itemId: number) {
    return this.runRows.filter((r) => r.item_id === itemId).map((r) => ({ ...r }));
  }
  updateAgentRun(id: number, patch: AgentRunPatch) {
    const r = this.runRows.find((x) => x.id === id)!;
    Object.assign(r, patch);
    if (patch.status === "done" || patch.status === "failed") r.ended_at = new Date().toISOString();
  }
  startTurn(itemId: number, plan: string | null, agentRunId: number | null = null) {
    const n = this.turnRows.filter((t) => t.item_id === itemId).length + 1;
    const turn: Turn = {
      id: this.turnRows.length + 1, item_id: itemId, agent_run_id: agentRunId, n, plan, started_at: new Date().toISOString(), ended_at: null,
      tokens_in: 0, tokens_out: 0, premium_requests: 0, nano_aiu: 0, cost_usd: 0, gate_result: null,
    };
    this.turnRows.push(turn);
    return { ...turn };
  }
  endTurn(turnId: number, usage: Usage, gate: "green" | "red" | null) {
    const t = this.turnRows.find((x) => x.id === turnId)!;
    Object.assign(t, {
      ended_at: new Date().toISOString(), tokens_in: usage.tokensIn, tokens_out: usage.tokensOut,
      premium_requests: usage.premiumRequests, nano_aiu: usage.nanoAiu, cost_usd: usage.costUsd, gate_result: gate,
    });
    const item = this.itemRows.find((i) => i.id === t.item_id)!;
    this.batches.get(item.batch_id)!.spent_usd += usage.costUsd;
  }
  itemSpendUsd(itemId: number) {
    return this.turnRows.filter((t) => t.item_id === itemId).reduce((s, t) => s + t.cost_usd, 0);
  }
  runSpendUsd(agentRunId: number) {
    return this.turnRows.filter((t) => t.agent_run_id === agentRunId).reduce((s, t) => s + t.cost_usd, 0);
  }
  turns(itemId: number) {
    return this.turnRows.filter((t) => t.item_id === itemId);
  }
  logEvent(itemId: number | null, kind: string, payload: unknown = {}) {
    this.events.push({ itemId, kind, payload });
  }
  itemEvents(itemId: number, limit: number): LoggedEvent[] {
    return this.events
      .map((e, i) => ({ ...e, id: i + 1 }))
      .filter((e) => e.itemId === itemId)
      .slice(-limit)
      .map((e) => ({ id: e.id, ts: "", kind: e.kind, payload: JSON.parse(JSON.stringify(e.payload ?? {})) }));
  }
  reconcile(batchId: string) {
    const stale = this.items(batchId).filter((i) => i.status === "running");
    for (const i of stale) {
      i.status = "paused";
      i.pause_reason = "the factory restarted mid-turn — Continue resumes the same agent run";
      this.logEvent(i.id, "reconciled", { from: "running", to: "paused" });
    }
    const ids = new Set(this.items(batchId).map((i) => i.id));
    for (const t of this.turnRows) if (ids.has(t.item_id) && !t.ended_at) t.ended_at = new Date().toISOString();
    for (const r of this.runRows) if (ids.has(r.item_id) && r.status === "running") r.status = "paused";
    return stale.map((i) => i.id);
  }
  private baselines = new Map<string, GateRun>();
  baseline(itemId: number, target: string) {
    return this.baselines.get(`${itemId}/${target}`);
  }
  saveBaseline(itemId: number, target: string, run: GateRun) {
    this.baselines.set(`${itemId}/${target}`, run);
  }
  private gateBaselines = new Map<string, GateRun>();
  gateBaseline(key: string) {
    return this.gateBaselines.get(key);
  }
  saveGateBaseline(key: string, run: GateRun) {
    this.gateBaselines.set(key, run);
  }
  private dismissed = new Set<string>();
  dismissJira(key: string) {
    this.dismissed.add(key.toUpperCase());
  }
  dismissedJira() {
    return new Set(this.dismissed);
  }
  close() {}
}
