import assert from "node:assert/strict";
import { test } from "node:test";
import { PlanBatch } from "../src/application/plan-batch.ts";
import type { Classifier } from "../src/application/ports/classifier.ts";
import type { ProposedRow } from "../src/domain/batch.ts";
import { zeroUsage } from "../src/domain/usage.ts";
import { MemoryBatchRepository } from "./fakes/memory-batch-repo.ts";

const row = (p: Partial<ProposedRow> & { intakeIndex: number }): ProposedRow => ({
  title: `row ${p.intakeIndex}`, type: "bug", targetRepo: "acme-app", complexity: 1, model: "haiku", lookahead: 1,
  dependsOn: [], claimedPaths: [], question: null, ...p,
});

const fixedClassifier = (rows: ProposedRow[]): Classifier => ({ classify: async () => ({ rows, usage: zeroUsage() }) });

const intake = [0, 1, 2].map((i) => ({ kind: "text" as const, ref: `paste-${i}`, body: `item ${i}` }));

test("PlanBatch persists one item per row, maps deps to item ids, and leaves vague rows unticked", async () => {
  const repo = new MemoryBatchRepository();
  // Classifier returns rows out of order; deps are intake indices.
  const plan = new PlanBatch(repo, fixedClassifier([
    row({ intakeIndex: 2, dependsOn: [0], claimedPaths: ["src/app/**"] }),
    row({ intakeIndex: 0, targetRepo: "acme-api" }),
    row({ intakeIndex: 1, targetRepo: "unknown", question: "Which page?" }),
  ]), 20);

  const out = await plan.execute("b1", intake);

  assert.equal(repo.batch("b1")!.budget_usd, 20);
  assert.deepEqual(out.items.map((i) => [i.source_ref, i.target_repo, i.run]), [
    ["paste-0", "acme-api", 1],
    ["paste-1", "unknown", 0],
    ["paste-2", "acme-app", 1],
  ]);
  const [first, , third] = out.items;
  assert.deepEqual(JSON.parse(third.depends_on), [first.id]);
  assert.deepEqual(JSON.parse(third.claimed_paths), ["src/app/**"]);
  assert.deepEqual(out.questions, [{ itemId: out.items[1].id, question: "Which page?" }]);
  assert.equal(repo.events.at(-1)?.kind, "batch.planned");
});

test("PlanBatch appends to an existing batch instead of recreating it", async () => {
  const repo = new MemoryBatchRepository();
  repo.createBatch("b1", 5);
  await new PlanBatch(repo, fixedClassifier([row({ intakeIndex: 0 })]), 20).execute("b1", intake.slice(0, 1));
  assert.equal(repo.batch("b1")!.budget_usd, 5);
  assert.equal(repo.items("b1").length, 1);
});

test("PlanBatch: an intake item split into several rows is depended on as a whole", async () => {
  const repo = new MemoryBatchRepository();
  const out = await new PlanBatch(repo, fixedClassifier([
    row({ intakeIndex: 0, targetRepo: "acme-api" }),
    row({ intakeIndex: 0, targetRepo: "acme-app" }),
    row({ intakeIndex: 1, dependsOn: [0] }),
  ]), 20).execute("b1", intake.slice(0, 2));
  const [api, app, dependent] = out.items;
  assert.deepEqual(JSON.parse(dependent.depends_on), [api.id, app.id]);
});
