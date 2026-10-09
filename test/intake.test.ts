import assert from "node:assert/strict";
import { test } from "node:test";
import { NormalizeIntake, renderIssue } from "../src/application/normalize-intake.ts";
import type { AttachmentSource, Issue, IssueTracker } from "../src/application/ports/issue-tracker.ts";
import type { Vision } from "../src/application/ports/vision.ts";
import { splitPaste } from "../src/domain/intake.ts";
import { zeroUsage } from "../src/domain/usage.ts";

test("splitPaste: a paste of only Jira keys becomes one jira entry per key", () => {
  assert.deepEqual(splitPaste(" ACME-1482, ACME-1040\nCAB-414 ACME-1482 "), [
    { kind: "jira", key: "ACME-1482" },
    { kind: "jira", key: "ACME-1040" },
    { kind: "jira", key: "CAB-414" },
  ]);
});

test("splitPaste: text that mentions a key stays text; blank paste is nothing", () => {
  assert.deepEqual(splitPaste("see ACME-1040, export button is cut off"), [
    { kind: "text", text: "see ACME-1040, export button is cut off" },
  ]);
  assert.deepEqual(splitPaste("   \n "), []);
});

const issue = (over: Partial<Issue> = {}): Issue => ({
  key: "ACME-1040", summary: "CPV report", status: "Resolved", description: "Generate the report.",
  comments: [{ author: "QA", body: "Column order wrong" }],
  attachments: [
    { id: "1", filename: "spec.xlsx", mimeType: "application/vnd.ms-excel", size: 100 },
    { id: "2", filename: "status-page.png", mimeType: "image/png", size: 2000 },
  ],
  ...over,
});

const tracker = (byKey: Record<string, Issue>): IssueTracker => ({
  getIssue: async (k) => {
    if (!byKey[k]) throw new Error("404");
    return byKey[k];
  },
  comment: async () => {},
});
const vision: Vision = { describe: async (img, ctx) => ({ text: `saw ${img.mimeType} (${ctx?.slice(0, 22)})`, usage: { ...zeroUsage(), costUsd: 0.001 } }) };
const attachments: AttachmentSource = { download: async (a) => ({ base64: "AAAA", mimeType: a.mimeType }) };

test("NormalizeIntake: jira issue becomes text with comments and vision-described image attachments", async () => {
  const out = await new NormalizeIntake(tracker({ "ACME-1040": issue() }), vision, attachments).execute([{ kind: "jira", key: "ACME-1040" }]);
  assert.equal(out.items.length, 1);
  const body = out.items[0].body;
  assert.match(body, /^ACME-1040 — CPV report \[Resolved\]/);
  assert.match(body, /- QA: Column order wrong/);
  assert.match(body, /- spec\.xlsx\n/); // non-image listed, not described
  assert.match(body, /- status-page\.png — saw image\/png \(Attachment "status-pag\)/);
  assert.deepEqual(out.warnings, []);
  assert.equal(out.usage.costUsd, 0.001);
});

test("NormalizeIntake: without an attachment source, images are listed and a warning says how to enable them", async () => {
  const out = await new NormalizeIntake(tracker({ "ACME-1040": issue() }), vision, null).execute([{ kind: "jira", key: "ACME-1040" }]);
  assert.match(out.items[0].body, /- status-page\.png$/m);
  assert.match(out.warnings[0], /ATLASSIAN_API_TOKEN/);
});

test("NormalizeIntake: one bad entry warns but never sinks the rest; text and screenshots keep their order", async () => {
  const out = await new NormalizeIntake(tracker({}), vision, attachments).execute([
    { kind: "text", text: "export button cut off" },
    { kind: "jira", key: "NOPE-1" },
    { kind: "image", mimeType: "image/png", base64: "AAAA" },
  ]);
  assert.deepEqual(out.items.map((i) => [i.kind, i.ref]), [["text", "paste-1"], ["image", "screenshot-2"]]);
  assert.match(out.items[1].body, /^Screenshot screenshot-2: saw image\/png/);
  assert.match(out.warnings[0], /NOPE-1: could not fetch/);
});

test("renderIssue omits empty sections", () => {
  assert.equal(renderIssue(issue({ comments: [], attachments: [] })), "ACME-1040 — CPV report [Resolved]\n\nGenerate the report.");
});

test("NormalizeIntake: entries run concurrently but results keep paste order", async () => {
  // Count fetches in flight instead of timing them, so a busy machine can't make this flaky.
  let inFlight = 0;
  let peak = 0;
  const slow: IssueTracker = {
    getIssue: async (k) => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
      return issue({ key: k, attachments: [] });
    },
    comment: async () => {},
  };
  const out = await new NormalizeIntake(slow, vision, null).execute([
    { kind: "jira", key: "B-2" }, { kind: "text", text: "t" }, { kind: "jira", key: "A-1" },
  ]);
  assert.deepEqual(out.items.map((i) => i.ref), ["B-2", "paste-1", "A-1"]);
  assert.equal(peak, 2, "both Jira fetches were in flight at once");
});

test("classifier prompt tells the model that @repo tags pin the target and lists known repos", async () => {
  const { StructuredClassifier } = await import("../src/adapters/classifier/structured.ts");
  let seen = "";
  const runtime = {
    structured: async (prompt: string) => {
      seen = prompt;
      return { value: { rows: [] }, usage: zeroUsage() };
    },
  };
  const c = new StructuredClassifier(runtime as never, () => ["alpha", "beta"], { small: "s", large: "l" });
  await c.classify([{ kind: "text", ref: "p1", body: "fix @alpha login" } as never]);
  assert.match(seen, /An @name token in an item names its target repo/);
  assert.match(seen, /Known target repos: alpha, beta/);
  assert.match(seen, /fix @alpha login/);
});
