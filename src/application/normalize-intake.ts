// Use case: raw pastes → text intake items. Jira keys are fetched (with comments and image attachments
// described by vision); pasted screenshots are described by vision. A failure on one entry never sinks the rest.
import { isImageMime, MAX_IMAGE_BYTES, MAX_IMAGES_PER_ISSUE, type RawEntry } from "../domain/intake.ts";
import { addUsage, zeroUsage, type Usage } from "../domain/usage.ts";
import type { IntakeItem } from "./ports/classifier.ts";
import type { AttachmentSource, Issue, IssueTracker } from "./ports/issue-tracker.ts";
import type { Vision } from "./ports/vision.ts";

export interface NormalizedIntake {
  items: IntakeItem[];
  // Non-fatal problems to show on the intake screen (e.g. "attachment download needs ATLASSIAN_API_TOKEN").
  warnings: string[];
  usage: Usage;
}

export class NormalizeIntake {
  constructor(
    private readonly tracker: IssueTracker,
    private readonly vision: Vision,
    private readonly attachments: AttachmentSource | null,
  ) {}

  async execute(entries: RawEntry[]): Promise<NormalizedIntake> {
    // Entries are independent (a Jira fetch takes ~30 s), so normalise them concurrently, then merge in paste order.
    let pasted = 0;
    const labelled = entries.map((e) => ({ e, ref: e.kind === "jira" ? e.key : e.kind === "image" ? (e.name ?? `screenshot-${++pasted}`) : `paste-${++pasted}` }));
    const parts = await Promise.all(labelled.map(({ e, ref }) => this.one(e, ref)));
    const out: NormalizedIntake = { items: [], warnings: [], usage: zeroUsage() };
    for (const p of parts) {
      if (p.item) out.items.push(p.item);
      out.warnings.push(...p.warnings);
      out.usage = addUsage(out.usage, p.usage);
    }
    return out;
  }

  private async one(e: RawEntry, ref: string): Promise<NormalizedIntake & { item?: IntakeItem }> {
    const out: NormalizedIntake & { item?: IntakeItem } = { items: [], warnings: [], usage: zeroUsage() };
    try {
      if (e.kind === "text") {
        out.item = { kind: "text", ref, body: e.text };
      } else if (e.kind === "image") {
        const v = await this.vision.describe(e, "A screenshot pasted as a work item for a software team.");
        out.usage = v.usage;
        out.item = { kind: "image", ref, body: `Screenshot ${ref}: ${v.text}` };
      } else {
        const issue = await this.tracker.getIssue(e.key);
        const described = await this.describeAttachments(issue, out);
        out.item = { kind: "jira", ref: issue.key, body: renderIssue(issue, described) };
      }
    } catch (err) {
      out.warnings.push(`${ref}: ${e.kind === "jira" ? "could not fetch" : "vision failed"} (${String(err)})`);
    }
    return out;
  }

  private async describeAttachments(issue: Issue, out: NormalizedIntake): Promise<Map<string, string>> {
    const described = new Map<string, string>();
    const images = issue.attachments.filter((a) => isImageMime(a.mimeType) && (a.size ?? 0) <= MAX_IMAGE_BYTES);
    if (!images.length) return described;
    if (!this.attachments) {
      out.warnings.push(`${issue.key}: ${images.length} image attachment(s) not read — set ATLASSIAN_EMAIL and ATLASSIAN_API_TOKEN`);
      return described;
    }
    for (const a of images.slice(0, MAX_IMAGES_PER_ISSUE)) {
      try {
        const img = await this.attachments.download(a);
        const v = await this.vision.describe(img, `Attachment "${a.filename}" on Jira ${issue.key}: ${issue.summary}`);
        out.usage = addUsage(out.usage, v.usage);
        described.set(a.id, v.text);
      } catch (err) {
        out.warnings.push(`${issue.key}/${a.filename}: ${String(err)}`);
      }
    }
    if (images.length > MAX_IMAGES_PER_ISSUE) out.warnings.push(`${issue.key}: only the first ${MAX_IMAGES_PER_ISSUE} of ${images.length} images were read`);
    return described;
  }
}

export function renderIssue(issue: Issue, described: Map<string, string> = new Map()): string {
  const lines = [`${issue.key} — ${issue.summary} [${issue.status}]`, "", issue.description.trim()];
  if (issue.comments.length) {
    lines.push("", "Comments:");
    for (const c of issue.comments) lines.push(`- ${c.author}: ${c.body.trim()}`);
  }
  if (issue.attachments.length) {
    lines.push("", "Attachments:");
    for (const a of issue.attachments) {
      const d = described.get(a.id);
      lines.push(`- ${a.filename}${d ? ` — ${d}` : ""}`);
    }
  }
  return lines.join("\n");
}
