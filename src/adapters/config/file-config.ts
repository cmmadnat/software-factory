// Loads factory.config.json: budgets, caps, and per-target gate commands.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { z } from "zod";

const Target = z.object({
  repo: z.string(),
  host: z.enum(["gitlab", "github", "local"]),
  baseBranch: z.string(),
  // Run once in a fresh worktree before any gate (dependency links/installs).
  setup: z.array(z.string()).default([]),
  // Gates pass on "no new failures vs the base-commit baseline", not on a green suite: Staging already fails tests.
  // {repo} → the main checkout; {changedTests} → pytest files the item touched (empty = whole tests/ tree);
  // {changedSpecs} → --include flags for karma specs of the changed modules (the full karma suite hangs on Staging).
  gate: z.object({ quick: z.array(z.string()).min(1), full: z.array(z.string()).min(1) }),
});

const Config = z.object({
  budget: z.object({
    perTurnUsd: z.number().positive(),
    perAgentUsd: z.number().positive(),
    perBatchUsd: z.number().positive(),
    usdPerAiu: z.number().positive(),
  }),
  maxParallel: z.number().int().positive(),
  maxTurnsPerAgent: z.number().int().positive(),
  jira: z.object({ site: z.string(), mcpUrl: z.string().url() }),
  targets: z.record(z.string(), Target),
});

export type Target = z.infer<typeof Target>;
export type FactoryConfig = z.infer<typeof Config>;

const expandHome = (p: string) => (p.startsWith("~/") ? resolve(homedir(), p.slice(2)) : p);

export const DEFAULT_CONFIG_PATH = resolve(import.meta.dirname, "../../../factory.config.json");
export const EXAMPLE_CONFIG_PATH = resolve(import.meta.dirname, "../../../factory.config.example.json");

export function loadConfig(path = DEFAULT_CONFIG_PATH): FactoryConfig {
  if (!existsSync(path)) throw new Error(`No config at ${path}. Copy factory.config.example.json to factory.config.json and edit it.`);
  const cfg = Config.parse(JSON.parse(readFileSync(path, "utf8")));
  for (const t of Object.values(cfg.targets)) t.repo = expandHome(t.repo);
  return cfg;
}

const fill = (cmd: string, target: Target, vars: Record<string, string>) =>
  Object.entries({ repo: target.repo, ...vars }).reduce((c, [k, v]) => c.replaceAll(`{${k}}`, v), cmd).trim();

export function setupCommands(target: Target): string[] {
  return target.setup.map((cmd) => fill(cmd, target, {}));
}

export function gateCommands(
  target: Target,
  level: "quick" | "full",
  changed: { tests?: string[]; specs?: string[] } = {},
): string[] {
  const vars = {
    changedTests: changed.tests?.length ? changed.tests.join(" ") : "tests",
    changedSpecs: (changed.specs ?? []).map((s) => `--include=${s}`).join(" "),
  };
  return target.gate[level].map((cmd) => fill(cmd, target, vars));
}
