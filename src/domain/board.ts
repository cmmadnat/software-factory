// Where a session's card sits on the kanban, and what it is doing there. Pure: derived from the row's status
// and its open agent run, never stored.
import type { AgentRun, Item, Role } from "./batch.ts";

export type Column = "intake" | "plan" | "running" | "review" | "shipped" | "merged" | "closed";
export const COLUMNS: Column[] = ["intake", "plan", "running", "review", "shipped", "merged"];

export type Stage = "draft" | "awaiting plan approval" | "queued" | "planning" | "coding" | "testing" | "reviewing" | "needs you" | "ready to review" | "shipped" | "merged" | "killed" | "dropped";

const DOING: Record<Role, Stage> = { planner: "planning", coder: "coding", tester: "testing", reviewer: "reviewing" };

export function columnOf(item: Pick<Item, "status" | "branch"> & { merged_at?: string | null }): Column {
  switch (item.status) {
    case "proposed": return "intake";
    case "planned": return "plan";
    case "approved": case "running": case "paused": case "gate_red": return "running";
    case "done": return item.merged_at ? "merged" : item.branch ? "shipped" : "review";
    case "failed": case "dropped": return "closed";
  }
}

export function stageOf(item: Pick<Item, "status" | "branch"> & { merged_at?: string | null }, runs: Pick<AgentRun, "role" | "status">[]): Stage {
  switch (item.status) {
    case "proposed": return "draft";
    case "planned": return "awaiting plan approval";
    case "paused": case "gate_red": return "needs you";
    case "done": return item.merged_at ? "merged" : item.branch ? "shipped" : "ready to review";
    case "failed": return "killed";
    case "dropped": return "dropped";
    case "approved": case "running": {
      const active = runs.find((r) => r.status === "running");
      return active ? DOING[active.role] : "queued";
    }
  }
}
