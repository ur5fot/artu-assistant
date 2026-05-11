import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createOllamaEmbeddingsClient } from '../embeddings.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('OllamaEmbeddingsClient', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('exposes dimension and identity', () => {
    const client = createOllamaEmbeddingsClient({ url: 'http://localhost:11434', model: 'nomic-embed-text' });
    expect(client.dimension).toBe(768);
    expect(client.identity).toBe('ollama:nomic-embed-text');
  });

  it('embedDocument calls Ollama /api/embeddings and returns vector', async () => {
    const fakeVec = Array.from({ length: 768 }, (_, i) => i / 768);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ embedding: fakeVec }),
    });

    const client = createOllamaEmbeddingsClient({ url: 'http://localhost:11434', model: 'nomic-embed-text' });
    const result = await client.embedDocument('hello');

    expect(result).toHaveLength(768);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:11434/api/embeddings',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ model: 'nomic-embed-text', prompt: 'hello' }),
      }),
    );
  });

  it('embedQuery uses the same Ollama call (no input_type for Ollama)', async () => {
    const fakeVec = Array.from({ length: 768 }, () => 0);
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ embedding: fakeVec }) });

    const client = createOllamaEmbeddingsClient({ url: 'http://localhost:11434', model: 'nomic-embed-text' });
    await client.embedQuery('query');

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:11434/api/embeddings',
      expect.objectContaining({
        body: JSON.stringify({ model: 'nomic-embed-text', prompt: 'query' }),
      }),
    );
  });

  it('throws on HTTP error', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
    const client = createOllamaEmbeddingsClient({ url: 'http://localhost:11434', model: 'nomic-embed-text' });
    await expect(client.embedDocument('hello')).rejects.toThrow('Embeddings error 500');
  });

  it('throws on invalid response shape', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    const client = createOllamaEmbeddingsClient({ url: 'http://localhost:11434', model: 'nomic-embed-text' });
    await expect(client.embedDocument('hello')).rejects.toThrow('missing embedding');
  });

  it('throws on dimension mismatch', async () => {
    const wrongDim = Array.from({ length: 1024 }, () => 0);
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ embedding: wrongDim }) });
    const client = createOllamaEmbeddingsClient({ url: 'http://localhost:11434', model: 'nomic-embed-text' });
    await expect(client.embedDocument('hello')).rejects.toThrow('dimension mismatch');
  });
});
