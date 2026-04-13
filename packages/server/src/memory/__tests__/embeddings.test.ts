import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createEmbeddingsClient } from '../embeddings.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('EmbeddingsClient', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('calls Ollama /api/embeddings and returns vector', async () => {
    const fakeVec = Array.from({ length: 768 }, (_, i) => i / 768);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ embedding: fakeVec }),
    });

    const client = createEmbeddingsClient({ url: 'http://localhost:11434', model: 'nomic-embed-text' });
    const result = await client.embed('hello');

    expect(result).toHaveLength(768);
    expect(result[0]).toBeCloseTo(0);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:11434/api/embeddings',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ model: 'nomic-embed-text', prompt: 'hello' }),
      }),
    );
  });

  it('throws on HTTP error', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
    const client = createEmbeddingsClient({ url: 'http://localhost:11434', model: 'nomic-embed-text' });
    await expect(client.embed('hello')).rejects.toThrow('Embeddings error 500');
  });

  it('throws on invalid response shape', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    const client = createEmbeddingsClient({ url: 'http://localhost:11434', model: 'nomic-embed-text' });
    await expect(client.embed('hello')).rejects.toThrow('missing embedding');
  });
});
