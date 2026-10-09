// Quick triage of the user's assigned Jira cards: list what is not yet handled, dismiss, or comment.
// "Add to board" is the existing intake flow, so it is not here.
import type { AssignedIssue, AssignedIssues } from "./ports/assigned-issues.ts";
import type { BatchRepository } from "./ports/batch-repo.ts";
import type { IssueTracker } from "./ports/issue-tracker.ts";

export interface TriageIssue extends AssignedIssue {
  onBoard: boolean;
}

const KEY = /^[A-Z][A-Z0-9_]+-\d+$/i;

export class TriageJira {
  constructor(
    private readonly source: AssignedIssues,
    private readonly tracker: IssueTracker,
    private readonly repo: BatchRepository,
  ) {}

  async list(): Promise<TriageIssue[]> {
    const assigned = await this.source.listAssigned();
    const dismissed = this.repo.dismissedJira();
    // Best-effort: a card is on the board if any item's ref or title mentions the key.
    const haystack = this.repo
      .listBatches(1000)
      .flatMap((b) => this.repo.items(b.id))
      .map((i) => `${i.source_ref} ${i.title}`.toUpperCase());
    return assigned
      .filter((a) => !dismissed.has(a.key.toUpperCase()))
      .map((a) => {
        const k = a.key.toUpperCase();
        const re = new RegExp(`(?<![A-Z0-9_-])${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?!\\d)`);
        return { ...a, onBoard: haystack.some((h) => re.test(h)) };
      });
  }

  async dismiss(key: string): Promise<{ ok: true }> {
    this.repo.dismissJira(this.validKey(key));
    return { ok: true };
  }

  async comment(key: string, body: string): Promise<{ ok: true }> {
    const k = this.validKey(key);
    if (!body.trim()) throw new Error("comment body is empty");
    await this.tracker.comment(k, body);
    return { ok: true };
  }

  private validKey(key: string): string {
    if (!KEY.test(key)) throw new Error(`not a Jira key: ${key}`);
    return key.toUpperCase();
  }
}
