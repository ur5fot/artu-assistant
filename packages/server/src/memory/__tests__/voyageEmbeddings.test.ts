import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createVoyageEmbeddingsClient } from '../voyageEmbeddings.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function ok(vec: number[]) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ data: [{ embedding: vec, index: 0 }] }),
  };
}

describe('VoyageEmbeddingsClient', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('exposes dimension and identity', () => {
    const client = createVoyageEmbeddingsClient({ apiKey: 'sk', model: 'voyage-3' });
    expect(client.dimension).toBe(1024);
    expect(client.identity).toBe('voyage:voyage-3');
  });

  it('rejects unsupported model', () => {
    expect(() =>
      createVoyageEmbeddingsClient({ apiKey: 'sk', model: 'voyage-3-lite' as any }),
    ).toThrow('Unsupported VOYAGE_MODEL');
  });

  it('embedDocument calls /v1/embeddings with input_type=document', async () => {
    const vec = Array.from({ length: 1024 }, () => 0.1);
    mockFetch.mockResolvedValueOnce(ok(vec));

    const client = createVoyageEmbeddingsClient({ apiKey: 'sk-test', model: 'voyage-3' });
    const result = await client.embedDocument('hello');

    expect(result).toHaveLength(1024);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.voyageai.com/v1/embeddings',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer sk-test',
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({ input: ['hello'], model: 'voyage-3', input_type: 'document' }),
      }),
    );
  });

  it('embedQuery calls with input_type=query', async () => {
    mockFetch.mockResolvedValueOnce(ok(Array.from({ length: 1024 }, () => 0)));

    const client = createVoyageEmbeddingsClient({ apiKey: 'sk', model: 'voyage-3' });
    await client.embedQuery('search me');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.voyageai.com/v1/embeddings',
      expect.objectContaining({
        body: JSON.stringify({ input: ['search me'], model: 'voyage-3', input_type: 'query' }),
      }),
    );
  });

  it('retries on 429 with exponential backoff', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 429, body: { cancel: () => Promise.resolve() } });
    mockFetch.mockResolvedValueOnce({ ok: false, status: 429, body: { cancel: () => Promise.resolve() } });
    mockFetch.mockResolvedValueOnce(ok(Array.from({ length: 1024 }, () => 0)));

    const client = createVoyageEmbeddingsClient({
      apiKey: 'sk',
      model: 'voyage-3',
      retryBackoffMs: 1,
    });
    const result = await client.embedDocument('hello');
    expect(result).toHaveLength(1024);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('throws after 3 failed retries on 429', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 429, body: { cancel: () => Promise.resolve() } });

    const client = createVoyageEmbeddingsClient({
      apiKey: 'sk',
      model: 'voyage-3',
      retryBackoffMs: 1,
    });
    await expect(client.embedDocument('hello')).rejects.toThrow('Voyage rate limit');
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('throws on 401 without retry', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401, body: { cancel: () => Promise.resolve() } });
    const client = createVoyageEmbeddingsClient({ apiKey: 'bad', model: 'voyage-3' });
    await expect(client.embedDocument('hi')).rejects.toThrow('Voyage auth failed (401)');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('retries on 5xx and recovers if transient', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503, body: { cancel: () => Promise.resolve() } });
    mockFetch.mockResolvedValueOnce(ok(Array.from({ length: 1024 }, () => 0)));

    const client = createVoyageEmbeddingsClient({
      apiKey: 'sk',
      model: 'voyage-3',
      retryBackoffMs: 1,
    });
    const result = await client.embedDocument('hello');
    expect(result).toHaveLength(1024);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('opens circuit breaker after exhausting 5xx retries', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 503, body: { cancel: () => Promise.resolve() } });
    const client = createVoyageEmbeddingsClient({
      apiKey: 'sk',
      model: 'voyage-3',
      retryBackoffMs: 1,
    });

    await expect(client.embedDocument('a')).rejects.toThrow('Voyage error 503');
    expect(mockFetch).toHaveBeenCalledTimes(3);

    await expect(client.embedDocument('b')).rejects.toThrow('Voyage circuit open');
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('rejects dimension mismatch in response', async () => {
    const wrongDim = Array.from({ length: 512 }, () => 0);
    mockFetch.mockResolvedValueOnce(ok(wrongDim));
    const client = createVoyageEmbeddingsClient({ apiKey: 'sk', model: 'voyage-3' });
    await expect(client.embedDocument('x')).rejects.toThrow('Voyage dimension mismatch');
  });

  it('caller abort does not open circuit', async () => {
    const ac = new AbortController();
    ac.abort();
    mockFetch.mockImplementation(() => {
      const err = new Error('aborted') as any;
      err.name = 'AbortError';
      throw err;
    });

    const client = createVoyageEmbeddingsClient({ apiKey: 'sk', model: 'voyage-3' });
    await expect(client.embedDocument('hello', ac.signal)).rejects.toThrow();
    mockFetch.mockResolvedValueOnce(ok(Array.from({ length: 1024 }, () => 0)));
    await expect(client.embedDocument('hello again')).resolves.toHaveLength(1024);
  });
});
