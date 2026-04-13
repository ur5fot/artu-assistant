import type Database from 'better-sqlite3';

export interface InsertEntryParams {
  kind: 'user_msg' | 'assistant_msg';
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
  importance?: number;
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
  kind: 'user_msg' | 'assistant_msg' | 'fact';
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
  // Normalize value so non-deterministic whitespace from the extractor LLM
  // ("Одеса" vs "Одеса ") doesn't trigger spurious supersede churn.
  const normalized: InsertFactParams = { ...params, value: params.value.trim().replace(/\s+/g, ' ') };
  const tx = db.transaction((p: InsertFactParams) => {
    const existing = db
      .prepare(
        `SELECT id, value, importance FROM memory_facts
         WHERE key = ? AND superseded_by IS NULL AND forgotten = 0`,
      )
      .get(p.key) as { id: number; value: string; importance: number } | undefined;

    const requestedImportance = p.importance ?? 1;
    const effectiveImportance = existing
      ? Math.max(existing.importance, requestedImportance)
      : requestedImportance;

    if (existing && existing.value === p.value) {
      db.prepare(
        `UPDATE memory_facts SET last_mentioned_at = ?, importance = ? WHERE id = ?`,
      ).run(p.createdAt, effectiveImportance, existing.id);
      return existing.id;
    }

    if (existing) {
      // Mark old row superseded BEFORE inserting new so the unique partial
      // index on (key) WHERE superseded_by IS NULL never sees two actives.
      // Self-reference acts as a non-null placeholder so the unique partial
      // index sees the row as inactive while we insert the replacement.
      db.prepare(
        `UPDATE memory_facts SET superseded_by = id WHERE id = ?`,
      ).run(existing.id);
      db.prepare(`DELETE FROM memory_vec_facts WHERE entity_id = ?`).run(BigInt(existing.id));
    }

    const result = db
      .prepare(
        `INSERT INTO memory_facts (key, value, created_at, last_mentioned_at, superseded_by, importance, forgotten)
         VALUES (?, ?, ?, ?, NULL, ?, 0)`,
      )
      .run(p.key, p.value, p.createdAt, p.createdAt, effectiveImportance);
    const newId = Number(result.lastInsertRowid);

    if (existing) {
      db.prepare(
        `UPDATE memory_facts SET superseded_by = ? WHERE id = ?`,
      ).run(newId, existing.id);
    }

    db.prepare(
      `INSERT INTO memory_vec_facts (entity_id, embedding) VALUES (?, ?)`,
    ).run(BigInt(newId), toBuffer(p.embedding));

    return newId;
  });
  return tx(normalized);
}

export function getActiveFacts(db: Database.Database): Array<{
  id: number;
  key: string;
  value: string;
  lastMentionedAt: number;
  importance: number;
}> {
  return db
    .prepare(
      `SELECT id, key, value, last_mentioned_at AS lastMentionedAt, importance
       FROM memory_facts
       WHERE superseded_by IS NULL AND forgotten = 0
       ORDER BY last_mentioned_at DESC`,
    )
    .all() as Array<{
      id: number;
      key: string;
      value: string;
      lastMentionedAt: number;
      importance: number;
    }>;
}

export function touchFactsLastMentioned(
  db: Database.Database,
  ids: number[],
  timestamp: number,
): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(
    `UPDATE memory_facts SET last_mentioned_at = ? WHERE id IN (${placeholders})`,
  ).run(timestamp, ...ids);
}

export function markFactForgotten(db: Database.Database, factId: number): boolean {
  // Self-reference superseded_by so the unique partial index on active keys
  // stops treating the forgotten row as live — otherwise re-inserting the same
  // key after a forget would hit the active-key constraint.
  const result = db
    .prepare(
      `UPDATE memory_facts SET forgotten = 1, superseded_by = COALESCE(superseded_by, id)
       WHERE id = ?`,
    )
    .run(factId);
  if (result.changes > 0) {
    db.prepare(`DELETE FROM memory_vec_facts WHERE entity_id = ?`).run(BigInt(factId));
    return true;
  }
  return false;
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
          kind: row.kind as 'user_msg' | 'assistant_msg',
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
        .prepare('SELECT key, value, created_at FROM memory_facts WHERE id = ? AND superseded_by IS NULL AND forgotten = 0')
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
