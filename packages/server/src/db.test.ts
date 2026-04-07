import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initDb, logToolCall, cleanupAuditLog, getDb, closeDb } from './db.js';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

describe('Database Module', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-test-'));
    dbPath = path.join(tmpDir, 'test.db');
    initDb(dbPath);
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('initDb', () => {
    it('creates audit_log table', () => {
      const db = getDb();
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='audit_log'"
      ).all();
      expect(tables).toHaveLength(1);
    });
  });

  describe('logToolCall', () => {
    it('inserts a record with correct fields', () => {
      logToolCall({
        toolName: 'web_search',
        input: { query: 'test' },
        result: { success: true, data: 'results' },
        success: true,
        durationMs: 150,
      });

      const db = getDb();
      const rows = db.prepare('SELECT * FROM audit_log').all() as any[];
      expect(rows).toHaveLength(1);
      expect(rows[0].tool_name).toBe('web_search');
      expect(JSON.parse(rows[0].input)).toEqual({ query: 'test' });
      expect(JSON.parse(rows[0].result)).toEqual({ success: true, data: 'results' });
      expect(rows[0].success).toBe(1);
      expect(rows[0].duration_ms).toBe(150);
      expect(rows[0].created_at).toBeTruthy();
    });
  });

  describe('cleanupAuditLog', () => {
    it('deletes records older than 30 days', () => {
      const db = getDb();
      const insert = db.prepare(
        `INSERT INTO audit_log (tool_name, input, result, success, duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      );
      // Insert old record (60 days ago)
      insert.run('old_tool', '{}', '{}', 1, 10, '2026-02-06T00:00:00');
      // Insert recent record
      insert.run('new_tool', '{}', '{}', 1, 10, new Date().toISOString());

      cleanupAuditLog();

      const rows = db.prepare('SELECT * FROM audit_log').all() as any[];
      expect(rows).toHaveLength(1);
      expect(rows[0].tool_name).toBe('new_tool');
    });

    it('keeps only latest 10000 when over limit', () => {
      const db = getDb();
      const insert = db.prepare(
        `INSERT INTO audit_log (tool_name, input, result, success, duration_ms)
         VALUES (?, ?, ?, ?, ?)`
      );
      // Insert 10005 records in a transaction
      const insertMany = db.transaction(() => {
        for (let i = 0; i < 10005; i++) {
          insert.run(`tool_${i}`, '{}', '{}', 1, 10);
        }
      });
      insertMany();

      cleanupAuditLog();

      const count = db.prepare('SELECT COUNT(*) as c FROM audit_log').get() as any;
      expect(count.c).toBe(10000);

      // Verify the oldest 5 were deleted (tool_0 through tool_4)
      const oldest = db.prepare(
        'SELECT tool_name FROM audit_log ORDER BY id ASC LIMIT 1'
      ).get() as any;
      expect(oldest.tool_name).toBe('tool_5');
    });
  });
});
