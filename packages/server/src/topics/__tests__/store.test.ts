import { describe, expect, it, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createTopicStore } from '../store.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      tool_calls TEXT,
      pii_entities TEXT,
      timestamp INTEGER NOT NULL,
      source TEXT
    )
  `);
  db.exec(`
    CREATE TABLE chat_topics (
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
  db.exec(`
    CREATE TABLE chat_topic_messages (
      topic_id INTEGER NOT NULL REFERENCES chat_topics(id) ON DELETE CASCADE,
      message_id TEXT NOT NULL,
      PRIMARY KEY (topic_id, message_id)
    )
  `);
  return db;
}

function insertMessage(
  db: Database.Database,
  messageId: string,
  timestamp: number,
  source: string | null = 'discord',
  role: 'user' | 'assistant' = 'user',
  content = 'hi',
): void {
  db.prepare(
    `INSERT INTO chat_messages (message_id, role, content, timestamp, source)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(messageId, role, content, timestamp, source);
}

describe('TopicStore', () => {
  let db: Database.Database;
  const fakeNow = 1_700_000_000_000;

  beforeEach(() => {
    db = freshDb();
  });

  it('createOpen sets status=open, started_at, source', () => {
    const store = createTopicStore({ db });
    const topic = store.createOpen(fakeNow, 'discord');
    expect(topic.id).toBeGreaterThan(0);
    expect(topic.status).toBe('open');
    expect(topic.started_at).toBe(fakeNow);
    expect(topic.source).toBe('discord');
    expect(topic.ended_at).toBeNull();
    expect(topic.failure_count).toBe(0);
  });

  it('getOpenTopic returns the open topic when one exists', () => {
    const store = createTopicStore({ db });
    const t = store.createOpen(fakeNow, 'discord');
    const found = store.getOpenTopic('discord');
    expect(found?.id).toBe(t.id);
  });

  it('getOpenTopic returns null when no open topic for source', () => {
    const store = createTopicStore({ db });
    store.createOpen(fakeNow, 'discord');
    expect(store.getOpenTopic('telegram')).toBeNull();
    expect(store.getOpenTopic(null)).toBeNull();
  });

  it('getOpenTopic treats null source distinctly', () => {
    const store = createTopicStore({ db });
    const nullTopic = store.createOpen(fakeNow, null);
    const discordTopic = store.createOpen(fakeNow, 'discord');
    expect(store.getOpenTopic(null)?.id).toBe(nullTopic.id);
    expect(store.getOpenTopic('discord')?.id).toBe(discordTopic.id);
  });

  it('getOpenTopic throws on invariant violation (multiple open for same source)', () => {
    const store = createTopicStore({ db });
    store.createOpen(fakeNow, 'discord');
    store.createOpen(fakeNow + 1, 'discord');
    expect(() => store.getOpenTopic('discord')).toThrow(/invariant/);
  });

  it('closeOpen transitions to closed and sets ended_at', () => {
    const store = createTopicStore({ db });
    const t = store.createOpen(fakeNow, 'discord');
    store.closeOpen(t.id, fakeNow + 500);
    const row = db.prepare('SELECT * FROM chat_topics WHERE id = ?').get(t.id) as any;
    expect(row.status).toBe('closed');
    expect(row.ended_at).toBe(fakeNow + 500);
  });

  it('closeOpen is no-op for non-open topics', () => {
    const store = createTopicStore({ db });
    const t = store.createOpen(fakeNow, 'discord');
    store.closeOpen(t.id, fakeNow + 100);
    store.closeOpen(t.id, fakeNow + 999); // second call shouldn't change ended_at
    const row = db.prepare('SELECT * FROM chat_topics WHERE id = ?').get(t.id) as any;
    expect(row.ended_at).toBe(fakeNow + 100);
  });

  it('linkMessage is idempotent (duplicate PK ignored)', () => {
    const store = createTopicStore({ db });
    insertMessage(db, 'm1', fakeNow);
    const t = store.createOpen(fakeNow, 'discord');
    store.linkMessage(t.id, 'm1');
    store.linkMessage(t.id, 'm1'); // duplicate
    const count = db
      .prepare('SELECT COUNT(*) AS c FROM chat_topic_messages WHERE topic_id = ?')
      .get(t.id) as { c: number };
    expect(count.c).toBe(1);
  });

  it('listClosedReadyForFinalize honors cutoff and limit', () => {
    const store = createTopicStore({ db });
    const t1 = store.createOpen(fakeNow, 'discord');
    store.closeOpen(t1.id, fakeNow + 100);
    const t2 = store.createOpen(fakeNow + 200, 'discord');
    store.closeOpen(t2.id, fakeNow + 300);
    const t3 = store.createOpen(fakeNow + 400, 'discord');
    store.closeOpen(t3.id, fakeNow + 500);

    // cutoff after t1, t2 but before t3
    const ready = store.listClosedReadyForFinalize(fakeNow + 400, 10);
    expect(ready.map((r) => r.id).sort()).toEqual([t1.id, t2.id].sort());

    // limit caps results, ordered by ended_at ASC
    const oneOnly = store.listClosedReadyForFinalize(fakeNow + 1000, 1);
    expect(oneOnly).toHaveLength(1);
    expect(oneOnly[0].id).toBe(t1.id);
  });

  it('listClosedReadyForFinalize ignores open and finalized topics', () => {
    const store = createTopicStore({ db });
    store.createOpen(fakeNow, 'discord'); // open
    const t2 = store.createOpen(fakeNow + 100, 'discord');
    store.closeOpen(t2.id, fakeNow + 200);
    store.finalize(t2.id, 'label', 'summary', 5, fakeNow + 300);
    const ready = store.listClosedReadyForFinalize(fakeNow + 1000, 10);
    expect(ready).toEqual([]);
  });

  it('finalize sets label, summary, importance, finalized_at and transitions status', () => {
    const store = createTopicStore({ db });
    const t = store.createOpen(fakeNow, 'discord');
    store.closeOpen(t.id, fakeNow + 100);
    store.finalize(t.id, 'mime fix', 'summary text', 7, fakeNow + 500);
    const row = db.prepare('SELECT * FROM chat_topics WHERE id = ?').get(t.id) as any;
    expect(row.status).toBe('finalized');
    expect(row.label).toBe('mime fix');
    expect(row.summary).toBe('summary text');
    expect(row.importance).toBe(7);
    expect(row.finalized_at).toBe(fakeNow + 500);
  });

  it('markFinalizationFailure increments failure_count and returns new count', () => {
    const store = createTopicStore({ db });
    const t = store.createOpen(fakeNow, 'discord');
    store.closeOpen(t.id, fakeNow + 100);
    expect(store.markFinalizationFailure(t.id)).toBe(1);
    expect(store.markFinalizationFailure(t.id)).toBe(2);
    expect(store.markFinalizationFailure(t.id)).toBe(3);
    const row = db.prepare('SELECT * FROM chat_topics WHERE id = ?').get(t.id) as any;
    expect(row.failure_count).toBe(3);
    expect(row.status).toBe('closed'); // stays closed
  });

  it('markFinalizationGiveUp transitions to finalized with placeholder label', () => {
    const store = createTopicStore({ db });
    const t = store.createOpen(fakeNow, 'discord');
    store.closeOpen(t.id, fakeNow + 100);
    store.markFinalizationGiveUp(t.id, fakeNow + 500);
    const row = db.prepare('SELECT * FROM chat_topics WHERE id = ?').get(t.id) as any;
    expect(row.status).toBe('finalized');
    expect(row.label).toBe('[finalization failed]');
    expect(row.summary).toBeNull();
    expect(row.importance).toBe(0);
    expect(row.finalized_at).toBe(fakeNow + 500);
  });

  it('findStaleOpen returns topics whose last message is older than cutoff', () => {
    const store = createTopicStore({ db });
    const tStale = store.createOpen(fakeNow, 'discord');
    insertMessage(db, 'old-msg', fakeNow + 100);
    store.linkMessage(tStale.id, 'old-msg');

    const tFresh = store.createOpen(fakeNow + 1000, 'telegram');
    insertMessage(db, 'fresh-msg', fakeNow + 10_000);
    store.linkMessage(tFresh.id, 'fresh-msg');

    const cutoff = fakeNow + 5000;
    const stale = store.findStaleOpen(cutoff);
    expect(stale.map((t) => t.id)).toEqual([tStale.id]);
  });

  it('findStaleOpen includes open topics with no messages (defensive)', () => {
    const store = createTopicStore({ db });
    const tEmpty = store.createOpen(fakeNow, 'discord');
    const stale = store.findStaleOpen(fakeNow + 10_000);
    expect(stale.map((t) => t.id)).toEqual([tEmpty.id]);
  });

  it('findStaleOpen does not return closed or finalized topics', () => {
    const store = createTopicStore({ db });
    const tClosed = store.createOpen(fakeNow, 'discord');
    insertMessage(db, 'msg-c', fakeNow + 50);
    store.linkMessage(tClosed.id, 'msg-c');
    store.closeOpen(tClosed.id, fakeNow + 100);
    const stale = store.findStaleOpen(fakeNow + 10_000);
    expect(stale).toEqual([]);
  });

  it('getTopicMessages returns linked messages in timestamp order', () => {
    const store = createTopicStore({ db });
    const t = store.createOpen(fakeNow, 'discord');
    insertMessage(db, 'm-b', fakeNow + 200, 'discord', 'assistant', 'hello back');
    insertMessage(db, 'm-a', fakeNow + 100, 'discord', 'user', 'hello');
    insertMessage(db, 'm-c', fakeNow + 300, 'discord', 'user', 'thanks');
    store.linkMessage(t.id, 'm-b');
    store.linkMessage(t.id, 'm-a');
    store.linkMessage(t.id, 'm-c');
    const msgs = store.getTopicMessages(t.id);
    expect(msgs.map((m) => m.message_id)).toEqual(['m-a', 'm-b', 'm-c']);
    expect(msgs[0].role).toBe('user');
    expect(msgs[1].role).toBe('assistant');
  });

  it('listFinalized returns finalized topics ordered by finalized_at DESC, excludes failed', () => {
    const store = createTopicStore({ db });
    const t1 = store.createOpen(fakeNow, 'discord');
    store.closeOpen(t1.id, fakeNow + 100);
    store.finalize(t1.id, 'first', 'sum1', 3, fakeNow + 200);

    const t2 = store.createOpen(fakeNow + 500, 'discord');
    store.closeOpen(t2.id, fakeNow + 600);
    store.finalize(t2.id, 'second', 'sum2', 9, fakeNow + 700);

    const t3 = store.createOpen(fakeNow + 800, 'discord');
    store.closeOpen(t3.id, fakeNow + 900);
    store.markFinalizationGiveUp(t3.id, fakeNow + 1000);

    const list = store.listFinalized(10);
    expect(list.map((t) => t.id)).toEqual([t2.id, t1.id]);
  });

  it('listFinalized honors limit', () => {
    const store = createTopicStore({ db });
    for (let i = 0; i < 3; i++) {
      const t = store.createOpen(fakeNow + i * 100, 'discord');
      store.closeOpen(t.id, fakeNow + i * 100 + 50);
      store.finalize(t.id, `l${i}`, `s${i}`, 5, fakeNow + i * 100 + 60);
    }
    const list = store.listFinalized(2);
    expect(list).toHaveLength(2);
  });
});
