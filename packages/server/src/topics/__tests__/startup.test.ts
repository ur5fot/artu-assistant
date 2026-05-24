import { describe, expect, it, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createTopicStore, type TopicStore } from '../store.js';
import { autocloseStaleOpenTopics } from '../startup.js';
import { TOPIC_GAP_MS } from '../detector.js';

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

describe('autocloseStaleOpenTopics', () => {
  let db: Database.Database;
  let store: TopicStore;
  const now = 1_700_000_000_000;

  beforeEach(() => {
    db = freshDb();
    store = createTopicStore({ db });
  });

  it('closes an open topic whose last message is older than the cutoff', () => {
    const ancient = now - TOPIC_GAP_MS - 60_000;
    insertMessage(db, 'm1', ancient);
    const topic = store.createOpen(ancient, 'discord');
    store.linkMessage(topic.id, 'm1');

    const count = autocloseStaleOpenTopics(store, TOPIC_GAP_MS, now);

    expect(count).toBe(1);
    const after = db
      .prepare(`SELECT status, ended_at FROM chat_topics WHERE id = ?`)
      .get(topic.id) as { status: string; ended_at: number };
    expect(after.status).toBe('closed');
    expect(after.ended_at).toBe(now - TOPIC_GAP_MS);
    // No open topic remains for the source.
    expect(store.getOpenTopic('discord')).toBeNull();
  });

  it('closes an open topic with no linked messages (defensive)', () => {
    const ancient = now - TOPIC_GAP_MS - 60_000;
    const topic = store.createOpen(ancient, 'discord');

    const count = autocloseStaleOpenTopics(store, TOPIC_GAP_MS, now);

    expect(count).toBe(1);
    const after = db
      .prepare(`SELECT status, ended_at FROM chat_topics WHERE id = ?`)
      .get(topic.id) as { status: string; ended_at: number };
    expect(after.status).toBe('closed');
    expect(after.ended_at).toBe(now - TOPIC_GAP_MS);
  });

  it('leaves a topic open if its last message is within the gap', () => {
    const recent = now - 60_000;
    insertMessage(db, 'm1', recent);
    const topic = store.createOpen(recent, 'discord');
    store.linkMessage(topic.id, 'm1');

    const count = autocloseStaleOpenTopics(store, TOPIC_GAP_MS, now);

    expect(count).toBe(0);
    const after = db
      .prepare(`SELECT status FROM chat_topics WHERE id = ?`)
      .get(topic.id) as { status: string };
    expect(after.status).toBe('open');
    expect(store.getOpenTopic('discord')).not.toBeNull();
  });

  it('returns 0 when there are no open topics', () => {
    expect(autocloseStaleOpenTopics(store, TOPIC_GAP_MS, now)).toBe(0);
  });

  it('closes only stale topics across multiple sources', () => {
    const ancient = now - TOPIC_GAP_MS - 60_000;
    const recent = now - 60_000;

    insertMessage(db, 'm-old', ancient, 'discord');
    const staleTopic = store.createOpen(ancient, 'discord');
    store.linkMessage(staleTopic.id, 'm-old');

    insertMessage(db, 'm-new', recent, 'web');
    const freshTopic = store.createOpen(recent, 'web');
    store.linkMessage(freshTopic.id, 'm-new');

    const count = autocloseStaleOpenTopics(store, TOPIC_GAP_MS, now);

    expect(count).toBe(1);
    expect(store.getOpenTopic('discord')).toBeNull();
    expect(store.getOpenTopic('web')).not.toBeNull();
  });
});
