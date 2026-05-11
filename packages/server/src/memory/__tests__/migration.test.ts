import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { ensureEmbedModelMatches } from '../migration.js';
import type { EmbeddingsClient } from '../embeddings.js';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  sqliteVec.load(db);
  db.exec(`
    CREATE TABLE memory_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL, source_id TEXT, content TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE memory_facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL, value TEXT NOT NULL, created_at INTEGER NOT NULL,
      superseded_by INTEGER REFERENCES memory_facts(id),
      last_mentioned_at INTEGER NOT NULL,
      importance INTEGER NOT NULL DEFAULT 1,
      forgotten INTEGER NOT NULL DEFAULT 0,
      source_message_id TEXT
    );
    CREATE TABLE memory_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE VIRTUAL TABLE memory_vec_entries USING vec0(
      entity_id INTEGER PRIMARY KEY, embedding FLOAT[1024] distance_metric=cosine
    );
    CREATE VIRTUAL TABLE memory_vec_facts USING vec0(
      entity_id INTEGER PRIMARY KEY, embedding FLOAT[1024] distance_metric=cosine
    );
  `);
  return db;
}

function makeEmbeddings(identity: string, dim = 1024): EmbeddingsClient {
  return {
    dimension: dim,
    identity,
    embedDocument: vi.fn().mockResolvedValue(Array.from({ length: dim }, () => 0)),
    embedQuery: vi.fn().mockResolvedValue(Array.from({ length: dim }, () => 0)),
  };
}

describe('ensureEmbedModelMatches', () => {
  it('on empty DB with no stored identity, records current identity, no embed calls', async () => {
    const db = makeDb();
    const embeddings = makeEmbeddings('ollama:nomic-embed-text');

    await ensureEmbedModelMatches(db, embeddings);

    const row = db.prepare('SELECT value FROM memory_metadata WHERE key=?').get('embed_model') as { value: string };
    expect(row.value).toBe('ollama:nomic-embed-text');
    expect(embeddings.embedDocument).not.toHaveBeenCalled();
  });

  it('on subsequent boot with same identity, is a no-op', async () => {
    const db = makeDb();
    db.prepare('INSERT INTO memory_metadata (key, value) VALUES (?, ?)').run(
      'embed_model',
      'ollama:nomic-embed-text',
    );
    const embeddings = makeEmbeddings('ollama:nomic-embed-text');

    await ensureEmbedModelMatches(db, embeddings);

    expect(embeddings.embedDocument).not.toHaveBeenCalled();
  });

  it('on identity change with existing data, wipes vec tables and reindexes', async () => {
    const db = makeDb();
    const buf = Buffer.from(new Float32Array(Array.from({ length: 1024 }, () => 0.1)).buffer);
    db.prepare(
      `INSERT INTO memory_entries (kind, source_id, content, created_at) VALUES (?, ?, ?, ?)`,
    ).run('user_msg', null, 'hello world', 1000);
    db.prepare('INSERT INTO memory_vec_entries (entity_id, embedding) VALUES (?, ?)').run(
      BigInt(1),
      buf,
    );
    db.prepare(
      `INSERT INTO memory_facts (key, value, created_at, last_mentioned_at, importance, forgotten)
       VALUES (?, ?, ?, ?, ?, 0)`,
    ).run('user.location', 'Одеса', 1000, 1000, 1);
    db.prepare('INSERT INTO memory_vec_facts (entity_id, embedding) VALUES (?, ?)').run(
      BigInt(1),
      buf,
    );
    db.prepare('INSERT INTO memory_metadata (key, value) VALUES (?, ?)').run(
      'embed_model',
      'ollama:nomic-embed-text',
    );

    const embeddings = makeEmbeddings('voyage:voyage-3', 1024);
    await ensureEmbedModelMatches(db, embeddings);

    expect(embeddings.embedDocument).toHaveBeenCalledTimes(2);
    expect(embeddings.embedDocument).toHaveBeenCalledWith('hello world');
    expect(embeddings.embedDocument).toHaveBeenCalledWith('user.location: Одеса');

    const row = db.prepare('SELECT value FROM memory_metadata WHERE key=?').get('embed_model') as { value: string };
    expect(row.value).toBe('voyage:voyage-3');

    expect(db.prepare('SELECT COUNT(*) AS c FROM memory_vec_entries').get()).toEqual({ c: 1 });
    expect(db.prepare('SELECT COUNT(*) AS c FROM memory_vec_facts').get()).toEqual({ c: 1 });
  });

  it('migration is idempotent: re-running after success is a no-op', async () => {
    const db = makeDb();
    const embeddings = makeEmbeddings('ollama:nomic-embed-text');
    await ensureEmbedModelMatches(db, embeddings);
    (embeddings.embedDocument as any).mockClear();

    await ensureEmbedModelMatches(db, embeddings);
    expect(embeddings.embedDocument).not.toHaveBeenCalled();
  });

  // Legacy DB upgrade path: pre-metadata code wrote vec rows without ever
  // recording an identity. On first boot under the new code, that DB has a
  // null identity AND non-empty vec tables — the migration must treat it as a
  // provider mismatch and reindex. A regression that simply writes the
  // current identity without rebuilding would leave the old (potentially
  // different-dim or different-model) vectors in place and corrupt search.
  it('on legacy DB (no stored identity but vec data present), wipes and reindexes', async () => {
    const db = makeDb();
    const buf = Buffer.from(new Float32Array(Array.from({ length: 1024 }, () => 0.1)).buffer);
    db.prepare(
      `INSERT INTO memory_entries (kind, source_id, content, created_at) VALUES (?, ?, ?, ?)`,
    ).run('user_msg', null, 'legacy entry', 1000);
    db.prepare('INSERT INTO memory_vec_entries (entity_id, embedding) VALUES (?, ?)').run(
      BigInt(1),
      buf,
    );
    db.prepare(
      `INSERT INTO memory_facts (key, value, created_at, last_mentioned_at, importance, forgotten)
       VALUES (?, ?, ?, ?, ?, 0)`,
    ).run('user.name', 'Roman', 1000, 1000, 1);
    db.prepare('INSERT INTO memory_vec_facts (entity_id, embedding) VALUES (?, ?)').run(
      BigInt(1),
      buf,
    );
    // No memory_metadata row → stored identity is null.

    const embeddings = makeEmbeddings('voyage:voyage-3', 1024);
    await ensureEmbedModelMatches(db, embeddings);

    expect(embeddings.embedDocument).toHaveBeenCalledTimes(2);
    expect(embeddings.embedDocument).toHaveBeenCalledWith('legacy entry');
    expect(embeddings.embedDocument).toHaveBeenCalledWith('user.name: Roman');
    const row = db
      .prepare('SELECT value FROM memory_metadata WHERE key=?')
      .get('embed_model') as { value: string };
    expect(row.value).toBe('voyage:voyage-3');
  });

  // wipeAndReindex pulls only active facts. A regression dropping the
  // `superseded_by IS NULL AND forgotten = 0` filter would re-embed (and pay
  // for) tombstoned rows and resurface them in search results.
  it('on reindex, skips superseded and forgotten facts', async () => {
    const db = makeDb();
    db.prepare(
      `INSERT INTO memory_facts (key, value, created_at, last_mentioned_at, importance, forgotten, superseded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('user.city', 'Київ', 1000, 1000, 1, 0, null);
    db.prepare(
      `INSERT INTO memory_facts (key, value, created_at, last_mentioned_at, importance, forgotten, superseded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('user.city', 'Одеса', 2000, 2000, 1, 0, 1);
    db.prepare(
      `INSERT INTO memory_facts (key, value, created_at, last_mentioned_at, importance, forgotten, superseded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('user.hobby', 'fishing', 1500, 1500, 1, 1, null);
    db.prepare('INSERT INTO memory_metadata (key, value) VALUES (?, ?)').run(
      'embed_model',
      'ollama:nomic-embed-text',
    );

    const embeddings = makeEmbeddings('voyage:voyage-3', 1024);
    await ensureEmbedModelMatches(db, embeddings);

    expect(embeddings.embedDocument).toHaveBeenCalledTimes(1);
    expect(embeddings.embedDocument).toHaveBeenCalledWith('user.city: Київ');
  });
});
