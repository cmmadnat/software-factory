// Durable batch state: items, turns and spend must survive a crash, a limit, or a closed laptop.
import type { AgentRun, AgentRunPatch, Batch, Item, ItemPatch, NewItem, Role, SessionTurn, SessionTurnPatch, Turn } from "../../domain/batch.ts";
import type { GateRun } from "../../domain/gate.ts";
import type { Usage } from "../../domain/usage.ts";

export interface LoggedEvent {
  id: number;
  ts: string;
  kind: string;
  payload: Record<string, unknown>;
}

export interface BatchRepository {
  createBatch(id: string, budgetUsd: number): void;
  batch(id: string): Batch | undefined;
  listBatches(limit: number): Batch[];
  updateBatch(id: string, patch: Partial<Pick<Batch, "status" | "worktree">>): void;
  addItem(item: NewItem): number;
  item(id: number): Item | undefined;
  items(batchId: string): Item[];
  updateItem(id: number, patch: ItemPatch): void;
  // A session's feedback loops, oldest first. n is assigned per item.
  startSessionTurn(itemId: number, trigger: SessionTurn["trigger"], comment: string | null): SessionTurn;
  sessionTurns(itemId: number): SessionTurn[];
  updateSessionTurn(id: number, patch: SessionTurnPatch): void;
  startAgentRun(sessionTurnId: number, role: Role, model: string, subtask?: string | null): AgentRun;
  agentRuns(itemId: number): AgentRun[];
  // Setting a terminal status ('done' | 'failed') also stamps ended_at.
  updateAgentRun(id: number, patch: AgentRunPatch): void;
  startTurn(itemId: number, plan: string | null, agentRunId?: number | null): Turn;
  // Closing a turn and charging its cost to the batch must be atomic, so spend never drifts.
  endTurn(turnId: number, usage: Usage, gate: "green" | "red" | null): void;
  itemSpendUsd(itemId: number): number;
  runSpendUsd(agentRunId: number): number;
  turns(itemId: number): Turn[];
  logEvent(itemId: number | null, kind: string, payload?: unknown): void;
  // The newest `limit` events of one row, oldest first: a card's activity log.
  itemEvents(itemId: number, limit: number): LoggedEvent[];
  // Gate result on a session's clean worktree, per (item, target). Persisted so a resume or a later turn never
  // re-measures a tree that already holds the session's own edits.
  baseline(itemId: number, target: string): GateRun | undefined;
  saveBaseline(itemId: number, target: string, run: GateRun): void;
  // Full-gate results on a base commit, keyed by target, sha and scope, so shipping many cards onto the same
  // base measures it once.
  gateBaseline(key: string): GateRun | undefined;
  saveGateBaseline(key: string, run: GateRun): void;
  // Jira keys the user dismissed from the triage inbox. Local and permanent; dismissing twice is a no-op.
  dismissJira(key: string): void;
  dismissedJira(): Set<string>;
  // Anything left 'running' has no live process behind it: mark it (and its open agent runs) resumable.
  // Returns the item ids touched.
  reconcile(batchId: string): number[];
  close(): void;
}
