// BatchRepository on node:sqlite. All batches share one file, runs/factory.db.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { BatchRepository, LoggedEvent } from "../../application/ports/batch-repo.ts";
import type { AgentRun, AgentRunPatch, Batch, Item, ItemPatch, NewItem, Role, SessionTurn, SessionTurnPatch, Turn } from "../../domain/batch.ts";
import type { GateRun } from "../../domain/gate.ts";
import type { Usage } from "../../domain/usage.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS batch (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  status TEXT NOT NULL DEFAULT 'planning',
  worktree TEXT,
  budget_usd REAL NOT NULL,
  spent_usd REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS item (
  id INTEGER PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES batch(id),
  source_kind TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  title TEXT NOT NULL,
  type TEXT NOT NULL,
  target_repo TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'coder',
  model TEXT NOT NULL,
  complexity INTEGER NOT NULL,
  depends_on TEXT NOT NULL DEFAULT '[]',
  claimed_paths TEXT NOT NULL DEFAULT '[]',
  question TEXT,
  notes TEXT NOT NULL DEFAULT '',
  brief TEXT NOT NULL DEFAULT '',
  pause_reason TEXT,
  extra_budget_usd REAL NOT NULL DEFAULT 0,
  run INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'proposed',
  branch TEXT,
  mr_url TEXT,
  merged_at TEXT,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS session_turn (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES item(id),
  n INTEGER NOT NULL,
  trigger TEXT NOT NULL,
  comment TEXT,
  plan_json TEXT,
  plan_status TEXT NOT NULL DEFAULT 'none',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (item_id, n)
);
CREATE TABLE IF NOT EXISTS agent_run (
  id INTEGER PRIMARY KEY,
  session_turn_id INTEGER NOT NULL REFERENCES session_turn(id),
  item_id INTEGER NOT NULL REFERENCES item(id),
  role TEXT NOT NULL,
  subtask TEXT,
  model TEXT NOT NULL,
  sdk_session_id TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  verdict TEXT,
  summary TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT
);
CREATE TABLE IF NOT EXISTS turn (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES item(id),
  agent_run_id INTEGER REFERENCES agent_run(id),
  n INTEGER NOT NULL,
  plan TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  premium_requests REAL NOT NULL DEFAULT 0,
  nano_aiu INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  gate_result TEXT,
  UNIQUE (item_id, n)
);
CREATE TABLE IF NOT EXISTS session_baseline (
  item_id INTEGER NOT NULL REFERENCES item(id),
  target TEXT NOT NULL,
  run_json TEXT NOT NULL,
  PRIMARY KEY (item_id, target)
);
CREATE TABLE IF NOT EXISTS gate_baseline (
  key TEXT PRIMARY KEY,
  run_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS jira_dismissal (
  key TEXT PRIMARY KEY,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE IF NOT EXISTS event (
  id INTEGER PRIMARY KEY,
  item_id INTEGER REFERENCES item(id),
  ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}'
);
`;

export class SqliteBatchRepository implements BatchRepository {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
    this.migrate();
  }

  // CREATE TABLE IF NOT EXISTS never alters an existing table, so columns added after a database was
  // created are added here. Additive only: a newer factory can always open an older runs/factory.db.
  private migrate(): void {
    const added: Record<string, Record<string, string>> = {
      batch: { worktree: "TEXT" },
      item: {
        question: "TEXT",
        notes: "TEXT NOT NULL DEFAULT ''",
        brief: "TEXT NOT NULL DEFAULT ''",
        session_id: "TEXT",
        pause_reason: "TEXT",
        extra_budget_usd: "REAL NOT NULL DEFAULT 0",
        merged_at: "TEXT",
      },
      turn: { agent_run_id: "INTEGER REFERENCES agent_run(id)" },
      session_turn: { plan_json: "TEXT", plan_status: "TEXT NOT NULL DEFAULT 'none'" },
      agent_run: { verdict: "TEXT", summary: "TEXT", subtask: "TEXT" },
    };
    for (const [table, cols] of Object.entries(added)) {
      const have = new Set((this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
      for (const [col, type] of Object.entries(cols)) if (!have.has(col)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
    }
    this.migrateToSessions();
  }

  // Rows that ran before sessions existed become one-turn sessions: their turns are attributed to one coder
  // run, which keeps the old item.session_id so a paused row still resumes. Idempotent.
  private migrateToSessions(): void {
    const hasLegacySession = (this.db.prepare("PRAGMA table_info(item)").all() as { name: string }[]).some((c) => c.name === "session_id");
    const orphans = this.db
      .prepare(`SELECT DISTINCT i.id, i.model, i.status, ${hasLegacySession ? "i.session_id" : "NULL"} AS sdk
                FROM item i JOIN turn t ON t.item_id = i.id WHERE t.agent_run_id IS NULL`)
      .all() as { id: number; model: string; status: string; sdk: string | null }[];
    for (const o of orphans) {
      const st = this.sessionTurns(o.id)[0] ?? this.startSessionTurn(o.id, "intake", null);
      const status = o.status === "done" ? "done" : o.status === "failed" || o.status === "dropped" ? "failed" : "paused";
      const r = this.db
        .prepare("INSERT INTO agent_run (session_turn_id, item_id, role, model, sdk_session_id, status) VALUES (?, ?, 'coder', ?, ?, ?)")
        .run(st.id, o.id, o.model, o.sdk, status);
      this.db.prepare("UPDATE turn SET agent_run_id = ? WHERE item_id = ? AND agent_run_id IS NULL").run(Number(r.lastInsertRowid), o.id);
    }
  }

  createBatch(id: string, budgetUsd: number): void {
    this.db.prepare("INSERT INTO batch (id, budget_usd) VALUES (?, ?)").run(id, budgetUsd);
  }

  batch(id: string): Batch | undefined {
    return this.db.prepare("SELECT * FROM batch WHERE id = ?").get(id) as unknown as Batch | undefined;
  }

  listBatches(limit: number): Batch[] {
    return this.db.prepare("SELECT * FROM batch ORDER BY created_at DESC, rowid DESC LIMIT ?").all(limit) as unknown as Batch[];
  }

  updateBatch(id: string, patch: Partial<Pick<Batch, "status" | "worktree">>): void {
    if (patch.status !== undefined) this.db.prepare("UPDATE batch SET status = ? WHERE id = ?").run(patch.status, id);
    if (patch.worktree !== undefined) this.db.prepare("UPDATE batch SET worktree = ? WHERE id = ?").run(patch.worktree, id);
  }

  addItem(item: NewItem): number {
    const position = (this.db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM item WHERE batch_id = ?").get(item.batch_id) as { p: number }).p;
    const r = this.db
      .prepare(
        `INSERT INTO item (batch_id, source_kind, source_ref, title, type, target_repo, role, model, complexity,
                           depends_on, claimed_paths, question, notes, brief, run, position)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        item.batch_id, item.source_kind, item.source_ref, item.title, item.type, item.target_repo, item.role,
        item.model, item.complexity, item.depends_on, item.claimed_paths, item.question ?? null, item.notes ?? "", item.brief ?? "", item.run ?? 1, position,
      );
    return Number(r.lastInsertRowid);
  }

  item(id: number): Item | undefined {
    return this.db.prepare("SELECT * FROM item WHERE id = ?").get(id) as unknown as Item | undefined;
  }

  items(batchId: string): Item[] {
    return this.db.prepare("SELECT * FROM item WHERE batch_id = ? ORDER BY position").all(batchId) as unknown as Item[];
  }

  // The column list is fixed so callers cannot write arbitrary SQL.
  updateItem(id: number, patch: ItemPatch): void {
    const cols = Object.keys(patch);
    if (!cols.length) return;
    const allowed = new Set(["title", "type", "target_repo", "role", "model", "complexity", "depends_on", "claimed_paths", "question", "notes", "brief", "pause_reason", "extra_budget_usd", "run", "status", "branch", "mr_url", "merged_at", "position"]);
    for (const c of cols) if (!allowed.has(c)) throw new Error(`not an editable item column: ${c}`);
    this.db
      .prepare(`UPDATE item SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`)
      .run(...(Object.values(patch) as (string | number | null)[]), id);
  }

  startSessionTurn(itemId: number, trigger: SessionTurn["trigger"], comment: string | null): SessionTurn {
    const n = (this.db.prepare("SELECT COALESCE(MAX(n), 0) + 1 AS n FROM session_turn WHERE item_id = ?").get(itemId) as { n: number }).n;
    const r = this.db.prepare("INSERT INTO session_turn (item_id, n, trigger, comment) VALUES (?, ?, ?, ?)").run(itemId, n, trigger, comment);
    return this.db.prepare("SELECT * FROM session_turn WHERE id = ?").get(Number(r.lastInsertRowid)) as unknown as SessionTurn;
  }

  sessionTurns(itemId: number): SessionTurn[] {
    return this.db.prepare("SELECT * FROM session_turn WHERE item_id = ? ORDER BY n").all(itemId) as unknown as SessionTurn[];
  }

  updateSessionTurn(id: number, patch: SessionTurnPatch): void {
    if (patch.plan_json !== undefined) this.db.prepare("UPDATE session_turn SET plan_json = ? WHERE id = ?").run(patch.plan_json, id);
    if (patch.plan_status !== undefined) this.db.prepare("UPDATE session_turn SET plan_status = ? WHERE id = ?").run(patch.plan_status, id);
  }

  startAgentRun(sessionTurnId: number, role: Role, model: string, subtask: string | null = null): AgentRun {
    const r = this.db
      .prepare("INSERT INTO agent_run (session_turn_id, item_id, role, subtask, model) SELECT id, item_id, ?, ?, ? FROM session_turn WHERE id = ?")
      .run(role, subtask, model, sessionTurnId);
    return this.db.prepare("SELECT * FROM agent_run WHERE id = ?").get(Number(r.lastInsertRowid)) as unknown as AgentRun;
  }

  agentRuns(itemId: number): AgentRun[] {
    return this.db.prepare("SELECT * FROM agent_run WHERE item_id = ? ORDER BY id").all(itemId) as unknown as AgentRun[];
  }

  updateAgentRun(id: number, patch: AgentRunPatch): void {
    if (patch.sdk_session_id !== undefined) this.db.prepare("UPDATE agent_run SET sdk_session_id = ? WHERE id = ?").run(patch.sdk_session_id, id);
    if (patch.verdict !== undefined) this.db.prepare("UPDATE agent_run SET verdict = ? WHERE id = ?").run(patch.verdict, id);
    if (patch.summary !== undefined) this.db.prepare("UPDATE agent_run SET summary = ? WHERE id = ?").run(patch.summary, id);
    if (patch.status !== undefined) {
      const ended = patch.status === "done" || patch.status === "failed";
      this.db.prepare(`UPDATE agent_run SET status = ?${ended ? ", ended_at = datetime('now')" : ""} WHERE id = ?`).run(patch.status, id);
    }
  }

  startTurn(itemId: number, plan: string | null, agentRunId: number | null = null): Turn {
    const n = (this.db.prepare("SELECT COALESCE(MAX(n), 0) + 1 AS n FROM turn WHERE item_id = ?").get(itemId) as { n: number }).n;
    const r = this.db.prepare("INSERT INTO turn (item_id, agent_run_id, n, plan) VALUES (?, ?, ?, ?)").run(itemId, agentRunId, n, plan);
    return this.db.prepare("SELECT * FROM turn WHERE id = ?").get(Number(r.lastInsertRowid)) as unknown as Turn;
  }

  endTurn(turnId: number, usage: Usage, gate: "green" | "red" | null): void {
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          `UPDATE turn SET ended_at = datetime('now'), tokens_in = ?, tokens_out = ?, premium_requests = ?,
                           nano_aiu = ?, cost_usd = ?, gate_result = ? WHERE id = ?`,
        )
        .run(usage.tokensIn, usage.tokensOut, usage.premiumRequests, usage.nanoAiu, usage.costUsd, gate, turnId);
      this.db
        .prepare(
          `UPDATE batch SET spent_usd = spent_usd + ?
           WHERE id = (SELECT i.batch_id FROM item i JOIN turn t ON t.item_id = i.id WHERE t.id = ?)`,
        )
        .run(usage.costUsd, turnId);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  itemSpendUsd(itemId: number): number {
    return (this.db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS s FROM turn WHERE item_id = ?").get(itemId) as { s: number }).s;
  }

  runSpendUsd(agentRunId: number): number {
    return (this.db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS s FROM turn WHERE agent_run_id = ?").get(agentRunId) as { s: number }).s;
  }

  turns(itemId: number): Turn[] {
    return this.db.prepare("SELECT * FROM turn WHERE item_id = ? ORDER BY n").all(itemId) as unknown as Turn[];
  }

  logEvent(itemId: number | null, kind: string, payload: unknown = {}): void {
    this.db.prepare("INSERT INTO event (item_id, kind, payload_json) VALUES (?, ?, ?)").run(itemId, kind, JSON.stringify(payload));
  }

  itemEvents(itemId: number, limit: number): LoggedEvent[] {
    const rows = this.db.prepare("SELECT id, ts, kind, payload_json FROM event WHERE item_id = ? ORDER BY id DESC LIMIT ?").all(itemId, limit) as {
      id: number; ts: string; kind: string; payload_json: string;
    }[];
    return rows.reverse().map((r) => ({ id: r.id, ts: r.ts, kind: r.kind, payload: JSON.parse(r.payload_json) }));
  }

  reconcile(batchId: string): number[] {
    const stale = this.db.prepare("SELECT id FROM item WHERE batch_id = ? AND status = 'running'").all(batchId) as { id: number }[];
    for (const { id } of stale) {
      this.updateItem(id, { status: "paused", pause_reason: "the factory restarted mid-turn — Continue resumes the same agent run" });
      this.logEvent(id, "reconciled", { from: "running", to: "paused" });
    }
    this.db.prepare("UPDATE turn SET ended_at = datetime('now') WHERE ended_at IS NULL AND item_id IN (SELECT id FROM item WHERE batch_id = ?)").run(batchId);
    this.db.prepare("UPDATE agent_run SET status = 'paused' WHERE status = 'running' AND item_id IN (SELECT id FROM item WHERE batch_id = ?)").run(batchId);
    return stale.map((s) => s.id);
  }

  baseline(itemId: number, target: string): GateRun | undefined {
    const row = this.db.prepare("SELECT run_json FROM session_baseline WHERE item_id = ? AND target = ?").get(itemId, target) as { run_json: string } | undefined;
    return row ? (JSON.parse(row.run_json) as GateRun) : undefined;
  }

  saveBaseline(itemId: number, target: string, run: GateRun): void {
    this.db.prepare("INSERT OR REPLACE INTO session_baseline (item_id, target, run_json) VALUES (?, ?, ?)").run(itemId, target, JSON.stringify(run));
  }

  gateBaseline(key: string): GateRun | undefined {
    const row = this.db.prepare("SELECT run_json FROM gate_baseline WHERE key = ?").get(key) as { run_json: string } | undefined;
    return row ? (JSON.parse(row.run_json) as GateRun) : undefined;
  }

  saveGateBaseline(key: string, run: GateRun): void {
    this.db.prepare("INSERT OR REPLACE INTO gate_baseline (key, run_json) VALUES (?, ?)").run(key, JSON.stringify(run));
  }

  dismissJira(key: string): void {
    this.db.prepare("INSERT OR IGNORE INTO jira_dismissal (key) VALUES (?)").run(key.toUpperCase());
  }

  dismissedJira(): Set<string> {
    return new Set((this.db.prepare("SELECT key FROM jira_dismissal").all() as { key: string }[]).map((r) => r.key));
  }

  close(): void {
    this.db.close();
  }
}
