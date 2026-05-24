import { describe, expect, it, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createTopicStore, type TopicStore } from '../store.js';
import { createTopicDetector, TOPIC_GAP_MS } from '../detector.js';

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
): void {
  db.prepare(
    `INSERT INTO chat_messages (message_id, role, content, timestamp, source)
     VALUES (?, 'user', 'hi', ?, ?)`,
  ).run(messageId, timestamp, source);
}

describe('TopicDetector', () => {
  let db: Database.Database;
  let store: TopicStore;
  const t0 = 1_700_000_000_000;

  beforeEach(() => {
    db = freshDb();
    store = createTopicStore({ db });
  });

  it('creates a new open topic when none exists for the source', () => {
    insertMessage(db, 'm1', t0);
    const detector = createTopicDetector({ store, gapMs: TOPIC_GAP_MS });

    detector.assign({ messageId: 'm1', timestamp: t0, source: 'discord' });

    const open = store.getOpenTopic('discord');
    expect(open).not.toBeNull();
    expect(open!.status).toBe('open');
    expect(open!.source).toBe('discord');
    expect(store.getTopicMessages(open!.id).map((m) => m.message_id)).toEqual(['m1']);
  });

  it('links second message within gap to the same open topic', () => {
    insertMessage(db, 'm1', t0);
    insertMessage(db, 'm2', t0 + 60_000);
    const detector = createTopicDetector({ store, gapMs: TOPIC_GAP_MS });

    detector.assign({ messageId: 'm1', timestamp: t0, source: 'discord' });
    detector.assign({ messageId: 'm2', timestamp: t0 + 60_000, source: 'discord' });

    const open = store.getOpenTopic('discord');
    expect(open).not.toBeNull();
    const msgs = store.getTopicMessages(open!.id).map((m) => m.message_id);
    expect(msgs).toEqual(['m1', 'm2']);
    // Only one topic should exist for this source.
    const count = (db.prepare(`SELECT COUNT(*) AS c FROM chat_topics WHERE source = ?`).get('discord') as { c: number }).c;
    expect(count).toBe(1);
  });

  it('closes old topic and creates new when gap exceeded', () => {
    insertMessage(db, 'm1', t0);
    insertMessage(db, 'm2', t0 + TOPIC_GAP_MS + 1);
    const detector = createTopicDetector({ store, gapMs: TOPIC_GAP_MS });

    detector.assign({ messageId: 'm1', timestamp: t0, source: 'discord' });
    detector.assign({
      messageId: 'm2',
      timestamp: t0 + TOPIC_GAP_MS + 1,
      source: 'discord',
    });

    // First topic should be closed with ended_at = last seen timestamp (t0).
    const topics = db
      .prepare(`SELECT id, status, ended_at FROM chat_topics WHERE source = ? ORDER BY id ASC`)
      .all('discord') as Array<{ id: number; status: string; ended_at: number | null }>;
    expect(topics.length).toBe(2);
    expect(topics[0].status).toBe('closed');
    expect(topics[0].ended_at).toBe(t0);
    expect(topics[1].status).toBe('open');

    expect(store.getTopicMessages(topics[0].id).map((m) => m.message_id)).toEqual(['m1']);
    expect(store.getTopicMessages(topics[1].id).map((m) => m.message_id)).toEqual(['m2']);
  });

  it('tracks topics independently per source', () => {
    insertMessage(db, 'm1', t0, 'discord');
    insertMessage(db, 'm2', t0, 'web');
    const detector = createTopicDetector({ store, gapMs: TOPIC_GAP_MS });

    detector.assign({ messageId: 'm1', timestamp: t0, source: 'discord' });
    detector.assign({ messageId: 'm2', timestamp: t0, source: 'web' });

    const discordOpen = store.getOpenTopic('discord');
    const webOpen = store.getOpenTopic('web');
    expect(discordOpen).not.toBeNull();
    expect(webOpen).not.toBeNull();
    expect(discordOpen!.id).not.toBe(webOpen!.id);
  });

  it('populates lastTimestamp from existing open topic on construction (no false split after restart)', () => {
    // Simulate a pre-existing open topic with a recent message: a restart
    // should resume into the same topic rather than starting a new one.
    insertMessage(db, 'm1', t0);
    const existing = store.createOpen(t0, 'discord');
    store.linkMessage(existing.id, 'm1');

    const detector = createTopicDetector({ store, gapMs: TOPIC_GAP_MS });

    // Next message arrives 1 minute later. Without the constructor populating
    // lastTimestamp, the detector would not know about m1 and would think
    // the open topic is "fresh", which is fine — but if we feed an ancient
    // timestamp into an in-memory map default of 0, we'd never split. So we
    // verify: a message within gap is linked to the same topic.
    insertMessage(db, 'm2', t0 + 60_000);
    detector.assign({ messageId: 'm2', timestamp: t0 + 60_000, source: 'discord' });

    const open = store.getOpenTopic('discord');
    expect(open).not.toBeNull();
    expect(open!.id).toBe(existing.id);
    const msgs = store.getTopicMessages(existing.id).map((m) => m.message_id);
    expect(msgs).toEqual(['m1', 'm2']);

    // And: a message arriving AFTER the gap (measured from m1) DOES split,
    // proving the constructor seeded lastTimestamp from the existing topic's
    // most recent message rather than from 0.
    insertMessage(db, 'm3', t0 + TOPIC_GAP_MS + 60_001);
    detector.assign({
      messageId: 'm3',
      timestamp: t0 + TOPIC_GAP_MS + 60_001,
      source: 'discord',
    });

    const open2 = store.getOpenTopic('discord');
    expect(open2).not.toBeNull();
    expect(open2!.id).not.toBe(existing.id);
  });

  it('does not rewind lastTimestamp when an out-of-order message arrives', () => {
    // Out-of-order timestamps (replay, clock skew) within gapMs must link to
    // the current topic but must NOT move the cursor backwards — otherwise
    // the next real-time message can falsely split.
    insertMessage(db, 'm1', t0);
    insertMessage(db, 'm2', t0 + 60_000);
    insertMessage(db, 'm-old', t0 - 30_000);
    insertMessage(db, 'm3', t0 + TOPIC_GAP_MS - 60_000);
    const detector = createTopicDetector({ store, gapMs: TOPIC_GAP_MS });

    detector.assign({ messageId: 'm1', timestamp: t0, source: 'discord' });
    detector.assign({ messageId: 'm2', timestamp: t0 + 60_000, source: 'discord' });
    // Backdated replay — still belongs to current topic (no rewind).
    detector.assign({ messageId: 'm-old', timestamp: t0 - 30_000, source: 'discord' });
    // m3 is within gapMs of m2 (the latest real cursor). It must link to the
    // same topic, not split, even though gap from m-old would exceed gapMs.
    detector.assign({
      messageId: 'm3',
      timestamp: t0 + TOPIC_GAP_MS - 60_000,
      source: 'discord',
    });

    const topics = db
      .prepare(`SELECT id, status FROM chat_topics WHERE source = ? ORDER BY id ASC`)
      .all('discord') as Array<{ id: number; status: string }>;
    expect(topics.length).toBe(1);
    expect(topics[0].status).toBe('open');
    const msgs = store.getTopicMessages(topics[0].id).map((m) => m.message_id);
    expect(msgs.sort()).toEqual(['m-old', 'm1', 'm2', 'm3']);
  });

  it('handles null source independently from named sources', () => {
    insertMessage(db, 'm1', t0, null);
    insertMessage(db, 'm2', t0, 'discord');
    const detector = createTopicDetector({ store, gapMs: TOPIC_GAP_MS });

    detector.assign({ messageId: 'm1', timestamp: t0, source: null });
    detector.assign({ messageId: 'm2', timestamp: t0, source: 'discord' });

    const nullOpen = store.getOpenTopic(null);
    const discordOpen = store.getOpenTopic('discord');
    expect(nullOpen).not.toBeNull();
    expect(discordOpen).not.toBeNull();
    expect(nullOpen!.id).not.toBe(discordOpen!.id);
  });
});
