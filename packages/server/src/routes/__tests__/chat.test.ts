import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createChatRouter } from '../chat.js';
import { createPassthroughProxy } from '../../pii/proxy.js';

describe('POST /api/chat', () => {
  it('returns 400 when messages not provided', async () => {
    const app = express();
    app.use(express.json());

    const router = createChatRouter({
      runLoop: vi.fn(),
      pendingConfirms: new Map(),
      pendingPlanReviews: new Map(),
      piiProxy: createPassthroughProxy(),
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
    });
    app.use('/api', router);

    await request(app)
      .post('/api/chat')
      .send({ messages: [{ role: 'user', content: 'Hello' }] })
      .expect(200);

    expect(receivedMessages[0].content).toBe('Hello');
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
