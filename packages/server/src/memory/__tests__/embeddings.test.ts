import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createOllamaEmbeddingsClient } from '../embeddings.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('OllamaEmbeddingsClient', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('exposes dimension and identity', () => {
    const client = createOllamaEmbeddingsClient({ url: 'http://localhost:11434', model: 'mxbai-embed-large' });
    expect(client.dimension).toBe(1024);
    expect(client.identity).toBe('ollama:mxbai-embed-large');
  });

  it('embedDocument calls Ollama /api/embeddings and returns vector', async () => {
    const fakeVec = Array.from({ length: 1024 }, (_, i) => i / 1024);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ embedding: fakeVec }),
    });

    const client = createOllamaEmbeddingsClient({ url: 'http://localhost:11434', model: 'mxbai-embed-large' });
    const result = await client.embedDocument('hello');

    expect(result).toHaveLength(1024);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:11434/api/embeddings',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ model: 'mxbai-embed-large', prompt: 'hello' }),
      }),
    );
  });

  it('embedQuery uses the same Ollama call (no input_type for Ollama)', async () => {
    const fakeVec = Array.from({ length: 1024 }, () => 0);
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ embedding: fakeVec }) });

    const client = createOllamaEmbeddingsClient({ url: 'http://localhost:11434', model: 'mxbai-embed-large' });
    await client.embedQuery('query');

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:11434/api/embeddings',
      expect.objectContaining({
        body: JSON.stringify({ model: 'mxbai-embed-large', prompt: 'query' }),
      }),
    );
  });

  it('throws on HTTP error', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
    const client = createOllamaEmbeddingsClient({ url: 'http://localhost:11434', model: 'mxbai-embed-large' });
    await expect(client.embedDocument('hello')).rejects.toThrow('Embeddings error 500');
  });

  it('throws on invalid response shape', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    const client = createOllamaEmbeddingsClient({ url: 'http://localhost:11434', model: 'mxbai-embed-large' });
    await expect(client.embedDocument('hello')).rejects.toThrow('missing embedding');
  });

  it('throws on dimension mismatch', async () => {
    const wrongDim = Array.from({ length: 768 }, () => 0);
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ embedding: wrongDim }) });
    const client = createOllamaEmbeddingsClient({ url: 'http://localhost:11434', model: 'mxbai-embed-large' });
    await expect(client.embedDocument('hello')).rejects.toThrow('dimension mismatch');
  });

  it('opens circuit on failure and short-circuits next call', async () => {
    // Without this guard a single Ollama outage stacks 15s timeouts on every
    // turn (~45s blocking). Verify the next call after a failure throws
    // immediately with the circuit-open message instead of hitting fetch.
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
    const client = createOllamaEmbeddingsClient({ url: 'http://localhost:11434', model: 'mxbai-embed-large' });
    await expect(client.embedDocument('first')).rejects.toThrow('Embeddings error 500');
    await expect(client.embedDocument('second')).rejects.toThrow('circuit open');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('does not open circuit on caller-initiated abort', async () => {
    // Caller aborts (Discord disconnects) are not server-health signals.
    // Opening the circuit on them would refuse subsequent legitimate calls
    // for 30s with no real outage.
    mockFetch.mockImplementationOnce(() => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      return Promise.reject(err);
    });
    const ac = new AbortController();
    ac.abort();
    const client = createOllamaEmbeddingsClient({ url: 'http://localhost:11434', model: 'mxbai-embed-large' });
    await expect(client.embedDocument('first', ac.signal)).rejects.toThrow();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ embedding: Array.from({ length: 1024 }, () => 0) }),
    });
    await expect(client.embedDocument('second')).resolves.toHaveLength(1024);
  });
});
