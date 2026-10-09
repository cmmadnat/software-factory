// Use case: a card file's diff — the session's committed change to one file its plan names, for a quick review
// from the card panel. Only plan files are served, so the endpoint can't read arbitrary paths of a target repo.
import type { Plan } from "../domain/pipeline.ts";
import { claimsFromPlan } from "../domain/pipeline.ts";
import { BoardError } from "./edit-board.ts";
import type { BatchRepository } from "./ports/batch-repo.ts";
import type { Workspace } from "./ports/workspace.ts";

const MAX_DIFF = 40_000; // the same cap the reviewer prompt uses

export interface CardFileDiffResult {
  file: string;
  diff: string;
}

export class CardFileDiff {
  constructor(
    private readonly repo: Pick<BatchRepository, "item" | "sessionTurns">,
    private readonly workspace: Pick<Workspace, "fileDiff">,
  ) {}

  async execute(itemId: number, file: string): Promise<CardFileDiffResult> {
    const item = this.repo.item(itemId);
    if (!item) throw new BoardError(`no card ${itemId}`);
    const plan = this.repo.sessionTurns(itemId).at(-1)?.plan_json;
    const files = plan ? claimsFromPlan(JSON.parse(plan) as Plan) : [];
    if (!files.includes(file)) throw new BoardError(`${file} is not a file in card ${itemId}'s plan`);
    const diff = await this.workspace.fileDiff(itemId, item.target_repo, file);
    return { file, diff: diff.length > MAX_DIFF ? `${diff.slice(0, MAX_DIFF)}\n… (diff truncated)` : diff };
  }
}
