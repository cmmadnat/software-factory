// Use case: the planning board — the interactive checkpoint. Nat can override any cell; approving is refused
// while a ticked row still can't run, and the reasons are shown rather than guessed around.
import type { Batch, Item, ItemType } from "../domain/batch.ts";
import { overlappingPairs } from "../domain/path-claims.ts";
import type { BatchRepository } from "./ports/batch-repo.ts";

export interface BoardView {
  batch: Batch;
  items: Item[];
  overlaps: [number, number][]; // runnable rows that would edit the same files (their MRs may conflict)
  stats: Record<number, { spentUsd: number; turns: number; lastGate: "green" | "red" | null }>;
  blockers: string[]; // why Approve is disabled; empty = approvable
}

export interface CellEdit {
  title?: string;
  type?: ItemType;
  target_repo?: string;
  model?: string;
  run?: boolean;
  depends_on?: number[];
  claimed_paths?: string[];
}

const TYPES: ItemType[] = ["bug", "feature", "refactor", "spike"];
const parseIds = (json: string): number[] => JSON.parse(json) as number[];

export class BoardError extends Error {}

export class EditBoard {
  constructor(
    private readonly repo: BatchRepository,
    private readonly targets: () => string[], // live: repos can be added while the app runs
    private readonly models: string[],
  ) {}

  view(batchId: string): BoardView {
    const batch = this.repo.batch(batchId);
    if (!batch) throw new BoardError(`no batch ${batchId}`);
    const items = this.repo.items(batchId);
    const live = items.filter((i) => i.status !== "dropped" && i.run === 1);
    const overlaps = overlappingPairs(live.map((i) => ({ id: i.id, repo: i.target_repo, paths: JSON.parse(i.claimed_paths) })));
    const stats: BoardView["stats"] = {};
    for (const i of items) {
      const turns = this.repo.turns(i.id);
      stats[i.id] = { spentUsd: this.repo.itemSpendUsd(i.id), turns: turns.length, lastGate: turns.findLast((t) => t.gate_result)?.gate_result ?? null };
    }
    return { batch, items, overlaps, stats, blockers: this.blockers(items) };
  }

  edit(itemId: number, edit: CellEdit): void {
    const item = this.item(itemId);
    if (edit.title !== undefined && !edit.title.trim()) throw new BoardError("title can't be empty");
    if (edit.type !== undefined && !TYPES.includes(edit.type)) throw new BoardError(`unknown type ${edit.type}`);
    if (edit.target_repo !== undefined && edit.target_repo !== "unknown" && !this.targets().includes(edit.target_repo))
      throw new BoardError(`unknown repo ${edit.target_repo}`);
    if (edit.model !== undefined && !this.models.includes(edit.model)) throw new BoardError(`unknown model ${edit.model}`);
    if (edit.depends_on?.includes(itemId)) throw new BoardError("a row can't depend on itself");
    const siblings = new Set(this.repo.items(item.batch_id).map((i) => i.id));
    for (const d of edit.depends_on ?? []) if (!siblings.has(d)) throw new BoardError(`row ${d} is not in this batch`);
    this.repo.updateItem(itemId, {
      ...(edit.title !== undefined && { title: edit.title.trim() }),
      ...(edit.type !== undefined && { type: edit.type }),
      ...(edit.target_repo !== undefined && { target_repo: edit.target_repo }),
      ...(edit.model !== undefined && { model: edit.model }),
      ...(edit.run !== undefined && { run: edit.run ? 1 : 0 }),
      ...(edit.depends_on !== undefined && { depends_on: JSON.stringify(edit.depends_on) }),
      ...(edit.claimed_paths !== undefined && { claimed_paths: JSON.stringify(edit.claimed_paths.map((p) => p.trim()).filter(Boolean)) }),
    });
    this.repo.logEvent(itemId, "board.edit", edit);
  }

  // The answer travels to the agent with the task; it clears the question so the row can be ticked.
  answer(itemId: number, answer: string): void {
    const item = this.item(itemId);
    if (!answer.trim()) throw new BoardError("answer can't be empty");
    const note = item.question ? `Q: ${item.question}\nA: ${answer.trim()}` : answer.trim();
    this.repo.updateItem(itemId, { notes: [item.notes, note].filter(Boolean).join("\n\n"), question: null });
    this.repo.logEvent(itemId, "board.answer", { answer });
  }

  drop(itemId: number): void {
    this.item(itemId);
    this.repo.updateItem(itemId, { status: "dropped", run: 0 });
    this.repo.logEvent(itemId, "board.drop");
  }

  reorder(batchId: string, ids: number[]): void {
    const current = this.repo.items(batchId).map((i) => i.id);
    if (ids.length !== current.length || !current.every((id) => ids.includes(id)))
      throw new BoardError("reorder must list every row of the batch exactly once");
    ids.forEach((id, position) => this.repo.updateItem(id, { position }));
  }

  approve(batchId: string): BoardView {
    const view = this.view(batchId);
    if (view.batch.status !== "planning") throw new BoardError(`batch is already ${view.batch.status}`);
    if (view.blockers.length) throw new BoardError(view.blockers.join("; "));
    for (const i of view.items) if (i.run === 1 && i.status === "proposed") this.repo.updateItem(i.id, { status: "approved" });
    this.repo.updateBatch(batchId, { status: "approved" });
    this.repo.logEvent(null, "board.approved", { batchId, rows: view.items.filter((i) => i.run === 1).map((i) => i.id) });
    return this.view(batchId);
  }

  private blockers(items: Item[]): string[] {
    const runnable = items.filter((i) => i.run === 1 && i.status !== "dropped");
    const out: string[] = [];
    if (!runnable.length) out.push("no rows are ticked to run");
    const runIds = new Set(runnable.map((i) => i.id));
    for (const i of runnable) {
      if (i.target_repo === "unknown") out.push(`row ${i.id}: pick a repo`);
      if (i.question) out.push(`row ${i.id}: answer the question first`);
      for (const d of parseIds(i.depends_on)) if (!runIds.has(d)) out.push(`row ${i.id}: depends on row ${d}, which won't run`);
    }
    return out;
  }

  private item(id: number): Item {
    const found = this.repo.item(id);
    if (!found) throw new BoardError(`no row ${id}`);
    return found;
  }
}
