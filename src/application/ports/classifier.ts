// Fills the planning board. A classifier only schedules — it never judges code.
import type { ProposedRow } from "../../domain/batch.ts";
import type { Usage } from "../../domain/usage.ts";

export interface IntakeItem {
  kind: "jira" | "text" | "image";
  ref: string; // Jira key, or a short label for pasted text
  body: string; // already normalised to text
}

export interface Classifier {
  classify(items: IntakeItem[]): Promise<{ rows: ProposedRow[]; usage: Usage }>;
}
