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
  const tx = db.transaction((p: InsertEntryParams) => {
    const result = db
      .prepare(
        `INSERT INTO memory_entries (kind, source_id, content, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(p.kind, p.sourceId, p.content, p.createdAt);
    const id = Number(result.lastInsertRowid);
    db.prepare(
      `INSERT INTO memory_vec_entries (entity_id, embedding) VALUES (?, ?)`,
    ).run(BigInt(id), toBuffer(p.embedding));
    return id;
  });
  return tx(params);
}

export function insertOrSupersedeFact(db: Database.Database, params: InsertFactParams): number {
  const tx = db.transaction((p: InsertFactParams) => {
    const existing = db
      .prepare(
        `SELECT id, value FROM memory_facts
         WHERE key = ? AND superseded_by IS NULL`,
      )
      .get(p.key) as { id: number; value: string } | undefined;

    if (existing && existing.value === p.value) {
      db.prepare(
        `UPDATE memory_facts SET last_mentioned_at = ? WHERE id = ?`,
      ).run(p.createdAt, existing.id);
      return existing.id;
    }

    const result = db
      .prepare(
        `INSERT INTO memory_facts (key, value, created_at, last_mentioned_at, superseded_by)
         VALUES (?, ?, ?, ?, NULL)`,
      )
      .run(p.key, p.value, p.createdAt, p.createdAt);
    const newId = Number(result.lastInsertRowid);

    if (existing) {
      db.prepare(
        `UPDATE memory_facts SET superseded_by = ? WHERE id = ?`,
      ).run(newId, existing.id);
      // Drop the vector for the superseded fact so search no longer surfaces it.
      db.prepare(`DELETE FROM memory_vec_facts WHERE entity_id = ?`).run(BigInt(existing.id));
    }

    db.prepare(
      `INSERT INTO memory_vec_facts (entity_id, embedding) VALUES (?, ?)`,
    ).run(BigInt(newId), toBuffer(p.embedding));

    return newId;
  });
  return tx(params);
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
  const wantEntries = params.kind !== 'fact';
  const wantFacts = params.kind !== 'entry';
  const hits: EntryHit[] = [];

  if (wantEntries) {
    const rows = db
      .prepare(
        `SELECT entity_id, distance
         FROM memory_vec_entries
         WHERE embedding MATCH ? AND k = ?
         ORDER BY distance`,
      )
      .all(toBuffer(params.embedding), params.limit) as Array<{
        entity_id: number;
        distance: number;
      }>;
    for (const r of rows) {
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
    }
  }

  if (wantFacts) {
    const rows = db
      .prepare(
        `SELECT entity_id, distance
         FROM memory_vec_facts
         WHERE embedding MATCH ? AND k = ?
         ORDER BY distance`,
      )
      .all(toBuffer(params.embedding), params.limit) as Array<{
        entity_id: number;
        distance: number;
      }>;
    for (const r of rows) {
      const row = db
        .prepare('SELECT key, value, created_at FROM memory_facts WHERE id = ? AND superseded_by IS NULL')
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

  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, params.limit);
}
