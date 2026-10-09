// EventSink + EventStream in one process: every event is persisted (the per-turn log) and pushed to live
// subscribers (the page's SSE connection).
import type { BatchRepository } from "../../application/ports/batch-repo.ts";
import type { EventSink, EventStream, RunEvent } from "../../application/ports/events.ts";

export class EventBus implements EventSink, EventStream {
  private listeners = new Map<string, Set<(e: RunEvent) => void>>();

  constructor(private readonly repo: Pick<BatchRepository, "logEvent">) {}

  emit(e: Omit<RunEvent, "ts">): void {
    const event: RunEvent = { ...e, ts: new Date().toISOString() };
    this.repo.logEvent(e.itemId, e.kind, { batchId: e.batchId, ...(e.data as object) });
    for (const key of [e.batchId, "*"]) for (const l of this.listeners.get(key) ?? []) l(event);
  }

  // batchId "*" receives every batch's events (the kanban shows all sessions).
  subscribe(batchId: string, listener: (e: RunEvent) => void): () => void {
    const set = this.listeners.get(batchId) ?? new Set();
    set.add(listener);
    this.listeners.set(batchId, set);
    return () => set.delete(listener);
  }
}
