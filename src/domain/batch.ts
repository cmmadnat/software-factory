// Batch entities: what the board shows and what survives a crash.
// An Item is one card, which is one session (PLAN.md, Realignment): it owns a worktree and branch per target,
// runs one or more SessionTurns (one feedback loop each), and every subagent in a turn is an AgentRun whose
// model turns are Turn rows.

// planned = the planner's plan for the current session turn waits for Nat's approval.
export type ItemStatus = "proposed" | "approved" | "running" | "planned" | "paused" | "gate_red" | "done" | "failed" | "dropped";
export type ItemType = "bug" | "feature" | "refactor" | "spike";
export type SourceKind = "jira" | "text" | "image";
export type Role = "planner" | "coder" | "tester" | "reviewer";

export type BatchStatus = "planning" | "approved" | "running" | "waiting" | "done";

export interface Batch {
  id: string;
  created_at: string;
  status: BatchStatus;
  worktree: string | null;
  budget_usd: number;
  spent_usd: number;
}

export interface Item {
  id: number;
  batch_id: string;
  source_kind: SourceKind;
  source_ref: string;
  title: string;
  type: ItemType;
  target_repo: string;
  role: Role;
  model: string;
  complexity: number;
  depends_on: string; // JSON array of item ids
  claimed_paths: string; // JSON array of globs
  question: string | null; // the classifier's question when it couldn't place the row
  notes: string; // Nat's answers and extra instructions, passed to the agent with the task
  brief: string; // the normalised intake text (ticket, comments, screenshot descriptions)
  pause_reason: string | null; // why a paused/gate_red row stopped; shown with Continue / Kill
  extra_budget_usd: number; // budget Nat granted on top of perAgentUsd via Continue
  run: number; // 0 | 1
  status: ItemStatus;
  branch: string | null;
  mr_url: string | null;
  merged_at: string | null; // set when a local card's branch was merged into the base branch
  position: number;
}

export type NewItem = Omit<Item, "id" | "status" | "branch" | "mr_url" | "merged_at" | "position" | "run" | "notes" | "question" | "brief" | "pause_reason" | "extra_budget_usd"> & {
  run?: number;
  notes?: string;
  question?: string | null;
  brief?: string;
};
export type ItemPatch = Partial<Omit<Item, "id" | "batch_id">>;

// One feedback loop of a session: opened by intake (n = 1) or by Nat's comment on the card (n > 1).
export interface SessionTurn {
  id: number;
  item_id: number;
  n: number;
  trigger: "intake" | "comment";
  comment: string | null;
  plan_json: string | null; // the planner's Plan (domain/pipeline.ts), possibly edited by Nat
  plan_status: "none" | "proposed" | "approved" | "superseded";
  created_at: string;
}
export type SessionTurnPatch = Partial<Pick<SessionTurn, "plan_json" | "plan_status">>;

export type AgentRunStatus = "running" | "paused" | "done" | "failed";

// One subagent's work inside a session turn. Its SDK session id is what a resume reattaches to.
export interface AgentRun {
  id: number;
  session_turn_id: number;
  item_id: number;
  role: Role;
  subtask: string | null; // the plan subtask a coder builds; null = whole card
  model: string;
  sdk_session_id: string | null;
  status: AgentRunStatus;
  verdict: "approve" | "changes_requested" | null; // reviewer runs only
  summary: string | null; // the agent's closing words, or the reviewer's comments
  started_at: string;
  ended_at: string | null;
}
export type AgentRunPatch = Partial<Pick<AgentRun, "sdk_session_id" | "status" | "verdict" | "summary">>;

// One model turn of an agent run.
export interface Turn {
  id: number;
  item_id: number;
  agent_run_id: number | null; // null only on rows written before sessions existed
  n: number;
  plan: string | null;
  started_at: string;
  ended_at: string | null;
  tokens_in: number;
  tokens_out: number;
  premium_requests: number;
  nano_aiu: number;
  cost_usd: number;
  gate_result: "green" | "red" | null;
}

// One classifier proposal, before it becomes an Item.
export interface ProposedRow {
  intakeIndex: number;
  title: string;
  type: ItemType;
  targetRepo: string; // a configured target, or "unknown"
  complexity: number; // 1..5
  model: string;
  lookahead: number; // turns planned ahead
  dependsOn: number[]; // intake indices
  claimedPaths: string[];
  question: string | null; // set when the item is too vague to start; asked, never refused
}
