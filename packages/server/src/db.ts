import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ToolCall } from '@r2/shared';

let db: Database.Database | null = null;

export function initDb(dbPath?: string): void {
  if (db) {
    db.close();
    db = null;
  }

  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  const defaultDbPath = path.resolve(thisDir, '..', '..', '..', 'data', 'r2.db');
  const resolvedPath = dbPath ?? (process.env.DB_PATH || defaultDbPath);
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

  if (memoryEnabled) {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_vec_entries USING vec0(
        entity_id INTEGER PRIMARY KEY,
        embedding FLOAT[768] distance_metric=cosine
      )
    `);

    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_vec_facts USING vec0(
        entity_id INTEGER PRIMARY KEY,
        embedding FLOAT[768] distance_metric=cosine
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

  // Migration: add `source` column if missing
  const cols = db.prepare("PRAGMA table_info(chat_messages)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'source')) {
    db.exec(`ALTER TABLE chat_messages ADD COLUMN source TEXT`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_chat_messages_source ON chat_messages(source, timestamp)`);

  // Migration: add importance / forgotten columns to memory_facts if missing.
  // SQLite can't do IF NOT EXISTS for columns, so we gate on PRAGMA table_info.
  const factCols = db.prepare('PRAGMA table_info(memory_facts)').all() as Array<{ name: string }>;
  if (!factCols.some((c) => c.name === 'importance')) {
    db.exec(`ALTER TABLE memory_facts ADD COLUMN importance INTEGER NOT NULL DEFAULT 1`);
  }
  if (!factCols.some((c) => c.name === 'forgotten')) {
    db.exec(`ALTER TABLE memory_facts ADD COLUMN forgotten INTEGER NOT NULL DEFAULT 0`);
  }
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
  d.prepare(
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
  let query: string;
  let params: unknown[];
  if (source === undefined) {
    query = 'SELECT message_id, role, content, tool_calls, pii_entities, timestamp, source FROM (SELECT id, message_id, role, content, tool_calls, pii_entities, timestamp, source FROM chat_messages ORDER BY timestamp DESC, id DESC LIMIT 500) ORDER BY timestamp ASC, id ASC';
    params = [];
  } else {
    query = 'SELECT message_id, role, content, tool_calls, pii_entities, timestamp, source FROM (SELECT id, message_id, role, content, tool_calls, pii_entities, timestamp, source FROM chat_messages WHERE source = ? ORDER BY timestamp DESC, id DESC LIMIT 500) ORDER BY timestamp ASC, id ASC';
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
  if (source === undefined) {
    d.prepare('DELETE FROM chat_messages').run();
  } else {
    d.prepare('DELETE FROM chat_messages WHERE source = ?').run(source);
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
