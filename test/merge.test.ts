import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { FactoryConfig } from "../src/adapters/config/file-config.ts";
import { ShellGate } from "../src/adapters/gate/shell-gate.ts";
import { GitWorkspace } from "../src/adapters/git/workspace.ts";
import { BoardError } from "../src/application/edit-board.ts";
import { InFlight } from "../src/application/in-flight.ts";
import { EditBoard } from "../src/application/edit-board.ts";
import { ResolveCheckout } from "../src/application/resolve-checkout.ts";
import type { AgentRuntime, TurnResult } from "../src/application/ports/agent-runtime.ts";
import { MergeCard } from "../src/application/merge-card.ts";
import { PublishBatch } from "../src/application/publish-batch.ts";
import { SessionBoard } from "../src/application/session-board.ts";
import type { GateRunner } from "../src/application/ports/gate.ts";
import type { NewItem } from "../src/domain/batch.ts";
import { columnOf } from "../src/domain/board.ts";
import { MemoryBatchRepository } from "./fakes/memory-batch-repo.ts";

const sh = (cwd: string, cmd: string) => execFileSync("sh", ["-c", cmd], { cwd, encoding: "utf8" });

// A local-only target (no origin) on branch `main`; the full gate fails whenever src/broken.ts exists.
async function sandbox(opts: { host?: "local" | "gitlab"; gate?: GateRunner } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sf-merge-"));
  const repo = join(dir, "repo");
  mkdirSync(repo);
  sh(repo, "git init -q -b main && git config user.email t@t && git config user.name t");
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src/shared.ts"), "export const v = 1;\n");
  sh(repo, "git add -A && git commit -qm base");
  const config = {
    budget: { perTurnUsd: 1, perAgentUsd: 1, perBatchUsd: 1, usdPerAiu: 0.1 }, maxParallel: 3, maxTurnsPerAgent: 5,
    jira: { site: "x", mcpUrl: "https://x" },
    targets: { app: { repo, host: opts.host ?? "local", baseBranch: "main", setup: [], gate: { quick: ["true"], full: [`if [ -f src/broken.ts ]; then echo "FAILED tests/test_b.py::test_broken - boom"; exit 1; fi`] } } },
  } as FactoryConfig;
  const ws = new GitWorkspace(config, join(dir, "worktrees"));
  const repoState = new MemoryBatchRepository();
  repoState.createBatch("b", 20);
  const events: string[] = [];
  const inFlight = new InFlight();
  const gate = opts.gate ?? new ShellGate(config);
  const sink = { emit: (e: { kind: string }) => void events.push(e.kind) };
  const merge = new MergeCard(repoState, ws, sink, (t) => config.targets[t].host, gate, inFlight);
  const publish = new PublishBatch(repoState, ws, { open: async () => "https://x/mr/1" }, { comment: async () => {} }, sink, () => "main", gate, inFlight);
  // A card whose session committed `file`, shipped as a local branch.
  const shipped = async (file: string, body: string, title = "Fix thing") => {
    const id = repoState.addItem({ batch_id: "b", source_kind: "text", source_ref: "p", title, type: "bug", target_repo: "app", role: "coder", model: "m", complexity: 1, depends_on: "[]", claimed_paths: "[]" } as NewItem);
    repoState.updateItem(id, { status: "done" });
    const wt = await ws.prepare(id, "app");
    mkdirSync(join(wt, file, ".."), { recursive: true });
    writeFileSync(join(wt, file), body);
    await ws.commit(wt, id, `row ${id}`, [file]);
    if (opts.host !== "gitlab") {
      const [r] = await publish.execute("b", [id]);
      assert.equal(r.error, undefined);
    }
    return id;
  };
  const head = () => sh(repo, "git rev-parse main").trim();
  return { dir, repo, ws, repoState, events, merge, publish, inFlight, shipped, head, sh: (c: string) => sh(repo, c) };
}

// A fake agent runtime: each turn runs `act(prompt, cwd)` against the main checkout and replies with its result.
function fakeRuntime(act: (prompt: string, cwd: string) => string | Promise<string>) {
  const log = { prompts: [] as string[], cwds: [] as string[], closed: 0 };
  const runtime: Pick<AgentRuntime, "startAgent"> = {
    startAgent: async (opts) => ({
      id: "s",
      send: async (prompt: string): Promise<TurnResult> => {
        log.prompts.push(prompt);
        log.cwds.push(opts.workingDirectory);
        return { reply: await act(prompt, opts.workingDirectory), usage: {} as never, outcome: "idle" };
      },
      abort: async () => {},
      close: async () => void log.closed++,
    }),
  };
  return { runtime, log };
}
const json = (o: object) => "done\n```json\n" + JSON.stringify(o) + "\n```";

async function blocked() {
  const s = await sandbox();
  const id = await s.shipped("src/a.ts", "a\n");
  s.sh("echo x >> src/shared.ts");
  assert.match((await s.merge.execute(id)).error!, /uncommitted/);
  const resolverWith = (rt: Pick<AgentRuntime, "startAgent">) =>
    new ResolveCheckout(s.repoState, s.ws, rt, { emit: (e: { kind: string }) => void s.events.push(e.kind) }, () => "local", s.inFlight);
  return { s, id, resolverWith };
}

test("Resolve: an agent commits the dirty file, the block clears, and Merge then succeeds", async () => {
  const { s, id, resolverWith } = await blocked();
  const { runtime, log } = fakeRuntime((_p, cwd) => {
    sh(cwd, "git add -A && git commit -qm 'keep edit'");
    return json({ status: "resolved", summary: "committed the edit" });
  });
  const r = await resolverWith(runtime).execute(id);
  assert.deepEqual([r.resolved, r.error], [true, undefined]);
  assert.equal(log.cwds[0], s.repo);
  assert.match(log.prompts[0], /src\/shared\.ts/);
  assert.equal(log.closed, 1);
  assert.equal(s.repoState.item(id)!.pause_reason, null);
  assert.ok(s.events.includes("item.resolve_started") && s.events.includes("item.resolved"));
  const m = await s.merge.execute(id);
  assert.equal(m.error, undefined);
  assert.ok(s.repoState.item(id)!.merged_at);
});

test("Resolve: a stash also counts, and an already clean checkout just clears the block", async () => {
  const { s, id, resolverWith } = await blocked();
  const { runtime } = fakeRuntime((_p, cwd) => (sh(cwd, "git stash push -u -m wip"), json({ status: "resolved", summary: "stashed" })));
  assert.equal((await resolverWith(runtime).execute(id)).resolved, true);
  assert.equal(s.repoState.item(id)!.pause_reason, null);
  const again = await blocked();
  again.s.sh("git stash push -u -m manual");
  const never = fakeRuntime(() => { throw new Error("agent must not run"); });
  assert.equal((await again.resolverWith(never.runtime).execute(again.id)).resolved, true);
  assert.equal(again.s.repoState.item(again.id)!.pause_reason, null);
});

test("Resolve: a question is stored on the card, and the answer reaches the next prompt", async () => {
  const { s, id, resolverWith } = await blocked();
  let turn = 0;
  const { runtime, log } = fakeRuntime((_p, cwd) => {
    if (turn++ === 0) return json({ status: "question", summary: "unsure", question: "Keep the shared.ts edit?" });
    sh(cwd, "git add -A && git commit -qm keep");
    return json({ status: "resolved", summary: "ok" });
  });
  const resolver = resolverWith(runtime);
  const r = await resolver.execute(id);
  assert.deepEqual([r.resolved, r.question], [false, "Keep the shared.ts edit?"]);
  assert.equal(s.repoState.item(id)!.question, "Keep the shared.ts edit?");
  assert.match(s.repoState.item(id)!.pause_reason!, /^merge blocked/);
  new EditBoard(s.repoState, () => ["app"], ["m"]).answer(id, "yes keep it");
  assert.equal((await resolver.execute(id)).resolved, true);
  assert.match(log.prompts[1], /yes keep it/);
});

test("Resolve: still dirty without a question reports resolve incomplete", async () => {
  const { s, id, resolverWith } = await blocked();
  const { runtime } = fakeRuntime(() => json({ status: "resolved", summary: "did nothing" }));
  const r = await resolverWith(runtime).execute(id);
  assert.match(r.error!, /still has 1 uncommitted/);
  assert.match(s.repoState.item(id)!.pause_reason!, /^resolve incomplete: did nothing/);
  assert.ok(s.events.includes("item.resolve_failed"));
});

test("Resolve: bad JSON is retried once, then fails; the agent is closed either way", async () => {
  const { id, resolverWith } = await blocked();
  const bad = fakeRuntime(() => "no json here");
  const r = await resolverWith(bad.runtime).execute(id);
  assert.match(r.error!, /no valid JSON/);
  assert.equal(bad.log.prompts.length, 2);
  assert.equal(bad.log.closed, 1);
  const boom = fakeRuntime(() => { throw new Error("boom"); });
  assert.match((await resolverWith(boom.runtime).execute(id)).error!, /boom/);
  assert.equal(boom.log.closed, 1);
});

test("Resolve: refused for cards that are not shipped, merged, remote, or not blocked", async () => {
  const { s, id, resolverWith } = await blocked();
  const rt = fakeRuntime(() => json({ status: "resolved", summary: "x" })).runtime;
  const resolver = resolverWith(rt);
  const fresh = s.repoState.addItem({ batch_id: "b", source_kind: "text", source_ref: "p", title: "t", type: "bug", target_repo: "app", role: "coder", model: "m", complexity: 1, depends_on: "[]", claimed_paths: "[]" } as NewItem);
  await assert.rejects(resolver.execute(fresh), BoardError);
  await assert.rejects(resolver.execute(9999), BoardError);
  const remote = new ResolveCheckout(s.repoState, s.ws, rt, { emit() {} }, () => "gitlab", s.inFlight);
  await assert.rejects(remote.execute(id), /remote host/);
  s.repoState.updateItem(id, { pause_reason: "merge blocked: merge conflicts: a.ts" });
  await assert.rejects(resolver.execute(id), /not blocked by uncommitted/);
  s.repoState.updateItem(id, { pause_reason: "merge blocked: the main checkout of app has uncommitted changes", merged_at: "2026-01-01T00:00:00Z" });
  await assert.rejects(resolver.execute(id), /already merged/);
});

test("Resolve: a concurrent Resolve or Merge is rejected while one runs", async () => {
  const { s, id, resolverWith } = await blocked();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { runtime } = fakeRuntime(async () => (await gate, json({ status: "resolved", summary: "x" })));
  const resolver = resolverWith(runtime);
  const first = resolver.execute(id);
  await assert.rejects(resolver.execute(id), /already resolving/);
  await assert.rejects(s.merge.execute(id), /already resolving/);
  release();
  await first;
});

test("Resolve: a card left 'resolve incomplete' can be resolved again, and then Merge succeeds", async () => {
  const { s, id, resolverWith } = await blocked();
  const first = fakeRuntime(() => json({ status: "resolved", summary: "did nothing" }));
  assert.equal((await resolverWith(first.runtime).execute(id)).resolved, false);
  assert.match(s.repoState.item(id)!.pause_reason!, /^resolve incomplete: did nothing/);
  const second = fakeRuntime((_p, cwd) => (sh(cwd, "git add -A && git commit -qm keep"), json({ status: "resolved", summary: "committed" })));
  assert.equal((await resolverWith(second.runtime).execute(id)).resolved, true);
  assert.equal(s.repoState.item(id)!.pause_reason, null);
  assert.equal((await s.merge.execute(id)).error, undefined);
  assert.ok(s.repoState.item(id)!.merged_at);
});

test("Merge: fast-forwards the base branch to the card's branch tip and lands the card in Merged", async () => {
  const s = await sandbox();
  const id = await s.shipped("src/a.ts", "a\n");
  const tip = s.sh(`git rev-parse ${s.repoState.item(id)!.branch}`).trim();
  const r = await s.merge.execute(id);
  assert.deepEqual([r.error, r.fastForward, r.sha], [undefined, true, tip]);
  assert.equal(s.head(), tip);
  assert.ok(existsSync(join(s.repo, "src/a.ts")), "the main checkout shows the change");
  const item = s.repoState.item(id)!;
  assert.ok(item.merged_at);
  assert.equal(item.pause_reason, null);
  assert.equal(columnOf(item), "merged");
  assert.ok(s.events.includes("item.merged"));
});

test("Merge: a diverged base gets a merge commit with two parents", async () => {
  const s = await sandbox();
  const id = await s.shipped("src/a.ts", "a\n");
  writeFileSync(join(s.repo, "src/other.ts"), "o\n");
  s.sh("git add -A && git commit -qm other");
  const r = await s.merge.execute(id);
  assert.equal(r.fastForward, false);
  assert.equal(s.sh("git rev-list --parents -n1 main").trim().split(" ").length, 3);
  assert.ok(existsSync(join(s.repo, "src/a.ts")) && existsSync(join(s.repo, "src/other.ts")));
  assert.equal(s.head(), r.sha);
});

test("Merge: refuses a dirty main checkout (tracked edit or untracked file) and shows why on the card", async () => {
  for (const dirty of ["echo x >> src/shared.ts", "echo x > src/untracked.ts"]) {
    const s = await sandbox();
    const id = await s.shipped("src/a.ts", "a\n");
    const before = s.head();
    s.sh(dirty);
    const r = await s.merge.execute(id);
    assert.match(r.error!, /uncommitted changes/);
    assert.equal(s.head(), before);
    const item = s.repoState.item(id)!;
    assert.match(item.pause_reason!, /^merge blocked: .*uncommitted/);
    assert.equal(item.merged_at, null);
    assert.equal(columnOf(item), "shipped");
    assert.ok(s.events.includes("item.merge_failed"));
  }
});

test("Merge: refuses when the main checkout is not on the base branch", async () => {
  const s = await sandbox();
  const id = await s.shipped("src/a.ts", "a\n");
  const before = s.head();
  s.sh("git checkout -q -b elsewhere");
  const r = await s.merge.execute(id);
  assert.match(r.error!, /is on elsewhere, not main/);
  assert.equal(s.head(), before);
});

test("Merge: a conflict is refused and leaves nothing behind", async () => {
  const s = await sandbox();
  const id = await s.shipped("src/shared.ts", "export const v = 2;\n");
  writeFileSync(join(s.repo, "src/shared.ts"), "export const v = 3;\n");
  s.sh("git commit -qam diverge");
  const before = s.head();
  const r = await s.merge.execute(id);
  assert.match(r.error!, /merge conflicts: src\/shared\.ts/);
  assert.equal(s.head(), before);
  assert.ok(!existsSync(join(s.repo, ".git/MERGE_HEAD")));
  assert.equal(s.sh("git worktree list").trim().split("\n").filter((l) => /sf-merge-[^/]+\/wt\s/.test(l)).length, 0);
  assert.equal(s.sh("git status --porcelain").trim(), "");
});

test("Merge: a red full gate on the merged result leaves the base branch where it was", async () => {
  const s = await sandbox();
  const id = await s.shipped("src/a.ts", "a\n");
  // The branch gained a breaking commit after it was shipped; the gate on the merged result must catch it.
  const branch = s.repoState.item(id)!.branch!;
  s.sh(`git checkout -q ${branch} && echo x > src/broken.ts && git add -A && git commit -qm breaks && git checkout -q main`);
  const before = s.head();
  const worktrees = s.sh("git worktree list").trim().split("\n").length;
  const r = await s.merge.execute(id);
  assert.equal(before, s.head());
  assert.ok(r.error);
  assert.equal(s.repoState.item(id)!.merged_at, null);
  assert.match(s.repoState.item(id)!.pause_reason!, /^merge blocked: /);
  assert.ok(!existsSync(join(s.repo, "src/a.ts")));
  assert.equal(s.sh("git worktree list").trim().split("\n").length, worktrees, "the temp worktree is removed after a red gate");
  assert.equal(s.sh("git status --porcelain").trim(), "");
});

test("Merge: a branch already contained in the base is a no-op that still lands the card in Merged", async () => {
  const s = await sandbox();
  const id = await s.shipped("src/a.ts", "a\n");
  s.sh(`git merge -q --ff-only ${s.repoState.item(id)!.branch}`);
  const before = s.head();
  const r = await s.merge.execute(id);
  assert.deepEqual([r.error, r.sha, r.fastForward], [undefined, before, true]);
  assert.equal(s.head(), before);
  assert.ok(s.repoState.item(id)!.merged_at);
  assert.equal(columnOf(s.repoState.item(id)!), "merged");
});

test("Merge: GitLab/GitHub cards are refused (their MR is merged on the host)", async () => {
  const s = await sandbox({ host: "gitlab" });
  const id = s.repoState.addItem({ batch_id: "b", source_kind: "text", source_ref: "p", title: "t", type: "bug", target_repo: "app", role: "coder", model: "m", complexity: 1, depends_on: "[]", claimed_paths: "[]" } as NewItem);
  s.repoState.updateItem(id, { status: "done", branch: "fix/x", mr_url: "https://gitlab.example/mr/1" });
  await assert.rejects(s.merge.execute(id), (e) => e instanceof BoardError && /remote host/.test(e.message));
  await assert.rejects(s.merge.execute(9999), /no card/);
});

test("Merge: only a shipped, unmerged card can be merged", async () => {
  const s = await sandbox();
  const id = await s.shipped("src/a.ts", "a\n");
  await s.merge.execute(id);
  await assert.rejects(s.merge.execute(id), /already merged/);
  const fresh = s.repoState.addItem({ batch_id: "b", source_kind: "text", source_ref: "p", title: "t", type: "bug", target_repo: "app", role: "coder", model: "m", complexity: 1, depends_on: "[]", claimed_paths: "[]" } as NewItem);
  await assert.rejects(s.merge.execute(fresh), /not shipped/);
});

test("in-flight: a second Ship or Merge for the same card is refused while one runs; other cards and later presses are fine", async () => {
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  let blocking = false;
  const gate: GateRunner = {
    run: async (_t, _wt, kind) => {
      if (kind === "full" && blocking) await hold;
      return { exitOk: true, failures: [], output: "" };
    },
  } as GateRunner;
  const s = await sandbox({ gate });
  const a = await s.shipped("src/a.ts", "a\n", "A");
  const b = await s.shipped("src/b.ts", "b\n", "B");
  const c = s.repoState.addItem({ batch_id: "b", source_kind: "text", source_ref: "p", title: "C", type: "bug", target_repo: "app", role: "coder", model: "m", complexity: 1, depends_on: "[]", claimed_paths: "[]" } as NewItem);
  s.repoState.updateItem(c, { status: "done" });
  await (async () => {
    const wt = await s.ws.prepare(c, "app");
    writeFileSync(join(wt, "src/c.ts"), "c\n");
    await s.ws.commit(wt, c, "row c", ["src/c.ts"]);
  })();
  const board = new SessionBoard(s.repoState, () => ["app"], s.inFlight);

  blocking = true;
  const first = s.merge.execute(a);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(board.card(a).card.busy, "merge");
  assert.equal(board.card(b).card.busy, null);
  await assert.rejects(s.merge.execute(a), /already merging/);
  const [shipAgain] = await s.publish.execute("b", [a]);
  assert.equal(shipAgain, undefined, "a card with a branch has nothing left to ship");
  // Ship of an unshipped card while it is merging is impossible; check Ship vs Ship with the card c.
  const shipC = s.publish.execute("b", [c]);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(board.card(c).card.busy, "ship");
  const [dup] = await s.publish.execute("b", [c]);
  assert.deepEqual(dup, { itemId: c, error: "already shipping" });
  assert.equal(s.repoState.item(c)!.pause_reason, null, "refusing a duplicate does not touch the card");
  await assert.rejects(s.merge.execute(c), /not shipped/);
  blocking = false;
  release();
  assert.equal((await first).error, undefined);
  assert.equal((await shipC)[0].error, undefined);
  assert.equal(board.card(a).card.busy, null);
  assert.equal(board.card(c).card.busy, null);
  assert.equal((await s.merge.execute(b)).error, undefined, "a different card is unaffected");
});

test("in-flight: the guard is released after a failed merge", async () => {
  const s = await sandbox();
  const id = await s.shipped("src/a.ts", "a\n");
  s.sh("echo x >> src/shared.ts");
  assert.ok((await s.merge.execute(id)).error);
  assert.equal(s.inFlight.kindOf(id), null);
  s.sh("git checkout -q -- src/shared.ts");
  assert.equal((await s.merge.execute(id)).error, undefined);
});

const markers = "a\n<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> main\n";
const spyGate = () => {
  const calls: string[] = [];
  const gate = { run: async (_t: string, _w: string, level: string) => (calls.push(level), { exitOk: true, failures: [], output: "" }) } as GateRunner;
  return { gate, calls };
};

test("Merge: committed conflict markers are refused by name and line, before the gate (diverged and fast-forward)", async () => {
  for (const diverge of [true, false]) {
    const calls = spyGate();
    const s = await sandbox({ gate: calls.gate });
    const id = await s.shipped("src/a.ts", "a\n");
    const branch = s.repoState.item(id)!.branch!;
    s.sh(`git checkout -q ${branch} && printf '%s' '${markers}' > src/main.ts && git add -A && git commit -qm conflicted && git checkout -q main`);
    if (diverge) {
      writeFileSync(join(s.repo, "src/other.ts"), "o\n");
      s.sh("git add -A && git commit -qm other");
    }
    const before = s.head();
    calls.calls.length = 0; // ignore the gate runs from shipping
    const r = await s.merge.execute(id);
    assert.match(r.error!, /conflict markers in src\/main\.ts:2/);
    assert.deepEqual(calls.calls, []);
    assert.equal(s.head(), before);
    assert.equal(s.repoState.item(id)!.merged_at, null);
  }
});

test("Workspace.commit: refuses a file with conflict markers (file:line), still commits clean files and lone =======", async () => {
  const s = await sandbox();
  const wt = await s.ws.prepare(99, "app");
  writeFileSync(join(wt, "src/main.ts"), markers);
  await assert.rejects(s.ws.commit(wt, 99, "bad", ["src/main.ts"]), /conflict markers in src\/main\.ts:2/);
  assert.equal(s.sh(`git -C ${wt} diff --cached --name-only`).trim(), "", "nothing stays staged");
  writeFileSync(join(wt, "src/main.ts"), "ok\n");
  writeFileSync(join(wt, "src/doc.md"), "Title\n=======\n");
  assert.ok(await s.ws.commit(wt, 99, "good", ["src/main.ts", "src/doc.md"]));
});
