import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDb, closeDb, getDb } from '../../db.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('memory schema', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-memory-schema-'));
    initDb(path.join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates memory_entries, memory_facts, and memory_vec tables', () => {
    const db = getDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','virtual')")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain('memory_entries');
    expect(names).toContain('memory_facts');
    expect(names).toContain('memory_vec_entries');
    expect(names).toContain('memory_vec_facts');
  });

  it('loads sqlite-vec extension and allows vec0 insert', () => {
    const db = getDb();
    const vec = new Float32Array(1024);
    vec[0] = 0.5;
    vec[1] = -0.3;
    db.prepare(
      `INSERT INTO memory_vec_entries (entity_id, embedding) VALUES (?, ?)`,
    ).run(BigInt(1), Buffer.from(vec.buffer));
    const row = db.prepare('SELECT entity_id FROM memory_vec_entries WHERE entity_id = 1').get() as { entity_id: number };
    expect(row.entity_id).toBe(1);
  });

  it('memory_facts has source_message_id column (nullable text)', () => {
    const db = getDb();
    const cols = db
      .prepare('PRAGMA table_info(memory_facts)')
      .all() as Array<{ name: string; type: string; notnull: number }>;
    const col = cols.find((c) => c.name === 'source_message_id');
    expect(col).toBeDefined();
    expect(col!.type.toUpperCase()).toBe('TEXT');
    expect(col!.notnull).toBe(0);
  });

  it('memory_facts has idx_facts_source_message index', () => {
    const db = getDb();
    const idx = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_facts_source_message'",
      )
      .get();
    expect(idx).toBeDefined();
  });
});
