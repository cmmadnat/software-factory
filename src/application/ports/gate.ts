// Runs a target's build/test commands in a worktree and reports failure signatures.
import type { GateRun } from "../../domain/gate.ts";

export interface GateRunner {
  // `changed` scopes the quick gate to the tests/specs an item touched; empty = the target's default scope.
  run(target: string, worktree: string, level: "quick" | "full", changed: string[]): Promise<GateRun>;
}
