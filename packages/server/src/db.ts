import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

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

export function cleanupAuditLog(): void {
  const d = getDb();
  // Delete records older than 30 days
  d.prepare("DELETE FROM audit_log WHERE created_at < datetime('now', '-30 days')").run();
  // Keep only latest 10000
  d.prepare(
    'DELETE FROM audit_log WHERE id NOT IN (SELECT id FROM audit_log ORDER BY id DESC LIMIT 10000)'
  ).run();
}
