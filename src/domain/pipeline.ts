// The role pipeline inside one session turn: planner → (Nat approves the plan) → coders in parallel, one per
// subtask of the plan's task graph, in dependency waves → tester → reviewer, with "changes requested" sending
// the work back to one whole-card coder at most maxReviewRounds times. Pure: the runner asks nextStage after
// every wave, so a crash or a pause resumes at exactly the right agents.
import type { AgentRun, Role, SessionTurn } from "./batch.ts";
import { globsOverlap } from "./path-claims.ts";

// One piece of a card's work, built by its own coder at the same time as its independent siblings.
export interface Subtask {
  id: string; // short, e.g. "api"
  title: string;
  files: string[]; // the only paths this subtask's coder may write
  dependsOn: string[]; // subtask ids that must be done first
}

export interface Plan {
  rootCause: string; // or, for a feature, what is missing
  approach: string;
  files: string[]; // repo-relative paths or globs the change touches; they become the row's claimed paths
  testFiles: string[];
  testPlan: string;
  risks: string;
  subtasks?: Subtask[]; // absent or empty = the whole plan is one subtask
}

export interface Review {
  verdict: "approve" | "changes_requested";
  comments: string;
}

export interface RoleSpec {
  readOnly: boolean; // may not edit files or run mutating commands
  model: "item" | "small"; // the row's model, or the cheap one
}

export const ROLE_SPECS: Record<Role, RoleSpec> = {
  planner: { readOnly: true, model: "item" },
  coder: { readOnly: false, model: "item" },
  tester: { readOnly: false, model: "small" },
  reviewer: { readOnly: true, model: "item" },
};

// coders: the subtask ids to run now, in parallel (null = one whole-card coder reworking review comments).
export type Stage = { role: "planner" | "tester" | "reviewer" } | { coders: (string | null)[] } | { wait: "plan_approval" } | { done: true } | { stuck: string };

export function subtasksOf(plan: Plan): Subtask[] {
  return plan.subtasks?.length ? plan.subtasks : [{ id: "main", title: plan.approach.slice(0, 80), files: plan.files, dependsOn: [] }];
}

const isOpen = (r: AgentRun) => r.status === "running" || r.status === "paused";

export function nextStage(turn: SessionTurn, runs: AgentRun[], maxReviewRounds: number): Stage {
  const mine = runs.filter((r) => r.session_turn_id === turn.id).sort((a, b) => a.id - b.id);
  const done = mine.filter((r) => r.status === "done");
  const open = mine.filter(isOpen);
  // A read-only or tester run left open is resumed on its own; open coders rejoin their wave below.
  const openSingle = open.find((r) => r.role !== "coder");
  if (openSingle) return { role: openSingle.role as "planner" | "tester" | "reviewer" };

  if (!done.some((r) => r.role === "planner") || turn.plan_status === "none") return { role: "planner" };
  if (turn.plan_status !== "approved") return { wait: "plan_approval" };
  const plan = JSON.parse(turn.plan_json!) as Plan;

  const reviews = done.filter((r) => r.role === "reviewer");
  if (!reviews.length) {
    // First pass: the task graph, wave by wave. A subtask is finished once a coder run for it is done.
    const coders = done.filter((r) => r.role === "coder");
    const finished = new Set(coders.map((r) => r.subtask!).filter(Boolean));
    // A whole-card coder (runs from before subtasks existed) covers every subtask.
    const pending = coders.some((r) => !r.subtask) ? [] : subtasksOf(plan).filter((t) => !finished.has(t.id));
    if (pending.length) {
      const ready = pending.filter((t) => t.dependsOn.every((d) => finished.has(d))).map((t) => t.id);
      return ready.length ? { coders: ready } : { stuck: `no subtask can start: ${pending.map((t) => t.id).join(", ")} wait on each other` };
    }
  } else if (open.some((r) => r.role === "coder")) return { coders: [null] };

  const last = done.filter((r) => r.role !== "planner").at(-1)!;
  if (last.role === "coder") return { role: "tester" };
  if (last.role === "tester") return { role: "reviewer" };
  if (last.verdict === "approve") return { done: true };
  const bounces = reviews.filter((r) => r.verdict === "changes_requested").length;
  if (bounces > maxReviewRounds) return { stuck: `the reviewer requested changes ${bounces} times: ${last.summary ?? ""}`.slice(0, 500) };
  return { coders: [null] };
}

// What is wrong with a plan's task graph, if anything: unknown or cyclic dependencies, and files two subtasks
// could both write at the same time (siblings must not overlap; one depending on the other may).
export function planProblems(plan: Plan): string[] {
  const tasks = subtasksOf(plan);
  const out: string[] = [];
  const ids = new Set<string>();
  for (const t of tasks) {
    if (!t.id.trim()) out.push("a subtask has no id");
    if (ids.has(t.id)) out.push(`subtask id ${t.id} is used twice`);
    ids.add(t.id);
    if (!t.files.length) out.push(`subtask ${t.id} lists no files`);
  }
  for (const t of tasks) for (const d of t.dependsOn) if (!ids.has(d) || d === t.id) out.push(`subtask ${t.id} depends on unknown subtask ${d}`);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const before = (a: string, b: string, seen = new Set<string>()): boolean => // does a (transitively) depend on b?
    (byId.get(a)?.dependsOn ?? []).some((d) => d === b || (!seen.has(d) && (seen.add(d), before(d, b, seen))));
  for (const t of tasks) if (before(t.id, t.id)) out.push(`subtask ${t.id} is part of a dependency cycle`);
  for (let i = 0; i < tasks.length; i++)
    for (let j = i + 1; j < tasks.length; j++) {
      const [a, b] = [tasks[i], tasks[j]];
      if (before(a.id, b.id) || before(b.id, a.id)) continue;
      const shared = a.files.flatMap((fa) => b.files.filter((fb) => globsOverlap(fa, fb)).map((fb) => (fa === fb ? fa : `${fa} ~ ${fb}`)));
      if (shared.length) out.push(`subtasks ${a.id} and ${b.id} both write ${shared.join(", ")}: merge them or make one depend on the other`);
    }
  return [...new Set(out)];
}

// The claimed paths an approved plan implies: its files plus its test files, de-duplicated.
export const claimsFromPlan = (plan: Plan): string[] =>
  [...new Set([...plan.files, ...subtasksOf(plan).flatMap((t) => t.files), ...plan.testFiles].map((p) => p.trim()).filter(Boolean))];
