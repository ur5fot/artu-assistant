import { describe, it, expect, vi } from 'vitest';
import { runToolLoop } from '../tool-loop.js';
import type { ToolRegistry } from '../../tools/registry.js';
import type { ClaudeClient } from '../claude.js';
import type { SSEEvent } from '@r2/shared';

function mockRegistry(tools: Record<string, (params: any) => any> = {}): ToolRegistry {
  const toolDefs = Object.entries(tools).map(([name, handler]) => ({
    name,
    description: `Mock ${name}`,
    permissionLevel: 'auto' as const,
    parameters: { type: 'object' as const, properties: {}, required: [] },
    handler: async (params: Record<string, unknown>) => handler(params),
  }));

  return {
    register: vi.fn(),
    get: (name: string) => toolDefs.find((t) => t.name === name),
    getAll: () => toolDefs,
  };
}

function mockClaudeClient(responses: any[]): ClaudeClient {
  let callIndex = 0;
  return {
    sendMessage: vi.fn(async () => responses[callIndex++]),
    anthropic: {} as any,
  };
}

describe('Agentic Tool Loop', () => {
  it('returns text response without tool calls', async () => {
    const client = mockClaudeClient([
      {
        content: [{ type: 'text', text: 'Hello!' }],
        stop_reason: 'end_turn',
      },
    ]);
    const registry = mockRegistry();
    const events: SSEEvent[] = [];

    await runToolLoop({
      messages: [{ role: 'user', content: 'Hi' }],
      client,
      registry,
      onEvent: (e) => events.push(e),
    });

    expect(events).toEqual([
      { type: 'text_delta', content: 'Hello!' },
      { type: 'done' },
    ]);
  });

  it('executes tool and sends result back to Claude', async () => {
    const client = mockClaudeClient([
      {
        content: [
          { type: 'tool_use', id: 'call_1', name: 'search', input: { query: 'test' } },
        ],
        stop_reason: 'tool_use',
      },
      {
        content: [{ type: 'text', text: 'Found results.' }],
        stop_reason: 'end_turn',
      },
    ]);

    const registry = mockRegistry({
      search: () => ({ success: true, data: 'results' }),
    });

    const events: SSEEvent[] = [];

    await runToolLoop({
      messages: [{ role: 'user', content: 'Search test' }],
      client,
      registry,
      onEvent: (e) => events.push(e),
    });

    expect(events[0]).toEqual({
      type: 'tool_call_start',
      toolCall: expect.objectContaining({ id: 'call_1', name: 'search', status: 'running' }),
    });
    expect(events[1]).toEqual({
      type: 'tool_call_result',
      id: 'call_1',
      result: { success: true, data: 'results' },
    });
    expect(events[2]).toEqual({ type: 'text_delta', content: 'Found results.' });
    expect(events[3]).toEqual({ type: 'done' });

    // Verify Claude received tool result
    expect(client.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('stops after max 10 iterations', async () => {
    const toolResponse = {
      content: [
        { type: 'tool_use', id: 'call_x', name: 'search', input: { query: 'loop' } },
      ],
      stop_reason: 'tool_use',
    };
    // 10 tool calls + 1 final forced response
    const responses = Array(10).fill(toolResponse).concat([
      {
        content: [{ type: 'text', text: 'Max reached' }],
        stop_reason: 'end_turn',
      },
    ]);

    const client = mockClaudeClient(responses);
    const registry = mockRegistry({
      search: () => ({ success: true, data: 'ok' }),
    });

    const events: SSEEvent[] = [];

    await runToolLoop({
      messages: [{ role: 'user', content: 'loop forever' }],
      client,
      registry,
      onEvent: (e) => events.push(e),
    });

    // Should have called Claude 11 times (10 tool iterations + 1 after max-iterations message)
    expect(client.sendMessage).toHaveBeenCalledTimes(11);
    expect(events[events.length - 1]).toEqual({ type: 'done' });
  });

  it('handles tool execution error gracefully', async () => {
    const client = mockClaudeClient([
      {
        content: [
          { type: 'tool_use', id: 'call_err', name: 'search', input: { query: 'fail' } },
        ],
        stop_reason: 'tool_use',
      },
      {
        content: [{ type: 'text', text: 'Search failed, sorry.' }],
        stop_reason: 'end_turn',
      },
    ]);

    const registry = mockRegistry({
      search: () => {
        throw new Error('API down');
      },
    });

    const events: SSEEvent[] = [];

    await runToolLoop({
      messages: [{ role: 'user', content: 'Search' }],
      client,
      registry,
      onEvent: (e) => events.push(e),
    });

    expect(events[1]).toEqual({
      type: 'tool_call_result',
      id: 'call_err',
      result: { success: false, error: 'API down' },
    });
  });
});
