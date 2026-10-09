// Use case: list target repos and add a new one. Adding is checked against the real checkout — a git repo whose
// origin has the chosen base branch, or, for a local-only target, whose local branches do — so a typo can't
// surface later as a failed batch.
import { hasRemote, targetProblems, type TargetSpec } from "../domain/target.ts";
import { BoardError } from "./edit-board.ts";
import type { RepoInspection, RepoInspector, TargetCatalog } from "./ports/targets.ts";

export class ManageTargets {
  constructor(
    private readonly catalog: TargetCatalog,
    private readonly inspector: RepoInspector,
  ) {}

  list(): TargetSpec[] {
    return this.catalog.list();
  }

  names(): string[] {
    return this.catalog.list().map((t) => t.name);
  }

  inspect(path: string): Promise<RepoInspection> {
    return this.inspector.inspect(path).catch((e) => {
      throw new BoardError(e instanceof Error ? e.message : String(e));
    });
  }

  async add(input: TargetSpec): Promise<TargetSpec> {
    const clean = (xs: string[]) => xs.map((x) => x.trim()).filter(Boolean);
    const t: TargetSpec = {
      ...input,
      name: input.name.trim(),
      repo: input.repo.trim(),
      baseBranch: input.baseBranch.trim(),
      setup: clean(input.setup),
      gate: { quick: clean(input.gate.quick), full: clean(input.gate.full) },
    };
    const problems = targetProblems(t, this.names());
    if (problems.length) throw new BoardError(problems.join("; "));
    const found = await this.inspect(t.repo);
    if (hasRemote(t)) {
      if (!found.remoteUrl) throw new BoardError(`${t.repo} has no "origin" remote: choose host "local" to work without one`);
      if (!found.branches.includes(t.baseBranch)) throw new BoardError(`origin has no branch "${t.baseBranch}" (found: ${found.branches.slice(0, 8).join(", ")})`);
    } else if (!found.localBranches.includes(t.baseBranch)) {
      throw new BoardError(`no local branch "${t.baseBranch}" (found: ${found.localBranches.slice(0, 8).join(", ") || "none — make a first commit"})`);
    }
    this.catalog.add({ ...t, repo: found.repo });
    return t;
  }
}
