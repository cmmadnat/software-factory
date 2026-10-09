// A target repo the factory can work in: where it lives, which branch MRs go to, and its build gate.

export interface TargetSpec {
  name: string; // short id shown on the board, e.g. "acme-api"
  repo: string; // absolute path to the main checkout
  host: "gitlab" | "github" | "local"; // local = no remote: nothing is fetched or pushed, branches stay local
  baseBranch: string;
  setup: string[]; // run once in a fresh worktree
  gate: { quick: string[]; full: string[] };
}

export const hasRemote = (t: Pick<TargetSpec, "host">) => t.host !== "local";

const NAME = /^[a-z0-9][a-z0-9._-]{0,39}$/i;

export function targetProblems(t: TargetSpec, existing: string[]): string[] {
  const out: string[] = [];
  if (!NAME.test(t.name)) out.push("name: letters, digits, . _ - only (max 40)");
  if (t.name.toLowerCase() === "unknown") out.push(`name: "unknown" is reserved`);
  if (existing.includes(t.name)) out.push(`name: "${t.name}" already exists`);
  if (!t.repo.startsWith("/")) out.push("repo: must be an absolute path");
  if (!t.baseBranch.trim()) out.push("base branch: required");
  if (!["gitlab", "github", "local"].includes(t.host)) out.push("host: gitlab, github or local");
  if (!t.gate.quick.some((c) => c.trim())) out.push("quick gate: at least one command");
  if (!t.gate.full.some((c) => c.trim())) out.push("full gate: at least one command");
  return out;
}
