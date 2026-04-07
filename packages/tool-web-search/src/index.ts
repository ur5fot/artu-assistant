import type { ToolResult } from '@r2/shared';

interface SearchResult {
  title: string;
  url: string;
  description: string;
}

interface BraveSearchResponse {
  web?: {
    results: Array<{
      title: string;
      url: string;
      description: string;
    }>;
  };
}

export const webSearchTool = {
  name: 'web_search',
  description: 'Search the web using Brave Search API. Use when you need current information, facts, or answers not in your training data.',
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
    const count = Math.min(Math.max((params.count as number) || 5, 1), 20);

    const apiKey = process.env.BRAVE_SEARCH_API_KEY;
    if (!apiKey) {
      return { success: false, error: 'BRAVE_SEARCH_API_KEY not configured' };
    }

    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`;

    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          Accept: 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': apiKey,
        },
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
        error: `Brave Search API error: ${response.status} ${response.statusText}`,
      };
    }

    let data: BraveSearchResponse;
    try {
      data = await response.json();
    } catch {
      return { success: false, error: 'Brave Search returned invalid JSON' };
    }
    const results: SearchResult[] =
      data.web?.results.map((r) => ({
        title: r.title,
        url: r.url,
        description: r.description,
      })) ?? [];

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
