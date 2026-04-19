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
  forgetFact?(params: { query: string }): Promise<{
    forgotten: Array<{ id: number; key: string; value: string }>;
    candidates: Array<{ id: number; key: string; value: string }>;
  }>;
  updateFact?(params: { key: string; newValue: string; sourceMessageId: string | null }): Promise<
    | { updated: { key: string; oldValue: string; newValue: string } }
    | { error: string; key: string }
  >;
  forgetLast?(params: { currentMessageTimestamp: number; dryRun?: boolean }): Promise<{
    forgotten: Array<{ id: number; key: string; value: string }>;
    sourceMessageId: string | null;
    reason?: string;
  }>;
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
        .replace(/[^\p{L}\p{N}._]/gu, '')
        .replace(/\.+/g, '.')
        .replace(/^\.+|\.+$/g, '');
      if (normalizedKey) {
        const key = normalizedKey.includes('.') ? normalizedKey : `user.${normalizedKey}`;
        return { key, value };
      }
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
      const safeLimit = Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 10;
      const limit = Math.min(Math.max(safeLimit, 1), 50);

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

export function createMemoryForgetTool(deps: { memoryService: MemoryServiceLike | null }): ToolDefinition {
  return {
    name: 'memory_forget',
    description: 'Mark a memory fact as forgotten so it no longer appears in recall. Use when the user asks to forget something.',
    permissionLevel: 'auto',
    provider: 'all',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Exact fact key (e.g. "user.wife") or natural-language description of the fact to forget.',
        },
      },
      required: ['query'],
    },
    command: {
      name: 'забудь',
      description: 'Забути факт із пам\'яті',
      params: [{ name: 'query', required: true, description: 'Ключ або опис факту' }],
    },
    async handler(params, ctx) {
      if (!deps.memoryService || typeof deps.memoryService.forgetFact !== 'function') {
        return { success: false, error: 'Memory service is disabled' };
      }
      const query = typeof params.query === 'string' ? params.query.trim() : '';
      if (!query) {
        return { success: false, error: 'query parameter is required' };
      }

      let effectiveQuery = query;
      if (ctx?.requestMemoryConfirm) {
        const response = await ctx.requestMemoryConfirm({
          tool: 'memory_forget',
          preview: `Забути: "${query}"`,
          editableField: 'query',
          initialValue: query,
          params: { query },
        });
        if (!response.approved) {
          return { success: false, error: 'Користувач відхилив' };
        }
        if (response.editedParams && typeof response.editedParams.query === 'string') {
          const edited = response.editedParams.query.trim();
          if (edited) effectiveQuery = edited;
        }
      }

      try {
        const result = await deps.memoryService.forgetFact({ query: effectiveQuery });
        if (result.forgotten.length > 0) {
          const lines = result.forgotten.map((f) => `${f.key} = ${f.value}`);
          return {
            success: true,
            data: result,
            display: {
              type: 'text',
              content: `Забув: ${lines.join(', ')}`,
            },
          };
        }
        if (result.candidates.length > 0) {
          const lines = result.candidates.map((f) => `- ${f.key} = ${f.value}`);
          return {
            success: true,
            data: result,
            display: {
              type: 'text',
              content: `Знайшов кілька збігів — уточни ключ:\n${lines.join('\n')}`,
            },
          };
        }
        return {
          success: false,
          error: `Нічого не знайдено для "${effectiveQuery}"`,
        };
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'memory_forget failed',
        };
      }
    },
  };
}

export function createMemoryUpdateTool(deps: { memoryService: MemoryServiceLike | null }): ToolDefinition {
  return {
    name: 'memory_update',
    description: 'Update the value of an existing memory fact. Use when the user corrects a previously stored fact (e.g. "мой возраст не 42 а 43").',
    permissionLevel: 'auto',
    provider: 'all',
    parameters: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description: 'Exact fact key, e.g. "user.age"',
        },
        newValue: {
          type: 'string',
          description: 'New value to replace the old one',
        },
      },
      required: ['key', 'newValue'],
    },
    async handler(params, ctx) {
      if (!deps.memoryService || typeof deps.memoryService.updateFact !== 'function') {
        return { success: false, error: 'Memory service is disabled' };
      }
      const key = typeof params.key === 'string' ? params.key.trim() : '';
      const newValue = typeof params.newValue === 'string' ? params.newValue.trim() : '';
      if (!key || !newValue) {
        return { success: false, error: 'key and newValue are required' };
      }

      let effectiveNewValue = newValue;
      if (ctx?.requestMemoryConfirm) {
        const response = await ctx.requestMemoryConfirm({
          tool: 'memory_update',
          preview: `Оновити ${key} → "${newValue}"`,
          editableField: 'newValue',
          initialValue: newValue,
          params: { key, newValue },
        });
        if (!response.approved) {
          return { success: false, error: 'Користувач відхилив' };
        }
        if (response.editedParams && typeof response.editedParams.newValue === 'string') {
          const edited = response.editedParams.newValue.trim();
          if (edited) effectiveNewValue = edited;
        }
      }

      const sourceMessageId = ctx?.currentUserMessageId ?? null;
      try {
        const result = await deps.memoryService.updateFact({
          key,
          newValue: effectiveNewValue,
          sourceMessageId,
        });
        if ('error' in result) {
          return { success: false, error: result.error };
        }
        return {
          success: true,
          data: result,
          display: {
            type: 'text',
            content: `Оновлено ${result.updated.key}: "${result.updated.oldValue}" → "${result.updated.newValue}"`,
          },
        };
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'memory_update failed',
        };
      }
    },
  };
}

export function createMemoryForgetLastTool(deps: { memoryService: MemoryServiceLike | null }): ToolDefinition {
  return {
    name: 'memory_forget_last',
    description: "Forget all facts extracted from the user's most recent previous message. Use when the user says \"це неправильно\" / \"ерунду запомнил\" / \"забудь що я тільки що сказав\".",
    permissionLevel: 'auto',
    provider: 'all',
    parameters: {
      type: 'object',
      properties: {},
    },
    async handler(_params, ctx) {
      if (!deps.memoryService || typeof deps.memoryService.forgetLast !== 'function') {
        return { success: false, error: 'Memory service is disabled' };
      }
      const currentMessageTimestamp = ctx?.currentUserMessageTimestamp ?? Date.now();

      // Dry-run so the user sees the exact facts in the confirm dialog before
      // anything is marked forgotten. markFactForgotten is not reversible via
      // the service API, so we never mutate rows until the user approves.
      let dry;
      try {
        dry = await deps.memoryService.forgetLast({ currentMessageTimestamp, dryRun: true });
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'memory_forget_last failed',
        };
      }
      if (dry.forgotten.length === 0) {
        return { success: false, error: 'Нічого забувати' };
      }

      if (ctx?.requestMemoryConfirm) {
        const previewItems = dry.forgotten.map((f) => `${f.key}=${f.value}`).join(', ');
        const response = await ctx.requestMemoryConfirm({
          tool: 'memory_forget_last',
          preview: `Забути ${dry.forgotten.length} факт(и): ${previewItems}`,
          editableField: null,
          initialValue: null,
          params: {},
        });
        if (!response.approved) {
          return { success: false, error: 'Користувач відхилив' };
        }
      }

      try {
        const result = await deps.memoryService.forgetLast({ currentMessageTimestamp });
        if (result.forgotten.length === 0) {
          return { success: false, error: 'Нічого забувати' };
        }
        const lines = result.forgotten.map((f) => `${f.key} = ${f.value}`);
        return {
          success: true,
          data: result,
          display: {
            type: 'text',
            content: `Забув: ${lines.join(', ')}`,
          },
        };
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'memory_forget_last failed',
        };
      }
    },
  };
}

export function createTool(deps: { memoryService: MemoryServiceLike | null }): ToolDefinition[] {
  return [
    createMemorySearchTool(deps),
    createMemoryRememberTool(deps),
    createMemoryForgetTool(deps),
    createMemoryUpdateTool(deps),
    createMemoryForgetLastTool(deps),
  ];
}

export default createTool;
