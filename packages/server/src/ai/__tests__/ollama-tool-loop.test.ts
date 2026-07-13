import { describe, expect, it, vi } from 'vitest';
import type { ToolDefinition } from '@r2/shared';
import { getNextLocalToolNames, runOllamaToolLoop } from '../ollama-tool-loop.js';

vi.mock('../../db.js', () => ({
  logToolCall: vi.fn(),
  getPermissionRule: vi.fn(() => null),
  savePermissionRule: vi.fn(),
}));

function tool(name: string, data: unknown = { ok: true }): ToolDefinition {
  return {
    name,
    description: name,
    permissionLevel: 'auto',
    provider: 'all',
    parameters: { type: 'object', properties: {} },
    handler: vi.fn(async () => ({ success: true, data })),
  };
}

function params(overrides: Record<string, unknown> = {}) {
  return {
    messages: [{ role: 'user' as const, content: 'find it' }],
    ollama: { chat: vi.fn() },
    tools: [],
    system: 'system',
    onEvent: vi.fn(),
    pendingConfirms: new Map(),
    pendingPlanReviews: new Map(),
    pendingMemoryConfirms: new Map(),
    piiProxy: {
      anonymize: vi.fn(async (text: string) => ({ text, entities: [] })),
      deanonymize: vi.fn(async (text: string) => text),
    },
    ...overrides,
  } as any;
}

describe('local tool phases', () => {
  it('narrows search/list tools and removes tools after terminal reads', () => {
    const allowed = new Set(['web_search', 'web_fetch', 'file_list', 'file_read']);
    expect(getNextLocalToolNames('web_search', allowed)).toEqual(['web_fetch']);
    expect(getNextLocalToolNames('web_fetch', allowed)).toEqual([]);
    expect(getNextLocalToolNames('file_list', allowed)).toEqual(['file_read']);
    expect(getNextLocalToolNames('file_read', allowed)).toEqual([]);
  });

  it('rejects a mutating tool set before executing anything', async () => {
    const write = tool('file_write');
    const result = await runOllamaToolLoop(params({ tools: [write] }));
    expect(result).toEqual({ escalate: true, reason: 'unsafe_local_tool_set' });
    expect(write.handler).not.toHaveBeenCalled();
  });

  it('synthesizes without tools after a terminal read', async () => {
    const read = tool('file_read', { content: 'hello' });
    const ollama = { chat: vi.fn().mockResolvedValueOnce({ text: 'Файл содержит hello.' }) };
    const onEvent = vi.fn();

    const result = await runOllamaToolLoop(params({
      tools: [read],
      ollama,
      onEvent,
      initialToolCalls: [{ function: { name: 'file_read', arguments: { path: 'a.txt' } } }],
    }));

    expect(result.escalate).toBe(false);
    expect(read.handler).toHaveBeenCalledOnce();
    expect(ollama.chat.mock.calls[0][0].tools).toBeUndefined();
    expect(ollama.chat.mock.calls[0][0].messages.at(-1)).toMatchObject({
      role: 'tool',
      tool_name: 'file_read',
    });
    expect(onEvent).toHaveBeenCalledWith({ type: 'text_delta', content: 'Файл содержит hello.' });
  });

  it('allows only web_fetch after web_search', async () => {
    const search = tool('web_search', { urls: ['https://example.com'] });
    const fetchTool = tool('web_fetch', { text: 'page' });
    const ollama = {
      chat: vi.fn()
        .mockResolvedValueOnce({
          text: '',
          toolCalls: [{ function: { name: 'web_fetch', arguments: { urls: ['https://example.com'] } } }],
        })
        .mockResolvedValueOnce({ text: 'Готово.' }),
    };

    const result = await runOllamaToolLoop(params({
      tools: [search, fetchTool],
      ollama,
      initialToolCalls: [{ function: { name: 'web_search', arguments: { query: 'x' } } }],
    }));

    expect(result.escalate).toBe(false);
    expect(ollama.chat.mock.calls[0][0].tools.map((item: any) => item.function.name)).toEqual(['web_fetch']);
    expect(ollama.chat.mock.calls[1][0].tools).toBeUndefined();
  });

  it('escalates when the model calls a tool outside the current phase', async () => {
    const list = tool('file_list');
    const read = tool('file_read');
    const result = await runOllamaToolLoop(params({
      tools: [list, read],
      initialToolCalls: [{ function: { name: 'web_search', arguments: {} } }],
    }));
    expect(result).toEqual({ escalate: true, reason: 'unoffered_local_tool:web_search' });
    expect(list.handler).not.toHaveBeenCalled();
    expect(read.handler).not.toHaveBeenCalled();
  });

  it('escalates before synthesis when a tool result exceeds local context', async () => {
    const read = tool('file_read', { content: 'x'.repeat(30_000) });
    const ollama = { chat: vi.fn() };
    const result = await runOllamaToolLoop(params({
      tools: [read],
      ollama,
      initialToolCalls: [{ function: { name: 'file_read', arguments: { path: 'large.txt' } } }],
    }));

    expect(result).toEqual({
      escalate: true,
      reason: 'local_tool_current_message_exceeds_local_context',
    });
    expect(read.handler).toHaveBeenCalledOnce();
    expect(ollama.chat).not.toHaveBeenCalled();
  });
});
