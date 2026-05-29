import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDb, closeDb, getDb, saveMessage, setTopicDetector, clearMessages } from '../db.js';
import { createTopicStore } from '../topics/store.js';
import { createTopicDetector, TOPIC_GAP_MS } from '../topics/detector.js';
import type { TopicDetector, IncomingMessage } from '../topics/detector.js';

beforeEach(() => initDb(':memory:'));
afterEach(() => {
  setTopicDetector(null);
  closeDb();
});

describe('email tables', () => {
  it('creates email_account_state with expected columns', () => {
    const cols = getDb()
      .prepare("PRAGMA table_info('email_account_state')")
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual(['account_id', 'last_error', 'last_poll_at', 'last_seen_uid'].sort());
  });

  it('creates email_pending with expected columns', () => {
    const cols = getDb()
      .prepare("PRAGMA table_info('email_pending')")
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual([
      'account_id', 'added_at', 'delivered_at', 'from_addr',
      'id', 'importance', 'message_uid', 'received_at', 'snippet', 'subject',
      'urgent_pinged_at',
    ].sort());
  });

  it('enforces UNIQUE(account_id, message_uid) on email_pending', () => {
    const db = getDb();
    const stmt = db.prepare(`
      INSERT INTO email_pending
      (account_id, message_uid, from_addr, subject, snippet, importance, received_at, added_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run('acc1', 123, 'a@b.com', 's', 'snip', 4, 1000, 1000);
    expect(() => stmt.run('acc1', 123, 'a@b.com', 's', 'snip', 4, 1000, 1000)).toThrow();
  });

  it('adds urgent_pinged_at column with INTEGER affinity, nullable, defaulting to NULL', () => {
    const cols = getDb()
      .prepare("PRAGMA table_info('email_pending')")
      .all() as Array<{ name: string; type: string; notnull: number; dflt_value: string | null }>;
    const col = cols.find((c) => c.name === 'urgent_pinged_at');
    expect(col).toBeDefined();
    expect(col!.type.toUpperCase()).toBe('INTEGER');
    expect(col!.notnull).toBe(0);
    expect(col!.dflt_value).toBeNull();
  });

  it('creates email_sent_log with expected columns', () => {
    const cols = getDb()
      .prepare("PRAGMA table_info('email_sent_log')")
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual([
      'action', 'created_at', 'draft_id', 'error_message', 'id', 'subject', 'to_addr',
    ].sort());
  });

  it('creates index idx_email_sent_log_action_at', () => {
    const row = getDb()
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_email_sent_log_action_at'",
      )
      .get() as { sql: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.sql).toMatch(/email_sent_log/);
    expect(row!.sql).toMatch(/action/);
    expect(row!.sql).toMatch(/created_at/);
  });

  it('email_sent_log CHECK constraint rejects invalid action', () => {
    const db = getDb();
    expect(() =>
      db
        .prepare(
          `INSERT INTO email_sent_log (action, draft_id, to_addr, subject, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run('bogus', 'd1', 'a@b', 's', Date.now()),
    ).toThrow();
  });

  it('initDb is idempotent: email_sent_log table survives a second initDb call', async () => {
    const os = await import('node:os');
    const path = await import('node:path');
    const fs = await import('node:fs');
    const tmp = path.join(
      os.tmpdir(),
      `r2-db-sent-log-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
    );
    try {
      initDb(tmp);
      let cols = getDb()
        .prepare("PRAGMA table_info('email_sent_log')")
        .all() as Array<{ name: string }>;
      expect(cols.length).toBeGreaterThan(0);

      expect(() => initDb(tmp)).not.toThrow();
      cols = getDb()
        .prepare("PRAGMA table_info('email_sent_log')")
        .all() as Array<{ name: string }>;
      expect(cols.length).toBeGreaterThan(0);
    } finally {
      closeDb();
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      for (const ext of ['-wal', '-shm']) {
        if (fs.existsSync(tmp + ext)) fs.unlinkSync(tmp + ext);
      }
    }
  });

  it('creates partial index idx_email_pending_urgent_unpinged', () => {
    const row = getDb()
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_email_pending_urgent_unpinged'",
      )
      .get() as { sql: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.sql).toMatch(/email_pending/);
    expect(row!.sql).toMatch(/importance/);
    expect(row!.sql).toMatch(/urgent_pinged_at/);
    expect(row!.sql).toMatch(/WHERE\s+urgent_pinged_at\s+IS\s+NULL/i);
  });

  it('creates email_suppression_rules with expected columns', () => {
    const cols = getDb()
      .prepare("PRAGMA table_info('email_suppression_rules')")
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual([
      'created_at', 'created_via', 'expires_at', 'id', 'pattern', 'rule_type',
    ].sort());
  });

  it('email_suppression_rules CHECK constraint rejects invalid rule_type', () => {
    const db = getDb();
    expect(() =>
      db
        .prepare(
          `INSERT INTO email_suppression_rules (rule_type, pattern, created_at)
           VALUES (?, ?, ?)`,
        )
        .run('bogus', 'pat', Date.now()),
    ).toThrow();
  });

  it('email_suppression_rules allows NULL expires_at (forever)', () => {
    const db = getDb();
    const info = db
      .prepare(
        `INSERT INTO email_suppression_rules (rule_type, pattern, created_at, expires_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run('sender', 'a@b.com', Date.now(), null);
    expect(info.changes).toBe(1);
    const row = db
      .prepare('SELECT expires_at FROM email_suppression_rules WHERE id = ?')
      .get(info.lastInsertRowid) as { expires_at: number | null };
    expect(row.expires_at).toBeNull();
  });

  it('email_suppression_rules defaults created_via to discord_button', () => {
    const db = getDb();
    const info = db
      .prepare(
        `INSERT INTO email_suppression_rules (rule_type, pattern, created_at)
         VALUES (?, ?, ?)`,
      )
      .run('sender', 'a@b.com', Date.now());
    const row = db
      .prepare('SELECT created_via FROM email_suppression_rules WHERE id = ?')
      .get(info.lastInsertRowid) as { created_via: string };
    expect(row.created_via).toBe('discord_button');
  });

  it('creates index idx_email_suppression_rules_type_pattern', () => {
    const row = getDb()
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_email_suppression_rules_type_pattern'",
      )
      .get() as { sql: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.sql).toMatch(/email_suppression_rules/);
    expect(row!.sql).toMatch(/rule_type/);
    expect(row!.sql).toMatch(/pattern/);
  });

  it('creates index idx_email_suppression_rules_expires', () => {
    const row = getDb()
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_email_suppression_rules_expires'",
      )
      .get() as { sql: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.sql).toMatch(/email_suppression_rules/);
    expect(row!.sql).toMatch(/expires_at/);
  });

  it('initDb is idempotent: email_suppression_rules survives a second initDb call', async () => {
    const os = await import('node:os');
    const path = await import('node:path');
    const fs = await import('node:fs');
    const tmp = path.join(
      os.tmpdir(),
      `r2-db-suppress-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
    );
    try {
      initDb(tmp);
      let cols = getDb()
        .prepare("PRAGMA table_info('email_suppression_rules')")
        .all() as Array<{ name: string }>;
      expect(cols.length).toBeGreaterThan(0);

      expect(() => initDb(tmp)).not.toThrow();
      cols = getDb()
        .prepare("PRAGMA table_info('email_suppression_rules')")
        .all() as Array<{ name: string }>;
      expect(cols.length).toBeGreaterThan(0);
    } finally {
      closeDb();
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      for (const ext of ['-wal', '-shm']) {
        if (fs.existsSync(tmp + ext)) fs.unlinkSync(tmp + ext);
      }
    }
  });
});

describe('window_history table', () => {
  it('creates window_history with expected columns', () => {
    const cols = getDb()
      .prepare("PRAGMA table_info('window_history')")
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual([
      'app_name', 'id', 'last_seen_at', 'sample_count', 'started_at', 'window_title',
    ].sort());
  });

  it('creates index idx_window_history_last_seen', () => {
    const row = getDb()
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_window_history_last_seen'",
      )
      .get() as { sql: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.sql).toMatch(/window_history/);
    expect(row!.sql).toMatch(/last_seen_at/);
  });

  it('creates index idx_window_history_app_last_seen', () => {
    const row = getDb()
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_window_history_app_last_seen'",
      )
      .get() as { sql: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.sql).toMatch(/window_history/);
    expect(row!.sql).toMatch(/app_name/);
    expect(row!.sql).toMatch(/last_seen_at/);
  });

  it('sample_count defaults to 1', () => {
    const db = getDb();
    const info = db
      .prepare(
        `INSERT INTO window_history (app_name, window_title, started_at, last_seen_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run('Chrome', 'Gmail', 1_700_000_000_000, 1_700_000_000_000);
    const row = db
      .prepare('SELECT sample_count FROM window_history WHERE id = ?')
      .get(info.lastInsertRowid) as { sample_count: number };
    expect(row.sample_count).toBe(1);
  });
});

describe('context_pings table', () => {
  it('creates context_pings with expected columns', () => {
    const cols = getDb()
      .prepare("PRAGMA table_info('context_pings')")
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual([
      'away_app', 'away_session_ended_at', 'away_session_started_at', 'id', 'pinged_at',
    ].sort());
  });

  it('creates index idx_context_pings_app_at', () => {
    const row = getDb()
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_context_pings_app_at'",
      )
      .get() as { sql: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.sql).toMatch(/context_pings/);
    expect(row!.sql).toMatch(/away_app/);
    expect(row!.sql).toMatch(/pinged_at/);
  });
});

describe('initDb idempotency for window_history + context_pings', () => {
  it('running initDb twice on the same file does not throw and tables remain', async () => {
    const os = await import('node:os');
    const path = await import('node:path');
    const fs = await import('node:fs');
    const tmp = path.join(
      os.tmpdir(),
      `r2-db-window-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
    );
    try {
      initDb(tmp);
      let wh = getDb()
        .prepare("PRAGMA table_info('window_history')")
        .all() as Array<{ name: string }>;
      let cp = getDb()
        .prepare("PRAGMA table_info('context_pings')")
        .all() as Array<{ name: string }>;
      expect(wh.length).toBeGreaterThan(0);
      expect(cp.length).toBeGreaterThan(0);

      expect(() => initDb(tmp)).not.toThrow();

      wh = getDb()
        .prepare("PRAGMA table_info('window_history')")
        .all() as Array<{ name: string }>;
      cp = getDb()
        .prepare("PRAGMA table_info('context_pings')")
        .all() as Array<{ name: string }>;
      expect(wh.length).toBeGreaterThan(0);
      expect(cp.length).toBeGreaterThan(0);

      // All three indexes still present
      const indexes = getDb()
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND name IN ('idx_window_history_last_seen','idx_window_history_app_last_seen','idx_context_pings_app_at')",
        )
        .all() as Array<{ name: string }>;
      expect(indexes.length).toBe(3);
    } finally {
      closeDb();
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      for (const ext of ['-wal', '-shm']) {
        if (fs.existsSync(tmp + ext)) fs.unlinkSync(tmp + ext);
      }
    }
  });
});

describe('initDb idempotency for email_pending migrations', () => {
  it('running initDb twice on the same file does not throw and column is present once', async () => {
    const os = await import('node:os');
    const path = await import('node:path');
    const fs = await import('node:fs');
    const tmp = path.join(os.tmpdir(), `r2-db-idempotent-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    try {
      initDb(tmp);
      // first run: column should exist
      let cols = getDb()
        .prepare("PRAGMA table_info('email_pending')")
        .all() as Array<{ name: string }>;
      expect(cols.filter((c) => c.name === 'urgent_pinged_at').length).toBe(1);

      // second initDb on the same file must not throw on duplicate column add
      expect(() => initDb(tmp)).not.toThrow();
      cols = getDb()
        .prepare("PRAGMA table_info('email_pending')")
        .all() as Array<{ name: string }>;
      expect(cols.filter((c) => c.name === 'urgent_pinged_at').length).toBe(1);
    } finally {
      closeDb();
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      // walls/journals
      for (const ext of ['-wal', '-shm']) {
        if (fs.existsSync(tmp + ext)) fs.unlinkSync(tmp + ext);
      }
    }
  });
});

describe('saveMessage topic-detector hook', () => {
  it('invokes the detector with messageId, timestamp, source when set', () => {
    const calls: IncomingMessage[] = [];
    const detector: TopicDetector = {
      assign: (msg) => {
        calls.push(msg);
      },
      reset: () => {},
    };
    setTopicDetector(detector);

    saveMessage({
      messageId: 'm1',
      role: 'user',
      content: 'hi',
      timestamp: 1_700_000_000_000,
      source: 'discord',
    });

    expect(calls).toEqual([
      { messageId: 'm1', timestamp: 1_700_000_000_000, source: 'discord' },
    ]);
  });

  it('passes source as null when omitted', () => {
    const calls: IncomingMessage[] = [];
    setTopicDetector({ assign: (msg) => calls.push(msg), reset: () => {} });

    saveMessage({
      messageId: 'm2',
      role: 'user',
      content: 'hi',
      timestamp: 1_700_000_001_000,
    });

    expect(calls).toEqual([
      { messageId: 'm2', timestamp: 1_700_000_001_000, source: null },
    ]);
  });

  it('is a no-op when no detector is registered', () => {
    expect(() =>
      saveMessage({
        messageId: 'm3',
        role: 'user',
        content: 'hi',
        timestamp: 1_700_000_002_000,
        source: 'discord',
      }),
    ).not.toThrow();

    const row = getDb()
      .prepare('SELECT message_id FROM chat_messages WHERE message_id = ?')
      .get('m3') as { message_id: string } | undefined;
    expect(row?.message_id).toBe('m3');
  });

  it('resets detector cache on clearMessages so a follow-up save does not FK-fault', () => {
    // Real detector (not a stub): without reset its in-memory state keeps the
    // pre-wipe topicId, and the next saveMessage within gapMs would try to
    // linkMessage to a deleted row → FOREIGN KEY constraint failed.
    const store = createTopicStore({ db: getDb() });
    const detector = createTopicDetector({ store, gapMs: TOPIC_GAP_MS });
    setTopicDetector(detector);
    const t0 = 1_700_000_010_000;

    saveMessage({ messageId: 'pre-wipe', role: 'user', content: 'hi', timestamp: t0, source: 'discord' });

    clearMessages();

    expect(() =>
      saveMessage({
        messageId: 'post-wipe',
        role: 'user',
        content: 'still here',
        timestamp: t0 + 60_000,
        source: 'discord',
      }),
    ).not.toThrow();
    const open = store.getOpenTopic('discord');
    expect(open).not.toBeNull();
    expect(store.getTopicMessages(open!.id).map((m) => m.message_id)).toEqual(['post-wipe']);
  });

  it('does not call detector for duplicate (already-inserted) messages', () => {
    const calls: IncomingMessage[] = [];
    setTopicDetector({ assign: (msg) => calls.push(msg), reset: () => {} });

    saveMessage({
      messageId: 'dup',
      role: 'user',
      content: 'hi',
      timestamp: 1_700_000_003_000,
      source: 'discord',
    });
    saveMessage({
      messageId: 'dup',
      role: 'user',
      content: 'hi',
      timestamp: 1_700_000_003_000,
      source: 'discord',
    });

    expect(calls.length).toBe(1);
  });
});
