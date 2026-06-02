import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import path from 'node:path';
import fs from 'node:fs';
import type { ToolCall } from '@r2/shared';
import type { TopicDetector } from './topics/detector.js';
import { resolveProjectPath } from './path-utils.js';

let db: Database.Database | null = null;
let topicDetector: TopicDetector | null = null;

export function setTopicDetector(detector: TopicDetector | null): void {
  topicDetector = detector;
}

export function initDb(dbPath?: string): void {
  if (db) {
    db.close();
    db = null;
  }

  const resolvedPath = dbPath ?? resolveProjectPath(
    process.env.DB_PATH,
    ['data', 'r2.db'],
  );
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  db = new Database(resolvedPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // The kill-switch must really kill: if the user disables memory we skip the
  // sqlite-vec extension load AND the vec0 virtual tables. Otherwise a broken
  // sqlite-vec build would still take down server startup, defeating the
  // purpose of MEMORY_ENABLED=false as an escape hatch.
  const memoryEnabled = (process.env.MEMORY_ENABLED ?? 'true') !== 'false';
  if (memoryEnabled) {
    sqliteVec.load(db);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      source_id TEXT,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_memory_entries_kind
      ON memory_entries(kind, created_at)
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      superseded_by INTEGER REFERENCES memory_facts(id),
      last_mentioned_at INTEGER NOT NULL
    )
  `);

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_facts_key_active
      ON memory_facts(key) WHERE superseded_by IS NULL
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  if (memoryEnabled) {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_vec_entries USING vec0(
        entity_id INTEGER PRIMARY KEY,
        embedding FLOAT[1024] distance_metric=cosine
      )
    `);

    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_vec_facts USING vec0(
        entity_id INTEGER PRIMARY KEY,
        embedding FLOAT[1024] distance_metric=cosine
      )
    `);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL,
      schedule_json TEXT NOT NULL,
      next_fire_at_ms INTEGER NOT NULL,
      cycle_stage TEXT NOT NULL DEFAULT 'idle',
      cycle_num INTEGER NOT NULL DEFAULT 0,
      cycle_stage_ends_at_ms INTEGER,
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_reminders_next_fire
      ON reminders(next_fire_at_ms)
      WHERE active = 1
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tool_name TEXT NOT NULL,
      input TEXT NOT NULL,
      result TEXT NOT NULL,
      success INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS permission_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tool_name TEXT NOT NULL UNIQUE,
      allowed INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS pii_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT NOT NULL UNIQUE,
      encrypted_value TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT DEFAULT (datetime('now', '+7 days'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      tool_calls TEXT,
      pii_entities TEXT,
      timestamp INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS prompt_overlays (
      model TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS cognition_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      paused INTEGER NOT NULL DEFAULT 0,
      paused_at INTEGER
    )
  `);
  db.exec(`INSERT OR IGNORE INTO cognition_state (id, paused) VALUES (1, 0)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS cognition_ticks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tick_at INTEGER NOT NULL
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_cognition_ticks_at
      ON cognition_ticks(tick_at)
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS cognition_handler_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      handler_name TEXT NOT NULL,
      fired_at INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ('publish', 'skip', 'error')),
      content TEXT,
      reason TEXT,
      published_at INTEGER
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_cognition_handler_runs_name_at
      ON cognition_handler_runs(handler_name, fired_at DESC)
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS email_account_state (
      account_id TEXT PRIMARY KEY,
      last_seen_uid INTEGER NOT NULL DEFAULT 0,
      last_poll_at INTEGER,
      last_error TEXT,
      uid_validity INTEGER
    )
  `);

  // Migration: add `uid_validity` column if missing. Stores the mailbox
  // UIDVALIDITY alongside `last_seen_uid` so the poller can detect a mailbox
  // recreation (UIDVALIDITY change) and self-heal instead of going silently
  // blind. Nullable, no DEFAULT — NULL means "baseline not yet recorded".
  const emailStateCols = db
    .prepare("PRAGMA table_info(email_account_state)")
    .all() as Array<{ name: string }>;
  if (!emailStateCols.some((c) => c.name === 'uid_validity')) {
    db.exec(`ALTER TABLE email_account_state ADD COLUMN uid_validity INTEGER`);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS email_pending (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id TEXT NOT NULL,
      message_uid INTEGER NOT NULL,
      from_addr TEXT NOT NULL,
      subject TEXT NOT NULL,
      snippet TEXT NOT NULL,
      importance INTEGER NOT NULL,
      received_at INTEGER NOT NULL,
      added_at INTEGER NOT NULL,
      delivered_at INTEGER,
      UNIQUE(account_id, message_uid)
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_email_pending_undelivered
      ON email_pending(delivered_at, importance DESC, received_at DESC)
  `);

  // Migration: add `urgent_pinged_at` column if missing. Tracks when an
  // importance=5 row was published as an urgent Discord ping so the
  // emailUrgent handler can find the next un-pinged row.
  const emailPendingCols = db
    .prepare("PRAGMA table_info(email_pending)")
    .all() as Array<{ name: string }>;
  if (!emailPendingCols.some((c) => c.name === 'urgent_pinged_at')) {
    db.exec(`ALTER TABLE email_pending ADD COLUMN urgent_pinged_at INTEGER`);
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_email_pending_urgent_unpinged
      ON email_pending(importance, urgent_pinged_at)
      WHERE urgent_pinged_at IS NULL
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS email_sent_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL CHECK(action IN ('sent','cancelled','error')),
      draft_id TEXT NOT NULL,
      to_addr TEXT NOT NULL,
      subject TEXT NOT NULL,
      error_message TEXT,
      created_at INTEGER NOT NULL
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_email_sent_log_action_at
      ON email_sent_log(action, created_at DESC)
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS email_suppression_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_type TEXT NOT NULL CHECK(rule_type IN ('sender', 'subject')),
      pattern TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER,
      created_via TEXT NOT NULL DEFAULT 'discord_button'
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_email_suppression_rules_type_pattern
      ON email_suppression_rules(rule_type, pattern)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_email_suppression_rules_expires
      ON email_suppression_rules(expires_at)
  `);

  // Implicit feedback (silence-as-data): one row per urgent-pinged email,
  // tracking whether the user replied (\Answered), read-but-ignored (\Seen,
  // no reply within window), or never opened it. pending_id references
  // email_pending.id. Terminal once resolved_at + outcome are set.
  db.exec(`
    CREATE TABLE IF NOT EXISTS email_feedback (
      pending_id INTEGER PRIMARY KEY REFERENCES email_pending(id),
      pinged_at INTEGER NOT NULL,
      seen_at INTEGER,
      answered_at INTEGER,
      resolved_at INTEGER,
      outcome TEXT CHECK (outcome IN ('replied', 'read', 'ignored')),
      created_at INTEGER NOT NULL
    )
  `);
  // Index for the "find unresolved" sweep: resolved_at IS NULL rows, scanned
  // each poll tick to re-poll flags and finalize outcomes.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_email_feedback_unresolved
      ON email_feedback(resolved_at, outcome)
  `);

  // Migration: add `source` column if missing
  const cols = db.prepare("PRAGMA table_info(chat_messages)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'source')) {
    db.exec(`ALTER TABLE chat_messages ADD COLUMN source TEXT`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_chat_messages_source ON chat_messages(source, timestamp)`);
  // Support queries that filter/sort by timestamp without a source filter
  // (e.g., morningBrief's activity check and recent-context fetch). The
  // (source, timestamp) index can't service these — SQLite needs the leading
  // column in the WHERE clause.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_chat_messages_timestamp ON chat_messages(timestamp)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_topics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT,
      summary TEXT,
      importance INTEGER,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      status TEXT NOT NULL CHECK (status IN ('open','closed','finalized')),
      source TEXT,
      finalized_at INTEGER,
      failure_count INTEGER NOT NULL DEFAULT 0
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_chat_topics_status ON chat_topics(status, ended_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_chat_topics_finalized ON chat_topics(finalized_at)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_topic_messages (
      topic_id INTEGER NOT NULL REFERENCES chat_topics(id) ON DELETE CASCADE,
      message_id TEXT NOT NULL,
      PRIMARY KEY (topic_id, message_id)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_chat_topic_messages_msg ON chat_topic_messages(message_id)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS window_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      app_name TEXT NOT NULL,
      window_title TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      sample_count INTEGER NOT NULL DEFAULT 1
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_window_history_last_seen
      ON window_history(last_seen_at DESC)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_window_history_app_last_seen
      ON window_history(app_name, last_seen_at DESC)
  `);
  // Serves morningBrief's hasWindowActivitySince range scan on started_at
  // (session-start signal), independent of last_seen_at.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_window_history_started
      ON window_history(started_at)
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS context_pings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      away_app TEXT NOT NULL,
      pinged_at INTEGER NOT NULL,
      away_session_started_at INTEGER NOT NULL,
      away_session_ended_at INTEGER NOT NULL
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_context_pings_app_at
      ON context_pings(away_app, pinged_at DESC)
  `);

  // distractionPullback: one row per AI evaluation of a "stuck" dwell. A dwell
  // is keyed by (app_name, dwell_started_at = runStart); window_title +
  // eval_dwell_ms let the filter decide whether to re-evaluate (title flip /
  // dwell growth). pinged marks the rows that turned into a Discord ping;
  // feedback/snooze_until capture the button responses.
  db.exec(`
    CREATE TABLE IF NOT EXISTS distraction_evals (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      app_name         TEXT    NOT NULL,
      dwell_started_at INTEGER NOT NULL,
      window_title     TEXT,
      evaluated_at     INTEGER NOT NULL,
      eval_dwell_ms    INTEGER NOT NULL,
      verdict          TEXT    NOT NULL,
      confidence       INTEGER,
      pinged           INTEGER NOT NULL DEFAULT 0,
      feedback         TEXT,
      snooze_until     INTEGER
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_distraction_dwell
      ON distraction_evals (app_name, dwell_started_at)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_distraction_evaluated_at
      ON distraction_evals (evaluated_at DESC)
  `);

  // Migration: add importance / forgotten columns to memory_facts if missing.
  // SQLite can't do IF NOT EXISTS for columns, so we gate on PRAGMA table_info.
  const factCols = db.prepare('PRAGMA table_info(memory_facts)').all() as Array<{ name: string }>;
  if (!factCols.some((c) => c.name === 'importance')) {
    db.exec(`ALTER TABLE memory_facts ADD COLUMN importance INTEGER NOT NULL DEFAULT 1`);
  }
  if (!factCols.some((c) => c.name === 'forgotten')) {
    db.exec(`ALTER TABLE memory_facts ADD COLUMN forgotten INTEGER NOT NULL DEFAULT 0`);
  }
  if (!factCols.some((c) => c.name === 'source_message_id')) {
    db.exec(`ALTER TABLE memory_facts ADD COLUMN source_message_id TEXT`);
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_facts_source_message
      ON memory_facts(source_message_id) WHERE source_message_id IS NOT NULL
  `);
}

export function getDb(): Database.Database {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

interface LogToolCallParams {
  toolName: string;
  input: Record<string, unknown>;
  result: unknown;
  success: boolean;
  durationMs: number;
}

export function logToolCall(params: LogToolCallParams): void {
  const d = getDb();
  d.prepare(
    `INSERT INTO audit_log (tool_name, input, result, success, duration_ms)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    params.toolName,
    JSON.stringify(params.input),
    JSON.stringify(params.result),
    params.success ? 1 : 0,
    params.durationMs,
  );
}

export function getPermissionRule(toolName: string): { allowed: boolean } | null {
  const d = getDb();
  const row = d.prepare('SELECT allowed FROM permission_rules WHERE tool_name = ?').get(toolName) as { allowed: number } | undefined;
  if (!row) return null;
  return { allowed: row.allowed === 1 };
}

export function savePermissionRule(toolName: string, allowed: boolean): void {
  const d = getDb();
  d.prepare(
    `INSERT INTO permission_rules (tool_name, allowed)
     VALUES (?, ?)
     ON CONFLICT(tool_name) DO UPDATE SET allowed = excluded.allowed, created_at = datetime('now')`
  ).run(toolName, allowed ? 1 : 0);
}

export function clearPermissionRules(): void {
  const d = getDb();
  d.prepare('DELETE FROM permission_rules').run();
}

interface SaveMessageParams {
  messageId: string;
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: ToolCall[];
  piiEntities?: Array<{ type: string; original: string }>;
  timestamp: number;
  source?: string;
}

export function saveMessage(params: SaveMessageParams): void {
  const d = getDb();
  const info = d.prepare(
    `INSERT OR IGNORE INTO chat_messages (message_id, role, content, tool_calls, pii_entities, timestamp, source)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    params.messageId,
    params.role,
    params.content,
    params.toolCalls ? JSON.stringify(params.toolCalls) : null,
    params.piiEntities ? JSON.stringify(params.piiEntities) : null,
    params.timestamp,
    params.source ?? null,
  );

  // Skip topic assignment for duplicates (INSERT OR IGNORE no-op): a re-saved
  // message_id must not be linked to a fresh topic, and re-running detector
  // logic on a no-op insert would spuriously update the per-source
  // lastTimestamp.
  if (info.changes > 0 && topicDetector) {
    topicDetector.assign({
      messageId: params.messageId,
      timestamp: params.timestamp,
      source: params.source ?? null,
    });
  }
}

export function getChatHistoryLimit(): number {
  const raw = Number(process.env.CHAT_HISTORY_LIMIT);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 500;
}

export function getMessages(source?: string): Array<{
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: ToolCall[];
  piiEntities?: Array<{ type: string; original: string }>;
  timestamp: number;
  source?: string;
}> {
  const d = getDb();
  const limit = getChatHistoryLimit();
  let query: string;
  let params: unknown[];
  if (source === undefined) {
    query = `SELECT message_id, role, content, tool_calls, pii_entities, timestamp, source FROM (SELECT id, message_id, role, content, tool_calls, pii_entities, timestamp, source FROM chat_messages ORDER BY timestamp DESC, id DESC LIMIT ${limit}) ORDER BY timestamp ASC, id ASC`;
    params = [];
  } else {
    query = `SELECT message_id, role, content, tool_calls, pii_entities, timestamp, source FROM (SELECT id, message_id, role, content, tool_calls, pii_entities, timestamp, source FROM chat_messages WHERE source = ? ORDER BY timestamp DESC, id DESC LIMIT ${limit}) ORDER BY timestamp ASC, id ASC`;
    params = [source];
  }
  const rows = d.prepare(query).all(...params) as Array<{
    message_id: string;
    role: string;
    content: string;
    tool_calls: string | null;
    pii_entities: string | null;
    timestamp: number;
    source: string | null;
  }>;

  return rows.map((row) => ({
    id: row.message_id,
    role: row.role as 'user' | 'assistant',
    content: row.content,
    toolCalls: row.tool_calls ? JSON.parse(row.tool_calls) : undefined,
    piiEntities: row.pii_entities ? JSON.parse(row.pii_entities) : undefined,
    timestamp: row.timestamp,
    source: row.source ?? undefined,
  }));
}

export function clearMessages(source?: string): void {
  const d = getDb();
  // Topic state and finalized summaries are derived from chat_messages — wipe
  // them in the same call so a cleared history can't leak old context back via
  // the topic-summary prefix that chat-prompt.ts injects on the next request.
  // chat_topic_messages cascades via FK ON DELETE CASCADE on topic_id.
  const topicRows = (source === undefined
    ? d.prepare('SELECT id FROM chat_topics').all()
    : d.prepare('SELECT id FROM chat_topics WHERE source = ?').all(source)) as Array<{ id: number }>;
  if (topicRows.length > 0) {
    const sourceIds = topicRows.map((r) => String(r.id));
    const placeholders = sourceIds.map(() => '?').join(',');
    const entryRows = d
      .prepare(
        `SELECT id FROM memory_entries WHERE kind = 'topic_summary' AND source_id IN (${placeholders})`,
      )
      .all(...sourceIds) as Array<{ id: number }>;
    for (const row of entryRows) {
      // Best-effort delete from the vec0 virtual table — if memory was disabled
      // at boot the table won't exist. Wrap in try/catch so a missing vec
      // table doesn't block the rest of the cleanup.
      try {
        d.prepare('DELETE FROM memory_vec_entries WHERE entity_id = ?').run(BigInt(row.id));
      } catch {
        // memory_vec_entries absent — vec0 extension not loaded.
      }
      d.prepare('DELETE FROM memory_entries WHERE id = ?').run(row.id);
    }
    if (source === undefined) {
      d.prepare('DELETE FROM chat_topics').run();
    } else {
      d.prepare('DELETE FROM chat_topics WHERE source = ?').run(source);
    }
  }
  if (source === undefined) {
    d.prepare('DELETE FROM chat_messages').run();
  } else {
    d.prepare('DELETE FROM chat_messages WHERE source = ?').run(source);
  }
  // Detector keeps a per-source cache of {topicId,lastTimestamp}. Without
  // dropping it, a saveMessage that lands inside gapMs after a wipe would
  // link to a deleted topic_id and trip the chat_topic_messages FK.
  if (topicDetector) {
    topicDetector.reset(source);
  }
}

export type OverlayModel = 'claude' | 'ollama';

export const PROMPT_OVERLAY_MAX_LENGTH = 10000;

export function getOverlay(model: OverlayModel): string | null {
  const d = getDb();
  const row = d
    .prepare('SELECT text FROM prompt_overlays WHERE model = ?')
    .get(model) as { text: string } | undefined;
  return row ? row.text : null;
}

export function setOverlay(model: OverlayModel, text: string): void {
  if (text.length > PROMPT_OVERLAY_MAX_LENGTH) {
    throw new Error(`prompt overlay too long (max ${PROMPT_OVERLAY_MAX_LENGTH} chars)`);
  }
  const d = getDb();
  d.prepare(
    `INSERT OR REPLACE INTO prompt_overlays (model, text, updated_at)
     VALUES (?, ?, ?)`
  ).run(model, text, Date.now());
}

export function clearOverlay(model: OverlayModel): void {
  const d = getDb();
  d.prepare('DELETE FROM prompt_overlays WHERE model = ?').run(model);
}

export function cleanupAuditLog(): void {
  const d = getDb();
  // Delete records older than 30 days
  d.prepare("DELETE FROM audit_log WHERE created_at < datetime('now', '-30 days')").run();
  // Keep only latest 10000
  d.prepare(
    'DELETE FROM audit_log WHERE id NOT IN (SELECT id FROM audit_log ORDER BY id DESC LIMIT 10000)'
  ).run();
}

/**
 * Deletes chat_messages older than CHAT_HISTORY_RETENTION_DAYS. If the env var
 * is unset, 0, or invalid, retention is disabled and nothing is deleted —
 * this preserves the historical default of "keep forever".
 * Returns the number of rows deleted (0 if disabled).
 */
export function cleanupOldChatMessages(): number {
  const raw = Number(process.env.CHAT_HISTORY_RETENTION_DAYS);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  const days = Math.floor(raw);
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const d = getDb();
  const info = d.prepare('DELETE FROM chat_messages WHERE timestamp < ?').run(cutoffMs);
  // chat_topic_messages.message_id is TEXT with no FK to chat_messages, so
  // retention sweeps would orphan link rows and leave finalized topics with
  // truncated transcripts on re-fetch. Drop orphans in the same pass.
  d.prepare(
    'DELETE FROM chat_topic_messages WHERE message_id NOT IN (SELECT message_id FROM chat_messages)',
  ).run();
  return Number(info.changes ?? 0);
}
