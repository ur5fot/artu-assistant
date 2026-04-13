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
  saveFact?(params: {
    key: string;
    value: string;
    importance?: number;
    timestamp?: number;
  }): Promise<{ id: number; key: string; value: string; importance: number } | null>;
}

const REMEMBER_IMPORTANCE = 10;

function parseRememberText(text: string): { key: string; value: string } {
  const trimmed = text.trim();
  const colonIdx = trimmed.indexOf(':');
  if (colonIdx > 0 && colonIdx < 80) {
    const rawKey = trimmed.slice(0, colonIdx).trim();
    const value = trimmed.slice(colonIdx + 1).trim();
    if (rawKey && value) {
      const normalizedKey = rawKey
        .toLowerCase()
        .replace(/\s+/g, '_')
        .replace(/[^a-z0-9._]/g, '');
      const key = normalizedKey.includes('.') ? normalizedKey : `user.${normalizedKey}`;
      return { key, value };
    }
  }
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  return { key: `user.note.${id}`, value: trimmed };
}

export function createMemorySearchTool(deps: { memoryService: MemoryServiceLike | null }): ToolDefinition {
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

export function createMemoryRememberTool(deps: { memoryService: MemoryServiceLike | null }): ToolDefinition {
  return {
    name: 'memory_remember',
    description: 'Save a user-provided fact into long-term memory with high importance so it survives decay. Use when the user explicitly asks to remember something.',
    permissionLevel: 'auto',
    provider: 'all',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'Free text to remember. May use "key: value" syntax for structured facts.',
        },
      },
      required: ['text'],
    },
    command: {
      name: 'запам\'ятай',
      description: 'Запам\'ятати факт назавжди',
      params: [{ name: 'text', required: true, description: 'Що запам\'ятати' }],
    },
    async handler(params: Record<string, unknown>): Promise<ToolResult> {
      if (!deps.memoryService || typeof deps.memoryService.saveFact !== 'function') {
        return { success: false, error: 'Memory service is disabled' };
      }
      const text = typeof params.text === 'string' ? params.text.trim() : '';
      if (!text) {
        return { success: false, error: 'text parameter is required' };
      }
      const { key, value } = parseRememberText(text);
      try {
        const saved = await deps.memoryService.saveFact({
          key,
          value,
          importance: REMEMBER_IMPORTANCE,
        });
        if (!saved) {
          return { success: false, error: 'Не вдалося зберегти факт' };
        }
        return {
          success: true,
          data: saved,
          display: {
            type: 'text',
            content: `Запам'ятав: ${saved.key} = ${saved.value}`,
          },
        };
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'memory_remember failed',
        };
      }
    },
  };
}

export function createTool(deps: { memoryService: MemoryServiceLike | null }): ToolDefinition[] {
  return [createMemorySearchTool(deps), createMemoryRememberTool(deps)];
}

export default createTool;
