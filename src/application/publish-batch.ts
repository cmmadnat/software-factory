// Use case: Ship — one branch and MR per finished card. Pressed explicitly by Nat because it pushes and opens
// MRs on a real host. Before anything is pushed, the card's commits are replayed onto the freshly fetched base
// and the target's FULL gate must show no new failures against the same base commit; a red full gate or a
// conflict blocks the ship and is shown on the card. Never merges, never transitions a Jira card.
import { branchName, stackFor } from "../domain/branch.ts";
import type { Item } from "../domain/batch.ts";
import type { BatchRepository } from "./ports/batch-repo.ts";
import type { EventSink } from "./ports/events.ts";
import type { IssueTracker } from "./ports/issue-tracker.ts";
import type { MergeRequestHost } from "./ports/merge-request-host.ts";
import type { GateRunner } from "./ports/gate.ts";
import type { Workspace } from "./ports/workspace.ts";
import { FullGateCheck } from "./full-gate-check.ts";
import { AlreadyRunning, InFlight } from "./in-flight.ts";

export { FullGateRed } from "./full-gate-check.ts";

export interface PublishResult {
  itemId: number;
  branch?: string;
  mrUrl?: string; // absent for local-only targets: the branch exists locally, nothing was pushed
  error?: string;
  warning?: string; // e.g. the Jira comment failed but the MR is open
}

export class PublishBatch {
  constructor(
    private readonly repo: BatchRepository,
    private readonly workspace: Workspace,
    private readonly host: MergeRequestHost,
    private readonly tracker: Pick<IssueTracker, "comment">,
    private readonly events: EventSink,
    private readonly baseBranchOf: (target: string) => string,
    gate: GateRunner,
    private readonly inFlight: InFlight = new InFlight(),
  ) {
    this.fullGate = new FullGateCheck(repo, workspace, gate, events);
  }

  private readonly fullGate: FullGateCheck;

  // Publish every finished, unpublished row of the batch — or only the given rows (Ship on one card).
  async execute(batchId: string, only?: number[]): Promise<PublishResult[]> {
    const items = this.repo.items(batchId);
    const taken = new Set(items.map((i) => i.branch).filter((b): b is string => !!b));
    const results: PublishResult[] = [];
    for (const item of items.filter((i) => i.status === "done" && !i.branch && (!only || only.includes(i.id)))) {
      // The name follows Nat's own convention, so it may already exist in his repo or on origin: take a free one.
      const existing = await this.workspace.branchesLike(item.target_repo, branchName(item));
      const branch = branchName(item, new Set([...taken, ...existing]));
      taken.add(branch);
      // Only same-repo dependencies are in this branch: the session worktree was cut from their branch.
      const stack = stackFor(item, items).filter((s) => s.target_repo === item.target_repo);
      try {
        this.inFlight.begin(item.id, "ship");
      } catch (e) {
        // Another Ship or Merge is running for this card: report it, leave the card's own state alone.
        if (!(e instanceof AlreadyRunning)) throw e;
        results.push({ itemId: item.id, error: e.message });
        continue;
      }
      this.events.emit({ batchId, itemId: item.id, kind: "item.ship_started", data: { branch } });
      try {
        const { pushed } = await this.workspace.publishBranch(item.id, item.target_repo, branch, this.fullGate.forItem(item));
        if (!pushed) {
          this.repo.updateItem(item.id, { branch, pause_reason: null });
          const result: PublishResult = { itemId: item.id, branch };
          if (item.source_kind === "jira") result.warning = await this.commentOrWarn(item.source_ref, `Local branch ready: ${branch} (${item.target_repo}, not pushed) — ${item.title}`);
          results.push(result);
          this.events.emit({ batchId, itemId: item.id, kind: "item.published", data: result });
          continue;
        }
        const mrUrl = await this.host.open({
          target: item.target_repo,
          sourceBranch: branch,
          targetBranch: this.baseBranchOf(item.target_repo),
          title: item.source_kind === "jira" ? `${item.source_ref}: ${item.title}` : item.title,
          description: this.describe(item, stack),
        });
        this.repo.updateItem(item.id, { branch, mr_url: mrUrl, pause_reason: null });
        const result: PublishResult = { itemId: item.id, branch, mrUrl };
        if (item.source_kind === "jira") result.warning = await this.commentOrWarn(item.source_ref, `MR: ${mrUrl} — ${item.title}`);
        results.push(result);
        this.events.emit({ batchId, itemId: item.id, kind: "item.published", data: result });
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        // The card stays in Review with the reason, so Nat can comment (another turn) or ship again later.
        this.repo.updateItem(item.id, { pause_reason: `ship blocked: ${error}`.slice(0, 2000) });
        results.push({ itemId: item.id, branch, error });
        this.events.emit({ batchId, itemId: item.id, kind: "item.publish_failed", data: { branch, error } });
      } finally {
        this.inFlight.end(item.id);
      }
    }
    return results;
  }

  private async commentOrWarn(key: string, body: string): Promise<string | undefined> {
    try {
      await this.tracker.comment(key, body);
      return undefined;
    } catch (e) {
      return `published, but the Jira comment failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  private describe(item: Item, stack: Item[]): string {
    const turns = this.repo.turns(item.id);
    return [
      `${item.type} · from ${item.source_kind} ${item.source_ref}`,
      "",
      item.brief.slice(0, 2000),
      ...(item.notes ? ["", "Notes:", item.notes] : []),
      ...(stack.length
        ? ["", `Includes the changes of row(s) ${stack.map((s) => `#${s.id} ${s.title}${s.mr_url ? ` (${s.mr_url})` : ""}`).join("; ")} — merge those first.`]
        : []),
      "",
      `Full gate: no new failures against ${this.baseBranchOf(item.target_repo)}. ${this.repo.sessionTurns(item.id).length} session turn(s), ${turns.length} agent turn(s), $${this.repo.itemSpendUsd(item.id).toFixed(2)}; planned, coded, tested and reviewed by agents.`,
      "",
      "🤖 Opened by software-factory. Review and merge are yours.",
    ].join("\n");
  }
}
