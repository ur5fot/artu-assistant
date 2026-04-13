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
      assistantMessage: 'приємно познайомитись',
      timestamp: 1000,
    });

    const facts = await svc.getActiveFacts();
    expect(facts).toEqual([
      expect.objectContaining({ key: 'user.name', value: 'Діма' }),
    ]);
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
    const prefix = await svc.buildContextPrefix('test');
    expect(prefix).toBe('');
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
      assistantMessage: 'круто',
      timestamp: 1000,
    });

    const prefix = await svc.buildContextPrefix('де я живу?');
    expect(prefix).toContain('ПАМ\'ЯТЬ R2');
    expect(prefix).toContain('user.location');
    expect(prefix).toContain('Одеса');
  });
});
