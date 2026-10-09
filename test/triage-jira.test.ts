import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssignedIssues } from "../src/application/ports/assigned-issues.ts";
import type { IssueTracker } from "../src/application/ports/issue-tracker.ts";
import { TriageJira } from "../src/application/triage-jira.ts";
import { MemoryBatchRepository } from "./fakes/memory-batch-repo.ts";

const setup = () => {
  const repo = new MemoryBatchRepository();
  repo.createBatch("b", 20);
  repo.addItem({
    batch_id: "b", source_kind: "jira", source_ref: "ACME-2", title: "t", type: "bug", target_repo: "r",
    role: "coder", model: "m", complexity: 1, depends_on: "[]", claimed_paths: "[]",
  });
  const comments: [string, string][] = [];
  const source: AssignedIssues = {
    listAssigned: async () => [
      { key: "ACME-1", summary: "a", status: "To Do" },
      { key: "ACME-2", summary: "b", status: "To Do" },
      { key: "ACME-3", summary: "c", status: "To Do" },
    ],
  };
  const tracker = { comment: async (k: string, b: string) => void comments.push([k, b]) } as IssueTracker;
  return { repo, comments, triage: new TriageJira(source, tracker, repo) };
};

test("list hides dismissed keys and flags cards already on the board", async () => {
  const { triage } = setup();
  await triage.dismiss("ACME-3");
  const l = await triage.list();
  assert.deepEqual(l.map((i) => [i.key, i.onBoard]), [["ACME-1", false], ["ACME-2", true]]);
});

test("dismiss persists", async () => {
  const { triage, repo } = setup();
  assert.deepEqual(await triage.dismiss("acme-1"), { ok: true });
  assert.ok(repo.dismissedJira().has("ACME-1"));
});

test("comment validates input and calls the tracker once", async () => {
  const { triage, comments } = setup();
  await assert.rejects(triage.comment("nope", "hi"));
  await assert.rejects(triage.comment("ACME-1", "  "));
  assert.equal(comments.length, 0);
  assert.deepEqual(await triage.comment("ACME-1", "hi"), { ok: true });
  assert.deepEqual(comments, [["ACME-1", "hi"]]);
});

test("onBoard matches whole keys only (ACME-1 is not ACME-12)", async () => {
  const { repo, triage } = setup();
  repo.addItem({
    batch_id: "b", source_kind: "jira", source_ref: "ACME-12", title: "t", type: "bug", target_repo: "r",
    role: "coder", model: "m", complexity: 1, depends_on: "[]", claimed_paths: "[]",
  });
  const l = await triage.list();
  assert.equal(l.find((i) => i.key === "ACME-1")?.onBoard, false);
});
