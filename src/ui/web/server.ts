// Web driving adapter: a small JSON API over the use cases plus the static board page.
// Binds to 127.0.0.1 only — this is a local tool, and the API can spend money.
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join } from "node:path";
import { BoardError, type CellEdit, type EditBoard } from "../../application/edit-board.ts";
import type { CardFileDiff } from "../../application/card-file-diff.ts";
import type { NormalizeIntake } from "../../application/normalize-intake.ts";
import type { PlanBatch } from "../../application/plan-batch.ts";
import type { BatchRepository } from "../../application/ports/batch-repo.ts";
import type { EventStream } from "../../application/ports/events.ts";
import type { ManageTargets } from "../../application/manage-targets.ts";
import type { ResolveCheckout } from "../../application/resolve-checkout.ts";
import type { MergeCard } from "../../application/merge-card.ts";
import type { PublishBatch } from "../../application/publish-batch.ts";
import type { RunBatch } from "../../application/run-batch.ts";
import type { SessionBoard } from "../../application/session-board.ts";
import { splitPaste, type RawEntry } from "../../domain/intake.ts";

export interface WebDeps {
  normalizeIntake: Pick<NormalizeIntake, "execute">;
  planBatch: Pick<PlanBatch, "execute">;
  board: EditBoard;
  batches: Pick<BatchRepository, "listBatches">;
  meta: () => { targets: string[]; local?: string[]; models: string[] };
  targets: Pick<ManageTargets, "list" | "inspect" | "add">;
  runner: Pick<RunBatch, "kick" | "continue" | "kill" | "anotherTurn" | "commentOnPlan" | "approvePlan" | "nudge">;
  events: EventStream;
  publish: Pick<PublishBatch, "execute">;
  merge: Pick<MergeCard, "execute">;
  resolve: Pick<ResolveCheckout, "execute">;
  sessions: Pick<SessionBoard, "board" | "card" | "start">;
  fileDiff: Pick<CardFileDiff, "execute">;
  triage: {
    list(): Promise<{ key: string; summary: string; status: string; onBoard: boolean }[]>;
    dismiss(key: string): Promise<{ ok: true }>;
    comment(key: string, body: string): Promise<{ ok: true }>;
  };
  newBatchId?: () => string;
}

const PUBLIC = join(import.meta.dirname, "public");
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css" };
const MAX_BODY = 25 * 1024 * 1024; // a few pasted screenshots as base64

// Pasted text is split into Jira keys vs free text here, so the page can send raw paste blocks.
type IntakeRequest = { entries: ({ kind: "paste"; text: string } | { kind: "image"; mimeType: string; base64: string; name?: string })[] };

const defaultBatchId = () => {
  const d = new Date();
  const ymd = `${d.getFullYear() % 100}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  return `b-${ymd}-${Math.random().toString(36).slice(2, 6)}`;
};

// The file path is one URL segment (slashes arrive as %2F), so a malformed escape is the client's error.
function decodeFilePath(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new BoardError(`bad file path ${raw}`);
  }
}

// A use case that validates, then runs on in the background (progress arrives over /events). Validation errors
// reject before its first await, so they still surface as a 400; later failures are reported as run events.
async function background(started: Promise<unknown>): Promise<{ ok: true }> {
  started.catch(() => {});
  await Promise.race([started, new Promise((r) => setImmediate(r))]);
  return { ok: true };
}

function jiraKey(raw: string): string {
  let key: string;
  try {
    key = decodeURIComponent(raw);
  } catch {
    throw new BoardError("not a Jira key: malformed encoding");
  }
  if (!/^[A-Z][A-Z0-9_]+-\d+$/.test(key)) throw new BoardError(`not a Jira key: ${key}`);
  return key;
}

export function createWebServer(deps: WebDeps): Server {
  const newBatchId = deps.newBatchId ?? defaultBatchId;

  const routes: [string, RegExp, (m: RegExpMatchArray, body: any) => Promise<unknown> | unknown][] = [
    ["GET", /^\/api\/meta$/, () => deps.meta()],
    ["GET", /^\/api\/targets$/, () => deps.targets.list()],
    ["POST", /^\/api\/targets\/inspect$/, (_m, body: { path?: string }) => deps.targets.inspect(body.path ?? "")],
    ["POST", /^\/api\/targets$/, (_m, body) => deps.targets.add(body)],
    ["GET", /^\/api\/batches$/, () => deps.batches.listBatches(20)],
    ["GET", /^\/api\/jira\/assigned$/, () => deps.triage.list()],
    ["POST", /^\/api\/jira\/([^/]+)\/dismiss$/, (m) => deps.triage.dismiss(jiraKey(m[1]))],
    ["POST", /^\/api\/jira\/([^/]+)\/comment$/, (m, body: { body?: string }) => {
      const text = (body.body ?? "").trim();
      if (!text) throw new BoardError("a comment needs text");
      return deps.triage.comment(jiraKey(m[1]), text);
    }],
    ["GET", /^\/api\/board$/, () => deps.sessions.board()],
    ["GET", /^\/api\/items\/(\d+)$/, (m) => deps.sessions.card(Number(m[1]))],
    ["GET", /^\/api\/items\/(\d+)\/diff\/(.+)$/, (m) => deps.fileDiff.execute(Number(m[1]), decodeFilePath(m[2]))],
    ["POST", /^\/api\/items\/(\d+)\/start$/, (m) => {
      const item = deps.sessions.start(Number(m[1]));
      void deps.runner.kick(item.batch_id); // the planner runs in the background
      return { ok: true };
    }],
    ["POST", /^\/api\/items\/(\d+)\/nudge$/, async (m) => (await deps.runner.nudge(Number(m[1])), { ok: true })],
    ["POST", /^\/api\/items\/(\d+)\/ship$/, async (m) => {
      const id = Number(m[1]);
      const [result] = await deps.publish.execute(deps.sessions.card(id).card.batchId, [id]);
      if (!result) throw new BoardError(`card ${id} is not ready to ship`);
      return result;
    }],
    ["POST", /^\/api\/items\/(\d+)\/merge$/, (m) => deps.merge.execute(Number(m[1]))],
    ["POST", /^\/api\/items\/(\d+)\/resolve$/, (m) => deps.resolve.execute(Number(m[1]))],
    ["GET", /^\/api\/batches\/([\w-]+)$/, (m) => deps.board.view(m[1])],
    ["POST", /^\/api\/intake$/, async (_m, body: IntakeRequest) => {
      const raw: RawEntry[] = (body.entries ?? []).flatMap((e) =>
        e.kind === "paste" ? splitPaste(e.text) : [{ kind: "image" as const, mimeType: e.mimeType, base64: e.base64, name: e.name }],
      );
      if (!raw.length) throw new BoardError("nothing to plan — paste a Jira key, some text, or a screenshot");
      const norm = await deps.normalizeIntake.execute(raw);
      if (!norm.items.length) throw new BoardError(`nothing could be read: ${norm.warnings.join("; ")}`);
      const batchId = newBatchId();
      const plan = await deps.planBatch.execute(batchId, norm.items);
      return { batchId, warnings: norm.warnings, costUsd: norm.usage.costUsd + plan.usage.costUsd, view: deps.board.view(batchId) };
    }],
    ["PATCH", /^\/api\/items\/(\d+)$/, (m, body: CellEdit) => (deps.board.edit(Number(m[1]), body), { ok: true })],
    ["POST", /^\/api\/items\/(\d+)\/answer$/, (m, body: { answer: string }) => (deps.board.answer(Number(m[1]), body.answer ?? ""), { ok: true })],
    ["POST", /^\/api\/items\/(\d+)\/drop$/, (m) => (deps.board.drop(Number(m[1])), { ok: true })],
    ["POST", /^\/api\/batches\/([\w-]+)\/reorder$/, (m, body: { ids: number[] }) => (deps.board.reorder(m[1], body.ids ?? []), { ok: true })],
    ["POST", /^\/api\/batches\/([\w-]+)\/approve$/, (m) => {
      const view = deps.board.approve(m[1]);
      void deps.runner.kick(m[1]); // runs in the background; progress arrives over /events
      return view;
    }],
    ["POST", /^\/api\/items\/(\d+)\/continue$/, (m, body: { extraUsd?: number }) => {
      void deps.runner.continue(Number(m[1]), Math.max(0, Number(body.extraUsd ?? 0)));
      return { ok: true };
    }],
    ["POST", /^\/api\/items\/(\d+)\/plan\/approve$/, (m, body: { plan?: unknown }) => background(deps.runner.approvePlan(Number(m[1]), body.plan))],
    ["POST", /^\/api\/items\/(\d+)\/turn$/, async (m, body: { comment?: string }) => {
      const id = Number(m[1]);
      return background(deps.runner.anotherTurn(id, body.comment ?? ""));
    }],
    ["POST", /^\/api\/items\/(\d+)\/plan\/comment$/, async (m, body: { comment?: string }) => background(deps.runner.commentOnPlan(Number(m[1]), body.comment ?? ""))],
    ["POST", /^\/api\/batches\/([\w-]+)\/publish$/, (m) => deps.publish.execute(m[1])],
    ["POST", /^\/api\/items\/(\d+)\/kill$/, async (m) => (await deps.runner.kill(Number(m[1])), { ok: true })],
  ];

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const sse = url.pathname.match(/^\/api\/batches\/([\w-]+)\/events$/);
      if (sse && req.method === "GET") return stream(res, deps.events, sse[1]);
      if (url.pathname === "/api/events" && req.method === "GET") return stream(res, deps.events, "*");
      if (url.pathname.startsWith("/api/")) {
        for (const [method, re, handler] of routes) {
          const m = url.pathname.match(re);
          if (m && req.method === method) return json(res, 200, await handler(m, method === "GET" ? undefined : await readJson(req)));
        }
        return json(res, 404, { error: `no route ${req.method} ${url.pathname}` });
      }
      return await serveStatic(url.pathname, res);
    } catch (e) {
      const status = e instanceof BoardError ? 400 : e instanceof SyntaxError ? 400 : 500;
      return json(res, status, { error: e instanceof Error ? e.message : String(e) });
    }
  });
}

// Server-sent events: one JSON event per message; a comment every 20 s keeps proxies from closing it.
function stream(res: ServerResponse, events: EventStream, batchId: string) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  res.write(": connected\n\n");
  const off = events.subscribe(batchId, (e) => res.write(`data: ${JSON.stringify(e)}\n\n`));
  const ping = setInterval(() => res.write(": ping\n\n"), 20_000);
  res.on("close", () => {
    off();
    clearInterval(ping);
  });
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new BoardError("request too large");
    chunks.push(c);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function serveStatic(pathname: string, res: ServerResponse) {
  const file = pathname === "/" || !extname(pathname) ? "index.html" : pathname.slice(1);
  if (file.includes("..")) return json(res, 400, { error: "bad path" });
  try {
    const body = await readFile(join(PUBLIC, file));
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    json(res, 404, { error: "not found" });
  }
}
