import type { ToolResult } from '@r2/shared';

interface SearchResult {
  title: string;
  url: string;
  description: string;
}

interface SearXNGResponse {
  results: Array<{
    title: string;
    url: string;
    content: string;
  }>;
}

export const webSearchTool = {
  name: 'web_search',
  description: 'Search the web using SearXNG. Use when you need current information, facts, or answers not in your training data.',
  permissionLevel: 'auto' as const,
  parameters: {
    type: 'object' as const,
    properties: {
      query: {
        type: 'string',
        description: 'The search query',
      },
      count: {
        type: 'number',
        description: 'Number of results to return (default 5, max 20)',
      },
    },
    required: ['query'] as string[],
  },

  async handler(params: Record<string, unknown>): Promise<ToolResult> {
    const query = params.query as string;
    const rawCount = Number(params.count);
    const count = Math.min(Math.max(Number.isFinite(rawCount) ? rawCount : 5, 1), 20);

    const baseUrl = process.env.SEARXNG_URL || 'http://localhost:8888';
    const url = `${baseUrl}/search?q=${encodeURIComponent(query)}&format=json&categories=general`;

    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      return {
        success: false,
        error: `Web search failed: ${err instanceof Error ? err.message : 'Network error'}`,
      };
    }

    if (!response.ok) {
      return {
        success: false,
        error: `Search error: ${response.status} ${response.statusText}`,
      };
    }

    let data: SearXNGResponse;
    try {
      data = await response.json();
    } catch {
      return { success: false, error: 'Search returned invalid JSON' };
    }

    const results: SearchResult[] = (data.results ?? [])
      .slice(0, count)
      .map((r) => ({
        title: r.title,
        url: r.url,
        description: r.content,
      }));

    return {
      success: true,
      data: results,
      display: {
        type: 'text',
        content: results.map((r) => `${r.title}\n${r.url}\n${r.description}`).join('\n\n'),
      },
    };
  },
};

export default webSearchTool;
