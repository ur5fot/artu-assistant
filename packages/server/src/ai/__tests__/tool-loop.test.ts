import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runToolLoop } from '../tool-loop.js';
import type { ToolRegistry } from '../../tools/registry.js';
import type { ClaudeClient } from '../claude.js';
import type { SSEEvent } from '@r2/shared';
import { initDb, getDb, closeDb } from '../../db.js';
import { createPassthroughProxy } from '../../pii/proxy.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function mockRegistry(tools: Record<string, (params: any) => any> = {}): ToolRegistry {
  const toolDefs = Object.entries(tools).map(([name, handler]) => ({
    name,
    description: `Mock ${name}`,
    permissionLevel: 'auto' as const,
    provider: 'all' as const,
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
      piiProxy: createPassthroughProxy(),
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
      piiProxy: createPassthroughProxy(),
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
      piiProxy: createPassthroughProxy(),
    });

    // Should have called Claude 11 times (10 tool iterations + 1 after max-iterations message)
    expect(client.sendMessage).toHaveBeenCalledTimes(11);
    expect(events[events.length - 1]).toEqual({ type: 'done' });
  });

  it('stops immediately when signal is already aborted', async () => {
    const client = mockClaudeClient([
      { content: [{ type: 'text', text: 'Should not appear' }], stop_reason: 'end_turn' },
    ]);
    const registry = mockRegistry();
    const events: SSEEvent[] = [];
    const controller = new AbortController();
    controller.abort();

    await runToolLoop({
      messages: [{ role: 'user', content: 'Hi' }],
      client,
      registry,
      onEvent: (e) => events.push(e),
      signal: controller.signal,
      piiProxy: createPassthroughProxy(),
    });

    expect(client.sendMessage).not.toHaveBeenCalled();
    // No events emitted - client already disconnected
    expect(events).toEqual([]);
  });

  it('stops after Claude call when signal is aborted mid-loop', async () => {
    const controller = new AbortController();
    const client = mockClaudeClient([
      { content: [{ type: 'text', text: 'Hello' }], stop_reason: 'end_turn' },
    ]);
    // Abort after the first sendMessage call
    (client.sendMessage as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      controller.abort();
      return { content: [{ type: 'tool_use', id: 'c1', name: 'search', input: {} }], stop_reason: 'tool_use' };
    });

    const registry = mockRegistry({ search: () => ({ success: true, data: 'ok' }) });
    const events: SSEEvent[] = [];

    await runToolLoop({
      messages: [{ role: 'user', content: 'Hi' }],
      client,
      registry,
      onEvent: (e) => events.push(e),
      signal: controller.signal,
      piiProxy: createPassthroughProxy(),
    });

    // Should not have executed any tools since signal was aborted after Claude response
    expect(events).toEqual([]);
  });

  it('skips final forced call when signal is aborted at max iterations', async () => {
    const controller = new AbortController();
    const toolResponse = {
      content: [{ type: 'tool_use', id: 'call_x', name: 'search', input: { query: 'loop' } }],
      stop_reason: 'tool_use',
    };
    const responses = Array(10).fill(toolResponse).concat([
      { content: [{ type: 'text', text: 'Should not appear' }], stop_reason: 'end_turn' },
    ]);

    const client = mockClaudeClient(responses);
    let callCount = 0;
    (client.sendMessage as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      const resp = responses[callCount++];
      if (callCount === 10) controller.abort();
      return resp;
    });

    const registry = mockRegistry({ search: () => ({ success: true, data: 'ok' }) });
    const events: SSEEvent[] = [];

    await runToolLoop({
      messages: [{ role: 'user', content: 'loop' }],
      client,
      registry,
      onEvent: (e) => events.push(e),
      signal: controller.signal,
      piiProxy: createPassthroughProxy(),
    });

    // Should have called Claude 10 times (not 11 - the forced final call should be skipped)
    expect(client.sendMessage).toHaveBeenCalledTimes(10);
  });

  it('passes signal to Claude client', async () => {
    const controller = new AbortController();
    const client = mockClaudeClient([
      { content: [{ type: 'text', text: 'Hello' }], stop_reason: 'end_turn' },
    ]);
    const registry = mockRegistry();
    const events: SSEEvent[] = [];

    await runToolLoop({
      messages: [{ role: 'user', content: 'Hi' }],
      client,
      registry,
      onEvent: (e) => events.push(e),
      signal: controller.signal,
      piiProxy: createPassthroughProxy(),
    });

    expect(client.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it('waits for confirm response and executes tool when allowed', async () => {
    const client = mockClaudeClient([
      {
        content: [
          { type: 'tool_use', id: 'call_c', name: 'write_file', input: { path: 'test.txt' } },
        ],
        stop_reason: 'tool_use',
      },
      {
        content: [{ type: 'text', text: 'File written.' }],
        stop_reason: 'end_turn',
      },
    ]);

    const toolDefs = [{
      name: 'write_file',
      description: 'Write a file',
      permissionLevel: 'confirm' as const,
      provider: 'all' as const,
      parameters: { type: 'object' as const, properties: {}, required: [] },
      handler: vi.fn(async () => ({ success: true, data: 'written' })),
    }];

    const registry: ToolRegistry = {
      register: vi.fn(),
      get: (name: string) => toolDefs.find((t) => t.name === name),
      getAll: () => toolDefs,
    };

    const events: SSEEvent[] = [];
    const pendingConfirms = new Map();

    // Auto-approve after confirm request
    const originalOnEvent = (e: SSEEvent) => {
      events.push(e);
      if (e.type === 'tool_confirm_request') {
        const resolve = pendingConfirms.get(e.toolCall.id);
        if (resolve) {
          pendingConfirms.delete(e.toolCall.id);
          resolve({ allowed: true, remember: false });
        }
      }
    };

    await runToolLoop({
      messages: [{ role: 'user', content: 'Write file' }],
      client,
      registry,
      onEvent: originalOnEvent,
      pendingConfirms,
      piiProxy: createPassthroughProxy(),
    });

    expect(toolDefs[0].handler).toHaveBeenCalled();
    expect(events.some(e => e.type === 'tool_confirm_request')).toBe(true);
  });

  it('rejects tool when confirm response is denied', async () => {
    const client = mockClaudeClient([
      {
        content: [
          { type: 'tool_use', id: 'call_d', name: 'write_file', input: { path: 'test.txt' } },
        ],
        stop_reason: 'tool_use',
      },
      {
        content: [{ type: 'text', text: 'Denied.' }],
        stop_reason: 'end_turn',
      },
    ]);

    const toolDefs = [{
      name: 'write_file',
      description: 'Write a file',
      permissionLevel: 'confirm' as const,
      provider: 'all' as const,
      parameters: { type: 'object' as const, properties: {}, required: [] },
      handler: vi.fn(async () => ({ success: true, data: 'written' })),
    }];

    const registry: ToolRegistry = {
      register: vi.fn(),
      get: (name: string) => toolDefs.find((t) => t.name === name),
      getAll: () => toolDefs,
    };

    const events: SSEEvent[] = [];
    const pendingConfirms = new Map();

    const originalOnEvent = (e: SSEEvent) => {
      events.push(e);
      if (e.type === 'tool_confirm_request') {
        const resolve = pendingConfirms.get(e.toolCall.id);
        if (resolve) {
          pendingConfirms.delete(e.toolCall.id);
          resolve({ allowed: false, remember: false });
        }
      }
    };

    await runToolLoop({
      messages: [{ role: 'user', content: 'Write file' }],
      client,
      registry,
      onEvent: originalOnEvent,
      pendingConfirms,
      piiProxy: createPassthroughProxy(),
    });

    expect(toolDefs[0].handler).not.toHaveBeenCalled();
    const resultEvent = events.find(e => e.type === 'tool_call_result');
    expect(resultEvent).toBeDefined();
    if (resultEvent && resultEvent.type === 'tool_call_result') {
      expect(resultEvent.result.success).toBe(false);
      expect(resultEvent.result.error).toContain('denied');
    }
  });

  it('auto-applies saved permission rule without showing card', async () => {
    // Setup DB with saved rule
    const permTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-perm-test-'));
    initDb(path.join(permTmpDir, 'perm-test.db'));

    const { savePermissionRule } = await import('../../db.js');
    savePermissionRule('write_file', true);

    const client = mockClaudeClient([
      {
        content: [
          { type: 'tool_use', id: 'call_auto', name: 'write_file', input: { path: 'test.txt' } },
        ],
        stop_reason: 'tool_use',
      },
      {
        content: [{ type: 'text', text: 'Done.' }],
        stop_reason: 'end_turn',
      },
    ]);

    const toolDefs = [{
      name: 'write_file',
      description: 'Write a file',
      permissionLevel: 'confirm' as const,
      provider: 'all' as const,
      parameters: { type: 'object' as const, properties: {}, required: [] },
      handler: vi.fn(async () => ({ success: true, data: 'written' })),
    }];

    const registry: ToolRegistry = {
      register: vi.fn(),
      get: (name: string) => toolDefs.find((t) => t.name === name),
      getAll: () => toolDefs,
    };

    const events: SSEEvent[] = [];
    const pendingConfirms = new Map();

    await runToolLoop({
      messages: [{ role: 'user', content: 'Write file' }],
      client,
      registry,
      onEvent: (e) => events.push(e),
      pendingConfirms,
      piiProxy: createPassthroughProxy(),
    });

    // Handler should be called (auto-approved)
    expect(toolDefs[0].handler).toHaveBeenCalled();
    // No confirm request should have been sent
    expect(events.some(e => e.type === 'tool_confirm_request')).toBe(false);

    closeDb();
    fs.rmSync(permTmpDir, { recursive: true, force: true });
  });

  it('shows forbidden card with forbidden level', async () => {
    const client = mockClaudeClient([
      {
        content: [
          { type: 'tool_use', id: 'call_f', name: 'dangerous', input: {} },
        ],
        stop_reason: 'tool_use',
      },
      {
        content: [{ type: 'text', text: 'OK.' }],
        stop_reason: 'end_turn',
      },
    ]);

    const toolDefs = [{
      name: 'dangerous',
      description: 'Dangerous tool',
      permissionLevel: 'forbidden' as const,
      provider: 'all' as const,
      parameters: { type: 'object' as const, properties: {}, required: [] },
      handler: vi.fn(async () => ({ success: true, data: 'done' })),
    }];

    const registry: ToolRegistry = {
      register: vi.fn(),
      get: (name: string) => toolDefs.find((t) => t.name === name),
      getAll: () => toolDefs,
    };

    const events: SSEEvent[] = [];
    const pendingConfirms = new Map();

    const originalOnEvent = (e: SSEEvent) => {
      events.push(e);
      if (e.type === 'tool_confirm_request') {
        const resolve = pendingConfirms.get(e.toolCall.id);
        if (resolve) {
          pendingConfirms.delete(e.toolCall.id);
          resolve({ allowed: true, remember: false });
        }
      }
    };

    await runToolLoop({
      messages: [{ role: 'user', content: 'Do it' }],
      client,
      registry,
      onEvent: originalOnEvent,
      pendingConfirms,
      piiProxy: createPassthroughProxy(),
    });

    const confirmEvent = events.find(e => e.type === 'tool_confirm_request');
    expect(confirmEvent).toBeDefined();
    if (confirmEvent && confirmEvent.type === 'tool_confirm_request') {
      expect(confirmEvent.level).toBe('forbidden');
    }
    expect(toolDefs[0].handler).toHaveBeenCalled();
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
      piiProxy: createPassthroughProxy(),
    });

    expect(events[1]).toEqual({
      type: 'tool_call_result',
      id: 'call_err',
      result: { success: false, error: 'API down' },
    });
  });
});

describe('Agentic Tool Loop — Permission Rules', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-perm-loop-'));
    initDb(path.join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('auto-denies tool when saved rule has allowed=false', async () => {
    const { savePermissionRule } = await import('../../db.js');
    savePermissionRule('write_file', false);

    const client = mockClaudeClient([
      {
        content: [
          { type: 'tool_use', id: 'call_deny', name: 'write_file', input: { path: 'x.txt' } },
        ],
        stop_reason: 'tool_use',
      },
      {
        content: [{ type: 'text', text: 'Denied.' }],
        stop_reason: 'end_turn',
      },
    ]);

    const toolDefs = [{
      name: 'write_file',
      description: 'Write a file',
      permissionLevel: 'confirm' as const,
      provider: 'all' as const,
      parameters: { type: 'object' as const, properties: {}, required: [] },
      handler: vi.fn(async () => ({ success: true, data: 'written' })),
    }];

    const registry: ToolRegistry = {
      register: vi.fn(),
      get: (name: string) => toolDefs.find((t) => t.name === name),
      getAll: () => toolDefs,
    };

    const events: SSEEvent[] = [];
    await runToolLoop({
      messages: [{ role: 'user', content: 'Write file' }],
      client,
      registry,
      onEvent: (e) => events.push(e),
      pendingConfirms: new Map(),
      piiProxy: createPassthroughProxy(),
    });

    expect(toolDefs[0].handler).not.toHaveBeenCalled();
    expect(events.some(e => e.type === 'tool_confirm_request')).toBe(false);
    const resultEvent = events.find(e => e.type === 'tool_call_result');
    expect(resultEvent).toBeDefined();
    if (resultEvent && resultEvent.type === 'tool_call_result') {
      expect(resultEvent.result.success).toBe(false);
      expect(resultEvent.result.error).toContain('denied');
    }
  });

  it('saves permission rule to DB when remember=true', async () => {
    const { getPermissionRule } = await import('../../db.js');

    const client = mockClaudeClient([
      {
        content: [
          { type: 'tool_use', id: 'call_rem', name: 'write_file', input: { path: 'x.txt' } },
        ],
        stop_reason: 'tool_use',
      },
      {
        content: [{ type: 'text', text: 'Done.' }],
        stop_reason: 'end_turn',
      },
    ]);

    const toolDefs = [{
      name: 'write_file',
      description: 'Write a file',
      permissionLevel: 'confirm' as const,
      provider: 'all' as const,
      parameters: { type: 'object' as const, properties: {}, required: [] },
      handler: vi.fn(async () => ({ success: true, data: 'written' })),
    }];

    const registry: ToolRegistry = {
      register: vi.fn(),
      get: (name: string) => toolDefs.find((t) => t.name === name),
      getAll: () => toolDefs,
    };

    const pendingConfirms = new Map();
    const onEvent = (e: SSEEvent) => {
      if (e.type === 'tool_confirm_request') {
        const resolve = pendingConfirms.get(e.toolCall.id);
        if (resolve) {
          pendingConfirms.delete(e.toolCall.id);
          resolve({ allowed: true, remember: true });
        }
      }
    };

    await runToolLoop({
      messages: [{ role: 'user', content: 'Write file' }],
      client,
      registry,
      onEvent,
      pendingConfirms,
      piiProxy: createPassthroughProxy(),
    });

    const rule = getPermissionRule('write_file');
    expect(rule).toEqual({ allowed: true });
  });

  it('does not save permission rule for forbidden tools even with remember=true', async () => {
    const { getPermissionRule } = await import('../../db.js');

    const client = mockClaudeClient([
      {
        content: [
          { type: 'tool_use', id: 'call_forb', name: 'dangerous', input: {} },
        ],
        stop_reason: 'tool_use',
      },
      {
        content: [{ type: 'text', text: 'Done.' }],
        stop_reason: 'end_turn',
      },
    ]);

    const toolDefs = [{
      name: 'dangerous',
      description: 'Dangerous tool',
      permissionLevel: 'forbidden' as const,
      provider: 'all' as const,
      parameters: { type: 'object' as const, properties: {}, required: [] },
      handler: vi.fn(async () => ({ success: true, data: 'done' })),
    }];

    const registry: ToolRegistry = {
      register: vi.fn(),
      get: (name: string) => toolDefs.find((t) => t.name === name),
      getAll: () => toolDefs,
    };

    const pendingConfirms = new Map();
    const onEvent = (e: SSEEvent) => {
      if (e.type === 'tool_confirm_request') {
        const resolve = pendingConfirms.get(e.toolCall.id);
        if (resolve) {
          pendingConfirms.delete(e.toolCall.id);
          resolve({ allowed: true, remember: true });
        }
      }
    };

    await runToolLoop({
      messages: [{ role: 'user', content: 'Do it' }],
      client,
      registry,
      onEvent,
      pendingConfirms,
      piiProxy: createPassthroughProxy(),
    });

    const rule = getPermissionRule('dangerous');
    expect(rule).toBeNull();
  });

  it('resolves with denied when signal aborts during confirm wait', async () => {
    const controller = new AbortController();

    const client = mockClaudeClient([
      {
        content: [
          { type: 'tool_use', id: 'call_abort', name: 'write_file', input: { path: 'x.txt' } },
        ],
        stop_reason: 'tool_use',
      },
      {
        content: [{ type: 'text', text: 'Done.' }],
        stop_reason: 'end_turn',
      },
    ]);

    const toolDefs = [{
      name: 'write_file',
      description: 'Write a file',
      permissionLevel: 'confirm' as const,
      provider: 'all' as const,
      parameters: { type: 'object' as const, properties: {}, required: [] },
      handler: vi.fn(async () => ({ success: true, data: 'written' })),
    }];

    const registry: ToolRegistry = {
      register: vi.fn(),
      get: (name: string) => toolDefs.find((t) => t.name === name),
      getAll: () => toolDefs,
    };

    const events: SSEEvent[] = [];
    const pendingConfirms = new Map();

    // Abort shortly after confirm request is sent
    const onEvent = (e: SSEEvent) => {
      events.push(e);
      if (e.type === 'tool_confirm_request') {
        setTimeout(() => controller.abort(), 10);
      }
    };

    await runToolLoop({
      messages: [{ role: 'user', content: 'Write file' }],
      client,
      registry,
      onEvent,
      pendingConfirms,
      signal: controller.signal,
      piiProxy: createPassthroughProxy(),
    });

    // Tool should NOT have been executed (denied by abort)
    expect(toolDefs[0].handler).not.toHaveBeenCalled();
    // Pending confirm should be cleaned up
    expect(pendingConfirms.size).toBe(0);
  });
});

describe('Agentic Tool Loop — Audit Logging', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-loop-test-'));
    initDb(path.join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('logs tool call to audit_log after execution', async () => {
    const client = mockClaudeClient([
      {
        content: [
          { type: 'tool_use', id: 'call_1', name: 'search', input: { query: 'test' } },
        ],
        stop_reason: 'tool_use',
      },
      {
        content: [{ type: 'text', text: 'Done.' }],
        stop_reason: 'end_turn',
      },
    ]);

    const registry = mockRegistry({
      search: () => ({ success: true, data: 'results' }),
    });

    await runToolLoop({
      messages: [{ role: 'user', content: 'Search' }],
      client,
      registry,
      onEvent: () => {},
      piiProxy: createPassthroughProxy(),
    });

    const db = getDb();
    const rows = db.prepare('SELECT * FROM audit_log').all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].tool_name).toBe('search');
    expect(JSON.parse(rows[0].input)).toEqual({ query: 'test' });
    expect(JSON.parse(rows[0].result)).toEqual({ success: true, data: 'results' });
    expect(rows[0].success).toBe(1);
    expect(rows[0].duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('logs failed tool call to audit_log', async () => {
    const client = mockClaudeClient([
      {
        content: [
          { type: 'tool_use', id: 'call_err', name: 'search', input: { query: 'fail' } },
        ],
        stop_reason: 'tool_use',
      },
      {
        content: [{ type: 'text', text: 'Error.' }],
        stop_reason: 'end_turn',
      },
    ]);

    const registry = mockRegistry({
      search: () => { throw new Error('API down'); },
    });

    await runToolLoop({
      messages: [{ role: 'user', content: 'Search' }],
      client,
      registry,
      onEvent: () => {},
      piiProxy: createPassthroughProxy(),
    });

    const db = getDb();
    const rows = db.prepare('SELECT * FROM audit_log').all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].tool_name).toBe('search');
    expect(rows[0].success).toBe(0);
    expect(rows[0].duration_ms).toBeGreaterThanOrEqual(0);
  });
});

describe('Agentic Tool Loop — preCheck and autoMode', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-precheck-'));
    initDb(path.join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('fires preCheck hook and forces confirmation when destructive', async () => {
    const client = mockClaudeClient([
      {
        content: [{ type: 'tool_use', id: 'call_dest', name: 'danger_tool', input: { task: 'delete stuff' } }],
        stop_reason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' },
    ]);

    const handler = vi.fn(async () => ({ success: true, data: 'x' }));
    const toolDefs = [{
      name: 'danger_tool',
      description: 'Dangerous',
      permissionLevel: 'confirm' as const,
      provider: 'all' as const,
      parameters: { type: 'object' as const, properties: {}, required: [] },
      preCheck: async () => ({ destructive: true, reason: 'test destructive' }),
      handler,
    }];

    const registry: any = { register: vi.fn(), get: (n: string) => toolDefs.find((t) => t.name === n), getAll: () => toolDefs };

    const events: SSEEvent[] = [];
    const pendingConfirms = new Map();
    const onEvent = (e: SSEEvent) => {
      events.push(e);
      if (e.type === 'tool_confirm_request') {
        const resolve = pendingConfirms.get(e.toolCall.id);
        if (resolve) {
          pendingConfirms.delete(e.toolCall.id);
          resolve({ allowed: true, remember: false });
        }
      }
    };

    await runToolLoop({
      messages: [{ role: 'user', content: 'do it' }],
      client,
      registry,
      onEvent,
      pendingConfirms,
      piiProxy: { anonymize: async (t: string) => ({ text: t, entities: [] }), deanonymize: async (t: string) => t } as any,
    });

    const confirmEvent = events.find((e) => e.type === 'tool_confirm_request');
    expect(confirmEvent).toBeDefined();
    if (confirmEvent?.type === 'tool_confirm_request') {
      expect(confirmEvent.destructiveWarning).toEqual({ reason: 'test destructive' });
    }
    expect(handler).toHaveBeenCalled();
  });

  it('autoMode=true when saved rule exists and not destructive', async () => {
    const { savePermissionRule } = await import('../../db.js');
    savePermissionRule('auto_tool', true);

    const client = mockClaudeClient([
      {
        content: [{ type: 'tool_use', id: 'call_auto', name: 'auto_tool', input: { task: 'safe task' } }],
        stop_reason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' },
    ]);

    let receivedCtx: any = null;
    const toolDefs = [{
      name: 'auto_tool',
      description: 'Auto',
      permissionLevel: 'confirm' as const,
      provider: 'all' as const,
      parameters: { type: 'object' as const, properties: {}, required: [] },
      preCheck: async () => ({ destructive: false, reason: '' }),
      handler: vi.fn(async (_p: any, ctx: any) => { receivedCtx = ctx; return { success: true, data: 'x' }; }),
    }];

    const registry: any = { register: vi.fn(), get: (n: string) => toolDefs.find((t) => t.name === n), getAll: () => toolDefs };

    await runToolLoop({
      messages: [{ role: 'user', content: 'do it' }],
      client,
      registry,
      onEvent: () => {},
      piiProxy: { anonymize: async (t: string) => ({ text: t, entities: [] }), deanonymize: async (t: string) => t } as any,
    });

    expect(receivedCtx?.meta?.autoMode).toBe(true);
  });

  it('saved rule does NOT apply when destructive', async () => {
    const { savePermissionRule } = await import('../../db.js');
    savePermissionRule('danger_tool', true);

    const client = mockClaudeClient([
      {
        content: [{ type: 'tool_use', id: 'call_x', name: 'danger_tool', input: { task: 'bad thing' } }],
        stop_reason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' },
    ]);

    const toolDefs = [{
      name: 'danger_tool',
      description: 'Dangerous',
      permissionLevel: 'confirm' as const,
      provider: 'all' as const,
      parameters: { type: 'object' as const, properties: {}, required: [] },
      preCheck: async () => ({ destructive: true, reason: 'danger' }),
      handler: vi.fn(async () => ({ success: true, data: 'x' })),
    }];

    const registry: any = { register: vi.fn(), get: (n: string) => toolDefs.find((t) => t.name === n), getAll: () => toolDefs };

    const events: SSEEvent[] = [];
    const pendingConfirms = new Map();

    await runToolLoop({
      messages: [{ role: 'user', content: 'do it' }],
      client,
      registry,
      onEvent: (e) => {
        events.push(e);
        if (e.type === 'tool_confirm_request') {
          const resolve = pendingConfirms.get(e.toolCall.id);
          if (resolve) { pendingConfirms.delete(e.toolCall.id); resolve({ allowed: true, remember: false }); }
        }
      },
      pendingConfirms,
      piiProxy: { anonymize: async (t: string) => ({ text: t, entities: [] }), deanonymize: async (t: string) => t } as any,
    });

    // Must have shown confirm card despite saved rule
    expect(events.some((e) => e.type === 'tool_confirm_request')).toBe(true);
  });
});
