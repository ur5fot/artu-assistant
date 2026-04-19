import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { initDb, closeDb, getDb } from '../../db.js';
import { createMemoryService } from '../service.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('MemoryService', () => {
  let tmpDir: string;
  let mockEmbeddings: { embed: ReturnType<typeof vi.fn> };
  let mockOllama: { chat: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-memory-svc-'));
    initDb(path.join(tmpDir, 'test.db'));
    mockEmbeddings = {
      embed: vi.fn().mockImplementation(async (text: string) => {
        // Deterministic hash-based vector so similarity ordering is reproducible.
        const vec = new Array(768).fill(0);
        let h = 0;
        for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
        vec[0] = ((h >>> 0) % 1000) / 1000;
        vec[1] = 1 - vec[0];
        return vec;
      }),
    };
    mockOllama = { chat: vi.fn().mockResolvedValue({ text: '[]' }) };
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('indexTurn stores user and assistant entries (tool results excluded)', async () => {
    const svc = createMemoryService({
      db: getDb(),
      embeddings: mockEmbeddings as any,
      ollama: mockOllama as any,
      extractorModel: 'qwen2.5:7b',
    });

    await svc.indexTurn({
      userMessage: 'привіт',
      userMessageId: 'msg-1',
      assistantMessage: 'вітаю',
      timestamp: 1000,
    });

    const count = getDb().prepare('SELECT COUNT(*) AS c FROM memory_entries').get() as { c: number };
    expect(count.c).toBe(2);
    expect(mockEmbeddings.embed).toHaveBeenCalledTimes(2);
  });

  it('indexTurn extracts and stores facts', async () => {
    mockOllama.chat.mockResolvedValue({
      text: '[{"key":"user.name","value":"Діма"}]',
    });

    const svc = createMemoryService({
      db: getDb(),
      embeddings: mockEmbeddings as any,
      ollama: mockOllama as any,
      extractorModel: 'qwen2.5:7b',
    });

    await svc.indexTurn({
      userMessage: 'мене звати Діма',
      userMessageId: 'msg-1',
      assistantMessage: 'приємно познайомитись',
      timestamp: 1000,
    });

    const facts = await svc.getActiveFacts();
    expect(facts).toEqual([
      expect.objectContaining({ key: 'user.name', value: 'Діма' }),
    ]);
  });

  it('indexTurn passes userMessageId to insertOrSupersedeFact', async () => {
    mockOllama.chat.mockResolvedValue({
      text: '[{"key":"user.x","value":"y","importance":5}]',
    });

    const svc = createMemoryService({
      db: getDb(),
      embeddings: mockEmbeddings as any,
      ollama: mockOllama as any,
      extractorModel: 'qwen2.5:7b',
    });

    await svc.indexTurn({
      userMessage: 'катаюсь на велике',
      userMessageId: 'msg-abc',
      assistantMessage: 'ок',
      timestamp: 1000,
    });

    const row = getDb()
      .prepare("SELECT source_message_id FROM memory_facts WHERE key = 'user.x'")
      .get() as { source_message_id: string } | undefined;
    expect(row?.source_message_id).toBe('msg-abc');
  });

  it('saveFact threads sourceMessageId through to the persisted row', async () => {
    const svc = createMemoryService({
      db: getDb(),
      embeddings: mockEmbeddings as any,
      ollama: mockOllama as any,
      extractorModel: 'qwen2.5:7b',
    });
    await svc.saveFact({
      key: 'user.note',
      value: 'привіт',
      importance: 10,
      sourceMessageId: 'MSG-REMEMBER',
    });
    const row = getDb()
      .prepare("SELECT source_message_id FROM memory_facts WHERE key = 'user.note'")
      .get() as { source_message_id: string } | undefined;
    expect(row?.source_message_id).toBe('MSG-REMEMBER');
  });

  it('indexTurn does not throw when embeddings fail', async () => {
    mockEmbeddings.embed.mockRejectedValueOnce(new Error('ollama down'));
    const svc = createMemoryService({
      db: getDb(),
      embeddings: mockEmbeddings as any,
      ollama: mockOllama as any,
      extractorModel: 'qwen2.5:7b',
    });
    await expect(svc.indexTurn({
      userMessage: 'x',
      userMessageId: 'msg-1',
      assistantMessage: 'y',
      timestamp: 1000,
    })).resolves.not.toThrow();
  });

  it('buildContextPrefix returns empty string when memory is empty', async () => {
    const svc = createMemoryService({
      db: getDb(),
      embeddings: mockEmbeddings as any,
      ollama: mockOllama as any,
      extractorModel: 'qwen2.5:7b',
    });
    const result = await svc.buildContextPrefix('test');
    expect(result.prefix).toBe('');
    expect(result.recalledFacts).toEqual([]);
  });

  it('buildContextPrefix injects active facts and entries', async () => {
    mockOllama.chat.mockResolvedValue({
      text: '[{"key":"user.location","value":"Одеса"}]',
    });
    const svc = createMemoryService({
      db: getDb(),
      embeddings: mockEmbeddings as any,
      ollama: mockOllama as any,
      extractorModel: 'qwen2.5:7b',
    });

    await svc.indexTurn({
      userMessage: 'я з Одеси',
      userMessageId: 'msg-1',
      assistantMessage: 'круто',
      timestamp: Date.now(),
    });

    const { prefix, recalledFacts } = await svc.buildContextPrefix('де я живу?');
    expect(prefix).toContain('ПАМ\'ЯТЬ R2');
    expect(prefix).toContain('user.location');
    expect(prefix).toContain('Одеса');
    expect(recalledFacts).toEqual([
      expect.objectContaining({ key: 'user.location', value: 'Одеса' }),
    ]);
  });

  it('buildContextPrefix ranks high-importance facts and drops decayed low-importance ones', async () => {
    const svc = createMemoryService({
      db: getDb(),
      embeddings: mockEmbeddings as any,
      ollama: mockOllama as any,
      extractorModel: 'qwen2.5:7b',
    });

    // Recent important fact — should always surface.
    await svc.saveFact({ key: 'user.name', value: 'Іван', importance: 10, timestamp: Date.now() });
    // Very old low-importance fact — score drops below MIN_RECALL_SCORE.
    const oldTs = Date.now() - 365 * 24 * 3600 * 1000;
    await svc.saveFact({ key: 'user.pet', value: 'кіт', importance: 1, timestamp: oldTs });

    const { recalledFacts, prefix } = await svc.buildContextPrefix('хто я?');
    const keys = recalledFacts.map((f) => f.key);
    expect(keys).toContain('user.name');
    expect(keys).not.toContain('user.pet');
    expect(prefix).toContain('user.name');
    expect(prefix).not.toContain('user.pet');
  });

  it('buildContextPrefix reconsolidates last_mentioned_at for recalled facts', async () => {
    const svc = createMemoryService({
      db: getDb(),
      embeddings: mockEmbeddings as any,
      ollama: mockOllama as any,
      extractorModel: 'qwen2.5:7b',
    });

    const oldTs = Date.now() - 7 * 24 * 3600 * 1000;
    await svc.saveFact({ key: 'user.city', value: 'Київ', importance: 5, timestamp: oldTs });

    const before = (await svc.getActiveFacts()).find((f) => f.key === 'user.city')!;
    expect(before.lastMentionedAt).toBe(oldTs);

    // Query text matches the stored fact text so the deterministic hash-based
    // mock embedding yields an exact vector match — reconsolidation only
    // refreshes facts that clear the vector-relevance threshold, so an
    // unrelated query would (correctly) NOT bump last_mentioned_at.
    await svc.buildContextPrefix('user.city: Київ');

    const after = (await svc.getActiveFacts()).find((f) => f.key === 'user.city')!;
    expect(after.lastMentionedAt).toBeGreaterThan(oldTs);
  });


  it('forgetFact marks an exact-key match forgotten and removes it from recall', async () => {
    const svc = createMemoryService({
      db: getDb(),
      embeddings: mockEmbeddings as any,
      ollama: mockOllama as any,
      extractorModel: 'qwen2.5:7b',
    });

    await svc.saveFact({ key: 'user.wife', value: 'Марина', importance: 10, timestamp: Date.now() });
    await svc.saveFact({ key: 'user.name', value: 'Іван', importance: 10, timestamp: Date.now() });

    const result = await svc.forgetFact({ query: 'user.wife' });
    expect(result.forgotten).toEqual([
      expect.objectContaining({ key: 'user.wife', value: 'Марина' }),
    ]);
    expect(result.candidates).toEqual([]);

    const active = await svc.getActiveFacts();
    expect(active.map((f) => f.key)).not.toContain('user.wife');
    expect(active.map((f) => f.key)).toContain('user.name');

    const { recalledFacts } = await svc.buildContextPrefix('хто моя дружина?');
    expect(recalledFacts.map((f) => f.key)).not.toContain('user.wife');
  });

  it('forgetFact returns empty result when query matches nothing', async () => {
    const svc = createMemoryService({
      db: getDb(),
      embeddings: mockEmbeddings as any,
      ollama: mockOllama as any,
      extractorModel: 'qwen2.5:7b',
    });
    const result = await svc.forgetFact({ query: 'user.unknown' });
    expect(result.forgotten).toEqual([]);
    expect(result.candidates).toEqual([]);
  });

  it('forgetFact rejects empty query', async () => {
    const svc = createMemoryService({
      db: getDb(),
      embeddings: mockEmbeddings as any,
      ollama: mockOllama as any,
      extractorModel: 'qwen2.5:7b',
    });
    const result = await svc.forgetFact({ query: '   ' });
    expect(result.forgotten).toEqual([]);
    expect(result.candidates).toEqual([]);
  });

  describe('updateFact', () => {
    it('supersedes active fact with new value + new sourceMessageId', async () => {
      const svc = createMemoryService({
        db: getDb(),
        embeddings: mockEmbeddings as any,
        ollama: mockOllama as any,
        extractorModel: 'qwen2.5:7b',
      });

      await svc.saveFact({ key: 'user.age', value: '42', importance: 5, timestamp: 1000 });

      const res = await svc.updateFact({ key: 'user.age', newValue: '43', sourceMessageId: 'MSG-X' });
      expect(res).toEqual({ updated: { key: 'user.age', oldValue: '42', newValue: '43' } });

      const row = getDb()
        .prepare(
          "SELECT value, source_message_id FROM memory_facts WHERE key = 'user.age' AND superseded_by IS NULL AND forgotten = 0",
        )
        .get() as { value: string; source_message_id: string };
      expect(row).toEqual({ value: '43', source_message_id: 'MSG-X' });
    });

    it('returns error when no active fact exists', async () => {
      const svc = createMemoryService({
        db: getDb(),
        embeddings: mockEmbeddings as any,
        ollama: mockOllama as any,
        extractorModel: 'qwen2.5:7b',
      });
      const res = await svc.updateFact({ key: 'user.missing', newValue: 'x', sourceMessageId: 'M' });
      expect(res).toEqual({ error: 'Не знайдено активного факту "user.missing"', key: 'user.missing' });
    });

    it('returns error for empty new value', async () => {
      const svc = createMemoryService({
        db: getDb(),
        embeddings: mockEmbeddings as any,
        ollama: mockOllama as any,
        extractorModel: 'qwen2.5:7b',
      });
      await svc.saveFact({ key: 'user.age', value: '42', importance: 5, timestamp: 1000 });
      const res = await svc.updateFact({ key: 'user.age', newValue: '   ', sourceMessageId: 'M' });
      expect(res).toEqual({ error: 'Порожнє нове значення', key: 'user.age' });
    });

    it('normalizes LLM-supplied keys so "User.Age" matches the stored "user.age"', async () => {
      const svc = createMemoryService({
        db: getDb(),
        embeddings: mockEmbeddings as any,
        ollama: mockOllama as any,
        extractorModel: 'qwen2.5:7b',
      });
      await svc.saveFact({ key: 'user.age', value: '42', importance: 5, timestamp: 1000 });
      const res = await svc.updateFact({ key: 'User.Age', newValue: '43', sourceMessageId: 'M' });
      expect(res).toEqual({ updated: { key: 'user.age', oldValue: '42', newValue: '43' } });
    });

    it('rejects malformed keys instead of persisting them bypassing saveFact validation', async () => {
      const svc = createMemoryService({
        db: getDb(),
        embeddings: mockEmbeddings as any,
        ollama: mockOllama as any,
        extractorModel: 'qwen2.5:7b',
      });
      const res = await svc.updateFact({ key: 'user.', newValue: 'x', sourceMessageId: 'M' });
      expect(res).toEqual({ error: 'Некоректний ключ', key: 'user.' });
    });
  });

  describe('forgetLast', () => {
    it('forgets all active facts with sourceMessageId of the most recent user msg before given timestamp', async () => {
      const svc = createMemoryService({
        db: getDb(),
        embeddings: mockEmbeddings as any,
        ollama: mockOllama as any,
        extractorModel: 'qwen2.5:7b',
      });
      const db = getDb();

      db.prepare(
        "INSERT INTO chat_messages (message_id, role, content, timestamp) VALUES ('M_prev', 'user', 'x', 1000)",
      ).run();
      db.prepare(
        "INSERT INTO chat_messages (message_id, role, content, timestamp) VALUES ('M_curr', 'user', 'y', 2000)",
      ).run();

      // Two facts from M_prev (should be forgotten), one from M_curr (should remain).
      mockOllama.chat.mockResolvedValue({
        text: '[{"key":"user.a","value":"alpha"},{"key":"user.b","value":"beta"}]',
      });
      await svc.indexTurn({
        userMessage: 'seed prev',
        userMessageId: 'M_prev',
        assistantMessage: 'ok',
        timestamp: 1000,
      });
      mockOllama.chat.mockResolvedValue({
        text: '[{"key":"user.c","value":"gamma"}]',
      });
      await svc.indexTurn({
        userMessage: 'seed curr',
        userMessageId: 'M_curr',
        assistantMessage: 'ok',
        timestamp: 2000,
      });

      const res = await svc.forgetLast({ currentMessageTimestamp: 2000 });
      expect(res.forgotten.length).toBe(2);
      expect(res.forgotten.map((f) => f.key).sort()).toEqual(['user.a', 'user.b']);
      expect(res.sourceMessageId).toBe('M_prev');

      const active = await svc.getActiveFacts();
      expect(active.map((f) => f.key)).toEqual(['user.c']);
    });

    it('dryRun returns facts without marking them forgotten', async () => {
      const svc = createMemoryService({
        db: getDb(),
        embeddings: mockEmbeddings as any,
        ollama: mockOllama as any,
        extractorModel: 'qwen2.5:7b',
      });
      const db = getDb();
      db.prepare(
        "INSERT INTO chat_messages (message_id, role, content, timestamp) VALUES ('M_prev', 'user', 'x', 1000)",
      ).run();
      mockOllama.chat.mockResolvedValue({
        text: '[{"key":"user.a","value":"alpha"}]',
      });
      await svc.indexTurn({
        userMessage: 'seed',
        userMessageId: 'M_prev',
        assistantMessage: 'ok',
        timestamp: 1000,
      });

      const preview = await svc.forgetLast({ currentMessageTimestamp: 2000, dryRun: true });
      expect(preview.forgotten.map((f) => f.key)).toEqual(['user.a']);

      // The fact must still be active — dry-run must not mutate rows, otherwise
      // cancelling the confirm dialog would silently delete data.
      const active = await svc.getActiveFacts();
      expect(active.map((f) => f.key)).toContain('user.a');
    });

    it('returns empty when no previous user message', async () => {
      const svc = createMemoryService({
        db: getDb(),
        embeddings: mockEmbeddings as any,
        ollama: mockOllama as any,
        extractorModel: 'qwen2.5:7b',
      });
      const res = await svc.forgetLast({ currentMessageTimestamp: 1000 });
      expect(res).toEqual({ forgotten: [], sourceMessageId: null, reason: 'no previous user message' });
    });

    it('returns empty when previous user message has no active facts', async () => {
      const svc = createMemoryService({
        db: getDb(),
        embeddings: mockEmbeddings as any,
        ollama: mockOllama as any,
        extractorModel: 'qwen2.5:7b',
      });
      getDb()
        .prepare(
          "INSERT INTO chat_messages (message_id, role, content, timestamp) VALUES ('M_prev', 'user', 'x', 1000)",
        )
        .run();
      const res = await svc.forgetLast({ currentMessageTimestamp: 2000 });
      expect(res).toEqual({ forgotten: [], sourceMessageId: 'M_prev', reason: 'no active facts' });
    });
  });
});
