import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDb, closeDb, getDb } from '../../db.js';
import {
  insertEntry,
  insertOrSupersedeFact,
  getActiveFacts,
  vectorSearch,
  markFactForgotten,
  findFactsBySourceMessageId,
  findActiveFactByKey,
  findLastUserMessageBefore,
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

  it('stores importance when provided, defaults to 1', () => {
    const idDefault = insertOrSupersedeFact(getDb(), {
      key: 'user.hobby',
      value: 'chess',
      createdAt: 1,
      embedding: makeVec(0.4),
    });
    const idHigh = insertOrSupersedeFact(getDb(), {
      key: 'user.name',
      value: 'Діма',
      createdAt: 1,
      embedding: makeVec(0.5),
      importance: 10,
    });

    const rowDefault = getDb()
      .prepare('SELECT importance, forgotten FROM memory_facts WHERE id = ?')
      .get(idDefault) as { importance: number; forgotten: number };
    const rowHigh = getDb()
      .prepare('SELECT importance, forgotten FROM memory_facts WHERE id = ?')
      .get(idHigh) as { importance: number; forgotten: number };

    expect(rowDefault.importance).toBe(1);
    expect(rowDefault.forgotten).toBe(0);
    expect(rowHigh.importance).toBe(10);
  });

  it('importance never decreases on supersede — user-marked fact survives auto-rewrite', () => {
    insertOrSupersedeFact(getDb(), {
      key: 'user.name',
      value: 'Діма',
      createdAt: 1,
      embedding: makeVec(0.5),
      importance: 10,
    });
    const secondId = insertOrSupersedeFact(getDb(), {
      key: 'user.name',
      value: 'Dmytro',
      createdAt: 2,
      embedding: makeVec(0.6),
      // extractor default — importance=1
    });

    const row = getDb()
      .prepare('SELECT importance FROM memory_facts WHERE id = ?')
      .get(secondId) as { importance: number };
    expect(row.importance).toBe(10);
  });

  it('markFactForgotten hides the fact from getActiveFacts and vectorSearch', () => {
    const id = insertOrSupersedeFact(getDb(), {
      key: 'user.location',
      value: 'Київ',
      createdAt: 1,
      embedding: makeVec(0.5),
    });

    expect(getActiveFacts(getDb())).toHaveLength(1);
    const ok = markFactForgotten(getDb(), id);
    expect(ok).toBe(true);

    expect(getActiveFacts(getDb())).toHaveLength(0);

    const hits = vectorSearch(getDb(), { embedding: makeVec(0.5), limit: 10, kind: 'fact' });
    expect(hits).toHaveLength(0);
  });

  it('markFactForgotten returns false when id does not exist', () => {
    expect(markFactForgotten(getDb(), 99999)).toBe(false);
  });

  it('insertOrSupersedeFact ignores forgotten rows when checking for duplicates', () => {
    const firstId = insertOrSupersedeFact(getDb(), {
      key: 'user.name',
      value: 'Діма',
      createdAt: 1,
      embedding: makeVec(0.5),
    });
    markFactForgotten(getDb(), firstId);

    // After forgetting, a fresh insert of the same key should be a brand-new row,
    // not a supersede chain linked to the forgotten one.
    const secondId = insertOrSupersedeFact(getDb(), {
      key: 'user.name',
      value: 'Діма',
      createdAt: 2,
      embedding: makeVec(0.5),
    });
    expect(secondId).not.toBe(firstId);

    const active = getActiveFacts(getDb());
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ key: 'user.name', value: 'Діма' });
  });

  it('superseded facts disappear from vectorSearch', () => {
    insertOrSupersedeFact(getDb(), { key: 'user.location', value: 'Київ', createdAt: 1, embedding: makeVec(0.5) });
    insertOrSupersedeFact(getDb(), { key: 'user.location', value: 'Одеса', createdAt: 2, embedding: makeVec(0.5) });

    const hits = vectorSearch(getDb(), { embedding: makeVec(0.5), limit: 10, kind: 'fact' });
    expect(hits).toHaveLength(1);
    expect(hits[0].content).toBe('user.location: Одеса');
  });

  describe('insertOrSupersedeFact with sourceMessageId', () => {
    it('persists source_message_id', () => {
      const id = insertOrSupersedeFact(getDb(), {
        key: 'user.name',
        value: 'Dim',
        createdAt: 1000,
        embedding: makeVec(0.5),
        importance: 5,
        sourceMessageId: 'msg-1',
      });
      const row = getDb()
        .prepare('SELECT source_message_id FROM memory_facts WHERE id = ?')
        .get(id) as { source_message_id: string };
      expect(row.source_message_id).toBe('msg-1');
    });

    it('accepts null sourceMessageId for legacy callers', () => {
      const id = insertOrSupersedeFact(getDb(), {
        key: 'user.name',
        value: 'Dim',
        createdAt: 1000,
        embedding: makeVec(0.5),
        importance: 5,
      });
      const row = getDb()
        .prepare('SELECT source_message_id FROM memory_facts WHERE id = ?')
        .get(id) as { source_message_id: string | null };
      expect(row.source_message_id).toBeNull();
    });

    it('backfills NULL source_message_id on equal-value re-insert', () => {
      const db = getDb();
      const id = insertOrSupersedeFact(db, {
        key: 'user.birthday',
        value: '15 березня',
        createdAt: 1000,
        embedding: makeVec(0.5),
        importance: 10,
      });
      const again = insertOrSupersedeFact(db, {
        key: 'user.birthday',
        value: '15 березня',
        createdAt: 2000,
        embedding: makeVec(0.5),
        sourceMessageId: 'M-late',
      });
      expect(again).toBe(id);
      const row = db
        .prepare('SELECT source_message_id FROM memory_facts WHERE id = ?')
        .get(id) as { source_message_id: string | null };
      expect(row.source_message_id).toBe('M-late');
    });

    it('does not overwrite an existing source_message_id on equal-value re-insert', () => {
      const db = getDb();
      const id = insertOrSupersedeFact(db, {
        key: 'user.city',
        value: 'Київ',
        createdAt: 1000,
        embedding: makeVec(0.5),
        sourceMessageId: 'M-first',
      });
      insertOrSupersedeFact(db, {
        key: 'user.city',
        value: 'Київ',
        createdAt: 2000,
        embedding: makeVec(0.5),
        sourceMessageId: 'M-second',
      });
      const row = db
        .prepare('SELECT source_message_id FROM memory_facts WHERE id = ?')
        .get(id) as { source_message_id: string | null };
      expect(row.source_message_id).toBe('M-first');
    });
  });

  describe('findFactsBySourceMessageId', () => {
    it('returns only active (non-forgotten, non-superseded) facts with the given source', () => {
      const db = getDb();
      const active = insertOrSupersedeFact(db, {
        key: 'user.a',
        value: 'x',
        createdAt: 1000,
        embedding: makeVec(0.1),
        importance: 5,
        sourceMessageId: 'M1',
      });
      insertOrSupersedeFact(db, {
        key: 'user.b',
        value: 'y',
        createdAt: 1000,
        embedding: makeVec(0.2),
        importance: 5,
        sourceMessageId: 'M2',
      });
      const forgottenId = insertOrSupersedeFact(db, {
        key: 'user.c',
        value: 'z',
        createdAt: 1000,
        embedding: makeVec(0.3),
        importance: 5,
        sourceMessageId: 'M1',
      });
      markFactForgotten(db, forgottenId);

      const found = findFactsBySourceMessageId(db, 'M1');
      expect(found.map((f) => f.id)).toEqual([active]);
    });

    it('returns empty for unknown source', () => {
      expect(findFactsBySourceMessageId(getDb(), 'nope')).toEqual([]);
    });
  });

  describe('findActiveFactByKey', () => {
    it('returns the single active row or null', () => {
      const db = getDb();
      const id = insertOrSupersedeFact(db, {
        key: 'user.age',
        value: '42',
        createdAt: 1000,
        embedding: makeVec(0.5),
        importance: 5,
      });
      const found = findActiveFactByKey(db, 'user.age');
      expect(found).toEqual(
        expect.objectContaining({ id, key: 'user.age', value: '42' }),
      );
      expect(findActiveFactByKey(db, 'user.nope')).toBeNull();
    });

    it('ignores forgotten and superseded rows', () => {
      const db = getDb();
      const firstId = insertOrSupersedeFact(db, {
        key: 'user.loc',
        value: 'Kyiv',
        createdAt: 1000,
        embedding: makeVec(0.5),
      });
      markFactForgotten(db, firstId);
      expect(findActiveFactByKey(db, 'user.loc')).toBeNull();

      insertOrSupersedeFact(db, {
        key: 'user.loc',
        value: 'Odesa',
        createdAt: 2000,
        embedding: makeVec(0.6),
      });
      const newerId = insertOrSupersedeFact(db, {
        key: 'user.loc',
        value: 'Lviv',
        createdAt: 3000,
        embedding: makeVec(0.7),
      });
      const found = findActiveFactByKey(db, 'user.loc');
      expect(found).toEqual(
        expect.objectContaining({ id: newerId, value: 'Lviv' }),
      );
    });
  });

  describe('findLastUserMessageBefore', () => {
    it('returns most recent user message strictly before `before`', () => {
      const db = getDb();
      const ins = db.prepare(
        "INSERT INTO chat_messages (message_id, role, content, timestamp) VALUES (?, 'user', 'x', ?)",
      );
      ins.run('M1', 1000);
      ins.run('M2', 2000);
      ins.run('M_CURRENT', 3000);
      expect(findLastUserMessageBefore(db, 3000)?.messageId).toBe('M2');
      expect(findLastUserMessageBefore(db, 1500)?.messageId).toBe('M1');
      expect(findLastUserMessageBefore(db, 500)).toBeNull();
    });

    it('ignores assistant messages', () => {
      const db = getDb();
      db.prepare(
        "INSERT INTO chat_messages (message_id, role, content, timestamp) VALUES ('A1', 'assistant', 'x', 1000)",
      ).run();
      expect(findLastUserMessageBefore(db, 2000)).toBeNull();
    });

    it('finds prior message even on same-ms collision when currentMessageId is supplied', () => {
      const db = getDb();
      const ins = db.prepare(
        "INSERT INTO chat_messages (message_id, role, content, timestamp) VALUES (?, 'user', 'x', ?)",
      );
      ins.run('M_PREV', 1000);
      ins.run('M_CURRENT', 1000);
      // Without exclude: `< 1000` misses both same-ms rows.
      expect(findLastUserMessageBefore(db, 1000)).toBeNull();
      // With exclude: tuple-based ordering (timestamp, id) < (1000, M_CURRENT.id)
      // correctly finds M_PREV (id lower than M_CURRENT).
      expect(
        findLastUserMessageBefore(db, 1000, 'M_CURRENT')?.messageId,
      ).toBe('M_PREV');
    });

    it('ignores same-ms message inserted AFTER current (concurrent future race)', () => {
      const db = getDb();
      const ins = db.prepare(
        "INSERT INTO chat_messages (message_id, role, content, timestamp) VALUES (?, 'user', 'x', ?)",
      );
      // Insertion order: M_CURRENT first (lower id), then M_FUTURE at same ms
      // (higher id) — simulates another channel writing concurrently while the
      // current turn's tool loop is still running.
      ins.run('M_CURRENT', 1000);
      ins.run('M_FUTURE', 1000);
      // Must NOT return M_FUTURE: it was inserted after M_CURRENT, so it's
      // not a prior user turn. `message_id != M_CURRENT` alone would wrongly
      // pick M_FUTURE due to `ORDER BY id DESC`.
      expect(findLastUserMessageBefore(db, 1000, 'M_CURRENT')).toBeNull();
    });
  });
});
