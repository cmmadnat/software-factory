// Which approved rows may start now. Pure: the runner asks this after every state change.
// Each row is a session with its own worktree, so overlapping claims never serialise rows; only dependencies do.
import type { Item } from "./batch.ts";

const deps = (i: Item): number[] => JSON.parse(i.depends_on);

const ACTIVE = new Set(["running"]);
const FINISHED = new Set(["done"]);

export function startable(items: Item[], maxParallel: number): Item[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const running = items.filter((i) => ACTIVE.has(i.status));
  const slots = maxParallel - running.length;
  if (slots <= 0) return [];

  const out: Item[] = [];
  // Board order decides precedence when slots are short.
  for (const i of [...items].sort((a, b) => a.position - b.position)) {
    if (out.length >= slots) break;
    if (i.status !== "approved" || i.run !== 1) continue;
    if (!deps(i).every((d) => FINISHED.has(byId.get(d)?.status ?? ""))) continue;
    out.push(i);
  }
  return out;
}

// Why an approved (queued) row isn't running yet; null when nothing holds it back.
export function waitReason(item: Item, items: Item[], maxParallel: number, stageOf: (i: Item) => string = (i) => i.status): string | null {
  if (item.status !== "approved") return null;
  const byId = new Map(items.map((i) => [i.id, i]));
  const open = deps(item).filter((d) => byId.get(d)?.status !== "done");
  if (open.length) return `waiting on ${open.map((d) => { const dep = byId.get(d); return dep ? `#${d} (${stageOf(dep)})` : `#${d} (missing)`; }).join(", ")}`;
  return items.filter((i) => ACTIVE.has(i.status)).length >= maxParallel ? "waiting for a free slot" : null;
}

// A batch is finished only when no row is running, queued, or waiting on Nat (planned / paused / gate_red).
const UNSETTLED = new Set(["running", "approved", "planned", "paused", "gate_red"]);
export function batchSettled(items: Item[]): boolean {
  return !items.some((i) => UNSETTLED.has(i.status));
}
