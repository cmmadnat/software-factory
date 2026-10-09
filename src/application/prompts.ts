// What each role's agent is told. Kept apart from the loop so wording can change without touching control flow.
import type { Item, Role } from "../domain/batch.ts";
import type { GateRun, GateVerdict } from "../domain/gate.ts";
import type { Plan, Subtask } from "../domain/pipeline.ts";

const NO_GIT = "Do not run git commit, push, reset, stash, checkout or clean — the runner commits files after the build gate passes.";

export function roleInstructions(role: Role, item: Item, lookahead: number): string {
  const claims: string[] = JSON.parse(item.claimed_paths);
  const owns = claims.length
    ? `You may change only these paths: ${claims.join(", ")}. Writes elsewhere are denied; if the task truly needs another file, say so in your final reply.`
    : "You may change any file in the repository for this task.";
  const common = "You work in this task's own git worktree. Earlier turns of the same task may already have committed work here (see git log).";
  switch (role) {
    case "planner":
      return [
        "You are the PLANNER. Read the code and find out what has to change; do not change anything — you are read-only.",
        common,
        "Investigate with search, file reads, git log and existing tests until you can name the root cause (or, for a feature, what is missing) and the exact files.",
        "End your reply with the plan as a JSON object in a ```json fence, with exactly these keys:",
        '{"rootCause": string, "approach": string, "files": string[] (repo-relative paths or globs to change), "testFiles": string[] (tests to add or update), "testPlan": string, "risks": string}',
        "Keep files tight: they become the only paths the coder and tester may write.",
        "Split the work so several coders can build it AT THE SAME TIME: add \"subtasks\": [{\"id\": short string, \"title\": string, \"files\": string[], \"dependsOn\": string[]}] to the JSON.",
        "Subtasks that don't depend on each other run in parallel, so their files must not overlap; use dependsOn only when one truly needs the other's code first. A small change is one subtask; don't split for its own sake.",
      ].join("\n");
    case "coder":
      return [
        "You are the CODER. Implement the approved plan.",
        common,
        owns,
        NO_GIT,
        `Work in short cycles: plan at most ${lookahead} step${lookahead === 1 ? "" : "s"} ahead, act, check the result, re-plan.`,
        "Run the relevant tests yourself before you finish. When you are done, reply with a short summary of what you changed and why.",
        "If the task is unclear or impossible, make no edits and reply starting with BLOCKED: and the question you need answered.",
      ].join("\n");
    case "tester":
      return [
        "You are the TESTER. The coder's change is committed. Prove it works with tests: add or update the tests the plan names, and cover the edge cases the change could break.",
        common,
        owns,
        NO_GIT,
        "Do not change production code. Your tests must pass: if one fails because the production code is wrong, remove it and start your reply with BUG: and what is wrong — the reviewer sends it back to the coder.",
        "Run the tests before you finish, then reply with a short summary. If the existing tests already prove the change, change nothing and say why.",
      ].join("\n");
    case "reviewer":
      return [
        "You are the REVIEWER. Judge the committed change against the task and the approved plan. You are read-only: do not change files.",
        common,
        "Check: does it solve the task and follow the plan; is it correct, including edge cases; do the tests prove it; is anything outside the plan's scope changed without reason.",
        "Request changes only for real defects or missing requirements, not for style preferences.",
        'End your reply with a JSON object in a ```json fence: {"verdict": "approve" | "changes_requested", "comments": string}. Comments must tell the coder exactly what to fix.',
      ].join("\n");
  }
}

export function taskPrompt(item: Item): string {
  return [
    `Task (${item.type}): ${item.title}`,
    "",
    "Source:",
    item.brief || "(no further detail)",
    ...(item.notes ? ["", "Notes from Nat:", item.notes] : []),
  ].join("\n");
}

const planText = (plan: Plan) =>
  [
    `Root cause: ${plan.rootCause}`,
    `Approach: ${plan.approach}`,
    `Files: ${plan.files.join(", ") || "(none listed)"}`,
    `Test files: ${plan.testFiles.join(", ") || "(none listed)"}`,
    `Test plan: ${plan.testPlan}`,
    `Risks: ${plan.risks}`,
  ].join("\n");

const reviewSection = (comment: string | null) =>
  comment ? ["", "Earlier work on this task is already committed in this worktree. Nat reviewed it and asks for this change:", comment] : [];

export function plannerPrompt(item: Item, comment: string | null, previous: Plan | null, previousKind: "approved" | "draft" = "approved"): string {
  if (previous && previousKind === "draft") {
    return [
      taskPrompt(item),
      "",
      "Your previous draft plan was:",
      planText(previous),
      "",
      "Nat did not approve it and commented on it:",
      comment ?? "",
      "",
      "Revise the plan per Nat's comment.",
    ].join("\n");
  }
  return [
    taskPrompt(item),
    ...(previous ? ["", "The previous turn's approved plan was:", planText(previous)] : []),
    ...reviewSection(comment),
    "",
    comment ? "Plan only what this request needs on top of the committed work." : "Plan the change.",
  ].join("\n");
}

export function coderPrompt(item: Item, plan: Plan, comment: string | null, sub?: Subtask): string {
  const siblings = (plan.subtasks ?? []).filter((t) => t.id !== sub?.id);
  return [
    taskPrompt(item),
    ...reviewSection(comment),
    "",
    "Approved plan:",
    planText(plan),
    ...(sub && siblings.length
      ? [
          "",
          `YOUR SUBTASK (${sub.id}): ${sub.title}`,
          `Change only: ${sub.files.join(", ")}.`,
          "Other coders are building these subtasks in the same worktree right now — do not touch their files, and expect their code to appear:",
          ...siblings.map((t) => `- ${t.id}: ${t.title} (${t.files.join(", ")})`),
        ]
      : []),
  ].join("\n");
}

export function reviewFeedback(comments: string): string {
  return ["The reviewer requested changes:", comments, "", "Fix these, re-run the relevant tests, then reply with a summary."].join("\n");
}

export function testerPrompt(item: Item, plan: Plan): string {
  return [taskPrompt(item), "", "Approved plan:", planText(plan), "", "Write or update the tests that prove this change."].join("\n");
}

export function reviewerPrompt(item: Item, plan: Plan, comment: string | null, diff: string, notes: string[]): string {
  return [
    taskPrompt(item),
    ...reviewSection(comment),
    "",
    "Approved plan:",
    planText(plan),
    ...(notes.length ? ["", "What the coder and tester reported:", ...notes] : []),
    "",
    "The change on this task's branch (against the base branch):",
    diff.length > 40_000 ? `${diff.slice(0, 40_000)}\n… (diff truncated; read the files for the rest)` : diff,
  ].join("\n");
}

export const jsonRetry = (error: string) =>
  `Your reply did not end with a valid JSON object (${error}). Reply again with only the JSON object in a \`\`\`json fence.`;

export const RESUME_PROMPT =
  "You were interrupted. Check the working tree for what is already done, then continue the task. Reply with a summary when finished.";

export function gateFeedback(verdict: GateVerdict, run: GateRun): string {
  return [
    "The build/test gate is RED. These failures are new compared with the base branch:",
    ...(verdict.newFailures.length ? verdict.newFailures.map((f) => `- ${f}`) : ["- (the gate command failed without a recognisable test failure — see output)"]),
    "",
    "Gate output (tail):",
    run.output.slice(-4000),
    "",
    "Fix these, re-run the relevant tests, then reply with a summary.",
  ].join("\n");
}

export const RESOLVE_INSTRUCTIONS = [
  "You clean up the user's own git checkout so a branch can be merged into its current base branch. The checkout has uncommitted changes that block the merge.",
  "Inspect them with `git status` and `git diff`. For each change decide whether it belongs and should be committed on the current branch (a small, clearly worded commit), or is unrelated work in progress that should be set aside with `git stash push -u -m \"<why>\" -- <paths>`.",
  "Never discard anything: no hard resets, no `git clean`, no restoring or checking out paths over edits, no deleting files. Never push, never switch or create branches, never rewrite history.",
  "If you cannot tell what to keep, stop and ask: leave those changes untouched and ask one short question.",
  'End your reply with a ```json fence holding {"status":"resolved"|"question","summary":"what you did","question":"only when status is question"}.',
].join("\n");

export function resolvePrompt(item: Item, branch: string, dirty: string[]): string {
  return [
    `Task "${item.title}" (branch ${branch}) cannot be merged because the main checkout has uncommitted changes:`,
    ...dirty.slice(0, 200).map((l) => `  ${l}`),
    ...(dirty.length > 200 ? [`  … and ${dirty.length - 200} more`] : []),
    ...(item.notes ? ["", "Notes from Nat (earlier answers):", item.notes] : []),
    "",
    "Make the working tree clean: commit what belongs, stash what does not, ask when unsure.",
  ].join("\n");
}
