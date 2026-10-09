import assert from "node:assert/strict";
import { test } from "node:test";
import { BoardError, EditBoard } from "../src/application/edit-board.ts";
import { claimsOverlap, globsOverlap, overlappingPairs } from "../src/domain/path-claims.ts";
import type { NewItem } from "../src/domain/batch.ts";
import { MemoryBatchRepository } from "./fakes/memory-batch-repo.ts";
import { MODELS, resolveModels } from "../src/main.ts";

const runtimeWith = (models: () => Promise<string[]>) => ({ models });

test("resolveModels: live list feeds the validator, drops auto, keeps policy models", async () => {
  const models = await resolveModels(runtimeWith(async () => ["auto", "gpt-6.1-sol", "kimi-k3", "gpt-6.1-sol"]), MODELS);
  assert.deepEqual(models, [MODELS.small, MODELS.large, "gpt-6.1-sol", "kimi-k3"]);
  const { ed, a } = (() => {
    const repo = new MemoryBatchRepository();
    repo.createBatch("m", 20);
    const a = repo.addItem({
      batch_id: "m", source_kind: "text", source_ref: "p", title: "t", type: "bug", target_repo: "acme-api", role: "coder",
      model: MODELS.small, complexity: 1, depends_on: "[]", claimed_paths: "[]",
    });
    return { ed: new EditBoard(repo, () => ["acme-api"], models), a };
  })();
  ed.edit(a, { model: "gpt-6.1-sol" });
  assert.throws(() => ed.edit(a, { model: "not-a-model" }), BoardError);
});

test("resolveModels falls back to [small, large] on empty list or error", async () => {
  assert.deepEqual(await resolveModels(runtimeWith(async () => []), MODELS), [MODELS.small, MODELS.large]);
  assert.deepEqual(await resolveModels(runtimeWith(async () => { throw new Error("down"); }), MODELS), [MODELS.small, MODELS.large]);
});

test("resolveModels always includes policy models without duplicates", async () => {
  const models = await resolveModels(runtimeWith(async () => ["gpt-6-luna", MODELS.large]), MODELS);
  assert.deepEqual(models, [MODELS.small, MODELS.large, "gpt-6-luna"]);
});

test("resolveModels keeps the policy small model when the live list omits it; validator uses that list", async () => {
  const models = await resolveModels(runtimeWith(async () => ["grok-4.7", "auto"]), MODELS);
  assert.deepEqual(models, [MODELS.small, MODELS.large, "grok-4.7"]);
  const repo = new MemoryBatchRepository();
  repo.createBatch("m", 20);
  const a = repo.addItem({
    batch_id: "m", source_kind: "text", source_ref: "p", title: "t", type: "bug", target_repo: "acme-api", role: "coder",
    model: MODELS.small, complexity: 1, depends_on: "[]", claimed_paths: "[]",
  });
  const ed = new EditBoard(repo, () => ["acme-api"], models);
  ed.edit(a, { model: MODELS.small });
  ed.edit(a, { model: "grok-4.7" });
  assert.throws(() => ed.edit(a, { model: "auto" }), BoardError);
});

test("globsOverlap compares literal prefixes, conservatively", () => {
  assert.equal(globsOverlap("src/app/supplier/**", "src/app/supplier/list.ts"), true);
  assert.equal(globsOverlap("src/app/**", "src/app/supplier/*.ts"), true);
  assert.equal(globsOverlap("src/app/supplier/**", "src/app/buyer/**"), false);
  assert.equal(globsOverlap("./src/a.ts", "src/a.ts"), true);
});

test("claimsOverlap: different repos never overlap; unknown claims overlap their whole repo", () => {
  assert.equal(claimsOverlap({ id: 1, repo: "api", paths: ["x/**"] }, { id: 2, repo: "app", paths: ["x/**"] }), false);
  assert.equal(claimsOverlap({ id: 1, repo: "app", paths: [] }, { id: 2, repo: "app", paths: ["y/**"] }), true);
  assert.deepEqual(overlappingPairs([
    { id: 1, repo: "app", paths: ["src/a/**"] }, { id: 2, repo: "app", paths: ["src/b/**"] }, { id: 3, repo: "app", paths: ["src/a/x.ts"] },
  ]), [[1, 3]]);
});

function board() {
  const repo = new MemoryBatchRepository();
  repo.createBatch("b", 20);
  const base: NewItem = {
    batch_id: "b", source_kind: "text", source_ref: "p", title: "t", type: "bug", target_repo: "acme-app", role: "coder",
    model: "haiku", complexity: 1, depends_on: "[]", claimed_paths: '["src/app/supplier/**"]',
  };
  const a = repo.addItem(base);
  const b = repo.addItem({ ...base, claimed_paths: '["src/app/supplier/list.ts"]', depends_on: JSON.stringify([a]) });
  const q = repo.addItem({ ...base, target_repo: "unknown", question: "Which page?", run: 0 });
  return { repo, ed: new EditBoard(repo, () => ["acme-api", "acme-app"], ["haiku", "sonnet"]), a, b, q };
}

test("view reports overlapping runnable rows and no blockers when the board is clean", () => {
  const { ed, a, b } = board();
  const v = ed.view("b");
  assert.deepEqual(v.overlaps, [[a, b]]);
  assert.deepEqual(v.blockers, []);
});

test("edits are validated; bad cells are refused with a reason", () => {
  const { ed, repo, a, b } = board();
  ed.edit(a, { title: "  New title ", model: "sonnet", claimed_paths: [" src/x/** ", ""] });
  assert.deepEqual([repo.item(a)!.title, repo.item(a)!.model, repo.item(a)!.claimed_paths], ["New title", "sonnet", '["src/x/**"]']);
  assert.throws(() => ed.edit(a, { target_repo: "nope" }), BoardError);
  assert.throws(() => ed.edit(a, { model: "gpt" }), /unknown model/);
  assert.throws(() => ed.edit(a, { depends_on: [a] }), /itself/);
  assert.throws(() => ed.edit(b, { depends_on: [999] }), /not in this batch/);
  assert.throws(() => ed.edit(a, { title: " " }), /empty/);
});

test("a ticked question row blocks approve until answered and given a repo", () => {
  const { ed, repo, q } = board();
  ed.edit(q, { run: true });
  assert.deepEqual(ed.view("b").blockers, [`row ${q}: pick a repo`, `row ${q}: answer the question first`]);
  assert.throws(() => ed.approve("b"), /pick a repo/);
  ed.answer(q, "The supplier list page");
  ed.edit(q, { target_repo: "acme-app" });
  assert.equal(repo.item(q)!.question, null);
  assert.equal(repo.item(q)!.notes, "Q: Which page?\nA: The supplier list page");
  assert.deepEqual(ed.view("b").blockers, []);
});

test("dropping a dependency blocks its dependant; approve marks runnable rows approved once", () => {
  const { ed, repo, a, b } = board();
  ed.drop(a);
  assert.deepEqual(ed.view("b").blockers, [`row ${b}: depends on row ${a}, which won't run`]);
  ed.edit(b, { depends_on: [] });
  const v = ed.approve("b");
  assert.equal(v.batch.status, "approved");
  assert.deepEqual(v.items.map((i) => i.status), ["dropped", "approved", "proposed"]);
  assert.throws(() => ed.approve("b"), /already approved/);
  assert.equal(repo.events.at(-1)?.kind, "board.approved");
});

test("a planned row can be dropped: status dropped, run 0, logged; approve ignores it", () => {
  const { ed, repo, a, b } = board();
  repo.updateItem(a, { status: "planned" });
  ed.drop(a);
  const dropped = repo.item(a)!;
  assert.equal(dropped.status, "dropped");
  assert.equal(dropped.run, 0);
  assert.equal(repo.events.at(-1)?.kind, "board.drop");
  ed.edit(b, { depends_on: [] });
  assert.deepEqual(ed.approve("b").items.map((i) => i.status), ["dropped", "approved", "proposed"]);
});

test("reorder must name every row exactly once", () => {
  const { ed, repo, a, b, q } = board();
  ed.reorder("b", [q, a, b]);
  assert.deepEqual(repo.items("b").map((i) => i.id), [q, a, b]);
  assert.throws(() => ed.reorder("b", [a, b]), /exactly once/);
});
