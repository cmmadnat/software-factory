// Use case: Resolve — when Merge is blocked by uncommitted changes in the main checkout, an agent works in
// that checkout and decides per change: commit it on the base branch, or stash it aside. It never discards;
// when unsure it asks Nat (the question shows on the card, his answer lands in the card's notes). Afterwards
// the checkout is re-checked here, not trusted from the agent's word. Usage of this agent is not charged to a batch.
import { BoardError } from "./edit-board.ts";
import { AlreadyRunning, InFlight } from "./in-flight.ts";
import { jsonRetry, RESOLVE_INSTRUCTIONS, resolvePrompt } from "./prompts.ts";
import type { AgentRuntime } from "./ports/agent-runtime.ts";
import type { BatchRepository } from "./ports/batch-repo.ts";
import type { EventSink } from "./ports/events.ts";
import type { BranchMerger } from "./ports/workspace.ts";
import { parseReply, ResolveSchema, type ResolveReply } from "./structured-reply.ts";

// MergeCard records `merge blocked: <reason>`; this matches the dirty-checkout reason.
export const MERGE_BLOCKED_PREFIX = "merge blocked";
export const RESOLVE_INCOMPLETE_PREFIX = "resolve incomplete";
export const blockedByUncommitted = (pauseReason: string | null): boolean =>
  !!pauseReason && pauseReason.startsWith(MERGE_BLOCKED_PREFIX) && pauseReason.includes("uncommitted changes");

export interface ResolveResult {
  itemId: number;
  resolved?: boolean;
  question?: string;
  error?: string;
}

export class ResolveCheckout {
  constructor(
    private readonly repo: BatchRepository,
    private readonly workspace: BranchMerger,
    private readonly runtime: Pick<AgentRuntime, "startAgent">,
    private readonly events: EventSink,
    private readonly hostOf: (target: string) => string,
    private readonly inFlight: InFlight,
  ) {}

  async execute(itemId: number): Promise<ResolveResult> {
    const item = this.repo.item(itemId);
    if (!item) throw new BoardError(`no card ${itemId}`);
    if (item.status !== "done" || !item.branch) throw new BoardError(`card ${itemId} is not shipped`);
    if (item.merged_at) throw new BoardError(`card ${itemId} is already merged`);
    if (item.mr_url || this.hostOf(item.target_repo) !== "local") throw new BoardError(`card ${itemId} is on a remote host: nothing to resolve here`);
    if (!blockedByUncommitted(item.pause_reason) && !item.pause_reason?.startsWith(RESOLVE_INCOMPLETE_PREFIX)) {
      throw new BoardError(`card ${itemId} is not blocked by uncommitted changes`);
    }
    try {
      this.inFlight.begin(itemId, "resolve");
    } catch (e) {
      throw e instanceof AlreadyRunning ? new BoardError(e.message) : e;
    }
    const emit = (kind: string, data: unknown) => this.events.emit({ batchId: item.batch_id, itemId, kind, data });
    let session: Awaited<ReturnType<AgentRuntime["startAgent"]>> | undefined;
    try {
      const dirty = await this.workspace.checkoutChanges(item.target_repo);
      if (!dirty.length) {
        this.repo.updateItem(itemId, { pause_reason: null });
        emit("item.resolved", { files: 0, summary: "the checkout was already clean" });
        return { itemId, resolved: true };
      }
      emit("item.resolve_started", { files: dirty.length });
      session = await this.runtime.startAgent({
        model: item.model,
        workingDirectory: this.workspace.checkoutPath(item.target_repo),
        instructions: RESOLVE_INSTRUCTIONS,
      });
      let prompt = resolvePrompt(item, item.branch, dirty);
      let parsed: ReturnType<typeof parseReply<ResolveReply>> | undefined;
      for (let attempt = 0; attempt < 2; attempt++) {
        const res = await session.send(prompt);
        if (res.outcome !== "idle") throw new Error(`the resolving agent ended with ${res.outcome}${res.error ? `: ${res.error}` : ""}`);
        parsed = parseReply(res.reply, ResolveSchema);
        if (parsed.ok) break;
        prompt = jsonRetry(parsed.error);
      }
      if (!parsed?.ok) throw new Error(`the resolving agent's reply had no valid JSON: ${parsed?.error}`);
      const { status, summary, question } = parsed.value;
      const left = await this.workspace.checkoutChanges(item.target_repo);
      if (!left.length) {
        this.repo.updateItem(itemId, { pause_reason: null, question: null });
        emit("item.resolved", { files: dirty.length, summary });
        return { itemId, resolved: true };
      }
      if (status === "question") {
        const q = question?.trim() || summary;
        this.repo.updateItem(itemId, { question: q });
        emit("item.resolved", { files: left.length, question: q });
        return { itemId, resolved: false, question: q };
      }
      this.repo.updateItem(itemId, { pause_reason: `${RESOLVE_INCOMPLETE_PREFIX}: ${summary}`.slice(0, 2000) });
      emit("item.resolve_failed", { error: "checkout still has uncommitted changes", files: left.length });
      return { itemId, resolved: false, error: `the checkout still has ${left.length} uncommitted change(s): ${summary}` };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      emit("item.resolve_failed", { error });
      return { itemId, resolved: false, error };
    } finally {
      await session?.close().catch(() => {});
      this.inFlight.end(itemId);
    }
  }
}
