import type Database from 'better-sqlite3';

export interface InsertEntryParams {
  kind: 'user_msg' | 'assistant_msg' | 'tool_result';
  sourceId: string | null;
  content: string;
  createdAt: number;
  embedding: number[];
}

export interface InsertFactParams {
  key: string;
  value: string;
  createdAt: number;
  embedding: number[];
}

export interface VectorSearchParams {
  embedding: number[];
  limit: number;
  kind?: 'fact' | 'entry' | 'all';
}

export interface EntryHit {
  entityId: number;
  entityType: 'entry' | 'fact';
  score: number;
  content: string;
  kind: string;
  createdAt: number;
}

function toBuffer(vec: number[]): Buffer {
  return Buffer.from(new Float32Array(vec).buffer);
}

export function insertEntry(db: Database.Database, params: InsertEntryParams): number {
  const result = db
    .prepare(
      `INSERT INTO memory_entries (kind, source_id, content, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(params.kind, params.sourceId, params.content, params.createdAt);
  const id = Number(result.lastInsertRowid);

  db.prepare(
    `INSERT INTO memory_vec (entity_id, entity_type, embedding) VALUES (?, 'entry', ?)`,
  ).run(BigInt(id), toBuffer(params.embedding));

  return id;
}

export function insertOrSupersedeFact(db: Database.Database, params: InsertFactParams): number {
  const existing = db
    .prepare(
      `SELECT id, value FROM memory_facts
       WHERE key = ? AND superseded_by IS NULL`,
    )
    .get(params.key) as { id: number; value: string } | undefined;

  if (existing && existing.value === params.value) {
    db.prepare(
      `UPDATE memory_facts SET last_mentioned_at = ? WHERE id = ?`,
    ).run(params.createdAt, existing.id);
    return existing.id;
  }

  const result = db
    .prepare(
      `INSERT INTO memory_facts (key, value, created_at, last_mentioned_at, superseded_by)
       VALUES (?, ?, ?, ?, NULL)`,
    )
    .run(params.key, params.value, params.createdAt, params.createdAt);
  const newId = Number(result.lastInsertRowid);

  if (existing) {
    db.prepare(
      `UPDATE memory_facts SET superseded_by = ? WHERE id = ?`,
    ).run(newId, existing.id);
  }

  db.prepare(
    `INSERT INTO memory_vec (entity_id, entity_type, embedding) VALUES (?, 'fact', ?)`,
  ).run(BigInt(newId), toBuffer(params.embedding));

  return newId;
}

export function getActiveFacts(db: Database.Database): Array<{
  id: number;
  key: string;
  value: string;
  lastMentionedAt: number;
}> {
  return db
    .prepare(
      `SELECT id, key, value, last_mentioned_at AS lastMentionedAt
       FROM memory_facts
       WHERE superseded_by IS NULL
       ORDER BY last_mentioned_at DESC`,
    )
    .all() as Array<{ id: number; key: string; value: string; lastMentionedAt: number }>;
}

export function vectorSearch(db: Database.Database, params: VectorSearchParams): EntryHit[] {
  const results = db
    .prepare(
      `SELECT entity_id, entity_type, distance
       FROM memory_vec
       WHERE embedding MATCH ? AND k = ?
       ORDER BY distance`,
    )
    .all(toBuffer(params.embedding), params.limit) as Array<{
      entity_id: number;
      entity_type: string;
      distance: number;
    }>;

  const hits: EntryHit[] = [];
  for (const r of results) {
    if (r.entity_type === 'entry') {
      const row = db
        .prepare('SELECT content, kind, created_at FROM memory_entries WHERE id = ?')
        .get(r.entity_id) as { content: string; kind: string; created_at: number } | undefined;
      if (row) {
        hits.push({
          entityId: r.entity_id,
          entityType: 'entry',
          score: 1 - r.distance,
          content: row.content,
          kind: row.kind,
          createdAt: row.created_at,
        });
      }
    } else if (r.entity_type === 'fact') {
      const row = db
        .prepare('SELECT key, value, created_at FROM memory_facts WHERE id = ?')
        .get(r.entity_id) as { key: string; value: string; created_at: number } | undefined;
      if (row) {
        hits.push({
          entityId: r.entity_id,
          entityType: 'fact',
          score: 1 - r.distance,
          content: `${row.key}: ${row.value}`,
          kind: 'fact',
          createdAt: row.created_at,
        });
      }
    }
  }
  return hits;
}
