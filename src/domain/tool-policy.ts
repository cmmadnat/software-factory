// Tool allowlist, enforced in onPreToolUse. Limits are code, not judgment: a denial explains itself to the
// agent and the turn continues — nothing here halts a batch.
import { isAbsolute, relative, resolve } from "node:path";
import { withinClaims } from "./path-claims.ts";

export type Decision = { allow: true } | { allow: false; reason: string };

const DENY_COMMANDS: [RegExp, string][] = [
  [/\bgit\s+push\b[^\n]*(\s--force\b|\s-f\b|\s--force-with-lease\b|\s\+\S)/, "force-push is not allowed"],
  [/\bgit\s+push\b/, "agents do not push; the runner opens the MR"],
  [/\b(glab|gh)\s+(mr|pr)\s+(merge|close)\b/, "merging/closing MRs is Nat's call"],
  [/\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s+\.)/, "destructive git command"],
  [/\bgit\s+worktree\s+(remove|prune)\b/, "the runner owns the worktree"],
  [/(^|[\s/])\.env(\.|\b)|\bprintenv\b|\benv\s*$|security\s+find-generic-password/, "secrets are not readable from the worktree"],
];

// Read-only roles (planner, reviewer) may look but not touch. A shell is still allowed for grep, git log, tests;
// these patterns catch the commands that change files. The runner also checks the tree afterwards.
const MUTATING_COMMANDS =
  /(^|[;&|]\s*|\s)(rm|rmdir|mv|cp|touch|mkdir|tee|truncate|chmod|ln|patch|dd)\s|\bsed\s+(-[a-zA-Z]*i|--in-place)|\bperl\s+-[a-zA-Z]*i|(^|[^0-9&>])>{1,2}\s*(?!&|\/dev\/null)[^\s]|\bgit\s+(add|commit|checkout|switch|restore|stash|apply|am|cherry-pick|rebase|merge|reset|rm|mv|tag|branch\s+-[dDmM])\b|\b(npm|pnpm|yarn)\s+(i|install|add|remove|uninstall|update|ci)\b|\bpip\s+install\b/;
const WRITE_TOOL = /^(create|edit|write|str_replace|apply_patch|delete)/i;

const PATH_KEYS = ["path", "file", "filePath", "file_path", "fileName", "filename", "target", "destination"];

// macOS spells temp dirs two ways (/var/… and /private/var/…); treat them as the same place.
const canon = (p: string) => p.replace(/^\/private(?=\/(?:var|tmp|etc)\/)/, "");

function within(root: string, p: string): boolean {
  const rel = relative(canon(root), canon(isAbsolute(p) ? p : resolve(root, p)));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

// Paths a shell `rm`/`mv` touches: every non-flag token after the verb.
function rmTargets(cmd: string): string[] {
  const out: string[] = [];
  for (const m of cmd.matchAll(/\b(rm|rmdir|mv|unlink)\s+([^;&|\n]+)/g)) {
    for (const tok of m[2].trim().split(/\s+/)) if (!tok.startsWith("-")) out.push(tok.replace(/^['"]|['"]$/g, ""));
  }
  return out;
}

export function checkTool(toolName: string, args: unknown, worktree: string, writable: string[] = [], readOnly = false): Decision {
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const command = typeof a.command === "string" ? a.command : undefined;

  if (readOnly) {
    if (WRITE_TOOL.test(toolName)) return { allow: false, reason: "this role is read-only: describe the change in your reply instead of making it" };
    if (command !== undefined && MUTATING_COMMANDS.test(command)) return { allow: false, reason: "this role is read-only: that command changes files" };
  }

  if (command !== undefined) {
    for (const [re, reason] of DENY_COMMANDS) if (re.test(command)) return { allow: false, reason };
    for (const t of rmTargets(command)) {
      if (t.startsWith("~") || !within(worktree, t)) return { allow: false, reason: `delete/move outside the worktree: ${t}` };
    }
  }

  for (const k of PATH_KEYS) {
    const p = a[k];
    if (typeof p !== "string") continue;
    if (/(^|\/)\.env(\.|$)/.test(p)) return { allow: false, reason: "secrets are not readable from the worktree" };
    // Writes must stay inside the worktree; reads elsewhere (e.g. the main repo's docs) are fine.
    if (WRITE_TOOL.test(toolName)) {
      if (!within(worktree, p)) return { allow: false, reason: `write outside the worktree: ${p}` };
      const rel = relative(canon(worktree), canon(isAbsolute(p) ? p : resolve(worktree, p)));
      if (!withinClaims(rel, writable))
        return { allow: false, reason: `${rel} is outside this row's claimed paths (${writable.join(", ")}); another agent may own it — say so in your reply instead` };
    }
  }
  return { allow: true };
}

// The runtime injects git config via GIT_CONFIG_COUNT/KEY_n/VALUE_n (e.g. safe.bareRepository=explicit); ShellGate
// runs with plain process.env. Unsetting COUNT makes the agent's shell see the same git config as the gate.
export function withGateGitEnv(args: unknown): unknown {
  if (!args || typeof args !== "object") return args;
  const a = args as Record<string, unknown>;
  if (typeof a.command !== "string") return args;
  return { ...a, command: `unset GIT_CONFIG_COUNT GIT_CONFIG_PARAMETERS GIT_CONFIG_GLOBAL GIT_CONFIG_SYSTEM GIT_CONFIG_NOSYSTEM; ${a.command}` };
}
