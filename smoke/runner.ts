// M6/M8/M9 live smoke: real Copilot agents in a SYNTHETIC sandbox repo (never a real project).
// Two rows (sessions) run the role pipeline in parallel, each in its own worktree: planner → plan approved here,
// standing in for Nat → coder → tester → reviewer. The base branch already has one failing test, which the
// baseline must tolerate. Then a comment opens session turn 2 on row 1, and session turn 2 on row 2 is SIGKILLed
// mid-turn in a child process and resumed after a restart. Run: npm run smoke:runner
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type FactoryConfig } from "../src/adapters/config/file-config.ts";
import { createApp } from "../src/main.ts";

type App = Awaited<ReturnType<typeof createApp>>;
// Stand-in for Nat at checkpoint 1: approve every plan that waits, until the batch settles without one.
async function settle(app: App, start: Promise<void>) {
  await start;
  for (let planned; (planned = app.repo.items(batchId).filter((i) => i.status === "planned")).length; )
    await Promise.all(planned.map((i) => app.runner.approvePlan(i.id)));
}

const sh = (cwd: string, cmd: string) => execFileSync("sh", ["-c", cmd], { cwd, encoding: "utf8" });
const configFor = (repo: string): FactoryConfig => ({
  ...loadConfig(),
  maxParallel: 2,
  maxTurnsPerAgent: 6,
  targets: {
    sandbox: { repo, host: "gitlab", baseBranch: "Staging", setup: [], gate: { quick: ["node --test --test-reporter=tap test/"], full: ["node --test --test-reporter=tap test/"] } },
  },
});
const batchId = "smoke-m6";
const ROW2_COMMENT = "Also make lower(s) return an empty string when s is null or undefined, and test that case.";

// Crash child: open session turn 2 on row 2, then die hard as soon as its agent uses a tool.
if (process.argv[2] === "--crash-child") {
  const dir = process.argv[3];
  const app = await createApp(join(dir, "factory.db"), configFor(join(dir, "sandbox")), join(dir, "worktrees"), { open: async () => "unused" });
  const row2 = app.repo.items(batchId)[1].id;
  app.events.subscribe(batchId, (e) => {
    if (e.itemId === row2 && e.kind === "agent.tool") {
      console.log(`child: row ${row2} is mid-turn (${JSON.stringify(e.data)}), SIGKILL`);
      process.kill(process.pid, "SIGKILL");
    }
  });
  await settle(app, app.runner.anotherTurn(row2, ROW2_COMMENT));
  console.log("child: the turn finished before any tool call; nothing was killed");
  process.exit(3);
}

const dir = mkdtempSync(join(tmpdir(), "sf-m8-"));
const repo = join(dir, "sandbox");
sh(dir, `git init -q --bare -b Staging origin.git && git clone -q origin.git sandbox`);
sh(repo, "git config user.email factory@local && git config user.name factory && git checkout -q -b Staging");
const files: Record<string, string> = {
  "package.json": '{ "name": "sandbox", "type": "module" }\n',
  "src/math/add.js": "export const add = (a, b) => a + b;\n",
  "src/text/upper.js": "export const upper = (s) => s.toUpperCase();\n",
  "test/math.test.js": 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "../src/math/add.js";\ntest("add", () => assert.equal(add(2, 3), 5));\n',
  "test/text.test.js": 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { upper } from "../src/text/upper.js";\ntest("upper", () => assert.equal(upper("a"), "A"));\n',
  "test/legacy.test.js": 'import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("legacy is broken on Staging", () => assert.equal(1, 2));\n',
};
for (const [f, c] of Object.entries(files)) {
  mkdirSync(join(repo, f, ".."), { recursive: true });
  writeFileSync(join(repo, f), c);
}
sh(repo, "git add -A && git commit -qm base && git push -q origin Staging");

const config = configFor(repo);
// GitLab stand-in: records the MR instead of opening one. Branches really are pushed to the sandbox's bare origin.
const opened: string[] = [];
const host = { open: async (mr: { sourceBranch: string; targetBranch: string; title: string }) => (opened.push(`${mr.sourceBranch} → ${mr.targetBranch}: ${mr.title}`), `https://gitlab.sandbox/mr/${opened.length}`) };
let app = await createApp(join(dir, "factory.db"), config, join(dir, "worktrees"), host);
app.repo.createBatch(batchId, config.budget.perBatchUsd);
const row = (title: string, brief: string, claims: string[]) =>
  app.repo.addItem({
    batch_id: batchId, source_kind: "text", source_ref: "smoke", title, type: "feature", target_repo: "sandbox", role: "coder",
    model: "claude-haiku-5.5", complexity: 1, depends_on: "[]", claimed_paths: JSON.stringify(claims), brief,
  });
row("Add multiply(a, b) to src/math", "Create src/math/multiply.js exporting multiply(a, b), and test it in test/multiply.test.js with node:test.", ["src/math/**", "test/multiply.test.js"]);
row("Add lower(s) to src/text", "Create src/text/lower.js exporting lower(s) that lowercases a string, and test it in test/lower.test.js with node:test.", ["src/text/**", "test/lower.test.js"]);

const started = Date.now();
const log = (e: { itemId: number | null; kind: string; data: unknown }) => {
  if (["agent.tool", "turn.started", "agent.message"].includes(e.kind)) return;
  console.log(`${((Date.now() - started) / 1000).toFixed(1).padStart(6)}s ${e.itemId ? `#${e.itemId}` : "  "} ${e.kind} ${JSON.stringify(e.data).slice(0, 160)}`);
};
const failures: string[] = [];
const check = (ok: boolean, what: string) => (console.log(`${ok ? "✓" : "✗"} ${what}`), ok || failures.push(what));
const wtOf = (id: number) => join(dir, "worktrees", `s${id}`, "sandbox");
const commitsOf = (id: number) => sh(repo, `git log --format='%h %s [%(trailers:key=Factory-Item,valueonly,separator=)]' Staging..factory/s${id}-sandbox`).trim().split("\n").filter(Boolean);

console.log("— session turn 1: both rows in parallel —");
app.events.subscribe(batchId, log);
app.board.approve(batchId);
await settle(app, app.runner.kick(batchId));
const [row1, row2] = app.repo.items(batchId).map((i) => i.id);
check(app.repo.items(batchId).every((i) => i.status === "done"), "turn 1: both rows done");
for (const id of [row1, row2]) {
  const roles = app.repo.agentRuns(id).map((r) => r.role);
  check(["planner", "coder", "tester", "reviewer"].every((r) => roles.includes(r as never)), `row ${id} ran ${roles.join(" → ")}`);
}

console.log("\n— session turn 2 on row 1, from a comment —");
await settle(app, app.runner.anotherTurn(row1, "Also export a square(n) helper from src/math/multiply.js built on multiply, and test it."));
check(app.repo.item(row1)!.status === "done", "row 1 turn 2 done");
check(commitsOf(row1).length >= 2, `row 1: both turns' commits on factory/s${row1}-sandbox (${commitsOf(row1).length})`);

console.log("\n— session turn 2 on row 2: SIGKILL mid-turn in a child, then restart and resume —");
await app.close();
const child = spawnSync(process.execPath, [...process.execArgv, process.argv[1], "--crash-child", dir], { stdio: "inherit" });
check(child.signal === "SIGKILL", `child was killed mid-turn (signal ${child.signal}, status ${child.status})`);
app = await createApp(join(dir, "factory.db"), config, join(dir, "worktrees"), host);
app.events.subscribe(batchId, log);
const turn2 = () => app.repo.agentRuns(row2).filter((r) => r.session_turn_id === app.repo.sessionTurns(row2).at(-1)!.id);
const paused = turn2().find((r) => r.status === "paused");
check(app.repo.item(row2)!.status === "paused" && !!paused?.sdk_session_id, `restart reconciled row 2 and its ${paused?.role ?? "?"} run to paused`);
await settle(app, app.runner.continue(row2, 0));
check(app.repo.item(row2)!.status === "done", "row 2 turn 2 done after resume");
check(turn2().filter((r) => r.role === paused?.role).length === 1 && turn2().some((r) => r.id === paused?.id && r.status === "done"), `the killed ${paused?.role} run was resumed, not replaced`);
check(app.repo.sessionTurns(row2).length === 2, "row 2 has 2 session turns");

console.log("\n— result —");
for (const i of app.repo.items(batchId)) {
  const t = app.repo.turns(i.id);
  console.log(`#${i.id} ${i.status.padEnd(7)} session turns=${app.repo.sessionTurns(i.id).length} agent runs=${app.repo.agentRuns(i.id).map((r) => `${r.role}${r.verdict ? `:${r.verdict}` : ""}`).join(",")} model turns=${t.length} gates=${t.map((x) => x.gate_result ?? "-").join(",")} $${app.repo.itemSpendUsd(i.id).toFixed(4)} ${i.pause_reason ?? ""}`);
  console.log(commitsOf(i.id).map((c) => `    ${c}`).join("\n"));
  console.log("    uncommitted:", sh(wtOf(i.id), "git status --porcelain").trim() || "(clean)");
}
console.log(`batch ${app.repo.batch(batchId)!.status} · spent $${app.repo.batch(batchId)!.spent_usd.toFixed(4)} · ${((Date.now() - started) / 1000).toFixed(0)}s`);
console.log("fsck:", sh(repo, "git fsck --no-progress 2>&1 && echo ok").trim().split("\n").at(-1));

console.log("\n— publish —");
const shipped = await app.publish.execute(batchId);
for (const r of shipped) console.log(`#${r.itemId} ${r.branch} ${r.mrUrl ?? ""} ${r.error ?? ""} ${r.warning ?? ""}`);
check(shipped.length === 2 && shipped.every((r) => r.mrUrl && !r.error), "both cards shipped through the full gate (the legacy failure is in the baseline)");
for (const o of opened) console.log("MR:", o);
for (const b of sh(join(dir, "origin.git"), "git branch --format='%(refname:short)'").trim().split("\n").filter((b) => b !== "Staging"))
  console.log(`origin ${b}:`, sh(join(dir, "origin.git"), `git diff --name-only Staging ${b}`).trim().split("\n").join(", "));
await app.close();
console.log(failures.length ? `\nFAILED: ${failures.join("; ")}` : "\nall checks passed");
process.exit(failures.length ? 1 : 0);
