import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createChatRouter } from '../chat.js';
import { createPassthroughProxy } from '../../pii/proxy.js';

function fakeRegistry() {
  return {
    register: vi.fn(),
    get: vi.fn(),
    getAll: vi.fn().mockReturnValue([]),
    getForProvider: vi.fn().mockReturnValue([]),
    getCommands: vi.fn().mockReturnValue([]),
    getByCommandName: vi.fn().mockReturnValue(undefined),
  };
}

const savedMessages: any[] = [];
vi.mock('../../db.js', () => ({
  saveMessage: (params: any) => {
    savedMessages.push(params);
  },
  initDb: () => {},
}));

beforeEach(() => {
  savedMessages.length = 0;
});

describe('POST /api/chat', () => {
  it('returns 400 when messages not provided', async () => {
    const app = express();
    app.use(express.json());

    const router = createChatRouter({
      runLoop: vi.fn(),
      pendingConfirms: new Map(),
      pendingPlanReviews: new Map(),
      piiProxy: createPassthroughProxy(),
      ollama: null,
      registry: fakeRegistry() as any,
    });
    app.use('/api', router);

    const res = await request(app)
      .post('/api/chat')
      .send({})
      .expect(400);

    expect(res.body.error).toBe('messages[] required');
  });

  it('streams SSE events for valid request', async () => {
    const app = express();
    app.use(express.json());

    const router = createChatRouter({
      runLoop: async ({ onEvent }) => {
        onEvent({ type: 'text_delta', content: 'Hello' });
        onEvent({ type: 'done' });
      },
      pendingConfirms: new Map(),
      pendingPlanReviews: new Map(),
      piiProxy: createPassthroughProxy(),
      ollama: null,
      registry: fakeRegistry() as any,
    });
    app.use('/api', router);

    const res = await request(app)
      .post('/api/chat')
      .send({ messages: [{ role: 'user', content: 'Hi' }] })
      .expect(200)
      .expect('Content-Type', /text\/event-stream/);

    expect(res.text).toContain('data: {"type":"text_delta","content":"Hello"}');
    expect(res.text).toContain('data: {"type":"done"}');
  });

  it('streams error event on loop failure', async () => {
    const app = express();
    app.use(express.json());

    const router = createChatRouter({
      runLoop: async () => {
        throw new Error('Claude API down');
      },
      pendingConfirms: new Map(),
      pendingPlanReviews: new Map(),
      piiProxy: createPassthroughProxy(),
      ollama: null,
      registry: fakeRegistry() as any,
    });
    app.use('/api', router);

    const res = await request(app)
      .post('/api/chat')
      .send({ messages: [{ role: 'user', content: 'Hi' }] })
      .expect(200);

    expect(res.text).toContain('"type":"error"');
    expect(res.text).toContain('Claude API down');
  });

  it('sanitizes Anthropic-related errors (case-insensitive)', async () => {
    const app = express();
    app.use(express.json());

    const router = createChatRouter({
      runLoop: async () => {
        throw new Error('Anthropic API returned 401');
      },
      pendingConfirms: new Map(),
      pendingPlanReviews: new Map(),
      piiProxy: createPassthroughProxy(),
      ollama: null,
      registry: fakeRegistry() as any,
    });
    app.use('/api', router);

    const res = await request(app)
      .post('/api/chat')
      .send({ messages: [{ role: 'user', content: 'Hi' }] })
      .expect(200);

    expect(res.text).toContain('AI service temporarily unavailable');
    expect(res.text).not.toContain('Anthropic');
  });

  it('sanitizes SearXNG-related errors (case-insensitive)', async () => {
    const app = express();
    app.use(express.json());

    const router = createChatRouter({
      runLoop: async () => {
        throw new Error('Web search failed: connect ECONNREFUSED 127.0.0.1:8888');
      },
      pendingConfirms: new Map(),
      pendingPlanReviews: new Map(),
      piiProxy: createPassthroughProxy(),
      ollama: null,
      registry: fakeRegistry() as any,
    });
    app.use('/api', router);

    const res = await request(app)
      .post('/api/chat')
      .send({ messages: [{ role: 'user', content: 'Hi' }] })
      .expect(200);

    expect(res.text).toContain('Search service temporarily unavailable');
    expect(res.text).not.toContain('127.0.0.1');
  });

  it('does not abort signal during runLoop execution (abort tied to res close)', async () => {
    const app = express();
    app.use(express.json());

    let signalAbortedDuringLoop = true;
    const router = createChatRouter({
      runLoop: async ({ onEvent, signal }) => {
        // Simulate async work — signal should NOT be aborted while streaming
        await new Promise((resolve) => setTimeout(resolve, 10));
        signalAbortedDuringLoop = signal?.aborted ?? false;
        onEvent({ type: 'text_delta', content: 'Hello' });
        onEvent({ type: 'done' });
      },
      pendingConfirms: new Map(),
      pendingPlanReviews: new Map(),
      piiProxy: createPassthroughProxy(),
      ollama: null,
      registry: fakeRegistry() as any,
    });
    app.use('/api', router);

    const res = await request(app)
      .post('/api/chat')
      .send({ messages: [{ role: 'user', content: 'Hi' }] })
      .expect(200);

    expect(res.text).toContain('Hello');
    // Signal must not have been aborted while runLoop was executing
    expect(signalAbortedDuringLoop).toBe(false);
  });

  it('formats timestamps in message content before passing to runLoop', async () => {
    const app = express();
    app.use(express.json());

    let receivedMessages: any[] = [];
    const router = createChatRouter({
      runLoop: async ({ messages, onEvent }) => {
        receivedMessages = messages;
        onEvent({ type: 'done' });
      },
      pendingConfirms: new Map(),
      pendingPlanReviews: new Map(),
      piiProxy: createPassthroughProxy(),
      ollama: null,
      registry: fakeRegistry() as any,
    });
    app.use('/api', router);

    const ts = new Date('2026-04-08T14:30:00').getTime();
    await request(app)
      .post('/api/chat')
      .send({ messages: [{ role: 'user', content: 'Hello', timestamp: ts }] })
      .expect(200);

    expect(receivedMessages).toHaveLength(1);
    expect(receivedMessages[0].content).toMatch(/^\[.*\] Hello$/);
    expect(receivedMessages[0].role).toBe('user');
  });

  it('passes messages without timestamp as-is', async () => {
    const app = express();
    app.use(express.json());

    let receivedMessages: any[] = [];
    const router = createChatRouter({
      runLoop: async ({ messages, onEvent }) => {
        receivedMessages = messages;
        onEvent({ type: 'done' });
      },
      pendingConfirms: new Map(),
      pendingPlanReviews: new Map(),
      piiProxy: createPassthroughProxy(),
      ollama: null,
      registry: fakeRegistry() as any,
    });
    app.use('/api', router);

    await request(app)
      .post('/api/chat')
      .send({ messages: [{ role: 'user', content: 'Hello' }] })
      .expect(200);

    expect(receivedMessages[0].content).toBe('Hello');
  });

  it('does not persist synthetic "router" pseudo tool call from escalation', async () => {
    const app = express();
    app.use(express.json());

    const router = createChatRouter({
      runLoop: async ({ onEvent }) => {
        onEvent({
          type: 'tool_call_start',
          toolCall: {
            id: 'router',
            name: 'router',
            input: { reason: 'low_confidence' },
            status: 'running',
          },
        });
        onEvent({ type: 'tool_progress', id: 'router', message: 'Escalating to Claude' });
        onEvent({
          type: 'tool_call_result',
          id: 'router',
          result: { success: true, display: { type: 'text', content: 'Escalating' } },
        });
        onEvent({ type: 'text_delta', content: 'Hello from Claude' });
        onEvent({ type: 'done' });
      },
      pendingConfirms: new Map(),
      pendingPlanReviews: new Map(),
      piiProxy: createPassthroughProxy(),
      ollama: null,
      registry: fakeRegistry() as any,
    });
    app.use('/api', router);

    const res = await request(app)
      .post('/api/chat')
      .send({ messages: [{ role: 'user', content: 'Hi' }] })
      .expect(200);

    // Synthetic router events are still forwarded to SSE for live UI visibility
    expect(res.text).toContain('"id":"router"');
    expect(res.text).toContain('Hello from Claude');

    // But the assistant save must NOT contain the synthetic router tool call
    const assistantSave = savedMessages.find((m) => m.role === 'assistant');
    expect(assistantSave).toBeDefined();
    expect(assistantSave.content).toBe('Hello from Claude');
    expect(assistantSave.toolCalls).toBeUndefined();
  });

  it('rewrites slash command with single required param', async () => {
    const app = express();
    app.use(express.json());

    let receivedMessages: any[] = [];
    const reg = fakeRegistry();
    reg.getByCommandName.mockReturnValue({
      name: 'web_search',
      provider: 'all',
      command: {
        name: 'пошук',
        params: [{ name: 'query', required: true }],
      },
    });

    const router = createChatRouter({
      runLoop: async ({ messages, onEvent }) => {
        receivedMessages = messages;
        onEvent({ type: 'done' });
      },
      pendingConfirms: new Map(),
      pendingPlanReviews: new Map(),
      piiProxy: createPassthroughProxy(),
      ollama: null,
      registry: reg as any,
    });
    app.use('/api', router);

    await request(app)
      .post('/api/chat')
      .send({ messages: [{ role: 'user', content: '/пошук hello world' }] })
      .expect(200);

    expect(reg.getByCommandName).toHaveBeenCalledWith('пошук');
    expect(receivedMessages[0].content).toContain('Use tool "web_search"');
    expect(receivedMessages[0].content).toContain('"query":"hello world"');
  });

  it('rewrites slash command with optional params', async () => {
    const app = express();
    app.use(express.json());

    let receivedMessages: any[] = [];
    const reg = fakeRegistry();
    reg.getByCommandName.mockReturnValue({
      name: 'file_list',
      provider: 'all',
      command: {
        name: 'файли',
        params: [{ name: 'path', required: false }],
      },
    });

    const router = createChatRouter({
      runLoop: async ({ messages, onEvent }) => {
        receivedMessages = messages;
        onEvent({ type: 'done' });
      },
      pendingConfirms: new Map(),
      pendingPlanReviews: new Map(),
      piiProxy: createPassthroughProxy(),
      ollama: null,
      registry: reg as any,
    });
    app.use('/api', router);

    await request(app)
      .post('/api/chat')
      .send({ messages: [{ role: 'user', content: '/файли src' }] })
      .expect(200);

    expect(receivedMessages[0].content).toContain('Use tool "file_list"');
    expect(receivedMessages[0].content).toContain('"path":"src"');
  });

  it('returns error when required slash-command args are missing', async () => {
    const app = express();
    app.use(express.json());

    let runLoopCalled = false;
    const reg = fakeRegistry();
    reg.getByCommandName.mockReturnValue({
      name: 'file_delete',
      provider: 'all',
      command: {
        name: 'видалити',
        params: [{ name: 'path', required: true, description: 'Шлях до файлу' }],
      },
    });

    const router = createChatRouter({
      runLoop: async () => { runLoopCalled = true; },
      pendingConfirms: new Map(),
      pendingPlanReviews: new Map(),
      piiProxy: createPassthroughProxy(),
      ollama: null,
      registry: reg as any,
    });
    app.use('/api', router);

    const res = await request(app)
      .post('/api/chat')
      .send({ messages: [{ role: 'user', content: '/видалити' }] })
      .expect(200);

    expect(runLoopCalled).toBe(false);
    expect(res.text).toContain('потребує параметри');
    expect(res.text).toContain('<path>');
  });

  it('rewrites slash command with multiple required params via deterministic parsing', async () => {
    const app = express();
    app.use(express.json());

    let receivedMessages: any[] = [];
    const reg = fakeRegistry();
    reg.getByCommandName.mockReturnValue({
      name: 'file_move',
      provider: 'all',
      command: {
        name: 'перемістити',
        params: [
          { name: 'source', required: true, description: 'Поточний шлях' },
          { name: 'destination', required: true, description: 'Новий шлях' },
        ],
      },
    });

    const router = createChatRouter({
      runLoop: async ({ messages, onEvent }) => {
        receivedMessages = messages;
        onEvent({ type: 'done' });
      },
      pendingConfirms: new Map(),
      pendingPlanReviews: new Map(),
      piiProxy: createPassthroughProxy(),
      ollama: null,
      registry: reg as any,
    });
    app.use('/api', router);

    await request(app)
      .post('/api/chat')
      .send({ messages: [{ role: 'user', content: '/перемістити old.txt new path/file.txt' }] })
      .expect(200);

    expect(receivedMessages[0].content).toContain('Use tool "file_move"');
    // Deterministic parser: first token → source, remainder joined → destination
    expect(receivedMessages[0].content).toContain('"source":"old.txt"');
    expect(receivedMessages[0].content).toContain('"destination":"new path/file.txt"');
  });

  it('sets forceProvider for claude-only tools', async () => {
    const app = express();
    app.use(express.json());

    let receivedMessages: any[] = [];
    const reg = fakeRegistry();
    reg.getByCommandName.mockReturnValue({
      name: 'code_task',
      provider: 'claude',
      command: {
        name: 'задача',
        params: [{ name: 'task', required: true }],
      },
    });

    const router = createChatRouter({
      runLoop: async ({ messages, onEvent }) => {
        receivedMessages = messages;
        onEvent({ type: 'done' });
      },
      pendingConfirms: new Map(),
      pendingPlanReviews: new Map(),
      piiProxy: createPassthroughProxy(),
      ollama: null,
      registry: reg as any,
    });
    app.use('/api', router);

    await request(app)
      .post('/api/chat')
      .send({ messages: [{ role: 'user', content: '/задача fix the bug' }] })
      .expect(200);

    expect(receivedMessages[0].content).toContain('Use tool "code_task"');
    expect(receivedMessages[0].content).toContain('"task":"fix the bug"');
  });

  it('passes unknown slash command through as normal message', async () => {
    const app = express();
    app.use(express.json());

    let receivedMessages: any[] = [];
    const reg = fakeRegistry();

    const router = createChatRouter({
      runLoop: async ({ messages, onEvent }) => {
        receivedMessages = messages;
        onEvent({ type: 'done' });
      },
      pendingConfirms: new Map(),
      pendingPlanReviews: new Map(),
      piiProxy: createPassthroughProxy(),
      ollama: null,
      registry: reg as any,
    });
    app.use('/api', router);

    await request(app)
      .post('/api/chat')
      .send({ messages: [{ role: 'user', content: '/unknown test' }] })
      .expect(200);

    // Should not be rewritten — passed through as-is
    expect(receivedMessages[0].content).toBe('/unknown test');
  });

  it('sanitizes errors containing API key patterns', async () => {
    const app = express();
    app.use(express.json());

    const router = createChatRouter({
      runLoop: async () => {
        throw new Error('Invalid key: sk-ant-abc123');
      },
      pendingConfirms: new Map(),
      pendingPlanReviews: new Map(),
      piiProxy: createPassthroughProxy(),
      ollama: null,
      registry: fakeRegistry() as any,
    });
    app.use('/api', router);

    const res = await request(app)
      .post('/api/chat')
      .send({ messages: [{ role: 'user', content: 'Hi' }] })
      .expect(200);

    expect(res.text).toContain('AI service temporarily unavailable');
    expect(res.text).not.toContain('sk-ant-');
  });
});
