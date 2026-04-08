import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { webSearchTool } from '../src/index.js';

const MOCK_SEARXNG_RESPONSE = {
  results: [
    {
      title: 'Example Result',
      url: 'https://example.com',
      content: 'An example search result.',
    },
    {
      title: 'Another Result',
      url: 'https://another.com',
      content: 'Another search result.',
    },
  ],
};

describe('web_search tool', () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = process.env.SEARXNG_URL;

  beforeEach(() => {
    process.env.SEARXNG_URL = 'http://localhost:8888';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalEnv !== undefined) {
      process.env.SEARXNG_URL = originalEnv;
    } else {
      delete process.env.SEARXNG_URL;
    }
  });

  it('has correct metadata', () => {
    expect(webSearchTool.name).toBe('web_search');
    expect(webSearchTool.permissionLevel).toBe('auto');
    expect(webSearchTool.parameters.required).toContain('query');
  });

  it('returns formatted search results on success', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => MOCK_SEARXNG_RESPONSE,
    });

    const result = await webSearchTool.handler({ query: 'test query', count: 5 });

    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(2);
    expect((result.data as any[])[0]).toEqual({
      title: 'Example Result',
      url: 'https://example.com',
      description: 'An example search result.',
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('q=test%20query'),
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: 'application/json',
        }),
      }),
    );
  });

  it('uses SEARXNG_URL from env', async () => {
    process.env.SEARXNG_URL = 'http://custom:9999';
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [] }),
    });

    await webSearchTool.handler({ query: 'test' });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('http://custom:9999/search'),
      expect.anything(),
    );
  });

  it('defaults to localhost:8888 when SEARXNG_URL not set', async () => {
    delete process.env.SEARXNG_URL;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [] }),
    });

    await webSearchTool.handler({ query: 'test' });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('http://localhost:8888/search'),
      expect.anything(),
    );
  });

  it('returns error on API failure', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
    });

    const result = await webSearchTool.handler({ query: 'test' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('503');
  });

  it('returns error on network failure', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Connection refused'));

    const result = await webSearchTool.handler({ query: 'test' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('SearXNG is not reachable');
  });

  it('returns error on invalid JSON', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => { throw new Error('invalid'); },
    });

    const result = await webSearchTool.handler({ query: 'test' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('invalid JSON');
  });

  it('respects count parameter', async () => {
    const manyResults = {
      results: Array.from({ length: 10 }, (_, i) => ({
        title: `Result ${i}`,
        url: `https://example.com/${i}`,
        content: `Content ${i}`,
      })),
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => manyResults,
    });

    const result = await webSearchTool.handler({ query: 'test', count: 3 });

    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(3);
  });
});
