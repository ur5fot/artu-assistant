import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { webSearchTool } from '../src/index.js';

const MOCK_BRAVE_RESPONSE = {
  web: {
    results: [
      {
        title: 'Example Result',
        url: 'https://example.com',
        description: 'An example search result.',
      },
      {
        title: 'Another Result',
        url: 'https://another.com',
        description: 'Another search result.',
      },
    ],
  },
};

describe('web_search tool', () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = process.env.BRAVE_SEARCH_API_KEY;

  beforeEach(() => {
    process.env.BRAVE_SEARCH_API_KEY = 'test-key';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env.BRAVE_SEARCH_API_KEY = originalEnv;
  });

  it('has correct metadata', () => {
    expect(webSearchTool.name).toBe('web_search');
    expect(webSearchTool.parameters.required).toContain('query');
  });

  it('returns formatted search results on success', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => MOCK_BRAVE_RESPONSE,
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
          'X-Subscription-Token': 'test-key',
        }),
      }),
    );
  });

  it('returns error when API key is missing', async () => {
    delete process.env.BRAVE_SEARCH_API_KEY;

    const result = await webSearchTool.handler({ query: 'test' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('BRAVE_SEARCH_API_KEY');
  });

  it('returns error on API failure', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
    });

    const result = await webSearchTool.handler({ query: 'test' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('429');
  });
});
