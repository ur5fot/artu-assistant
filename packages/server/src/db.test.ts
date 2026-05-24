import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initDb, logToolCall, cleanupAuditLog, cleanupOldChatMessages, getChatHistoryLimit, getDb, closeDb, getPermissionRule, savePermissionRule, clearPermissionRules, saveMessage, getMessages, clearMessages, getOverlay, setOverlay, clearOverlay, PROMPT_OVERLAY_MAX_LENGTH } from './db.js';
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
      // Insert old record (60 days ago) using SQLite datetime format
      const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
      const oldDate = sixtyDaysAgo.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
      insert.run('old_tool', '{}', '{}', 1, 10, oldDate);
      // Insert recent record using SQLite datetime format
      const now = new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
      insert.run('new_tool', '{}', '{}', 1, 10, now);

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

  describe('Permission Rules', () => {
    it('returns null for unknown tool', () => {
      const rule = getPermissionRule('unknown_tool');
      expect(rule).toBeNull();
    });

    it('saves and retrieves permission rule', () => {
      savePermissionRule('file_write', true);
      const rule = getPermissionRule('file_write');
      expect(rule).toEqual({ allowed: true });
    });

    it('overwrites existing rule for same tool', () => {
      savePermissionRule('file_write', true);
      savePermissionRule('file_write', false);
      const rule = getPermissionRule('file_write');
      expect(rule).toEqual({ allowed: false });
    });

    it('clears all permission rules', () => {
      savePermissionRule('file_write', true);
      savePermissionRule('file_delete', false);
      clearPermissionRules();
      expect(getPermissionRule('file_write')).toBeNull();
      expect(getPermissionRule('file_delete')).toBeNull();
    });
  });

  describe('Chat Messages', () => {
    it('saves and retrieves a user message', () => {
      saveMessage({
        messageId: 'msg-1',
        role: 'user',
        content: 'Hello R2',
        timestamp: 1700000000000,
      });

      const messages = getMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0].id).toBe('msg-1');
      expect(messages[0].role).toBe('user');
      expect(messages[0].content).toBe('Hello R2');
      expect(messages[0].timestamp).toBe(1700000000000);
      expect(messages[0].toolCalls).toBeUndefined();
      expect(messages[0].piiEntities).toBeUndefined();
    });

    it('saves assistant message with tool calls', () => {
      saveMessage({
        messageId: 'msg-2',
        role: 'assistant',
        content: 'Searching...',
        toolCalls: [{
          id: 'tc-1',
          name: 'web_search',
          input: { query: 'test' },
          status: 'done',
          result: { success: true, data: 'results' },
        }],
        timestamp: 1700000001000,
      });

      const messages = getMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0].toolCalls).toHaveLength(1);
      expect(messages[0].toolCalls![0].name).toBe('web_search');
      expect(messages[0].toolCalls![0].result).toEqual({ success: true, data: 'results' });
    });

    it('saves message with piiEntities', () => {
      saveMessage({
        messageId: 'msg-3',
        role: 'assistant',
        content: 'Found it',
        piiEntities: [{ type: 'EMAIL_ADDRESS', original: 'john@example.com' }, { type: 'EMAIL_ADDRESS', original: 'jane@test.com' }],
        timestamp: 1700000002000,
      });

      const messages = getMessages();
      expect(messages[0].piiEntities).toEqual([{ type: 'EMAIL_ADDRESS', original: 'john@example.com' }, { type: 'EMAIL_ADDRESS', original: 'jane@test.com' }]);
    });

    it('returns messages ordered by timestamp ASC', () => {
      saveMessage({ messageId: 'msg-a', role: 'user', content: 'First', timestamp: 1700000000000 });
      saveMessage({ messageId: 'msg-b', role: 'assistant', content: 'Second', timestamp: 1700000001000 });
      saveMessage({ messageId: 'msg-c', role: 'user', content: 'Third', timestamp: 1700000002000 });

      const messages = getMessages();
      expect(messages).toHaveLength(3);
      expect(messages[0].content).toBe('First');
      expect(messages[1].content).toBe('Second');
      expect(messages[2].content).toBe('Third');
    });

    it('is idempotent — duplicate messageId is ignored', () => {
      saveMessage({ messageId: 'msg-dup', role: 'user', content: 'Hello', timestamp: 1700000000000 });
      saveMessage({ messageId: 'msg-dup', role: 'user', content: 'Hello again', timestamp: 1700000001000 });

      const messages = getMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('Hello');
    });

    it('saves and retrieves source field', () => {
      saveMessage({
        messageId: 'msg-src-1',
        role: 'user',
        content: 'Hello from Discord',
        timestamp: 1700000000000,
        source: 'discord:1234',
      });
      saveMessage({
        messageId: 'msg-src-2',
        role: 'assistant',
        content: 'Hi back',
        timestamp: 1700000001000,
        source: 'discord:1234',
      });

      const messages = getMessages('discord:1234');
      expect(messages).toHaveLength(2);
      expect(messages[0].source).toBe('discord:1234');
      expect(messages[1].source).toBe('discord:1234');
    });

    it('getMessages without args returns all messages regardless of source', () => {
      saveMessage({ messageId: 'msg-web', role: 'user', content: 'Hello web', timestamp: 1700000000000 });
      saveMessage({ messageId: 'msg-claude', role: 'assistant', content: 'Hi from claude', timestamp: 1700000001000, source: 'claude' });
      saveMessage({ messageId: 'msg-discord', role: 'user', content: 'Hello discord', timestamp: 1700000002000, source: 'discord:1234' });

      const messages = getMessages();
      expect(messages).toHaveLength(3);
    });

    it('getMessages with source filters by that source', () => {
      saveMessage({ messageId: 'msg-web', role: 'user', content: 'Hello web', timestamp: 1700000000000 });
      saveMessage({ messageId: 'msg-d1', role: 'user', content: 'Hello discord', timestamp: 1700000001000, source: 'discord:1234' });
      saveMessage({ messageId: 'msg-d2', role: 'assistant', content: 'Hi back', timestamp: 1700000002000, source: 'discord:1234' });

      const discordMsgs = getMessages('discord:1234');
      expect(discordMsgs).toHaveLength(2);
      expect(discordMsgs.every(m => m.source === 'discord:1234')).toBe(true);
    });

    it('source defaults to undefined when not provided', () => {
      saveMessage({
        messageId: 'msg-nosrc',
        role: 'user',
        content: 'Hello from web',
        timestamp: 1700000000000,
      });

      const messages = getMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0].source).toBeUndefined();
    });

    it('clears all messages', () => {
      saveMessage({ messageId: 'msg-x', role: 'user', content: 'Hello', timestamp: 1700000000000 });
      saveMessage({ messageId: 'msg-y', role: 'assistant', content: 'Hi', timestamp: 1700000001000 });
      clearMessages();

      const messages = getMessages();
      expect(messages).toHaveLength(0);
    });

    it('unified history: getMessages() includes both web and discord rows', () => {
      saveMessage({ messageId: 'web-u', role: 'user', content: 'web msg', timestamp: 1700000000000 });
      saveMessage({ messageId: 'web-a', role: 'assistant', content: 'web reply', timestamp: 1700000001000, source: 'claude' });
      saveMessage({ messageId: 'dc-u', role: 'user', content: 'discord msg', timestamp: 1700000002000, source: 'discord:123' });

      const all = getMessages();
      expect(all).toHaveLength(3);
    });

    describe('CHAT_HISTORY_LIMIT', () => {
      const prev = process.env.CHAT_HISTORY_LIMIT;
      afterEach(() => {
        if (prev === undefined) delete process.env.CHAT_HISTORY_LIMIT;
        else process.env.CHAT_HISTORY_LIMIT = prev;
      });

      it('defaults to 500 when env is unset', () => {
        delete process.env.CHAT_HISTORY_LIMIT;
        expect(getChatHistoryLimit()).toBe(500);
      });

      it('accepts a positive integer from env', () => {
        process.env.CHAT_HISTORY_LIMIT = '50';
        expect(getChatHistoryLimit()).toBe(50);
      });

      it('falls back to default on invalid values', () => {
        process.env.CHAT_HISTORY_LIMIT = 'abc';
        expect(getChatHistoryLimit()).toBe(500);
        process.env.CHAT_HISTORY_LIMIT = '0';
        expect(getChatHistoryLimit()).toBe(500);
        process.env.CHAT_HISTORY_LIMIT = '-5';
        expect(getChatHistoryLimit()).toBe(500);
      });

      it('getMessages respects the limit', () => {
        process.env.CHAT_HISTORY_LIMIT = '2';
        for (let i = 0; i < 5; i++) {
          saveMessage({ messageId: `m-${i}`, role: 'user', content: `m${i}`, timestamp: 1700000000000 + i });
        }
        const msgs = getMessages();
        expect(msgs).toHaveLength(2);
        // The two most recent messages are returned in ascending order.
        expect(msgs.map((m) => m.content)).toEqual(['m3', 'm4']);
      });
    });

    describe('cleanupOldChatMessages', () => {
      const prev = process.env.CHAT_HISTORY_RETENTION_DAYS;
      afterEach(() => {
        if (prev === undefined) delete process.env.CHAT_HISTORY_RETENTION_DAYS;
        else process.env.CHAT_HISTORY_RETENTION_DAYS = prev;
      });

      it('is a no-op when env is unset, 0, or invalid', () => {
        saveMessage({ messageId: 'old', role: 'user', content: 'old', timestamp: Date.now() - 100 * 24 * 60 * 60 * 1000 });
        delete process.env.CHAT_HISTORY_RETENTION_DAYS;
        expect(cleanupOldChatMessages()).toBe(0);
        process.env.CHAT_HISTORY_RETENTION_DAYS = '0';
        expect(cleanupOldChatMessages()).toBe(0);
        process.env.CHAT_HISTORY_RETENTION_DAYS = 'abc';
        expect(cleanupOldChatMessages()).toBe(0);
        expect(getMessages()).toHaveLength(1);
      });

      it('deletes rows older than the cutoff and keeps recent ones', () => {
        const now = Date.now();
        const oneDay = 24 * 60 * 60 * 1000;
        saveMessage({ messageId: 'old-1', role: 'user', content: 'old1', timestamp: now - 60 * oneDay });
        saveMessage({ messageId: 'old-2', role: 'assistant', content: 'old2', timestamp: now - 45 * oneDay });
        saveMessage({ messageId: 'new-1', role: 'user', content: 'new1', timestamp: now - 5 * oneDay });

        process.env.CHAT_HISTORY_RETENTION_DAYS = '30';
        const deleted = cleanupOldChatMessages();
        expect(deleted).toBe(2);

        const remaining = getMessages();
        expect(remaining).toHaveLength(1);
        expect(remaining[0].content).toBe('new1');
      });

      it('also deletes orphaned chat_topic_messages link rows', () => {
        const db = getDb();
        const now = Date.now();
        const oneDay = 24 * 60 * 60 * 1000;
        saveMessage({ messageId: 'old-1', role: 'user', content: 'old', timestamp: now - 60 * oneDay });
        saveMessage({ messageId: 'new-1', role: 'user', content: 'new', timestamp: now - 5 * oneDay });
        db.prepare(
          "INSERT INTO chat_topics (started_at, status) VALUES (?, 'open')",
        ).run(now - 60 * oneDay);
        const topicId = Number(
          (db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id,
        );
        db.prepare(
          'INSERT INTO chat_topic_messages (topic_id, message_id) VALUES (?, ?), (?, ?)',
        ).run(topicId, 'old-1', topicId, 'new-1');

        process.env.CHAT_HISTORY_RETENTION_DAYS = '30';
        cleanupOldChatMessages();

        const links = db
          .prepare('SELECT message_id FROM chat_topic_messages ORDER BY message_id')
          .all() as Array<{ message_id: string }>;
        expect(links.map((r) => r.message_id)).toEqual(['new-1']);
      });
    });
  });

  describe('Prompt Overlays', () => {
    it('returns null when no overlay set', () => {
      expect(getOverlay('claude')).toBeNull();
      expect(getOverlay('ollama')).toBeNull();
    });

    it('set then get returns the stored text', () => {
      setOverlay('claude', 'be brief');
      expect(getOverlay('claude')).toBe('be brief');
    });

    it('INSERT OR REPLACE updates existing overlay', () => {
      setOverlay('claude', 'first');
      setOverlay('claude', 'second');
      expect(getOverlay('claude')).toBe('second');

      const db = getDb();
      const rows = db.prepare('SELECT * FROM prompt_overlays WHERE model = ?').all('claude');
      expect(rows).toHaveLength(1);
    });

    it('stores claude and ollama independently', () => {
      setOverlay('claude', 'claude overlay');
      setOverlay('ollama', 'ollama overlay');
      expect(getOverlay('claude')).toBe('claude overlay');
      expect(getOverlay('ollama')).toBe('ollama overlay');
    });

    it('clearOverlay removes existing overlay', () => {
      setOverlay('claude', 'x');
      clearOverlay('claude');
      expect(getOverlay('claude')).toBeNull();
    });

    it('clearOverlay on missing key does not throw', () => {
      expect(() => clearOverlay('claude')).not.toThrow();
      expect(getOverlay('claude')).toBeNull();
    });

    it('throws when text exceeds max length', () => {
      const tooLong = 'a'.repeat(PROMPT_OVERLAY_MAX_LENGTH + 1);
      expect(() => setOverlay('claude', tooLong)).toThrow(/too long/);
    });

    it('accepts text at exactly max length', () => {
      const atLimit = 'a'.repeat(PROMPT_OVERLAY_MAX_LENGTH);
      expect(() => setOverlay('claude', atLimit)).not.toThrow();
      expect(getOverlay('claude')).toBe(atLimit);
    });

    it('persists updated_at timestamp', () => {
      const before = Date.now();
      setOverlay('claude', 'x');
      const db = getDb();
      const row = db.prepare('SELECT updated_at FROM prompt_overlays WHERE model = ?').get('claude') as { updated_at: number };
      expect(row.updated_at).toBeGreaterThanOrEqual(before);
    });
  });

});

describe('cognition tables', () => {
  beforeEach(() => initDb(':memory:'));

  it('cognition_state has a single row with paused=0', () => {
    const row = getDb()
      .prepare('SELECT id, paused FROM cognition_state')
      .all() as Array<{ id: number; paused: number }>;
    expect(row).toEqual([{ id: 1, paused: 0 }]);
  });

  it('cognition_ticks accepts inserts and indexes by tick_at', () => {
    getDb().prepare('INSERT INTO cognition_ticks (tick_at) VALUES (?)').run(1000);
    getDb().prepare('INSERT INTO cognition_ticks (tick_at) VALUES (?)').run(2000);
    const rows = getDb()
      .prepare('SELECT tick_at FROM cognition_ticks ORDER BY tick_at')
      .all();
    expect(rows).toEqual([{ tick_at: 1000 }, { tick_at: 2000 }]);
  });

  it('cognition_handler_runs CHECK constraint rejects bad outcome', () => {
    expect(() =>
      getDb()
        .prepare(
          'INSERT INTO cognition_handler_runs (handler_name, fired_at, duration_ms, outcome) VALUES (?, ?, ?, ?)',
        )
        .run('x', 1, 0, 'bogus'),
    ).toThrow();
  });

  it('cognition_handler_runs accepts publish/skip/error', () => {
    const stmt = getDb().prepare(
      'INSERT INTO cognition_handler_runs (handler_name, fired_at, duration_ms, outcome) VALUES (?, ?, ?, ?)',
    );
    expect(() => stmt.run('x', 1, 0, 'publish')).not.toThrow();
    expect(() => stmt.run('x', 2, 0, 'skip')).not.toThrow();
    expect(() => stmt.run('x', 3, 0, 'error')).not.toThrow();
  });
});
