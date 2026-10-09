// Classifier as one structured-output call. Jev or Laya can replace it behind the same port.
import { z } from "zod";
import type { AgentRuntime } from "../../application/ports/agent-runtime.ts";
import type { Classifier, IntakeItem } from "../../application/ports/classifier.ts";
import type { ProposedRow } from "../../domain/batch.ts";
import { lookaheadFor, modelFor, type ModelPolicy } from "../../domain/routing.ts";
import type { Usage } from "../../domain/usage.ts";

// The Claude backend rejects minimum/maximum in schemas (zod .int() emits them too), so bounded
// numbers are enums and integers are plain numbers rounded after parsing.
const rowSchema = (targets: string[]) =>
  z.object({
    rows: z.array(
      z.object({
        intakeIndex: z.number(),
        title: z.string().describe("imperative, under 70 chars"),
        type: z.enum(["bug", "feature", "refactor", "spike"]),
        targetRepo: z.enum(["unknown", ...targets] as [string, ...string[]]),
        complexity: z.enum(["1", "2", "3", "4", "5"]).describe("1 = one-line fix, 5 = multi-module change"),
        dependsOn: z.array(z.number()).describe("intakeIndex values that must land first"),
        claimedPaths: z.array(z.string()).describe("repo-relative globs this item will likely edit; empty if unknown"),
        question: z.string().nullable().describe("one question for Nat if the item is too vague to start, else null"),
      }),
    ),
  });

export class StructuredClassifier implements Classifier {
  constructor(
    private readonly runtime: AgentRuntime,
    private readonly targets: () => string[], // live: repos can be added while the app runs
    private readonly models: ModelPolicy,
    private readonly classifierModel = models.small,
  ) {}

  async classify(items: IntakeItem[]): Promise<{ rows: ProposedRow[]; usage: Usage }> {
    const prompt = [
      "Classify each intake item into one planning-board row for a coding agent.",
      `Known target repos: ${this.targets().join(", ")}. Use "unknown" if none fits.`,
      "An @name token in an item names its target repo; use it when name is a known repo.",
      "Only schedule; do not solve the task. Return one row per item, in order.",
      "",
      ...items.map((it, i) => `--- intakeIndex ${i} (${it.kind} ${it.ref}) ---\n${it.body}`),
    ].join("\n");

    const { value, usage } = await this.runtime.structured(prompt, rowSchema(this.targets()), this.classifierModel);
    const rows = value.rows
      .map((r) => ({ ...r, intakeIndex: Math.round(r.intakeIndex), dependsOn: r.dependsOn.map(Math.round) }))
      .filter((r) => r.intakeIndex >= 0 && r.intakeIndex < items.length)
      .map((r): ProposedRow => {
        const complexity = Number(r.complexity);
        return {
          intakeIndex: r.intakeIndex,
          title: r.title,
          type: r.type,
          targetRepo: r.targetRepo,
          complexity,
          model: modelFor(complexity, this.models),
          lookahead: lookaheadFor(complexity),
          dependsOn: r.dependsOn.filter((d) => d >= 0 && d < r.intakeIndex),
          claimedPaths: r.claimedPaths,
          question: r.question || null,
        };
      });
    return { rows, usage };
  }
}
