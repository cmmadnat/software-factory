// Use case: Merge — land a shipped local card's branch on the target's base branch in the main checkout.
// Pressed explicitly by Nat because it moves a branch in his own checkout. The workspace refuses a dirty
// checkout, one that is not on the base branch, and conflicts; the full gate runs on the merged result before
// the base moves. A refusal is shown on the card (it stays in Shipped); GitLab/GitHub cards are merged on the host.
import { BoardError } from "./edit-board.ts";
import { FullGateCheck } from "./full-gate-check.ts";
import { AlreadyRunning, InFlight } from "./in-flight.ts";
import type { BatchRepository } from "./ports/batch-repo.ts";
import type { EventSink } from "./ports/events.ts";
import type { GateRunner } from "./ports/gate.ts";
import type { BranchMerger, Workspace } from "./ports/workspace.ts";

export interface MergeResult {
  itemId: number;
  sha?: string;
  fastForward?: boolean;
  error?: string;
}

export class MergeCard {
  private readonly fullGate: FullGateCheck;

  constructor(
    private readonly repo: BatchRepository,
    private readonly workspace: Pick<Workspace, "snapshot"> & BranchMerger,
    private readonly events: EventSink,
    private readonly hostOf: (target: string) => string,
    gate: GateRunner,
    private readonly inFlight: InFlight,
  ) {
    this.fullGate = new FullGateCheck(repo, workspace, gate, events);
  }

  async execute(itemId: number): Promise<MergeResult> {
    const item = this.repo.item(itemId);
    if (!item) throw new BoardError(`no card ${itemId}`);
    if (item.status !== "done" || !item.branch) throw new BoardError(`card ${itemId} is not shipped`);
    if (item.merged_at) throw new BoardError(`card ${itemId} is already merged`);
    if (item.mr_url || this.hostOf(item.target_repo) !== "local") throw new BoardError(`card ${itemId} is on a remote host: merge its MR there`);
    try {
      this.inFlight.begin(itemId, "merge");
    } catch (e) {
      throw e instanceof AlreadyRunning ? new BoardError(e.message) : e;
    }
    const emit = (kind: string, data: unknown) => this.events.emit({ batchId: item.batch_id, itemId, kind, data });
    emit("item.merge_started", { branch: item.branch });
    try {
      const { sha, fastForward } = await this.workspace.mergeBranch(item.target_repo, item.branch, this.fullGate.forItem(item));
      this.repo.updateItem(itemId, { merged_at: new Date().toISOString(), pause_reason: null });
      emit("item.merged", { branch: item.branch, sha, fastForward });
      return { itemId, sha, fastForward };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      this.repo.updateItem(itemId, { pause_reason: `merge blocked: ${error}`.slice(0, 2000) });
      emit("item.merge_failed", { branch: item.branch, error });
      return { itemId, error };
    } finally {
      this.inFlight.end(itemId);
    }
  }
}
