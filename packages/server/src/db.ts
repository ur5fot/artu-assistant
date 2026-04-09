import Database from 'better-sqlite3';
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
  piiEntities?: Array<{ type: string; count: number }>;
  timestamp: number;
}

export function saveMessage(params: SaveMessageParams): void {
  const d = getDb();
  d.prepare(
    `INSERT OR IGNORE INTO chat_messages (message_id, role, content, tool_calls, pii_entities, timestamp)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    params.messageId,
    params.role,
    params.content,
    params.toolCalls ? JSON.stringify(params.toolCalls) : null,
    params.piiEntities ? JSON.stringify(params.piiEntities) : null,
    params.timestamp,
  );
}

export function getMessages(): Array<{
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: ToolCall[];
  piiEntities?: Array<{ type: string; count: number }>;
  timestamp: number;
}> {
  const d = getDb();
  const rows = d.prepare(
    'SELECT message_id, role, content, tool_calls, pii_entities, timestamp FROM (SELECT id, message_id, role, content, tool_calls, pii_entities, timestamp FROM chat_messages ORDER BY timestamp DESC, id DESC LIMIT 500) ORDER BY timestamp ASC, id ASC'
  ).all() as Array<{
    message_id: string;
    role: string;
    content: string;
    tool_calls: string | null;
    pii_entities: string | null;
    timestamp: number;
  }>;

  return rows.map((row) => ({
    id: row.message_id,
    role: row.role as 'user' | 'assistant',
    content: row.content,
    toolCalls: row.tool_calls ? JSON.parse(row.tool_calls) : undefined,
    piiEntities: row.pii_entities ? JSON.parse(row.pii_entities) : undefined,
    timestamp: row.timestamp,
  }));
}

export function clearMessages(): void {
  const d = getDb();
  d.prepare('DELETE FROM chat_messages').run();
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
