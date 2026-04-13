import type { ToolDefinition, ToolResult } from '@r2/shared';

interface MemoryServiceLike {
  search(params: {
    query: string;
    kind?: 'fact' | 'entry' | 'all';
    limit?: number;
  }): Promise<Array<{
    text: string;
    kind: string;
    score: number;
    timestamp: number;
  }>>;
}

export function createTool(deps: { memoryService: MemoryServiceLike | null }): ToolDefinition {
  return {
    name: 'memory_search',
    description: 'Search R2 memory for relevant facts and past conversations. Use when you need to recall what the user told you before, what was done in past tasks, or to verify facts about the user.',
    permissionLevel: 'auto',
    provider: 'all',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Semantic search query in natural language',
        },
        kind: {
          type: 'string',
          enum: ['fact', 'entry', 'all'],
          description: 'Filter by result kind. fact = structured user facts, entry = past messages/tool results, all = both (default).',
        },
        limit: {
          type: 'number',
          description: 'Max results (default 10, max 50)',
        },
      },
      required: ['query'],
    },
    command: {
      name: 'память',
      description: 'Пошук у пам\'яті R2',
      params: [{ name: 'query', required: true, description: 'Що шукати' }],
    },
    async handler(params: Record<string, unknown>): Promise<ToolResult> {
      if (!deps.memoryService) {
        return { success: false, error: 'Memory service is disabled' };
      }
      const query = typeof params.query === 'string' ? params.query : '';
      if (!query) {
        return { success: false, error: 'query parameter is required' };
      }
      const kind = params.kind === 'fact' || params.kind === 'entry' ? params.kind : 'all';
      const rawLimit = Number(params.limit);
      const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 10, 1), 50);

      try {
        const hits = await deps.memoryService.search({ query, kind, limit });
        if (hits.length === 0) {
          return {
            success: true,
            data: [],
            display: { type: 'text', content: 'Нічого не знайдено в пам\'яті.' },
          };
        }
        const lines = hits.map((h) => {
          const date = new Date(h.timestamp).toISOString().slice(0, 10);
          return `[${date}] (${h.kind}, ${h.score.toFixed(2)}) ${h.text.slice(0, 200)}`;
        });
        return {
          success: true,
          data: hits,
          display: { type: 'text', content: lines.join('\n') },
        };
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'memory_search failed',
        };
      }
    },
  };
}

export default createTool;
