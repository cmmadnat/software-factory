// Composition root: the only place that knows which adapter backs which port.
import { EventBus } from "./adapters/events/bus.ts";
import { ShellGate } from "./adapters/gate/shell-gate.ts";
import { GitWorkspace } from "./adapters/git/workspace.ts";
import { GlabMergeRequestHost } from "./adapters/gitlab/glab-mr-host.ts";
import { AtlassianMcpIssueTracker } from "./adapters/atlassian/mcp-issue-tracker.ts";
import { JiraRestAttachments } from "./adapters/atlassian/rest-attachments.ts";
import { StructuredClassifier } from "./adapters/classifier/structured.ts";
import { DEFAULT_CONFIG_PATH, loadConfig, type FactoryConfig } from "./adapters/config/file-config.ts";
import { FileTargetCatalog } from "./adapters/config/file-target-catalog.ts";
import { GitRepoInspector } from "./adapters/git/repo-inspector.ts";
import { GhPullRequestHost, HostRouter } from "./adapters/github/gh-pr-host.ts";
import { ManageTargets } from "./application/manage-targets.ts";
import { CopilotRuntime } from "./adapters/copilot/runtime.ts";
import { CopilotVision } from "./adapters/copilot/vision.ts";
import { SqliteBatchRepository } from "./adapters/sqlite/batch-repo.ts";
import { EditBoard } from "./application/edit-board.ts";
import type { AgentRuntime } from "./application/ports/agent-runtime.ts";
import { TriageJira } from "./application/triage-jira.ts";
import { NormalizeIntake } from "./application/normalize-intake.ts";
import { PlanBatch } from "./application/plan-batch.ts";
import { InFlight } from "./application/in-flight.ts";
import { ResolveCheckout } from "./application/resolve-checkout.ts";
import { CardFileDiff } from "./application/card-file-diff.ts";
import { MergeCard } from "./application/merge-card.ts";
import { PublishBatch } from "./application/publish-batch.ts";
import type { MergeRequestHost } from "./application/ports/merge-request-host.ts";
import { RunBatch } from "./application/run-batch.ts";
import { SessionBoard } from "./application/session-board.ts";
import type { ModelPolicy } from "./domain/routing.ts";
import { createWebServer } from "./ui/web/server.ts";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const MODELS: ModelPolicy = { small: "claude-haiku-5.5", large: "claude-sonnet-5.5" };

// The live model list drives what a user may pick; MODELS stays the routing policy and is always included.
export async function resolveModels(runtime: Pick<AgentRuntime, "models">, policy: ModelPolicy): Promise<string[]> {
  let live: string[] = [];
  try {
    live = (await runtime.models()) ?? [];
  } catch {
    live = [];
  }
  return [...new Set([policy.small, policy.large, ...live.filter((m) => m && m !== "auto")])];
}

export async function createApp(
  dbPath: string,
  config: FactoryConfig = loadConfig(),
  worktreeRoot = resolve(dirname(dbPath), "worktrees"),
  mrHost: MergeRequestHost = new HostRouter(config, { gitlab: new GlabMergeRequestHost(config), github: new GhPullRequestHost(config) }),
  configPath = DEFAULT_CONFIG_PATH,
) {
  const targets = new ManageTargets(new FileTargetCatalog(config, configPath), new GitRepoInspector());
  const runtime = new CopilotRuntime(config.budget.usdPerAiu);
  await runtime.start();
  const models = await resolveModels(runtime, MODELS);
  const repo = new SqliteBatchRepository(dbPath);
  const classifier = new StructuredClassifier(runtime, () => targets.names(), MODELS);
  const tracker = new AtlassianMcpIssueTracker(runtime, MODELS.small, config.jira.mcpUrl);
  const normalizeIntake = new NormalizeIntake(
    tracker,
    new CopilotVision(runtime, MODELS.small),
    JiraRestAttachments.fromEnv(config.jira.site),
  );
  const events = new EventBus(repo);
  const workspace = new GitWorkspace(config, worktreeRoot);
  const gate = new ShellGate(config);
  const runner = new RunBatch(repo, runtime, workspace, gate, events, {
    maxParallel: config.maxParallel,
    maxTurnsPerAgent: config.maxTurnsPerAgent,
    perTurnUsd: config.budget.perTurnUsd,
    perAgentUsd: config.budget.perAgentUsd,
    perBatchUsd: config.budget.perBatchUsd,
    maxRedGates: 5,
    maxReviewRounds: 2,
    maxAgentsPerCard: 3,
    smallModel: MODELS.small,
  });
  // A crash leaves rows 'running' with no process behind them: mark them paused so Continue resumes them.
  for (const b of repo.listBatches(100)) if (b.status === "running") {
    repo.reconcile(b.id);
    repo.updateBatch(b.id, { status: "waiting" });
  }
  const inFlight = new InFlight();
  return {
    config,
    repo,
    events,
    runner,
    publish: new PublishBatch(repo, workspace, mrHost, tracker, events, (t) => config.targets[t].baseBranch, gate, inFlight),
    merge: new MergeCard(repo, workspace, events, (t) => config.targets[t].host, gate, inFlight),
    resolve: new ResolveCheckout(repo, workspace, runtime, events, (t) => config.targets[t].host, inFlight),
    normalizeIntake,
    triage: new TriageJira(tracker, tracker, repo),
    planBatch: new PlanBatch(repo, classifier, config.budget.perBatchUsd),
    board: new EditBoard(repo, () => targets.names(), models),
    models,
    sessions: new SessionBoard(repo, () => targets.names(), inFlight, config.maxParallel),
    fileDiff: new CardFileDiff(repo, workspace),
    targets,
    async close() {
      repo.close();
      await runtime.stop();
    },
  };
}

// `npm start`: one SQLite file for all batches, served on localhost only. FACTORY_DB / FACTORY_PORT /
// FACTORY_CONFIG override the defaults.
if (process.argv[1] === import.meta.filename) {
  const runs = resolve(import.meta.dirname, "../runs");
  mkdirSync(runs, { recursive: true });
  // FACTORY_CONFIG points the app at another config (e.g. a synthetic sandbox target for UI checks).
  const configPath = process.env.FACTORY_CONFIG ? resolve(process.env.FACTORY_CONFIG) : DEFAULT_CONFIG_PATH;
  const db = process.env.FACTORY_DB ?? resolve(runs, "factory.db");
  const app = await createApp(db, loadConfig(configPath), resolve(dirname(db), "worktrees"), undefined, configPath);
  const port = Number(process.env.FACTORY_PORT ?? 4600);
  createWebServer({
    normalizeIntake: app.normalizeIntake,
    triage: app.triage,
    planBatch: app.planBatch,
    board: app.board,
    batches: app.repo,
    meta: () => ({
      targets: app.targets.names(),
      local: app.targets.list().filter((t) => t.host === "local").map((t) => t.name),
      models: app.models,
    }),
    targets: app.targets,
    runner: app.runner,
    events: app.events,
    publish: app.publish,
    merge: app.merge,
    resolve: app.resolve,
    sessions: app.sessions,
    fileDiff: app.fileDiff,
  }).listen(port, "127.0.0.1", () => console.log(`factory → http://localhost:${port}`));
  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
