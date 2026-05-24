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
