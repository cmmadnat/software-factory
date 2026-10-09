// Use case: intake → classifier → board rows persisted as proposed items.
import type { Item } from "../domain/batch.ts";
import type { Usage } from "../domain/usage.ts";
import type { BatchRepository } from "./ports/batch-repo.ts";
import type { Classifier, IntakeItem } from "./ports/classifier.ts";

export interface PlannedBatch {
  items: Item[];
  questions: { itemId: number; question: string }[];
  usage: Usage;
}

export class PlanBatch {
  constructor(
    private readonly repo: BatchRepository,
    private readonly classifier: Classifier,
    private readonly budgetUsd: number,
  ) {}

  async execute(batchId: string, intake: IntakeItem[]): Promise<PlannedBatch> {
    if (!this.repo.batch(batchId)) this.repo.createBatch(batchId, this.budgetUsd);
    const { rows, usage } = await this.classifier.classify(intake);

    // Insert in intake order so dependsOn (intake indices) can be mapped to item ids. One intake item may
    // split into several rows (e.g. an api row and an app row), so an index maps to every row it produced.
    const idsByIntake = new Map<number, number[]>();
    const rowIds: number[] = [];
    const questions: PlannedBatch["questions"] = [];
    const ordered = [...rows].sort((a, b) => a.intakeIndex - b.intakeIndex);
    for (const r of ordered) {
      const source = intake[r.intakeIndex];
      // A row the classifier couldn't place starts unticked: it waits for Nat's answer, it isn't refused.
      const blocked = r.question !== null || r.targetRepo === "unknown";
      const id = this.repo.addItem({
        batch_id: batchId,
        source_kind: source.kind,
        source_ref: source.ref,
        title: r.title,
        type: r.type,
        target_repo: r.targetRepo,
        role: "coder",
        model: r.model,
        complexity: r.complexity,
        depends_on: "[]",
        claimed_paths: JSON.stringify(r.claimedPaths),
        question: r.question,
        brief: source.body,
        run: blocked ? 0 : 1,
      });
      idsByIntake.set(r.intakeIndex, [...(idsByIntake.get(r.intakeIndex) ?? []), id]);
      rowIds.push(id);
      if (r.question) questions.push({ itemId: id, question: r.question });
    }
    ordered.forEach((r, i) => {
      const deps = r.dependsOn.flatMap((d) => idsByIntake.get(d) ?? []);
      if (deps.length) this.repo.updateItem(rowIds[i], { depends_on: JSON.stringify(deps) });
    });
    this.repo.logEvent(null, "batch.planned", { batchId, items: rows.length, questions: questions.length, usage });
    return { items: this.repo.items(batchId), questions, usage };
  }
}
