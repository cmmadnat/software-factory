// Live run events: persisted for the per-turn log and pushed to whoever is watching (the web page over SSE).

export interface RunEvent {
  batchId: string;
  itemId: number | null;
  kind: string; // e.g. item.started, turn.ended, gate.red, item.paused, item.done, batch.settled
  data: unknown;
  ts: string;
}

export interface EventSink {
  emit(e: Omit<RunEvent, "ts">): void;
}

export interface EventStream {
  subscribe(batchId: string, listener: (e: RunEvent) => void): () => void;
}
