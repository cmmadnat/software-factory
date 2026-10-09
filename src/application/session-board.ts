// Use case: the kanban. Every card is one session (an item row) from any recent batch; the board is derived
// from rows and agent runs on each read, so it never drifts from what the runner did. Starting a card from
// Intake is the only write here — plan approval, comments and shipping go through RunBatch / PublishBatch.
import type { AgentRun, Item, SessionTurn } from "../domain/batch.ts";
import { COLUMNS, columnOf, stageOf, type Column, type Stage } from "../domain/board.ts";
import type { Plan } from "../domain/pipeline.ts";
import { BoardError } from "./edit-board.ts";
import type { InFlight, InFlightKind } from "./in-flight.ts";
import { waitReason } from "../domain/scheduler.ts";
import type { BatchRepository, LoggedEvent } from "./ports/batch-repo.ts";

export interface CardSummary {
  id: number;
  batchId: string;
  title: string;
  type: Item["type"];
  repo: string;
  model: string;
  source: { kind: Item["source_kind"]; ref: string };
  column: Column;
  stage: Stage;
  waitingFor: string | null; // why a queued card isn't running yet
  sessionTurn: number; // 0 before the first run
  spentUsd: number;
  pauseReason: string | null;
  question: string | null;
  lastVerdict: AgentRun["verdict"];
  lastGate: "green" | "red" | null;
  activeAgents: number; // agent runs working right now (parallel coders count separately)
  plan: { approach: string; files: number } | null; // the current turn's plan, for Plan cards
  branch: string | null;
  mrUrl: string | null;
  mergedAt: string | null;
  busy: InFlightKind | null; // a Ship, Merge or Resolve is running for this card
}

export interface BoardSnapshot {
  columns: Record<Exclude<Column, "closed">, CardSummary[]>;
  closed: CardSummary[];
  spentUsd: number;
}

export interface RunView extends AgentRun {
  spentUsd: number;
  modelTurns: number;
  gates: ("green" | "red")[];
}

export interface CardDetail {
  card: CardSummary;
  item: Item;
  turns: { turn: SessionTurn; plan: Plan | null; runs: RunView[] }[];
  events: LoggedEvent[];
  startBlockers: string[]; // why an Intake card can't start yet
  siblings: { id: number; title: string }[]; // rows of the same batch, for dependencies
}

export class SessionBoard {
  constructor(
    private readonly repo: BatchRepository,
    private readonly targets: () => string[],
    private readonly inFlight?: InFlight,
    private readonly maxParallel = Infinity,
  ) {}

  board(recentBatches = 30): BoardSnapshot {
    const cards = this.repo
      .listBatches(recentBatches)
      .flatMap((b) => this.repo.items(b.id))
      .map((i) => this.summary(i));
    const columns = Object.fromEntries(COLUMNS.map((c) => [c, cards.filter((x) => x.column === c)])) as BoardSnapshot["columns"];
    return { columns, closed: cards.filter((c) => c.column === "closed"), spentUsd: cards.reduce((s, c) => s + c.spentUsd, 0) };
  }

  card(itemId: number): CardDetail {
    const item = this.item(itemId);
    const runs = this.repo.agentRuns(itemId);
    const modelTurns = this.repo.turns(itemId);
    const turns = this.repo.sessionTurns(itemId).map((turn) => ({
      turn,
      plan: turn.plan_json ? (JSON.parse(turn.plan_json) as Plan) : null,
      runs: runs
        .filter((r) => r.session_turn_id === turn.id)
        .map((r) => {
          const mine = modelTurns.filter((t) => t.agent_run_id === r.id);
          return { ...r, spentUsd: this.repo.runSpendUsd(r.id), modelTurns: mine.length, gates: mine.flatMap((t) => (t.gate_result ? [t.gate_result] : [])) };
        }),
    }));
    return {
      card: this.summary(item),
      item,
      turns,
      events: this.repo.itemEvents(itemId, 300),
      startBlockers: item.status === "proposed" ? this.startBlockers(item) : [],
      siblings: this.repo.items(item.batch_id).filter((i) => i.id !== itemId).map((i) => ({ id: i.id, title: i.title })),
    };
  }

  // Intake → the planner. The caller kicks the runner for the card's batch.
  start(itemId: number): Item {
    const item = this.item(itemId);
    if (item.status !== "proposed") throw new BoardError(`card ${itemId} has already started (${item.status})`);
    const blockers = this.startBlockers(item);
    if (blockers.length) throw new BoardError(blockers.join("; "));
    this.repo.updateItem(itemId, { status: "approved", run: 1 });
    this.repo.logEvent(itemId, "card.started", { batchId: item.batch_id });
    return this.item(itemId);
  }

  private startBlockers(item: Item): string[] {
    const out: string[] = [];
    if (item.target_repo === "unknown" || !this.targets().includes(item.target_repo)) out.push("pick a repo");
    if (item.question) out.push("answer the question first");
    for (const d of JSON.parse(item.depends_on) as number[]) {
      const dep = this.repo.item(d);
      if (!dep || dep.status === "dropped" || dep.status === "failed") out.push(`depends on card ${d}, which won't run`);
    }
    return out;
  }

  private summary(i: Item): CardSummary {
    const runs = this.repo.agentRuns(i.id);
    const turn = this.repo.sessionTurns(i.id).at(-1);
    const plan = turn?.plan_json ? (JSON.parse(turn.plan_json) as Plan) : null;
    const stage = stageOf(i, runs);
    return {
      id: i.id,
      batchId: i.batch_id,
      title: i.title,
      type: i.type,
      repo: i.target_repo,
      model: i.model,
      source: { kind: i.source_kind, ref: i.source_ref },
      column: columnOf(i),
      stage,
      waitingFor: stage === "queued" ? this.waitingFor(i) : null,
      sessionTurn: turn?.n ?? 0,
      spentUsd: this.repo.itemSpendUsd(i.id),
      pauseReason: i.pause_reason,
      question: i.question,
      lastVerdict: runs.filter((r) => r.role === "reviewer" && r.verdict).at(-1)?.verdict ?? null,
      lastGate: this.repo.turns(i.id).findLast((t) => t.gate_result)?.gate_result ?? null,
      activeAgents: i.status === "running" ? runs.filter((r) => r.status === "running").length : 0,
      plan: plan ? { approach: plan.approach, files: plan.files.length + plan.testFiles.length } : null,
      branch: i.branch,
      mrUrl: i.mr_url,
      mergedAt: i.merged_at,
      busy: this.inFlight?.kindOf(i.id) ?? null,
    };
  }

  private waitingFor(i: Item): string | null {
    const stageOfItem = (d: Item) => stageOf(d, this.repo.agentRuns(d.id));
    return waitReason(i, this.repo.items(i.batch_id), this.maxParallel, stageOfItem);
  }

  private item(id: number): Item {
    const found = this.repo.item(id);
    if (!found) throw new BoardError(`no card ${id}`);
    return found;
  }
}
