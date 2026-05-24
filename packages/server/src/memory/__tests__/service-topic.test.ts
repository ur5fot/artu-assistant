import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initDb, closeDb, getDb } from '../../db.js';
import { createMemoryService } from '../service.js';

type MockEmbeddings = {
  dimension: number;
  identity: string;
  embedDocument: ReturnType<typeof vi.fn>;
  embedQuery: ReturnType<typeof vi.fn>;
};

function makeHashEmbedder(): MockEmbeddings {
  const impl = async (text: string): Promise<number[]> => {
    const vec = new Array(1024).fill(0);
    let h = 0;
    for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
    vec[0] = ((h >>> 0) % 1000) / 1000;
    vec[1] = 1 - vec[0];
    return vec;
  };
  return {
    dimension: 1024,
    identity: 'ollama:mxbai-embed-large',
    embedDocument: vi.fn().mockImplementation(impl),
    embedQuery: vi.fn().mockImplementation(impl),
  };
}

describe('MemoryService topic methods', () => {
  let tmpDir: string;
  let mockEmbeddings: MockEmbeddings;
  let mockTextProvider: { chat: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-memory-topic-'));
    initDb(path.join(tmpDir, 'test.db'));
    mockEmbeddings = makeHashEmbedder();
    mockTextProvider = { chat: vi.fn().mockResolvedValue({ text: '[]' }) };
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('indexTopicSummary writes a topic_summary entry to memory_entries', async () => {
    const svc = createMemoryService({
      db: getDb(),
      embeddings: mockEmbeddings as any,
      textProvider: mockTextProvider as any,
      extractorModel: 'qwen2.5:7b',
    });

    await svc.indexTopicSummary({
      topicId: 42,
      label: 'fixed bug X',
      summary: 'patched foo.ts to handle null inputs',
      finalizedAt: 5000,
    });

    const row = getDb()
      .prepare('SELECT kind, source_id, content, created_at FROM memory_entries WHERE kind = ?')
      .get('topic_summary') as { kind: string; source_id: string; content: string; created_at: number };
    expect(row).toBeTruthy();
    expect(row.kind).toBe('topic_summary');
    expect(row.source_id).toBe('42');
    expect(row.content).toBe('fixed bug X\npatched foo.ts to handle null inputs');
    expect(row.created_at).toBe(5000);
    expect(mockEmbeddings.embedDocument).toHaveBeenCalledWith(
      'fixed bug X\npatched foo.ts to handle null inputs',
      undefined,
    );
  });

  it('indexTopicSummary silently skips when embedding fails', async () => {
    mockEmbeddings.embedDocument.mockRejectedValueOnce(new Error('voyage down'));
    const svc = createMemoryService({
      db: getDb(),
      embeddings: mockEmbeddings as any,
      textProvider: mockTextProvider as any,
      extractorModel: 'qwen2.5:7b',
    });

    await svc.indexTopicSummary({
      topicId: 1,
      label: 'x',
      summary: 'y',
      finalizedAt: 1000,
    });

    const count = getDb()
      .prepare('SELECT COUNT(*) AS c FROM memory_entries WHERE kind = ?')
      .get('topic_summary') as { c: number };
    expect(count.c).toBe(0);
  });

  it('extractFactsFromConversation runs extractor with concatenated turns and stores facts', async () => {
    mockTextProvider.chat.mockResolvedValue({
      text: '[{"key":"user.location","value":"Одеса"}]',
    });
    const svc = createMemoryService({
      db: getDb(),
      embeddings: mockEmbeddings as any,
      textProvider: mockTextProvider as any,
      extractorModel: 'qwen2.5:7b',
    });

    await svc.extractFactsFromConversation({
      messages: [
        { role: 'user', content: 'я з Одеси', messageId: 'u1', timestamp: 1000 },
        { role: 'assistant', content: 'круто', messageId: 'a1', timestamp: 1100 },
        { role: 'user', content: 'там тепло', messageId: 'u2', timestamp: 1200 },
      ],
    });

    const facts = await svc.getActiveFacts();
    expect(facts).toEqual([expect.objectContaining({ key: 'user.location', value: 'Одеса' })]);
    const promptArg = mockTextProvider.chat.mock.calls[0][0].messages[0].content as string;
    expect(promptArg).toContain('я з Одеси');
    expect(promptArg).toContain('там тепло');
    expect(promptArg).toContain('круто');
  });

  it('extractFactsFromConversation anchors facts to the LAST user message', async () => {
    mockTextProvider.chat.mockResolvedValue({
      text: '[{"key":"user.name","value":"Діма"}]',
    });
    const svc = createMemoryService({
      db: getDb(),
      embeddings: mockEmbeddings as any,
      textProvider: mockTextProvider as any,
      extractorModel: 'qwen2.5:7b',
    });

    await svc.extractFactsFromConversation({
      messages: [
        { role: 'user', content: 'old', messageId: 'u1', timestamp: 1000 },
        { role: 'assistant', content: 'a', messageId: 'a1', timestamp: 1100 },
        { role: 'user', content: 'мене звати Діма', messageId: 'u-last', timestamp: 2000 },
      ],
    });

    const row = getDb()
      .prepare('SELECT source_message_id, created_at FROM memory_facts WHERE key = ?')
      .get('user.name') as { source_message_id: string; created_at: number };
    expect(row.source_message_id).toBe('u-last');
    expect(row.created_at).toBe(2000);
  });

  it('extractFactsFromConversation is a no-op with empty input', async () => {
    const svc = createMemoryService({
      db: getDb(),
      embeddings: mockEmbeddings as any,
      textProvider: mockTextProvider as any,
      extractorModel: 'qwen2.5:7b',
    });

    await svc.extractFactsFromConversation({ messages: [] });
    expect(mockTextProvider.chat).not.toHaveBeenCalled();
  });
});
