import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDb, closeDb, getDb } from '../../db.js';
import {
  insertEntry,
  insertOrSupersedeFact,
  getActiveFacts,
  vectorSearch,
} from '../db.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('memory db', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-memory-db-'));
    initDb(path.join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeVec(seed: number): number[] {
    const vec = new Array(768).fill(0);
    vec[0] = seed;
    vec[1] = 1 - seed;
    return vec;
  }

  it('inserts an entry and its embedding', () => {
    const id = insertEntry(getDb(), {
      kind: 'user_msg',
      sourceId: 'msg-1',
      content: 'hello world',
      createdAt: 1000,
      embedding: makeVec(0.5),
    });
    expect(id).toBeGreaterThan(0);
    const row = getDb().prepare('SELECT kind, content FROM memory_entries WHERE id = ?').get(id) as { kind: string; content: string };
    expect(row.kind).toBe('user_msg');
    expect(row.content).toBe('hello world');
  });

  it('inserts a new fact when key is empty', () => {
    const id = insertOrSupersedeFact(getDb(), {
      key: 'user.location',
      value: 'Київ',
      createdAt: 1000,
      embedding: makeVec(0.5),
    });
    expect(id).toBeGreaterThan(0);
    const facts = getActiveFacts(getDb());
    expect(facts).toEqual([
      expect.objectContaining({ key: 'user.location', value: 'Київ' }),
    ]);
  });

  it('supersedes an existing fact with same key but different value', () => {
    const firstId = insertOrSupersedeFact(getDb(), {
      key: 'user.location',
      value: 'Київ',
      createdAt: 1000,
      embedding: makeVec(0.5),
    });
    const secondId = insertOrSupersedeFact(getDb(), {
      key: 'user.location',
      value: 'Одеса',
      createdAt: 2000,
      embedding: makeVec(0.6),
    });

    const firstRow = getDb().prepare('SELECT superseded_by FROM memory_facts WHERE id = ?').get(firstId) as { superseded_by: number };
    expect(firstRow.superseded_by).toBe(secondId);

    const active = getActiveFacts(getDb());
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ key: 'user.location', value: 'Одеса' });
  });

  it('updates last_mentioned_at when inserting same key+value', () => {
    const id = insertOrSupersedeFact(getDb(), {
      key: 'user.name',
      value: 'Діма',
      createdAt: 1000,
      embedding: makeVec(0.5),
    });
    const again = insertOrSupersedeFact(getDb(), {
      key: 'user.name',
      value: 'Діма',
      createdAt: 2000,
      embedding: makeVec(0.5),
    });
    expect(again).toBe(id);
    const row = getDb().prepare('SELECT last_mentioned_at FROM memory_facts WHERE id = ?').get(id) as { last_mentioned_at: number };
    expect(row.last_mentioned_at).toBe(2000);
  });

  it('vectorSearch returns entries sorted by similarity', () => {
    insertEntry(getDb(), { kind: 'user_msg', sourceId: 'a', content: 'apple', createdAt: 1, embedding: makeVec(0.1) });
    insertEntry(getDb(), { kind: 'user_msg', sourceId: 'b', content: 'banana', createdAt: 2, embedding: makeVec(0.9) });
    const hits = vectorSearch(getDb(), { embedding: makeVec(0.1), limit: 2 });
    expect(hits).toHaveLength(2);
    expect(hits[0].content).toBe('apple');
    expect(hits[1].content).toBe('banana');
  });

  it('entries and facts with colliding numeric ids both index and search', () => {
    // Both autoincrement from 1 — the previous single-table vec schema collided.
    insertEntry(getDb(), { kind: 'user_msg', sourceId: 'x', content: 'hello', createdAt: 1, embedding: makeVec(0.5) });
    insertOrSupersedeFact(getDb(), { key: 'user.name', value: 'Діма', createdAt: 1, embedding: makeVec(0.5) });

    const hits = vectorSearch(getDb(), { embedding: makeVec(0.5), limit: 10 });
    const kinds = hits.map((h) => h.entityType).sort();
    expect(kinds).toEqual(['entry', 'fact']);
  });

  it('vectorSearch filters by kind', () => {
    insertEntry(getDb(), { kind: 'user_msg', sourceId: 'a', content: 'msg', createdAt: 1, embedding: makeVec(0.5) });
    insertOrSupersedeFact(getDb(), { key: 'k', value: 'v', createdAt: 1, embedding: makeVec(0.5) });

    const onlyFacts = vectorSearch(getDb(), { embedding: makeVec(0.5), limit: 10, kind: 'fact' });
    expect(onlyFacts.every((h) => h.entityType === 'fact')).toBe(true);
    expect(onlyFacts).toHaveLength(1);

    const onlyEntries = vectorSearch(getDb(), { embedding: makeVec(0.5), limit: 10, kind: 'entry' });
    expect(onlyEntries.every((h) => h.entityType === 'entry')).toBe(true);
    expect(onlyEntries).toHaveLength(1);
  });

  it('superseded facts disappear from vectorSearch', () => {
    insertOrSupersedeFact(getDb(), { key: 'user.location', value: 'Київ', createdAt: 1, embedding: makeVec(0.5) });
    insertOrSupersedeFact(getDb(), { key: 'user.location', value: 'Одеса', createdAt: 2, embedding: makeVec(0.5) });

    const hits = vectorSearch(getDb(), { embedding: makeVec(0.5), limit: 10, kind: 'fact' });
    expect(hits).toHaveLength(1);
    expect(hits[0].content).toBe('user.location: Одеса');
  });
});
