// The full gate on a candidate tree (a rebased branch for Ship, a merge result for Merge), judged against the
// full gate on the same base commit, so both actions apply the identical rule: no new failures.
import type { Item } from "../domain/batch.ts";
import { judge, type GateRun } from "../domain/gate.ts";
import type { BatchRepository } from "./ports/batch-repo.ts";
import type { EventSink } from "./ports/events.ts";
import type { GateRunner } from "./ports/gate.ts";
import type { ShipCheck, Workspace } from "./ports/workspace.ts";

export class FullGateRed extends Error {
  constructor(readonly newFailures: string[], output: string) {
    super(`full gate red — ${newFailures.length ? `new failures: ${newFailures.slice(0, 8).join(", ")}` : `the gate failed without a recognisable test failure: ${output.slice(-300)}`}`);
  }
}

export class FullGateCheck {
  constructor(
    private readonly repo: BatchRepository,
    private readonly workspace: Pick<Workspace, "snapshot">,
    private readonly gate: GateRunner,
    private readonly events: EventSink,
  ) {}

  forItem(item: Item): ShipCheck {
    return async (worktree, { baseSha, changed }) => {
      const emit = (kind: string, data: unknown) => this.events.emit({ batchId: item.batch_id, itemId: item.id, kind, data });
      emit("ship.gate", { phase: "baseline", baseSha: baseSha.slice(0, 10) });
      const baseline = await this.fullBaseline(item.target_repo, baseSha, changed);
      emit("ship.gate", { phase: "full", files: changed.length });
      const run = await this.gate.run(item.target_repo, worktree, "full", changed);
      const verdict = judge(baseline, run);
      emit(verdict.green ? "ship.gate_green" : "ship.gate_red", { newFailures: verdict.newFailures, fixed: verdict.fixed });
      if (!verdict.green) throw new FullGateRed(verdict.newFailures, run.output);
    };
  }

  // Measured once per (target, base commit, scope) in a throwaway worktree at that commit.
  private async fullBaseline(target: string, baseSha: string, changed: string[]): Promise<GateRun> {
    const key = `${target}@${baseSha}#${[...changed].sort().join(",")}`;
    const cached = this.repo.gateBaseline(key);
    if (cached) return cached;
    const snap = await this.workspace.snapshot(target, baseSha);
    try {
      const run = await this.gate.run(target, snap.worktree, "full", changed);
      this.repo.saveGateBaseline(key, run);
      return run;
    } finally {
      await snap.dispose();
    }
  }
}
