// Web API over the real use cases with an in-memory repo and fake intake (no model calls).
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { BoardError, EditBoard } from "../src/application/edit-board.ts";
import { PlanBatch } from "../src/application/plan-batch.ts";
import { SessionBoard } from "../src/application/session-board.ts";
import type { Classifier } from "../src/application/ports/classifier.ts";
import type { RunEvent } from "../src/application/ports/events.ts";
import type { TargetSpec } from "../src/domain/target.ts";
import { zeroUsage } from "../src/domain/usage.ts";
import { createWebServer } from "../src/ui/web/server.ts";
import { MemoryBatchRepository } from "./fakes/memory-batch-repo.ts";

const repo = new MemoryBatchRepository();
let seen: unknown[] = [];
const classifier: Classifier = {
  classify: async (items) => ({
    usage: zeroUsage(),
    rows: items.map((it, i) => ({
      intakeIndex: i, title: `do ${it.ref}`, type: "bug" as const, targetRepo: it.kind === "image" ? "unknown" : "acme-app",
      complexity: 1, model: "haiku", lookahead: 1, dependsOn: [], claimedPaths: [`src/${i}/**`],
      question: it.kind === "image" ? "Which screen?" : null,
    })),
  }),
};
const server = createWebServer({
  normalizeIntake: {
    execute: async (raw) => {
      seen = raw;
      return { items: raw.map((r, i) => ({ kind: r.kind, ref: r.kind === "jira" ? r.key : `e${i}`, body: "x" })), warnings: ["w1"], usage: zeroUsage() };
    },
  },
  planBatch: new PlanBatch(repo, classifier, 20),
  board: new EditBoard(repo, () => targetNames, ["haiku", "sonnet"]),
  batches: repo,
  meta: () => ({ targets: targetNames, models: ["haiku", "sonnet"] }),
  targets: {
    list: () => targetNames.map((name) => ({ name, repo: `/r/${name}`, host: "gitlab" as const, baseBranch: "Staging", setup: [], gate: { quick: ["true"], full: ["true"] } })),
    inspect: async (path: string) => ({ repo: path, name: "new", remoteUrl: "git@x:y.git", host: "gitlab" as const, branches: ["Staging"], localBranches: ["Staging"], baseBranch: "Staging", setup: [], gate: { quick: ["true"], full: ["true"] }, notes: [] }),
    add: async (t: TargetSpec) => (targetNames.push(t.name), t),
  },
  triage: {
    list: async () => [{ key: "SF-1", summary: "one", status: "To Do", onBoard: false }],
    dismiss: async (key: string) => (dismissed.push(key), { ok: true as const }),
    comment: async (key: string, body: string) => (jiraComments.push([key, body]), { ok: true as const }),
  },
  newBatchId: () => "b-test",
  runner: {
    kick: async (id: string) => void kicked.push(id), continue: async () => {}, kill: async () => {},
    approvePlan: async (id: number, plan?: unknown) => {
      if (id === 404) throw new BoardError("row 404 has no plan waiting for approval");
      approved.push([id, plan]);
    },
    nudge: async (id: number) => {
      if (id === 404) throw new BoardError(`row ${id} is not approved`);
      nudged.push(id);
    },
    anotherTurn: async (id: number, comment: string) => {
      if (!comment.trim()) throw new BoardError("another turn needs a comment");
      turns.push([id, comment]);
    },
    commentOnPlan: async (id: number, comment: string) => {
      if (!comment.trim()) throw new BoardError("a plan comment needs text");
      turns.push([id, `plan:${comment}`]);
    },
  },
  publish: { execute: async () => [] },
  merge: { execute: async (id: number) => { throw new BoardError(`card ${id} is on a remote host: merge its MR there`); } },
  resolve: { execute: async (id: number) => { if (id === 8) throw new BoardError(`card ${id} is not blocked by uncommitted changes`); return { itemId: id, resolved: true }; } },
  sessions: new SessionBoard(repo, () => targetNames),
  fileDiff: {
    execute: async (id: number, file: string) => {
      if (id === 404) throw new BoardError(`no card ${id}`);
      return { file, diff: `diff of ${file}` };
    },
  },
  events: { subscribe: (_b: string, l: (e: RunEvent) => void) => ((listener = l), () => {}) },
});
const dismissed: string[] = [];
const jiraComments: [string, string][] = [];
const kicked: string[] = [];
const turns: [number, string][] = [];
const nudged: number[] = [];
const approved: [number, unknown][] = [];
const targetNames = ["acme-api", "acme-app"];
let listener: ((e: RunEvent) => void) | undefined;
let base = "";
before(() => new Promise<void>((ok) => server.listen(0, "127.0.0.1", () => { base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; ok(); })));
after(() => new Promise<void>((ok) => server.close(() => ok())));

const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as any };
};

test("web: intake splits pastes into Jira keys vs text, plans a batch, and returns its board", async () => {
  const r = await call("POST", "/api/intake", {
    entries: [{ kind: "paste", text: "ACME-1, ACME-2" }, { kind: "paste", text: "button cut off" }, { kind: "image", mimeType: "image/png", base64: "AAAA" }],
  });
  assert.equal(r.status, 200);
  assert.deepEqual((seen as { kind: string }[]).map((e) => e.kind), ["jira", "jira", "text", "image"]);
  assert.equal(r.body.batchId, "b-test");
  assert.deepEqual(r.body.warnings, ["w1"]);
  assert.equal(r.body.view.items.length, 4);
  assert.match(r.body.view.blockers.join(), /^$/); // the image row is unticked, so nothing blocks yet
});

test("web: board edits, answers, and approve go through validation", async () => {
  const items = (await call("GET", "/api/batches/b-test")).body.items;
  const q = items.find((i: { question: string | null }) => i.question);
  assert.equal((await call("PATCH", `/api/items/${q.id}`, { run: true })).status, 200);
  const blocked = await call("POST", "/api/batches/b-test/approve");
  assert.equal(blocked.status, 400);
  assert.match(blocked.body.error, /pick a repo/);
  assert.equal((await call("PATCH", `/api/items/${q.id}`, { target_repo: "nope" })).status, 400);
  await call("PATCH", `/api/items/${q.id}`, { target_repo: "acme-app" });
  await call("POST", `/api/items/${q.id}/answer`, { answer: "Supplier list" });
  const ok = await call("POST", "/api/batches/b-test/approve");
  assert.equal(ok.status, 200);
  assert.equal(ok.body.batch.status, "approved");
  assert.deepEqual(kicked, ["b-test"], "approve starts the runner");
});

test("web: the events endpoint streams run events as SSE", async () => {
  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/batches/b-test/events`, { signal: ctrl.signal });
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  const reader = res.body!.getReader();
  await reader.read(); // ": connected"
  listener!({ batchId: "b-test", itemId: 1, kind: "gate.green", data: {}, ts: "t" });
  const { value } = await reader.read();
  assert.match(new TextDecoder().decode(value), /^data: \{"batchId":"b-test","itemId":1,"kind":"gate.green"/);
  ctrl.abort();
});

test("web: empty intake is a 400 with a reason; unknown routes 404; meta and the page are served", async () => {
  assert.equal((await call("POST", "/api/intake", { entries: [{ kind: "paste", text: "  " }] })).status, 400);
  assert.equal((await call("GET", "/api/nope")).status, 404);
  assert.deepEqual((await call("GET", "/api/meta")).body.models, ["haiku", "sonnet"]);
  const page = await fetch(`${base}/c/1`);
  assert.match(await page.text(), /Add work[\s\S]*id="kanban"/, "deep links to a card serve the kanban page");
});

test("web: a repo added through the API is offered on the board at once", async () => {
  const found = await call("POST", "/api/targets/inspect", { path: "/somewhere/new" });
  assert.equal(found.body.baseBranch, "Staging");
  const added = await call("POST", "/api/targets", { ...found.body, name: "web-shop", host: "gitlab" });
  assert.equal(added.status, 200);
  assert.ok((await call("GET", "/api/meta")).body.targets.includes("web-shop"));
  assert.ok((await call("GET", "/api/targets")).body.some((t: { name: string }) => t.name === "web-shop"));
});

test("web: a comment on a row opens another session turn; an empty one is a 400", async () => {
  assert.equal((await call("POST", "/api/items/3/turn", { comment: " " })).status, 400);
  assert.deepEqual((await call("POST", "/api/items/3/turn", { comment: "use the date pipe" })).body, { ok: true });
  assert.deepEqual(turns, [[3, "use the date pipe"]]);
});

test("web: a plain-text comment on a proposed plan goes to the runner; a blank one is a 400", async () => {
  const blank = await call("POST", "/api/items/3/plan/comment", { comment: " " });
  assert.equal(blank.status, 400);
  assert.match(JSON.stringify(blank.body), /a plan comment needs text/);
  assert.deepEqual((await call("POST", "/api/items/3/plan/comment", { comment: "split step 2" })).body, { ok: true });
  assert.ok(turns.some(([id, text]) => id === 3 && text === "plan:split step 2"), "the comment reaches commentOnPlan for that row");
});

test("web: approving a plan (optionally edited) goes to the runner; a row without a waiting plan is a 400", async () => {
  assert.equal((await call("POST", "/api/items/404/plan/approve", {})).status, 400);
  assert.deepEqual((await call("POST", "/api/items/5/plan/approve", {})).body, { ok: true });
  assert.deepEqual((await call("POST", "/api/items/6/plan/approve", { plan: { files: ["a"] } })).body, { ok: true });
  assert.deepEqual(approved, [[5, undefined], [6, { files: ["a"] }]]);
});

test("web: nudge goes to the runner; a refused row is a 400", async () => {
  assert.deepEqual((await call("POST", "/api/items/12/nudge")).body, { ok: true });
  assert.deepEqual(nudged, [12]);
  const r = await call("POST", "/api/items/404/nudge");
  assert.equal(r.status, 400);
  assert.match(r.body.error, /not approved/);
});

test("web: Merge is refused with a message for a card that can't be merged", async () => {
  const r = await call("POST", "/api/items/7/merge", {});
  assert.equal(r.status, 400);
  assert.match(r.body.error, /remote host/);
});

test("web: Resolve is routed to the use case", async () => {
  const r = await call("POST", "/api/items/7/resolve", {});
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { itemId: 7, resolved: true });
});

test("web: Resolve refused for a card not blocked by uncommitted changes is a 400 with the message", async () => {
  const r = await call("POST", "/api/items/8/resolve", {});
  assert.equal(r.status, 400);
  assert.match(r.body.error, /not blocked by uncommitted changes/);
});

test("web: the kanban lists every session as a card; card detail, start and ship validate", async () => {
  const board = (await call("GET", "/api/board")).body;
  assert.deepEqual(Object.keys(board.columns), ["intake", "plan", "running", "review", "shipped", "merged"]);
  const started = board.columns.running.filter((c: { batchId: string }) => c.batchId === "b-test");
  assert.ok(started.length > 0, "approved rows show as running");
  assert.equal(started[0].stage, "queued");
  const detail = (await call("GET", `/api/items/${started[0].id}`)).body;
  assert.equal(detail.card.id, started[0].id);
  assert.deepEqual(detail.turns, []);
  assert.match((await call("POST", `/api/items/${started[0].id}/start`)).body.error, /already started/);
  assert.equal((await call("POST", `/api/items/${started[0].id}/ship`)).status, 400, "nothing to ship until it is done");
  assert.equal((await call("GET", "/api/items/9999")).status, 400);
});

test("web: a shipped card's panel offers an answer form for a pending question", async () => {
  const app = await (await fetch(`${base}/app.js`)).text();
  assert.match(app, /function answerForm\(item\)/, "the answer form is a shared helper");
  assert.match(app, /answerForm\(item\)\)\s*: null,\s*card\.column === "merged"/, "the shipped panel renders it");
});

test("web: a pending agent question is visible text above the answer input, not only a placeholder", async () => {
  const app = await (await fetch(`${base}/app.js`)).text();
  const form = app.match(/function answerForm\(item\) \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(form, /h\("p", \{ class: "[^"]*break-words[^"]*" \}, item\.question\)/, "the question is rendered as wrapped text");
  assert.match(form, /placeholder: "Your answer"/, "the input placeholder no longer carries the question");
  assert.match(form, /aria-label": item\.question/, "the input keeps the question as its accessible label");
});

test("web: a long agent question is never truncated, and the answer form is omitted without one", async () => {
  const app = await (await fetch(`${base}/app.js`)).text();
  const form = app.match(/function answerForm\(item\) \{[\s\S]*?\n\}/)?.[0] ?? "";
  const questionP = form.match(/h\("p", \{ class: "([^"]*)" \}, item\.question\)/)?.[1] ?? "";
  assert.ok(questionP, "the question paragraph exists");
  assert.doesNotMatch(questionP, /truncate|line-clamp|whitespace-nowrap|overflow-hidden/, "the question is not cut off");
  assert.match(form, /return item\.question\s*\?/, "no question, no answer form");
});

test("web: the review panel's alerts, title and collapse content wrap instead of clipping", async () => {
  const app = await (await fetch(`${base}/app.js`)).text();
  assert.match(app, /h\("h2", \{ class: "[^"]*min-w-0[^"]*break-words[^"]*" \}/, "the panel title wraps long tokens");
  const alertText = app.match(/role: "alert", class: "alert alert-warning alert-soft text-sm" \}, h\("span", \{ class: "min-w-0 break-words/g) ?? [];
  assert.equal(alertText.length, 2, "the review and shipped pause_reason alerts wrap their text");
  assert.match(app, /h\("span", \{ class: "flex-1 min-w-0 break-words whitespace-pre-wrap" \}, item\.pause_reason\)/, "the needs-you alert text wraps beside its Continue/Kill buttons");
  assert.match(app, /class: "collapse-content min-w-0 break-words"/, "collapse content wraps long tokens");
  const html = await (await fetch(`${base}/`)).text();
  assert.match(html, /#panel \{[^}]*overflow-wrap: anywhere/, "the panel wraps long unbreakable text even when Tailwind CDN is offline");
});

test("web: a shipped card's long branch name is a truncated label with the full name as its title", async () => {
  const app = await (await fetch(`${base}/app.js`)).text();
  assert.match(app, /h\("span", \{ class: "branch-label [^"]*", title: c\.branch \}, c\.branch\)/, "the branch label carries the full name in its title");
  const html = await (await fetch(`${base}/`)).text();
  assert.match(html, /\.branch-label \{[^}]*min-width: 0[^}]*overflow: hidden[^}]*text-overflow: ellipsis[^}]*white-space: nowrap/, "the label truncates with an ellipsis instead of overflowing the card");
});

test("web: the page and app.js are served, and app.js has the structured plan card helpers", async () => {
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  const res = await fetch(`${base}/app.js`);
  assert.equal(res.status, 200);
  const app = await res.text();
  for (const name of ["planView", "chipList", "groupByDir", "statChip"]) {
    assert.match(app, new RegExp(`(function|const) ${name}\\b`), `${name} is defined in app.js`);
  }
});

test("web: the intake page serves the @-mention menu and app.js is served", async () => {
  const html = await (await fetch(`${base}/`)).text();
  assert.match(html, /id="mention-menu"/, "index.html has the #mention-menu element");
  assert.match(html, /@/, "page mentions @");
  const res = await fetch(`${base}/app.js`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /mention-menu/, "app.js wires the mention menu");
});

test("web: the plan card renders from plan fields: one coder, waves, orphan files, risks, long file lists, untrusted text", async () => {
  const app = await (await fetch(`${base}/app.js`)).text();
  const fnSource = (name: string): string => {
    const start = app.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `${name} is defined in app.js`);
    let depth = 0;
    for (let j = app.indexOf("{", start); j < app.length; j++) {
      if (app[j] === "{") depth++;
      else if (app[j] === "}" && --depth === 0) return app.slice(start, j + 1);
    }
    throw new Error(`${name} has no closing brace`);
  };
  const oneLine = (name: string): string => {
    const line = app.match(new RegExp(`^const ${name} = .*;$`, "m"))?.[0];
    assert.ok(line, `${name} is defined in app.js`);
    return line;
  };
  type Node = { tag: string; attrs: Record<string, unknown>; kids: unknown[] };
  const h = (tag: string, attrs: Record<string, unknown> = {}, ...kids: unknown[]): Node => ({ tag, attrs, kids });
  const { planView } = new Function("h",
    [oneLine("fileBadge"), oneLine("statChip"), oneLine("section"), fnSource("groupByDir"), fnSource("chipList"),
      fnSource("waves"), fnSource("subtaskGraph"), fnSource("planView"), "return { planView };"].join("\n"))(h) as {
    planView: (plan: Record<string, unknown>) => unknown;
  };
  const textOf = (n: unknown): string => Array.isArray(n) ? n.map(textOf).join("") : n && typeof n === "object" ? textOf((n as Node).kids) : n == null || n === false ? "" : String(n);
  const find = (n: unknown, pred: (x: Node) => boolean, out: Node[] = []): Node[] => {
    if (Array.isArray(n)) n.forEach((x) => find(x, pred, out));
    else if (n && typeof n === "object") {
      if (pred(n as Node)) out.push(n as Node);
      find((n as Node).kids, pred, out);
    }
    return out;
  };
  const alerts = (tree: unknown) => find(tree, (x) => x.attrs.role === "alert");
  const badgesOf = (tree: unknown, cls: string) => find(tree, (x) => x.tag === "span" && String(x.attrs.class ?? "").includes(cls));

  const single = planView({ approach: "Guard the null", rootCause: "x is undefined", files: ["src/a.ts"], testFiles: ["test/a.test.ts"], testPlan: "", risks: "none", subtasks: [] });
  assert.match(textOf(single), /One coder \(no split\)\./, "no subtasks falls back to one coder");
  assert.match(textOf(single), /1 coder/);
  assert.equal(alerts(single).length, 0, "risks of 'none' show no alert");
  assert.match(textOf(single), /Test plan[\s\S]*—/, "an empty test plan shows a dash");

  const multi = planView({
    approach: "Split the work", rootCause: "r", files: ["db/schema.sql", "src/api/a.ts", "src/ui/app.js", "src/orphan/x.ts"], testFiles: [],
    testPlan: "- run migrations\n* smoke test UI", risks: "Schema migration locks the table",
    subtasks: [
      { id: "s1", title: "Schema", files: ["db/schema.sql"], dependsOn: [] },
      { id: "s2", title: "API", files: ["src/api/a.ts"], dependsOn: [] },
      { id: "s3", title: "UI", files: ["src/ui/app.js"], dependsOn: ["s1", "s2"] },
    ],
  });
  const text = textOf(multi);
  assert.match(text, /wave 1/);
  assert.match(text, /wave 2/);
  assert.equal(text.split("parallel").length - 1, 1, "only the wave with two coders is marked parallel");
  assert.match(text, /3 coders/);
  assert.match(text, /2 waves/);
  const fileChips = (tree: unknown) => badgesOf(tree, "badge-ghost");
  const warnChips = fileChips(multi).filter((x) => String(x.attrs.class).includes("badge-warning"));
  assert.deepEqual(warnChips.map(textOf), ["⚠ x.ts"], "only the file no subtask covers gets a warning chip");
  assert.match(textOf(alerts(multi)), /Risks: Schema migration locks the table/, "real risks show as a warning alert");
  assert.match(text, /run migrations/);
  assert.doesNotMatch(text, /- run migrations/, "test-plan bullets are stripped into checklist items");

  for (const risks of ["", "None.", "n/a", "—"]) {
    assert.equal(alerts(planView({ approach: "a", files: [], testFiles: [], testPlan: "", risks })).length, 0, `risks ${JSON.stringify(risks)} show no alert`);
  }

  const many = Array.from({ length: 120 }, (_, i) => `pkg${i % 6}/module-${i}.ts`);
  const big = planView({ approach: "a", files: many, testFiles: many.slice(0, 40), testPlan: "", risks: "", subtasks: [] });
  assert.equal(badgesOf(big, "badge-ghost").length, 160, "every file and test file is a chip");
  assert.match(textOf(big), /Files \(120\)/);
  assert.match(textOf(big), /Test files \(40\)/);
  assert.match(textOf(big), /pkg0\//, "chips are grouped under their directory");

  const hostile = planView({ approach: "<img src=x onerror=alert(1)>", rootCause: "<b>x</b>", files: ["<i>f.ts</i>"], testFiles: [], testPlan: "<script>1</script>", risks: "<u>r</u>" });
  assert.match(textOf(hostile), /<img src=x onerror=alert\(1\)>/, "plan text stays literal text");
  assert.equal(find(hostile, (x) => x.tag === "img" || x.tag === "script").length, 0, "no markup from plan text becomes elements");
  for (const name of ["planView", "subtaskGraph", "chipList", "groupByDir", "waves"]) {
    assert.doesNotMatch(fnSource(name), /innerHTML|insertAdjacentHTML/, `${name} renders plan text as text nodes`);
  }

  const empty = planView({});
  assert.match(textOf(empty), /One coder \(no split\)\./, "a plan with no fields still renders");
});

test("web: plan file badges are buttons titled with the full path, click opens that file's diff, orphans keep their warning", async () => {
  const app = await (await fetch(`${base}/app.js`)).text();
  const oneLine = (name: string): string => {
    const line = app.match(new RegExp(`^const ${name} = .*;$`, "m"))?.[0];
    assert.ok(line, `${name} is defined in app.js`);
    return line;
  };
  const fnSource = (name: string): string => {
    const start = app.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `${name} is defined in app.js`);
    let depth = 0;
    for (let j = app.indexOf("{", start); j < app.length; j++) {
      if (app[j] === "{") depth++;
      else if (app[j] === "}" && --depth === 0) return app.slice(start, j + 1);
    }
    throw new Error(`${name} has no closing brace`);
  };
  type Node = { tag: string; attrs: Record<string, any>; kids: unknown[] };
  const h = (tag: string, attrs: Record<string, unknown> = {}, ...kids: unknown[]): Node => ({ tag, attrs, kids });
  const opened: string[] = [];
  const { planView } = new Function("h", "opened",
    ["const openFileDiff = (f) => opened.push(f);", oneLine("fileBadge"), oneLine("statChip"), oneLine("section"), fnSource("groupByDir"), fnSource("chipList"),
      fnSource("waves"), fnSource("subtaskGraph"), fnSource("planView"), "return { planView };"].join("\n"))(h, opened) as {
    planView: (plan: Record<string, unknown>) => unknown;
  };
  const textOf = (n: unknown): string => Array.isArray(n) ? n.map(textOf).join("") : n && typeof n === "object" ? textOf((n as Node).kids) : n == null || n === false ? "" : String(n);
  const find = (n: unknown, pred: (x: Node) => boolean, out: Node[] = []): Node[] => {
    if (Array.isArray(n)) n.forEach((x) => find(x, pred, out));
    else if (n && typeof n === "object") {
      if (pred(n as Node)) out.push(n as Node);
      find((n as Node).kids, pred, out);
    }
    return out;
  };
  const tree = planView({
    approach: "a", rootCause: "r", files: ["src/api/a.ts", "src/orphan/x.ts"], testFiles: ["test/a.test.ts"], testPlan: "", risks: "",
    subtasks: [{ id: "s1", title: "API", files: ["src/api/a.ts"], dependsOn: [] }, { id: "s2", title: "Docs", files: [], dependsOn: ["s1"] }],
  });
  const badges = find(tree, (x) => x.tag === "span" && x.attrs.role === "button");
  const byTitle = Object.fromEntries(badges.map((b) => [b.attrs.title as string, b]));
  for (const full of ["src/api/a.ts", "src/orphan/x.ts", "test/a.test.ts"]) {
    assert.ok(byTitle[full], `${full} is a button titled with its full path`);
    assert.equal(byTitle[full].attrs.tabindex, "0", `${full} is keyboard focusable`);
  }
  const orphan = byTitle["src/orphan/x.ts"];
  assert.equal(textOf(orphan), "⚠ x.ts", "an orphan keeps its warning label");
  assert.match(String(orphan.attrs.class), /badge-warning/, "an orphan keeps its warning styling");

  let stopped = false;
  byTitle["src/api/a.ts"].attrs.onclick({ stopPropagation: () => { stopped = true; } });
  assert.deepEqual(opened, ["src/api/a.ts"], "clicking a plan file opens its diff by full path");
  assert.ok(stopped, "the click does not bubble to the card");
  let enterPrevented = false;
  byTitle["test/a.test.ts"].attrs.onkeydown({ key: "Enter", preventDefault: () => { enterPrevented = true; }, stopPropagation: () => {} });
  assert.deepEqual(opened.at(-1), "test/a.test.ts", "Enter on a focused test file opens its diff");
  assert.ok(enterPrevented);

  assert.match(app, /api\("GET", `\/api\/items\/\$\{openId\}\/diff\/\$\{encodeURIComponent\(file\)\}`\)/, "the diff is requested with the encoded path");
  assert.match(app, /No changes on the session branch yet\./, "an empty diff shows a friendly message");
  assert.match(app, /!\$\("#file-diff"\)\.open/, "Escape closes the diff dialog before the card");

  const page = await (await fetch(`${base}/`)).text();
  assert.match(page, /<dialog id="file-diff"/, "the file-diff dialog is in the page");
  assert.match(page, /id="file-diff-title"/);
  assert.match(page, /<pre id="file-diff-body"[^>]*overflow-auto/, "the diff body scrolls in a pre");
});

test("web: the plan approve and edit flows still POST the same way and the card sits above the editor", async () => {
  const app = await (await fetch(`${base}/app.js`)).text();
  assert.ok(app.includes('api("POST", `/api/items/${item.id}/plan/approve`, changed ? { plan: edited } : {})'), "the editor approve sends the edited plan only when changed");
  assert.ok(app.includes('api("POST", `/api/items/${item.id}/plan/approve`, {})'), "the card's approve sends an empty body");
  assert.match(app, /sticky bottom-0[^"]*"[\s\S]*Approve plan → run/, "the approve action is a sticky footer");
  assert.ok(app.includes("`/api/items/${item.id}/plan/comment`") && app.includes("Send comment → re-plan"), "the plan comment form posts to /plan/comment");
  assert.match(app, /"Edit plan"/, "the Edit toggle is present");
  const planViewAt = app.indexOf("[planView(t.plan),");
  assert.ok(planViewAt > 0 && planViewAt < app.indexOf('"Edit plan"'), "the card is rendered above the editor");
});

test("web: a shipped card renders its long branch as a titled truncation label beside Merge; an MR link replaces both", async () => {
  const app = await (await fetch(`${base}/app.js`)).text();
  const fnSource = (name: string): string => {
    const start = app.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `${name} is defined in app.js`);
    let depth = 0;
    for (let j = app.indexOf("{", start); j < app.length; j++) {
      if (app[j] === "{") depth++;
      else if (app[j] === "}" && --depth === 0) return app.slice(start, j + 1);
    }
    throw new Error(`${name} has no closing brace`);
  };
  const busyLabel = app.match(/^const busyLabel = .*;$/m)?.[0];
  assert.ok(busyLabel, "busyLabel is defined in app.js");
  const resolveHelpers = app.match(/^const blockedByDirtyCheckout = .*;\nconst resolveBtn = .*;$/m)?.[0];
  assert.ok(resolveHelpers, "the resolve helpers are defined in app.js");
  type Node = { tag: string; attrs: Record<string, unknown>; kids: unknown[] };
  const h = (tag: string, attrs: Record<string, unknown> = {}, ...kids: unknown[]): Node => ({ tag, attrs, kids });
  const stub = () => undefined;
  const { cardActions } = new Function("h", "stop", "act", "api", "openCard", "ship", "merge", "mrLabel", "chip", "resolveCheckout",
    `${busyLabel}\n${resolveHelpers}\n${fnSource("actionBtn")}\n${fnSource("cardActions")}\nreturn { cardActions };`)(
    h, (fn: () => void) => () => fn(), stub, stub, stub, stub, stub, (label: string) => label, () => ({}), stub);

  const branch = "feat/add-merge-action-and-merged-column-for-shipped-local-cards-with-a-very-long-suffix";
  const card = { id: 6, column: "shipped", branch, mrUrl: null, busy: null, spentUsd: 1.04 };
  const [label, merge] = cardActions(card) as [Node, Node];
  assert.equal(label.tag, "span");
  assert.match(String(label.attrs.class), /\bbranch-label\b/, "the label carries the truncation class");
  assert.equal(label.attrs.title, branch, "the title holds the full branch name");
  assert.deepEqual(label.kids, [branch]);
  assert.equal(merge.tag, "button");
  assert.equal(merge.attrs.disabled, false, "Merge stays pressable when the card is idle");
  assert.deepEqual(merge.kids, ["Merge"]);

  const busy = cardActions({ ...card, busy: "merge" }) as [Node, Node];
  assert.match(String(busy[0].attrs.class), /\bbranch-label\b/, "the label is still truncated while merging");
  assert.equal(busy[1].attrs.disabled, true);
  assert.deepEqual(busy[1].kids.slice(-1), ["Merging…"]);

  const linked = cardActions({ ...card, mrUrl: "https://gitlab.example/g/p/-/merge_requests/7" }) as Node[];
  assert.equal(linked.length, 1, "a card with an MR shows only the MR link");
  assert.equal(linked[0].tag, "a");
  assert.ok(!linked.some((n) => /branch-label/.test(String(n.attrs.class))), "no branch label once an MR exists");
});

test("web: a card file's diff is served by its encoded path (slashes as %2F); unknown cards are a 400", async () => {
  const r = await call("GET", `/api/items/3/diff/${encodeURIComponent("src/ui/deep/b.ts")}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { file: "src/ui/deep/b.ts", diff: "diff of src/ui/deep/b.ts" });
  assert.equal((await call("GET", `/api/items/404/diff/${encodeURIComponent("src/a.ts")}`)).status, 400);
  assert.equal((await call("GET", "/api/items/3/diff/%E0%A4%A")).status, 400, "a malformed escape is a 400");
});

test("web: the page uses the custom light green DaisyUI theme", async () => {
  const html = await (await fetch(`${base}/`)).text();
  assert.match(html, /<html[^>]*data-theme="tweakcn-light-green"/);
  assert.match(html, /\[data-theme="tweakcn-light-green"\]\s*\{[^}]*--color-primary:/);
  assert.doesNotMatch(html, /luxury/);
  assert.match(html, /#panel \{[^}]*box-shadow: -8px 0 24px rgb\(0 0 0 \/ \.15\)/, "the side panel shadow is tuned for a light page");
});

test("web: panel re-renders keep typed drafts of the answer and comment boxes", async () => {
  const app = await (await fetch(`${base}/app.js`)).text();
  for (const key of ["answer:${item.id}", "plan-comment:${item.id}", "review-comment:${item.id}", "title:${item.id}"]) {
    assert.ok(app.includes(`"data-draft": \`${key}\``), `${key} is a draft key`);
  }
  assert.match(app, /function captureDrafts\(/);
  assert.match(app, /restoreDrafts\(p, saved\)/, "renderPanel restores drafts after replaceChildren");
  assert.match(app, /next === lastDetailJson/, "an unchanged card skips the re-render");
});

// Pull one top-level `[async] function name(...) {...}` out of app.js so its real logic runs against fake DOM nodes.
function extractFunction(src: string, name: string): string {
  const decl = src.indexOf(`function ${name}(`);
  assert.ok(decl >= 0, `${name} is defined in app.js`);
  const start = src.lastIndexOf("\n", decl) + 1;
  let paren = 0;
  let i = src.indexOf("(", decl);
  for (; i < src.length; i++) {
    if (src[i] === "(") paren++;
    else if (src[i] === ")" && --paren === 0) break;
  }
  const open = src.indexOf("{", i);
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}" && --depth === 0) return src.slice(start, j + 1);
  }
  throw new Error(`${name} has no closing brace`);
}

type FakeEl = {
  value: string; defaultValue: string; dataset: { draft?: string };
  selectionStart: number; selectionEnd: number; focused: boolean;
  focus(): void; setSelectionRange(s: number, e: number): void;
};
function fakeControl(draft: string | undefined, value = "", defaultValue = ""): FakeEl {
  const el: FakeEl = {
    value, defaultValue, dataset: draft === undefined ? {} : { draft },
    selectionStart: value.length, selectionEnd: value.length, focused: false,
    focus() { el.focused = true; }, setSelectionRange(s, e) { el.selectionStart = s; el.selectionEnd = e; },
  };
  return el;
}
function fakeRoot(controls: FakeEl[]) {
  return {
    querySelectorAll: () => controls,
    contains: (n: unknown) => controls.includes(n as FakeEl),
  };
}

test("web: captured drafts and focus are restored onto rebuilt controls, and untouched fields keep server values", async () => {
  const app = await (await fetch(`${base}/app.js`)).text();
  const sandbox = new Function("document", `${extractFunction(app, "captureDrafts")}\n${extractFunction(app, "restoreDrafts")}\nreturn { captureDrafts, restoreDrafts };`);

  const typed = fakeControl("answer:7", "half a thought", "");
  const title = fakeControl("title:7", "Server title", "Server title");
  typed.selectionStart = 4; typed.selectionEnd = 6;
  const oldRoot = fakeRoot([typed, title]);
  const { captureDrafts, restoreDrafts } = sandbox({ activeElement: typed });
  const saved = captureDrafts(oldRoot);
  assert.deepEqual([...saved.drafts.entries()], [["answer:7", "half a thought"]], "only edited fields are captured");
  assert.deepEqual(saved.focus, { key: "answer:7", start: 4, end: 6 });

  const freshAnswer = fakeControl("answer:7", "", "");
  const freshTitle = fakeControl("title:7", "Server title renamed", "Server title renamed");
  const newRoot = fakeRoot([freshAnswer, freshTitle]);
  restoreDrafts(newRoot, saved);
  assert.equal(freshAnswer.value, "half a thought", "the typed answer survives the rebuild");
  assert.equal(freshTitle.value, "Server title renamed", "an unedited field keeps the fresh server value");
  assert.equal(freshAnswer.focused, true, "focus returns to the draft control");
  assert.deepEqual([freshAnswer.selectionStart, freshAnswer.selectionEnd], [4, 6], "caret selection is restored");
});

test("web: with no typed drafts or focus on a control, capture and restore leave the rebuilt panel untouched", async () => {
  const app = await (await fetch(`${base}/app.js`)).text();
  const { captureDrafts, restoreDrafts } = new Function("document", `${extractFunction(app, "captureDrafts")}\n${extractFunction(app, "restoreDrafts")}\nreturn { captureDrafts, restoreDrafts };`)({ activeElement: null });
  const saved = captureDrafts(fakeRoot([fakeControl("answer:9")]));
  assert.equal(saved.drafts.size, 0);
  assert.equal(saved.focus, null);
  const fresh = fakeControl("answer:9", "", "");
  restoreDrafts(fakeRoot([fresh]), saved);
  assert.equal(fresh.value, "");
  assert.equal(fresh.focused, false);
});

test("web: a sent draft is cleared by act so the re-render cannot bring it back", async () => {
  const app = await (await fetch(`${base}/app.js`)).text();
  const sandbox = new Function("toast", "refreshAll", "document", `${extractFunction(app, "act")}\nreturn act;`);
  const act = sandbox(() => {}, async () => {}, {});
  const box = fakeControl("answer:3", "sent text", "");
  await act(async () => {}, undefined, box);
  assert.equal(box.value, "", "a successful submit empties the box");
  const failing = fakeControl("answer:3", "keep me", "");
  await act(async () => { throw new Error("boom"); }, undefined, failing);
  assert.equal(failing.value, "keep me", "a failed submit keeps the typed text for a retry");
});

test("web: /api/jira lists, dismisses and comments, rejecting bad keys and empty comments", async () => {
  const list = await call("GET", "/api/jira/assigned");
  assert.equal(list.status, 200);
  assert.deepEqual((list.body as { key: string }[]).map((r) => r.key), ["SF-1"]);
  assert.equal((await call("POST", "/api/jira/SF-1/dismiss")).status, 200);
  assert.deepEqual(dismissed, ["SF-1"]);
  assert.equal((await call("POST", "/api/jira/nope/dismiss")).status, 400);
  assert.equal((await call("POST", "/api/jira/SF-1/comment", { body: " hi " })).status, 200);
  assert.deepEqual(jiraComments, [["SF-1", "hi"]]);
  assert.equal((await call("POST", "/api/jira/SF-1/comment", { body: "  " })).status, 400);
  assert.equal((await call("POST", "/api/jira/bad/comment", { body: "x" })).status, 400);
  assert.equal((await call("POST", "/api/jira/%E0%A4%A/dismiss")).status, 400);
});
