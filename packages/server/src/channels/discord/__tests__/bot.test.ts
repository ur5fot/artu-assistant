import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { ChannelType, Client } from 'discord.js';
import type { SSEEvent } from '@r2/shared';
import { startDiscordBot, sendReply, isRetryableError, type DiscordBotDeps } from '../bot.js';
import { getDb, initDb } from '../../../db.js';
import { createCognitionStore, type CognitionStore } from '../../../cognition/store.js';

function makeFakeClient() {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    login: vi.fn().mockResolvedValue('token'),
    destroy: vi.fn().mockResolvedValue(undefined),
    isReady: vi.fn().mockReturnValue(true),
  }) as unknown as Client;
}

function makeDmChannel() {
  let nextId = 0;
  return {
    type: ChannelType.DM,
    send: vi.fn().mockImplementation(async () => ({ id: `msg-${++nextId}` })),
    sendTyping: vi.fn().mockResolvedValue(undefined),
  };
}

function makeMessage(overrides: Record<string, any> = {}) {
  const channel = makeDmChannel();
  return {
    msg: {
      author: { bot: false, id: '123' },
      channel,
      content: 'hello',
      ...overrides,
    },
    channel,
  };
}

function makeFakeDb(rows: Array<{ role: string; content: string }> = []) {
  // Expose the internal row array so the default saveMessage mock can
  // append on ingest — this mirrors the production behaviour where
  // messageCreate persists each burst message BEFORE handleMessage reads
  // history. Without this, tests under the coalesced flow would see an
  // empty DB and the LLM would get no context.
  const internal = [...rows];
  return {
    prepare: vi.fn().mockReturnValue({
      all: vi.fn(() => [...internal]),
    }),
    _rows: internal,
  };
}

async function setup(overrides: Partial<DiscordBotDeps> = {}) {
  const client = overrides._client ?? makeFakeClient();
  const runChatRequest = overrides.runChatRequest ?? vi.fn<any>().mockResolvedValue(undefined);
  const db = overrides.db ?? makeFakeDb();
  const saveMsgFn = overrides.saveMessage ?? vi.fn((params: { role: string; content: string }) => {
    const internal = (db as any)._rows;
    // Prepend so `prepare().all()` mimics `ORDER BY timestamp DESC` (most
    // recent first). The production bot calls reverse() on the result.
    if (Array.isArray(internal)) internal.unshift({ role: params.role, content: params.content });
  });

  const deps: DiscordBotDeps = {
    token: 'test-token',
    whitelist: new Set(['123']),
    runChatRequest: runChatRequest as any,
    db: db as any,
    historyLimit: 50,
    saveMessage: saveMsgFn as any,
    memoryService: null,
    _client: client as Client,
    // Default to 0ms debounce so existing tests keep their existing
    // `await delay(...)` waits small. Coalescing-specific tests override.
    coalesceMs: 0,
    ...overrides,
  };

  const bot = await startDiscordBot(deps);
  return { bot, client: client as Client, runChatRequest: runChatRequest as ReturnType<typeof vi.fn>, db, saveMessage: saveMsgFn as ReturnType<typeof vi.fn> };
}

function delay(ms = 50) {
  return new Promise((r) => setTimeout(r, ms));
}

describe('Discord bot', () => {
  it('ignores bot messages', async () => {
    const { client, runChatRequest } = await setup();
    const { msg } = makeMessage({ author: { bot: true, id: '123' } });

    client.emit('messageCreate', msg as any);
    await delay();

    expect(runChatRequest).not.toHaveBeenCalled();
  });

  it('ignores non-DM messages', async () => {
    const { client, runChatRequest } = await setup();
    const { msg } = makeMessage();
    msg.channel.type = ChannelType.GuildText as any;

    client.emit('messageCreate', msg as any);
    await delay();

    expect(runChatRequest).not.toHaveBeenCalled();
  });

  it('ignores messages with empty content', async () => {
    const { client, runChatRequest } = await setup();
    const { msg } = makeMessage({ content: '   ' });

    client.emit('messageCreate', msg as any);
    await delay();

    expect(runChatRequest).not.toHaveBeenCalled();
  });

  it('ignores non-whitelisted users silently', async () => {
    const { client, runChatRequest } = await setup({
      whitelist: new Set(['999']),
    });
    const { msg, channel } = makeMessage();

    client.emit('messageCreate', msg as any);
    await delay();

    expect(runChatRequest).not.toHaveBeenCalled();
    expect(channel.send).not.toHaveBeenCalled();
  });

  it('calls runChatRequest with loaded history for whitelisted DM', async () => {
    const historyRows = [
      { role: 'assistant', content: 'prev answer' },
      { role: 'user', content: 'prev question' },
    ];
    const db = makeFakeDb(historyRows);

    const runChatRequest = vi.fn<any>(async ({ onEvent }: { onEvent: (e: SSEEvent) => void }) => {
      onEvent({ type: 'text_delta', content: 'reply' } as SSEEvent);
      onEvent({ type: 'done' } as SSEEvent);
    });

    const { client, saveMessage } = await setup({
      runChatRequest: runChatRequest as any,
      db: db as any,
    });

    const { msg } = makeMessage({ content: 'new question' });
    client.emit('messageCreate', msg as any);
    await delay();

    expect(runChatRequest).toHaveBeenCalledTimes(1);

    const call = runChatRequest.mock.calls[0]![0] as { messages: Array<{ role: string; content: string }> };
    expect(call.messages).toEqual([
      { role: 'user', content: 'prev question' },
      { role: 'assistant', content: 'prev answer' },
      { role: 'user', content: 'new question' },
    ]);

    expect(saveMessage).toHaveBeenCalledTimes(2);
    const userSave = saveMessage.mock.calls[0][0];
    expect(userSave.role).toBe('user');
    expect(userSave.content).toBe('new question');
    expect(userSave.source).toBe('discord:123');

    const assistantSave = saveMessage.mock.calls[1][0];
    expect(assistantSave.role).toBe('assistant');
    expect(assistantSave.content).toBe('reply');
    expect(assistantSave.source).toBe('discord:123');
  });

  it('accumulates text_delta and sends full text on done', async () => {
    const runChatRequest = vi.fn<any>(async ({ onEvent }: { onEvent: (e: SSEEvent) => void }) => {
      onEvent({ type: 'text_delta', content: 'hello ' } as SSEEvent);
      onEvent({ type: 'text_delta', content: 'world' } as SSEEvent);
      onEvent({ type: 'done' } as SSEEvent);
    });

    const { client } = await setup({ runChatRequest: runChatRequest as any });
    const { msg, channel } = makeMessage();

    client.emit('messageCreate', msg as any);
    await delay();

    expect(channel.send).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'hello world', allowedMentions: { parse: [] } }),
    );
  });

  it('splits long messages into chunks <= 2000 chars', async () => {
    const longText = 'word '.repeat(500).trim();

    const runChatRequest = vi.fn<any>(async ({ onEvent }: { onEvent: (e: SSEEvent) => void }) => {
      onEvent({ type: 'text_delta', content: longText } as SSEEvent);
      onEvent({ type: 'done' } as SSEEvent);
    });

    const { client } = await setup({ runChatRequest: runChatRequest as any });
    const { msg, channel } = makeMessage();

    client.emit('messageCreate', msg as any);
    await delay();

    expect(channel.send.mock.calls.length).toBeGreaterThanOrEqual(2);

    for (const call of channel.send.mock.calls) {
      expect(call[0].content.length).toBeLessThanOrEqual(2000);
    }

    const concatenated = channel.send.mock.calls.map((c: any) => c[0].content).join(' ');
    expect(concatenated.replace(/\s+/g, ' ')).toBe(longText);
  });

  it('sends error message on error event', async () => {
    const runChatRequest = vi.fn<any>(async ({ onEvent }: { onEvent: (e: SSEEvent) => void }) => {
      onEvent({ type: 'error', message: 'something broke' } as SSEEvent);
    });

    const { client } = await setup({ runChatRequest: runChatRequest as any });
    const { msg, channel } = makeMessage();

    client.emit('messageCreate', msg as any);
    await delay();

    expect(channel.send).toHaveBeenCalledWith(
      expect.objectContaining({ content: '⚠️ Something went wrong. Please try again later.' }),
    );
  });

  it('stop() destroys the client', async () => {
    const { bot, client } = await setup();
    await bot.stop();
    expect((client as any).destroy).toHaveBeenCalled();
  });
});

describe('isRetryableError', () => {
  it('returns true for network-related errors', () => {
    expect(isRetryableError(new Error('Connect Timeout Error'))).toBe(true);
    expect(isRetryableError(new Error('ECONNREFUSED'))).toBe(true);
    expect(isRetryableError(new Error('ECONNRESET'))).toBe(true);
    expect(isRetryableError(new Error('ENOTFOUND'))).toBe(true);
    expect(isRetryableError(new Error('socket hang up'))).toBe(true);
    expect(isRetryableError(new Error('fetch failed'))).toBe(true);
    expect(isRetryableError(new Error('network error'))).toBe(true);
  });

  it('returns false for non-network errors', () => {
    expect(isRetryableError(new Error('Invalid API key'))).toBe(false);
    expect(isRetryableError(new Error('Rate limited'))).toBe(false);
    expect(isRetryableError('string error')).toBe(false);
    expect(isRetryableError(null)).toBe(false);
  });
});

describe('retry on network error', () => {
  it('retries on retryable error and succeeds on second attempt', async () => {
    let callCount = 0;
    const runChatRequest = vi.fn<any>(async ({ onEvent }: { onEvent: (e: SSEEvent) => void }) => {
      callCount++;
      if (callCount === 1) {
        throw new Error('Connect Timeout Error (attempted address: discord.com:443, timeout: 10000ms)');
      }
      onEvent({ type: 'text_delta', content: 'ok' } as SSEEvent);
      onEvent({ type: 'done' } as SSEEvent);
    });

    const { client } = await setup({ runChatRequest: runChatRequest as any });
    const { msg, channel } = makeMessage({ content: 'test' });

    client.emit('messageCreate', msg as any);
    await delay(1500);

    expect(runChatRequest).toHaveBeenCalledTimes(2);
    expect(channel.send).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'ok' }),
    );
  });

  it('does not retry on non-retryable errors', async () => {
    const runChatRequest = vi.fn<any>(async () => {
      throw new Error('Invalid API key');
    });

    const { client } = await setup({ runChatRequest: runChatRequest as any });
    const { msg, channel } = makeMessage({ content: 'test' });

    client.emit('messageCreate', msg as any);
    await delay(100);

    expect(runChatRequest).toHaveBeenCalledTimes(1);
    expect(channel.send).toHaveBeenCalledWith(
      expect.objectContaining({ content: '⚠️ Something went wrong. Please try again later.' }),
    );
  });
});

describe('reminder delivery', () => {
  it('sends embed DM with buttons on reminder_ring to whitelisted users', async () => {
    const reminderBus = new EventEmitter();
    const client = makeFakeClient();
    const fakeDm = makeDmChannel();
    fakeDm.send = vi.fn().mockResolvedValue({ id: 'msg-1' });
    const fakeUser = { createDM: vi.fn().mockResolvedValue(fakeDm) };
    (client as any).users = {
      fetch: vi.fn().mockResolvedValue(fakeUser),
      cache: new Map([['123', fakeUser]]),
    };

    await setup({ _client: client as any, reminderBus });

    (client as any).emit('clientReady');
    await delay(100);

    reminderBus.emit('push', { type: 'reminder_ring', id: 1, text: 'Buy fish' });
    await delay(100);

    expect(fakeDm.send).toHaveBeenCalledWith(
      expect.objectContaining({
        embeds: expect.any(Array),
        components: expect.any(Array),
      }),
    );
  });

  it('does not send or edit anything on reminder_done when no ringing embed stored', async () => {
    const reminderBus = new EventEmitter();
    const client = makeFakeClient();
    const fakeDm = makeDmChannel();
    const fakeUser = { createDM: vi.fn().mockResolvedValue(fakeDm) };
    (client as any).users = {
      fetch: vi.fn().mockResolvedValue(fakeUser),
      cache: new Map([['123', fakeUser]]),
    };

    await setup({ _client: client as any, reminderBus });
    (client as any).emit('clientReady');
    await delay(100);

    reminderBus.emit('push', { type: 'reminder_done', id: 1 });
    await delay(100);

    expect(fakeDm.send).not.toHaveBeenCalled();
  });

  async function setupRingAndCapture(eventType: 'reminder_done' | 'reminder_dismissed' | 'reminder_snoozed') {
    const reminderBus = new EventEmitter();
    const client = makeFakeClient();
    const fakeDm = makeDmChannel();

    const storedMsg = {
      embeds: [{ title: '⏰ Buy fish' }],
      edit: vi.fn().mockResolvedValue(undefined),
    };
    (fakeDm as any).messages = {
      fetch: vi.fn().mockResolvedValue(storedMsg),
    };
    fakeDm.send = vi.fn().mockResolvedValue({ id: 'msg-1' });

    const fakeUser = { createDM: vi.fn().mockResolvedValue(fakeDm) };
    (client as any).users = {
      fetch: vi.fn().mockResolvedValue(fakeUser),
      cache: new Map([['123', fakeUser]]),
    };

    await setup({ _client: client as any, reminderBus });
    (client as any).emit('clientReady');
    await delay(50);

    reminderBus.emit('push', { type: 'reminder_ring', id: 7, text: 'Buy fish' });
    await delay(100);

    reminderBus.emit('push', { type: eventType, id: 7 });
    await delay(100);

    return { fakeDm, storedMsg };
  }

  it('edits stored ringing embed to missed on reminder_done', async () => {
    const { fakeDm, storedMsg } = await setupRingAndCapture('reminder_done');
    expect((fakeDm as any).messages.fetch).toHaveBeenCalledWith('msg-1');
    expect(storedMsg.edit).toHaveBeenCalledTimes(1);
    const editArg = storedMsg.edit.mock.calls[0][0] as { embeds: any[]; components: any[] };
    expect(editArg.components).toEqual([]);
    const embedData = editArg.embeds[0].data ?? editArg.embeds[0];
    expect(embedData.title).toBe('⏰ Buy fish');
    expect(embedData.footer?.text).toContain('missed');
  });

  it('edits stored ringing embed to dismissed on reminder_dismissed', async () => {
    const { storedMsg } = await setupRingAndCapture('reminder_dismissed');
    expect(storedMsg.edit).toHaveBeenCalledTimes(1);
    const editArg = storedMsg.edit.mock.calls[0][0] as { embeds: any[]; components: any[] };
    const embedData = editArg.embeds[0].data ?? editArg.embeds[0];
    expect(embedData.footer?.text).toContain('Dismissed');
    expect(editArg.components).toEqual([]);
  });

  it('edits stored ringing embed to snoozed on reminder_snoozed', async () => {
    const { storedMsg } = await setupRingAndCapture('reminder_snoozed');
    expect(storedMsg.edit).toHaveBeenCalledTimes(1);
    const editArg = storedMsg.edit.mock.calls[0][0] as { embeds: any[]; components: any[] };
    const embedData = editArg.embeds[0].data ?? editArg.embeds[0];
    expect(embedData.footer?.text).toContain('Snoozed');
    expect(editArg.components).toEqual([]);
  });

  it('clears terminal state on new reminder_ring — recurring reminder re-rings keep buttons', async () => {
    const reminderBus = new EventEmitter();
    const client = makeFakeClient();
    const fakeDm = makeDmChannel();
    const storedMsg = {
      embeds: [{ title: '⏰ Buy fish' }],
      edit: vi.fn().mockResolvedValue(undefined),
    };
    (fakeDm as any).messages = { fetch: vi.fn().mockResolvedValue(storedMsg) };
    const sendCalls: Array<{ id: string; edit: ReturnType<typeof vi.fn> }> = [];
    fakeDm.send = vi.fn().mockImplementation(async () => {
      const msg = { id: `msg-${sendCalls.length + 1}`, edit: vi.fn().mockResolvedValue(undefined) };
      sendCalls.push(msg);
      return msg;
    });
    const fakeUser = { createDM: vi.fn().mockResolvedValue(fakeDm) };
    (client as any).users = {
      fetch: vi.fn().mockResolvedValue(fakeUser),
      cache: new Map([['123', fakeUser]]),
    };

    await setup({ _client: client as any, reminderBus });
    (client as any).emit('clientReady');
    await delay(50);

    // First cycle: ring, then dismiss (sets terminal for id 7).
    reminderBus.emit('push', { type: 'reminder_ring', id: 7, text: 'Buy fish' });
    await delay(100);
    reminderBus.emit('push', { type: 'reminder_dismissed', id: 7 });
    await delay(100);

    // Recurring reminder: scheduler fires the same id again.
    reminderBus.emit('push', { type: 'reminder_ring', id: 7, text: 'Buy fish' });
    await delay(100);

    // The freshly-sent DM for the new cycle must NOT be immediately edited to
    // a terminal state; the user needs the actionable buttons.
    expect(sendCalls).toHaveLength(2);
    expect(sendCalls[1]!.edit).not.toHaveBeenCalled();
  });

  it('ignores scheduler reminder_stop_ring — does not mislabel cycle pause as snoozed', async () => {
    const reminderBus = new EventEmitter();
    const client = makeFakeClient();
    const fakeDm = makeDmChannel();
    const storedMsg = {
      embeds: [{ title: '⏰ Buy fish' }],
      edit: vi.fn().mockResolvedValue(undefined),
    };
    (fakeDm as any).messages = { fetch: vi.fn().mockResolvedValue(storedMsg) };
    fakeDm.send = vi.fn().mockResolvedValue({ id: 'msg-1' });
    const fakeUser = { createDM: vi.fn().mockResolvedValue(fakeDm) };
    (client as any).users = {
      fetch: vi.fn().mockResolvedValue(fakeUser),
      cache: new Map([['123', fakeUser]]),
    };

    await setup({ _client: client as any, reminderBus });
    (client as any).emit('clientReady');
    await delay(50);

    reminderBus.emit('push', { type: 'reminder_ring', id: 7, text: 'Buy fish' });
    await delay(100);

    reminderBus.emit('push', { type: 'reminder_stop_ring', id: 7 });
    await delay(100);

    expect(storedMsg.edit).not.toHaveBeenCalled();
  });

});

describe('mid-stream tool_confirm_request handling', () => {
  it('flushes buffer, sends permission embed, then continues stream', async () => {
    const runChatRequest = vi.fn<any>(async ({ onEvent }: { onEvent: (e: SSEEvent) => void }) => {
      onEvent({ type: 'text_delta', content: 'before ' } as SSEEvent);
      onEvent({
        type: 'tool_confirm_request',
        toolCall: {
          id: 'c-1',
          name: 'files.write',
          input: { path: '/tmp/x' },
          status: 'running',
        },
        level: 'confirm',
      } as SSEEvent);
      onEvent({ type: 'text_delta', content: 'after' } as SSEEvent);
      onEvent({ type: 'done' } as SSEEvent);
    });

    const { client } = await setup({
      runChatRequest: runChatRequest as any,
      permissionService: {
        hasPending: vi.fn().mockReturnValue(true),
        isResolvedByUser: vi.fn().mockReturnValue(true),
        resolveConfirm: vi.fn(),
      } as any,
      reminderService: {
        dismiss: vi.fn(),
        snooze: vi.fn(),
        list: vi.fn(),
      } as any,
      planReviewService: {
        hasPending: vi.fn(),
        isResolvedByUser: vi.fn().mockReturnValue(true),
        resolveReview: vi.fn(),
      } as any,
      commandService: {
        status: vi.fn(),
        clearHistory: vi.fn(),
        listReminders: vi.fn(),
        listMemory: vi.fn(),
      } as any,
    });

    const { msg, channel } = makeMessage();
    client.emit('messageCreate', msg as any);
    await delay(100);

    const calls = (channel.send as any).mock.calls;
    // After allowedMentions hardening: text sends are now {content, allowedMentions} objects.
    // Discriminate text from embeds by the absence of `embeds`.
    const textsSent = calls
      .map((c: any[]) =>
        typeof c[0] === 'object' && c[0] !== null && typeof c[0].content === 'string' && !('embeds' in c[0])
          ? c[0].content
          : '',
      )
      .filter(Boolean);
    const embedsSent = calls.filter(
      (c: any[]) => typeof c[0] === 'object' && c[0] !== null && 'embeds' in c[0],
    );
    expect(textsSent).toEqual(expect.arrayContaining(['before ']));
    expect(embedsSent.length).toBeGreaterThan(0);
    expect(textsSent).toEqual(expect.arrayContaining(['after']));
  });

  it('flushes buffer and sends plan-review chunks on tool_plan_review', async () => {
    const runChatRequest = vi.fn<any>(async ({ onEvent }: { onEvent: (e: SSEEvent) => void }) => {
      onEvent({ type: 'text_delta', content: 'analyzing ' } as SSEEvent);
      onEvent({
        type: 'tool_plan_review',
        id: 'p-1',
        task: 'refactor',
        plan: 'step 1\nstep 2',
      } as SSEEvent);
      onEvent({ type: 'text_delta', content: 'next' } as SSEEvent);
      onEvent({ type: 'done' } as SSEEvent);
    });

    const { client } = await setup({
      runChatRequest: runChatRequest as any,
      permissionService: {
        hasPending: vi.fn(),
        isResolvedByUser: vi.fn().mockReturnValue(true),
        resolveConfirm: vi.fn(),
      } as any,
      reminderService: {
        dismiss: vi.fn(),
        snooze: vi.fn(),
        list: vi.fn(),
      } as any,
      planReviewService: {
        hasPending: vi.fn(),
        isResolvedByUser: vi.fn().mockReturnValue(true),
        resolveReview: vi.fn(),
      } as any,
      commandService: {
        status: vi.fn(),
        clearHistory: vi.fn(),
        listReminders: vi.fn(),
        listMemory: vi.fn(),
      } as any,
    });

    const { msg, channel } = makeMessage();
    client.emit('messageCreate', msg as any);
    await delay(100);

    const calls = (channel.send as any).mock.calls;
    const textsSent = calls
      .map((c: any[]) =>
        typeof c[0] === 'object' && c[0] !== null && typeof c[0].content === 'string' && !('embeds' in c[0])
          ? c[0].content
          : '',
      )
      .filter(Boolean);
    expect(textsSent).toEqual(expect.arrayContaining(['analyzing ']));
    const planChunkSent = calls.some(
      (c: any[]) => typeof c[0] === 'object' && c[0] !== null && typeof c[0].content === 'string' && c[0].content.includes('📋 Plan review'),
    );
    expect(planChunkSent).toBe(true);
    expect(textsSent).toEqual(expect.arrayContaining(['next']));
  });

  it('expires unresolved permission embed when runChatRequest finishes without user click', async () => {
    const runChatRequest = vi.fn<any>(async ({ onEvent }: { onEvent: (e: SSEEvent) => void }) => {
      onEvent({
        type: 'tool_confirm_request',
        toolCall: {
          id: 'c-99',
          name: 'files.write',
          input: { path: '/tmp/x' },
          status: 'running',
        },
        level: 'confirm',
      } as SSEEvent);
      onEvent({ type: 'done' } as SSEEvent);
    });

    // isResolvedByUser returns false — user never clicked the button.
    // The finally block should expire the stored embed.
    const sentEmbed = { id: 'perm-msg-1' };
    const channel = makeDmChannel();
    const fetchedMsg = { edit: vi.fn().mockResolvedValue(undefined) };
    (channel as any).messages = { fetch: vi.fn().mockResolvedValue(fetchedMsg) };
    channel.send = vi.fn().mockResolvedValue(sentEmbed);

    const { client } = await setup({
      runChatRequest: runChatRequest as any,
      permissionService: {
        hasPending: vi.fn().mockReturnValue(false),
        isResolvedByUser: vi.fn().mockReturnValue(false),
        resolveConfirm: vi.fn(),
      } as any,
      reminderService: { dismiss: vi.fn(), snooze: vi.fn(), list: vi.fn() } as any,
      planReviewService: {
        hasPending: vi.fn(),
        isResolvedByUser: vi.fn().mockReturnValue(false),
        resolveReview: vi.fn(),
      } as any,
      commandService: {
        status: vi.fn(),
        clearHistory: vi.fn(),
        listReminders: vi.fn(),
        listMemory: vi.fn(),
      } as any,
    });

    const msg = {
      author: { bot: false, id: '123' },
      channel,
      content: 'do a risky thing',
    };
    client.emit('messageCreate', msg as any);
    await delay(150);

    expect(fetchedMsg.edit).toHaveBeenCalled();
    const editArg = (fetchedMsg.edit.mock.calls[0] as any[])[0] as { embeds: any[]; components: any[] };
    const embedData = editArg.embeds[0].data ?? editArg.embeds[0];
    expect(embedData.footer?.text).toContain('expired');
    expect(editArg.components).toEqual([]);
  });
});

describe('interactionCreate routing', () => {
  it('delegates button interaction to routeInteraction', async () => {
    const reminderService = {
      dismiss: vi.fn().mockReturnValue({ ok: true }),
      snooze: vi.fn(),
      list: vi.fn(),
    };
    const { client } = await setup({
      reminderService: reminderService as any,
      permissionService: {
        hasPending: vi.fn(),
        isResolvedByUser: vi.fn().mockReturnValue(false),
        resolveConfirm: vi.fn(),
      } as any,
      planReviewService: {
        hasPending: vi.fn(),
        isResolvedByUser: vi.fn().mockReturnValue(false),
        resolveReview: vi.fn(),
      } as any,
      commandService: {
        status: vi.fn(),
        clearHistory: vi.fn(),
        listReminders: vi.fn(),
        listMemory: vi.fn(),
      } as any,
      cognitionService: {
        register: vi.fn(), start: vi.fn(), stop: vi.fn(),
        pause: vi.fn(), resume: vi.fn(),
        status: vi.fn().mockReturnValue({
          paused: false, lastTickAt: null, ticks24h: 0, queueSize: 0, handlers: [], recentRuns: [],
        }),
        markPublished: vi.fn(),
      } as any,
    });

    const fakeInteraction = {
      user: { id: '123' },
      customId: 'reminder:dismiss:42',
      isButton: () => true,
      isChatInputCommand: () => false,
      update: vi.fn().mockResolvedValue(undefined),
      message: { embeds: [{ title: '⏰ Buy fish' }] },
    };
    client.emit('interactionCreate', fakeInteraction as any);
    await delay(50);

    expect(reminderService.dismiss).toHaveBeenCalledWith(42);
    expect(fakeInteraction.update).toHaveBeenCalled();
  });
});

describe('tool_call_start handling', () => {
  it('sends a tool-call embed and tracks messageId', async () => {
    const runChatRequest = vi.fn<any>(async ({ onEvent }: any) => {
      onEvent({
        type: 'tool_call_start',
        toolCall: { id: 'c-1', name: 'file_write', input: { path: '/tmp/x' }, status: 'running' },
      } as SSEEvent);
      onEvent({ type: 'done' } as SSEEvent);
    });

    const { client } = await setup({
      runChatRequest: runChatRequest as any,
      permissionService: {
        hasPending: vi.fn(),
        isResolvedByUser: vi.fn().mockReturnValue(true),
        resolveConfirm: vi.fn(),
      } as any,
      reminderService: { dismiss: vi.fn(), snooze: vi.fn(), list: vi.fn() } as any,
      planReviewService: {
        hasPending: vi.fn(),
        isResolvedByUser: vi.fn().mockReturnValue(true),
        resolveReview: vi.fn(),
      } as any,
      commandService: {
        clearHistory: vi.fn(), status: vi.fn(), listReminders: vi.fn(), listMemory: vi.fn(),
        listPermissionRules: vi.fn().mockReturnValue([]),
        revokePermissionRule: vi.fn(),
      } as any,
    });
    const { msg, channel } = makeMessage({ author: { bot: false, id: '123' } });

    client.emit('messageCreate', msg as any);
    await delay(100);

    const embedCalls = (channel.send as any).mock.calls.filter(
      (c: any[]) => typeof c[0] === 'object' && c[0] !== null && 'embeds' in c[0],
    );
    expect(embedCalls.length).toBeGreaterThan(0);
    const firstEmbed = embedCalls[0][0].embeds[0];
    expect(firstEmbed.toJSON().title).toBe('🔧 file_write');
  });

  it('silent tool (memory_search): no embed sent', async () => {
    const runChatRequest = vi.fn<any>(async ({ onEvent }: any) => {
      onEvent({
        type: 'tool_call_start',
        toolCall: { id: 'c-1', name: 'memory_search', input: {}, status: 'running' },
      } as SSEEvent);
      onEvent({ type: 'done' } as SSEEvent);
    });

    const { client } = await setup({
      runChatRequest: runChatRequest as any,
      permissionService: {
        hasPending: vi.fn(),
        isResolvedByUser: vi.fn().mockReturnValue(true),
        resolveConfirm: vi.fn(),
      } as any,
      reminderService: { dismiss: vi.fn(), snooze: vi.fn(), list: vi.fn() } as any,
      planReviewService: {
        hasPending: vi.fn(),
        isResolvedByUser: vi.fn().mockReturnValue(true),
        resolveReview: vi.fn(),
      } as any,
      commandService: {
        clearHistory: vi.fn(), status: vi.fn(), listReminders: vi.fn(), listMemory: vi.fn(),
        listPermissionRules: vi.fn().mockReturnValue([]),
        revokePermissionRule: vi.fn(),
      } as any,
    });
    const { msg, channel } = makeMessage({ author: { bot: false, id: '123' } });

    client.emit('messageCreate', msg as any);
    await delay(100);

    const embedCalls = (channel.send as any).mock.calls.filter(
      (c: any[]) => typeof c[0] === 'object' && c[0] !== null && 'embeds' in c[0],
    );
    expect(embedCalls.length).toBe(0);
  });
});

describe('tool_progress handling (debounced)', () => {
  it('progress events within 800ms cooldown collapse to one trailing edit', async () => {
    const editMock = vi.fn().mockResolvedValue(undefined);
    const runChatRequest = vi.fn<any>(async ({ onEvent }: any) => {
      onEvent({
        type: 'tool_call_start',
        toolCall: { id: 'c-1', name: 'file_write', input: {}, status: 'running' },
      } as SSEEvent);
      onEvent({ type: 'tool_progress', id: 'c-1', message: 'step 1' } as SSEEvent);
      onEvent({ type: 'tool_progress', id: 'c-1', message: 'step 2' } as SSEEvent);
      // Let the 800ms trailing debounce fire before the request ends — the
      // finally-block cleanup otherwise cancels the pending timer.
      await new Promise((r) => setTimeout(r, 900));
      onEvent({
        type: 'tool_call_result',
        id: 'c-1',
        result: { success: true, display: { type: 'text', content: 'ok' } },
      } as SSEEvent);
      onEvent({ type: 'done' } as SSEEvent);
    });

    const channel = makeDmChannel();
    (channel.send as any).mockResolvedValue({ id: 'sent-1', edit: editMock });
    (channel as any).messages = {
      fetch: vi.fn().mockResolvedValue({ edit: editMock }),
    };

    const { client } = await setup({
      runChatRequest: runChatRequest as any,
      permissionService: {
        hasPending: vi.fn(),
        isResolvedByUser: vi.fn().mockReturnValue(true),
        resolveConfirm: vi.fn(),
      } as any,
      reminderService: { dismiss: vi.fn(), snooze: vi.fn(), list: vi.fn() } as any,
      planReviewService: {
        hasPending: vi.fn(),
        isResolvedByUser: vi.fn().mockReturnValue(true),
        resolveReview: vi.fn(),
      } as any,
      commandService: {
        clearHistory: vi.fn(), status: vi.fn(), listReminders: vi.fn(), listMemory: vi.fn(),
        listPermissionRules: vi.fn().mockReturnValue([]),
        revokePermissionRule: vi.fn(),
      } as any,
    });

    const msg = {
      author: { bot: false, id: '123' },
      channel,
      content: 'do work',
    };
    client.emit('messageCreate', msg as any);
    // Wait longer than the 800ms debounce so the trailing edit fires.
    await delay(1100);

    // Two rapid progress events should collapse to a single trailing edit.
    expect(editMock.mock.calls.length).toBeGreaterThanOrEqual(1);
    // Verify that a progress-state embed was edited (title retains 🔧 and
    // description matches one of the progress messages).
    const progressEdit = editMock.mock.calls.find((c: any[]) => {
      const arg = c[0];
      if (!arg || !Array.isArray(arg.embeds)) return false;
      const e = arg.embeds[0]?.toJSON?.() ?? arg.embeds[0];
      return e?.title === '🔧 file_write' && typeof e?.description === 'string';
    });
    expect(progressEdit).toBeDefined();
  });

  it('rapid progress events are coalesced: trailing edit uses latest message', async () => {
    const editMock = vi.fn().mockResolvedValue(undefined);
    const runChatRequest = vi.fn<any>(async ({ onEvent }: any) => {
      onEvent({
        type: 'tool_call_start',
        toolCall: { id: 'c-2', name: 'file_write', input: {}, status: 'running' },
      } as SSEEvent);
      // Fire three progresses back-to-back — within the 800ms cooldown.
      onEvent({ type: 'tool_progress', id: 'c-2', message: 'a' } as SSEEvent);
      onEvent({ type: 'tool_progress', id: 'c-2', message: 'b' } as SSEEvent);
      onEvent({ type: 'tool_progress', id: 'c-2', message: 'c' } as SSEEvent);
      // Wait past the debounce window so the trailing edit fires inside the
      // request lifecycle (before tool_call_result / done / cleanup).
      await new Promise((r) => setTimeout(r, 900));
      onEvent({
        type: 'tool_call_result',
        id: 'c-2',
        result: { success: true, display: { type: 'text', content: 'ok' } },
      } as SSEEvent);
      onEvent({ type: 'done' } as SSEEvent);
    });

    const channel = makeDmChannel();
    (channel.send as any).mockResolvedValue({ id: 'sent-2', edit: editMock });
    (channel as any).messages = {
      fetch: vi.fn().mockResolvedValue({ edit: editMock }),
    };

    const { client } = await setup({
      runChatRequest: runChatRequest as any,
      permissionService: {
        hasPending: vi.fn(),
        isResolvedByUser: vi.fn().mockReturnValue(true),
        resolveConfirm: vi.fn(),
      } as any,
      reminderService: { dismiss: vi.fn(), snooze: vi.fn(), list: vi.fn() } as any,
      planReviewService: {
        hasPending: vi.fn(),
        isResolvedByUser: vi.fn().mockReturnValue(true),
        resolveReview: vi.fn(),
      } as any,
      commandService: {
        clearHistory: vi.fn(), status: vi.fn(), listReminders: vi.fn(), listMemory: vi.fn(),
        listPermissionRules: vi.fn().mockReturnValue([]),
        revokePermissionRule: vi.fn(),
      } as any,
    });

    const msg = {
      author: { bot: false, id: '123' },
      channel,
      content: 'do work',
    };
    client.emit('messageCreate', msg as any);
    // Wait longer than the 800ms cooldown so trailing edit lands.
    await delay(1100);

    // Collect description strings from edit calls.
    const progressDescs = editMock.mock.calls
      .map((c: any[]) => {
        const e = c[0]?.embeds?.[0]?.toJSON?.() ?? c[0]?.embeds?.[0];
        return e?.description;
      })
      .filter((d: any) => typeof d === 'string');

    // Three rapid progress events should NOT yield three progress edits.
    const countForMsg = (m: string) => progressDescs.filter((d: string) => d === m).length;
    expect(countForMsg('a') + countForMsg('b') + countForMsg('c')).toBeLessThanOrEqual(2);
    // The latest progress ("c") should have landed on the trailing edit.
    expect(progressDescs).toContain('c');
  });
});

describe('tool_call_result handling', () => {
  it('done result: edits embed to done state', async () => {
    const editMock = vi.fn().mockResolvedValue(undefined);
    const runChatRequest = vi.fn<any>(async ({ onEvent }: any) => {
      onEvent({
        type: 'tool_call_start',
        toolCall: { id: 'c-1', name: 'file_write', input: { path: '/tmp/x' }, status: 'running' },
      } as SSEEvent);
      onEvent({
        type: 'tool_call_result',
        id: 'c-1',
        result: { success: true, display: { type: 'text', content: 'wrote 42 bytes' } },
      } as SSEEvent);
      onEvent({ type: 'done' } as SSEEvent);
    });

    const channel = makeDmChannel();
    (channel.send as any).mockResolvedValue({ id: 'sent-1', edit: editMock });
    (channel as any).messages = { fetch: vi.fn().mockResolvedValue({ edit: editMock }) };

    const { client } = await setup({
      runChatRequest: runChatRequest as any,
      permissionService: {
        hasPending: vi.fn(),
        isResolvedByUser: vi.fn().mockReturnValue(true),
        resolveConfirm: vi.fn(),
      } as any,
      reminderService: { dismiss: vi.fn(), snooze: vi.fn(), list: vi.fn() } as any,
      planReviewService: {
        hasPending: vi.fn(),
        isResolvedByUser: vi.fn().mockReturnValue(true),
        resolveReview: vi.fn(),
      } as any,
      commandService: {
        clearHistory: vi.fn(), status: vi.fn(), listReminders: vi.fn(), listMemory: vi.fn(),
        listPermissionRules: vi.fn().mockReturnValue([]),
        revokePermissionRule: vi.fn(),
      } as any,
    });

    const msg = {
      author: { bot: false, id: '123' },
      channel,
      content: 'do work',
    };
    client.emit('messageCreate', msg as any);
    await delay(100);

    expect(editMock).toHaveBeenCalled();
    const lastCall = editMock.mock.calls[editMock.mock.calls.length - 1];
    const lastEmbed = lastCall[0].embeds[0].toJSON();
    expect(lastEmbed.title).toBe('✅ file_write');
  });

  it('error result: edits embed to error state', async () => {
    const editMock = vi.fn().mockResolvedValue(undefined);
    const runChatRequest = vi.fn<any>(async ({ onEvent }: any) => {
      onEvent({
        type: 'tool_call_start',
        toolCall: { id: 'c-err', name: 'file_write', input: {}, status: 'running' },
      } as SSEEvent);
      onEvent({
        type: 'tool_call_result',
        id: 'c-err',
        result: { success: false, error: 'permission denied' },
      } as SSEEvent);
      onEvent({ type: 'done' } as SSEEvent);
    });

    const channel = makeDmChannel();
    (channel.send as any).mockResolvedValue({ id: 'sent-err', edit: editMock });
    (channel as any).messages = { fetch: vi.fn().mockResolvedValue({ edit: editMock }) };

    const { client } = await setup({
      runChatRequest: runChatRequest as any,
      permissionService: {
        hasPending: vi.fn(),
        isResolvedByUser: vi.fn().mockReturnValue(true),
        resolveConfirm: vi.fn(),
      } as any,
      reminderService: { dismiss: vi.fn(), snooze: vi.fn(), list: vi.fn() } as any,
      planReviewService: {
        hasPending: vi.fn(),
        isResolvedByUser: vi.fn().mockReturnValue(true),
        resolveReview: vi.fn(),
      } as any,
      commandService: {
        clearHistory: vi.fn(), status: vi.fn(), listReminders: vi.fn(), listMemory: vi.fn(),
        listPermissionRules: vi.fn().mockReturnValue([]),
        revokePermissionRule: vi.fn(),
      } as any,
    });

    const msg = {
      author: { bot: false, id: '123' },
      channel,
      content: 'do work',
    };
    client.emit('messageCreate', msg as any);
    await delay(100);

    const lastCall = editMock.mock.calls[editMock.mock.calls.length - 1];
    const lastEmbed = lastCall[0].embeds[0].toJSON();
    expect(lastEmbed.title).toBe('❌ file_write');
  });

  it('code_task with fullDiff: sends attachment follow-up', async () => {
    const editMock = vi.fn().mockResolvedValue(undefined);
    const runChatRequest = vi.fn<any>(async ({ onEvent }: any) => {
      onEvent({
        type: 'tool_call_start',
        toolCall: { id: 'c-1', name: 'code_task', input: { task: 't' }, status: 'running' },
      } as SSEEvent);
      onEvent({
        type: 'tool_call_result',
        id: 'c-1',
        result: {
          success: true,
          data: {
            commit: 'abcdef1234',
            files: [{ path: 'a.ts', added: 1, removed: 0 }],
            fullDiff: '--- a\n+++ b\n@@ @@\n-old\n+new\n',
          },
        },
      } as SSEEvent);
      onEvent({ type: 'done' } as SSEEvent);
    });

    const channel = makeDmChannel();
    (channel.send as any).mockResolvedValue({ id: 'sent-1', edit: editMock });
    (channel as any).messages = { fetch: vi.fn().mockResolvedValue({ edit: editMock }) };

    const { client } = await setup({
      runChatRequest: runChatRequest as any,
      permissionService: {
        hasPending: vi.fn(),
        isResolvedByUser: vi.fn().mockReturnValue(true),
        resolveConfirm: vi.fn(),
      } as any,
      reminderService: { dismiss: vi.fn(), snooze: vi.fn(), list: vi.fn() } as any,
      planReviewService: {
        hasPending: vi.fn(),
        isResolvedByUser: vi.fn().mockReturnValue(true),
        resolveReview: vi.fn(),
      } as any,
      commandService: {
        clearHistory: vi.fn(), status: vi.fn(), listReminders: vi.fn(), listMemory: vi.fn(),
        listPermissionRules: vi.fn().mockReturnValue([]),
        revokePermissionRule: vi.fn(),
      } as any,
    });

    const msg = {
      author: { bot: false, id: '123' },
      channel,
      content: 'refactor',
    };
    client.emit('messageCreate', msg as any);
    await delay(100);

    const fileCalls = (channel.send as any).mock.calls.filter(
      (c: any[]) => typeof c[0] === 'object' && c[0] !== null && 'files' in c[0],
    );
    expect(fileCalls.length).toBe(1);
    const attachment = fileCalls[0][0].files[0];
    expect(attachment.name).toBe('code_task_abcdef1.diff');
  });

  it('code_task without fullDiff: no attachment follow-up', async () => {
    const editMock = vi.fn().mockResolvedValue(undefined);
    const runChatRequest = vi.fn<any>(async ({ onEvent }: any) => {
      onEvent({
        type: 'tool_call_start',
        toolCall: { id: 'c-2', name: 'code_task', input: { task: 't' }, status: 'running' },
      } as SSEEvent);
      onEvent({
        type: 'tool_call_result',
        id: 'c-2',
        result: { success: true, data: { commit: 'deadbeef' } },
      } as SSEEvent);
      onEvent({ type: 'done' } as SSEEvent);
    });

    const channel = makeDmChannel();
    (channel.send as any).mockResolvedValue({ id: 'sent-2', edit: editMock });
    (channel as any).messages = { fetch: vi.fn().mockResolvedValue({ edit: editMock }) };

    const { client } = await setup({
      runChatRequest: runChatRequest as any,
      permissionService: {
        hasPending: vi.fn(),
        isResolvedByUser: vi.fn().mockReturnValue(true),
        resolveConfirm: vi.fn(),
      } as any,
      reminderService: { dismiss: vi.fn(), snooze: vi.fn(), list: vi.fn() } as any,
      planReviewService: {
        hasPending: vi.fn(),
        isResolvedByUser: vi.fn().mockReturnValue(true),
        resolveReview: vi.fn(),
      } as any,
      commandService: {
        clearHistory: vi.fn(), status: vi.fn(), listReminders: vi.fn(), listMemory: vi.fn(),
        listPermissionRules: vi.fn().mockReturnValue([]),
        revokePermissionRule: vi.fn(),
      } as any,
    });

    const msg = {
      author: { bot: false, id: '123' },
      channel,
      content: 'refactor',
    };
    client.emit('messageCreate', msg as any);
    await delay(100);

    const fileCalls = (channel.send as any).mock.calls.filter(
      (c: any[]) => typeof c[0] === 'object' && c[0] !== null && 'files' in c[0],
    );
    expect(fileCalls.length).toBe(0);
  });
});

describe('escalation prefix', () => {
  it('ollama → claude: prefix on first flush', async () => {
    const runChatRequest = vi.fn<any>(async ({ onEvent }: any) => {
      onEvent({ type: 'assistant_source', source: 'ollama' } as SSEEvent);
      onEvent({ type: 'text_delta', content: 'hi' } as SSEEvent);
      onEvent({ type: 'assistant_source', source: 'claude' } as SSEEvent);
      onEvent({ type: 'text_delta', content: ' world' } as SSEEvent);
      onEvent({ type: 'done' } as SSEEvent);
    });

    const { client } = await setup({
      runChatRequest: runChatRequest as any,
      permissionService: {
        hasPending: vi.fn(),
        isResolvedByUser: vi.fn().mockReturnValue(true),
        resolveConfirm: vi.fn(),
      } as any,
      reminderService: { dismiss: vi.fn(), snooze: vi.fn(), list: vi.fn() } as any,
      planReviewService: {
        hasPending: vi.fn(),
        isResolvedByUser: vi.fn().mockReturnValue(true),
        resolveReview: vi.fn(),
      } as any,
      commandService: {
        clearHistory: vi.fn(), status: vi.fn(), listReminders: vi.fn(), listMemory: vi.fn(),
        listPermissionRules: vi.fn().mockReturnValue([]),
        revokePermissionRule: vi.fn(),
      } as any,
    });
    const { msg, channel } = makeMessage({ author: { bot: false, id: '123' } });

    client.emit('messageCreate', msg as any);
    await delay(100);

    const textCalls = (channel.send as any).mock.calls
      .filter((c: any[]) => typeof c[0] === 'object' && c[0] !== null && 'content' in c[0]);
    expect(textCalls.length).toBe(1);
    expect(textCalls[0][0].content).toBe('🔵 claude\n\nhi world');
  });

  it('claude only (no prior ollama): no prefix', async () => {
    const runChatRequest = vi.fn<any>(async ({ onEvent }: any) => {
      onEvent({ type: 'assistant_source', source: 'claude' } as SSEEvent);
      onEvent({ type: 'text_delta', content: 'hello' } as SSEEvent);
      onEvent({ type: 'done' } as SSEEvent);
    });

    const { client } = await setup({
      runChatRequest: runChatRequest as any,
      permissionService: {
        hasPending: vi.fn(),
        isResolvedByUser: vi.fn().mockReturnValue(true),
        resolveConfirm: vi.fn(),
      } as any,
      reminderService: { dismiss: vi.fn(), snooze: vi.fn(), list: vi.fn() } as any,
      planReviewService: {
        hasPending: vi.fn(),
        isResolvedByUser: vi.fn().mockReturnValue(true),
        resolveReview: vi.fn(),
      } as any,
      commandService: {
        clearHistory: vi.fn(), status: vi.fn(), listReminders: vi.fn(), listMemory: vi.fn(),
        listPermissionRules: vi.fn().mockReturnValue([]),
        revokePermissionRule: vi.fn(),
      } as any,
    });
    const { msg, channel } = makeMessage({ author: { bot: false, id: '123' } });

    client.emit('messageCreate', msg as any);
    await delay(100);

    const textCalls = (channel.send as any).mock.calls
      .filter((c: any[]) => typeof c[0] === 'object' && c[0] !== null && 'content' in c[0]);
    expect(textCalls.length).toBe(1);
    expect(textCalls[0][0].content).toBe('hello');
  });
});

describe('cognition_publish handling', () => {
  it('emits cognition_publish on bus → DM is sent and markPublished called', async () => {
    const client = makeFakeClient();
    const bus = new EventEmitter();
    const dmSend = vi.fn().mockResolvedValue(undefined);
    const fetchUser = vi.fn().mockResolvedValue({ createDM: vi.fn().mockResolvedValue({ send: dmSend }) });
    (client as any).users = { fetch: fetchUser };
    const markPublished = vi.fn();

    const { stop } = await startDiscordBot({
      token: 'test', whitelist: new Set(['123']),
      runChatRequest: vi.fn(),
      db: makeFakeDb() as any, historyLimit: 10, saveMessage: vi.fn(),
      memoryService: null, _client: client,
      reminderBus: bus,
      reminderService: { dismiss: vi.fn(), snooze: vi.fn(), list: vi.fn() } as any,
      permissionService: { hasPending: vi.fn(), resolveConfirm: vi.fn() } as any,
      planReviewService: { hasPending: vi.fn(), resolveReview: vi.fn() } as any,
      commandService: {
        clearHistory: vi.fn(), status: vi.fn(), listReminders: vi.fn(), listMemory: vi.fn(),
        listPermissionRules: vi.fn().mockReturnValue([]), revokePermissionRule: vi.fn(),
      } as any,
      cognitionService: {
        register: vi.fn(), start: vi.fn(), stop: vi.fn(),
        pause: vi.fn(), resume: vi.fn(),
        status: vi.fn(), markPublished,
      } as any,
    });

    bus.emit('push', { type: 'cognition_publish', runId: 7, handler: 'pulse', content: 'hello' });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(dmSend).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('hello') }),
    );
    expect(markPublished).toHaveBeenCalledWith(7, expect.any(Number));
    await stop();
  });

  it('markPublished is called exactly once per run even with multiple whitelisted users', async () => {
    const client = makeFakeClient();
    const bus = new EventEmitter();
    const dmSend = vi.fn().mockResolvedValue(undefined);
    const fetchUser = vi.fn().mockImplementation(async () => ({
      createDM: vi.fn().mockResolvedValue({ send: dmSend }),
    }));
    (client as any).users = { fetch: fetchUser };
    const markPublished = vi.fn();

    const { stop } = await startDiscordBot({
      token: 'test', whitelist: new Set(['a', 'b', 'c']),
      runChatRequest: vi.fn(),
      db: makeFakeDb() as any, historyLimit: 10, saveMessage: vi.fn(),
      memoryService: null, _client: client,
      reminderBus: bus,
      reminderService: { dismiss: vi.fn(), snooze: vi.fn(), list: vi.fn() } as any,
      permissionService: { hasPending: vi.fn(), resolveConfirm: vi.fn() } as any,
      planReviewService: { hasPending: vi.fn(), resolveReview: vi.fn() } as any,
      commandService: {
        clearHistory: vi.fn(), status: vi.fn(), listReminders: vi.fn(), listMemory: vi.fn(),
        listPermissionRules: vi.fn().mockReturnValue([]), revokePermissionRule: vi.fn(),
      } as any,
      cognitionService: {
        register: vi.fn(), start: vi.fn(), stop: vi.fn(),
        pause: vi.fn(), resume: vi.fn(),
        status: vi.fn(), markPublished,
      } as any,
    });

    bus.emit('push', { type: 'cognition_publish', runId: 42, handler: 'h', content: 'x' });
    // 3 fetch → createDM → send → mark chains; flush enough microtasks.
    for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));

    expect(dmSend).toHaveBeenCalledTimes(3);
    expect(markPublished).toHaveBeenCalledTimes(1);
    expect(markPublished).toHaveBeenCalledWith(42, expect.any(Number));
    await stop();
  });

  it('cognition_publish with embed → DM sent as embeds/components, not plain text', async () => {
    const client = makeFakeClient();
    const bus = new EventEmitter();
    const dmSend = vi.fn().mockResolvedValue(undefined);
    const fetchUser = vi.fn().mockResolvedValue({ createDM: vi.fn().mockResolvedValue({ send: dmSend }) });
    (client as any).users = { fetch: fetchUser };
    const markPublished = vi.fn();

    const { stop } = await startDiscordBot({
      token: 'test', whitelist: new Set(['123']),
      runChatRequest: vi.fn(),
      db: makeFakeDb() as any, historyLimit: 10, saveMessage: vi.fn(),
      memoryService: null, _client: client,
      reminderBus: bus,
      reminderService: { dismiss: vi.fn(), snooze: vi.fn(), list: vi.fn() } as any,
      permissionService: { hasPending: vi.fn(), resolveConfirm: vi.fn() } as any,
      planReviewService: { hasPending: vi.fn(), resolveReview: vi.fn() } as any,
      commandService: {
        clearHistory: vi.fn(), status: vi.fn(), listReminders: vi.fn(), listMemory: vi.fn(),
        listPermissionRules: vi.fn().mockReturnValue([]), revokePermissionRule: vi.fn(),
      } as any,
      cognitionService: {
        register: vi.fn(), start: vi.fn(), stop: vi.fn(),
        pause: vi.fn(), resume: vi.fn(),
        status: vi.fn(), markPublished,
      } as any,
    });

    bus.emit('push', {
      type: 'cognition_publish',
      runId: 99,
      handler: 'emailUrgent',
      content: '🚨 fallback text',
      embed: {
        title: '🚨 Urgent email',
        fields: [
          { name: 'From', value: 'boss@acme.com' },
          { name: 'Subject', value: 'Server down' },
          { name: 'Snippet', value: 'Prod is on fire' },
        ],
      },
      components: [
        {
          type: 'row',
          buttons: [
            { customId: 'email_draft:start:42', label: 'Draft reply', style: 'primary' },
          ],
        },
      ],
    });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(dmSend).toHaveBeenCalledTimes(1);
    const arg = dmSend.mock.calls[0]![0];
    expect(typeof arg).toBe('object');
    expect(arg.embeds).toBeDefined();
    expect(arg.embeds).toHaveLength(1);
    expect(arg.embeds[0].toJSON().title).toBe('🚨 Urgent email');
    expect(arg.components).toBeDefined();
    expect(arg.components).toHaveLength(1);
    const buttonJson = arg.components[0].toJSON().components[0];
    expect(buttonJson.custom_id).toBe('email_draft:start:42');
    expect(buttonJson.label).toBe('Draft reply');
    expect(markPublished).toHaveBeenCalledWith(99, expect.any(Number));
    await stop();
  });

  it('cognition_publish with components but no embed → buttons still attached (distraction nudge)', async () => {
    const client = makeFakeClient();
    const bus = new EventEmitter();
    const dmSend = vi.fn().mockResolvedValue(undefined);
    const fetchUser = vi.fn().mockResolvedValue({ createDM: vi.fn().mockResolvedValue({ send: dmSend }) });
    (client as any).users = { fetch: fetchUser };
    const markPublished = vi.fn();

    const { stop } = await startDiscordBot({
      token: 'test', whitelist: new Set(['123']),
      runChatRequest: vi.fn(),
      db: makeFakeDb() as any, historyLimit: 10, saveMessage: vi.fn(),
      memoryService: null, _client: client,
      reminderBus: bus,
      reminderService: { dismiss: vi.fn(), snooze: vi.fn(), list: vi.fn() } as any,
      permissionService: { hasPending: vi.fn(), resolveConfirm: vi.fn() } as any,
      planReviewService: { hasPending: vi.fn(), resolveReview: vi.fn() } as any,
      commandService: {
        clearHistory: vi.fn(), status: vi.fn(), listReminders: vi.fn(), listMemory: vi.fn(),
        listPermissionRules: vi.fn().mockReturnValue([]), revokePermissionRule: vi.fn(),
      } as any,
      cognitionService: {
        register: vi.fn(), start: vi.fn(), stop: vi.fn(),
        pause: vi.fn(), resume: vi.fn(),
        status: vi.fn(), markPublished,
      } as any,
    });

    bus.emit('push', {
      type: 'cognition_publish',
      runId: 77,
      handler: 'distractionPullback',
      content: '🧲 Ты ~25 мин в YouTube. Вернёшься?',
      components: [
        {
          type: 'row',
          buttons: [
            { customId: 'distract:back:1700000000', label: 'Возвращаюсь', style: 'success' },
            { customId: 'distract:work:YouTube:1700000000', label: 'Это по работе', style: 'secondary' },
            { customId: 'distract:snooze:YouTube:1700000000', label: 'Отстань на 60м', style: 'danger' },
          ],
        },
      ],
    });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(dmSend).toHaveBeenCalledTimes(1);
    const arg = dmSend.mock.calls[0]![0];
    expect(typeof arg).toBe('object');
    expect(arg.content).toContain('Вернёшься?');
    expect(arg.components).toBeDefined();
    expect(arg.components).toHaveLength(1);
    const buttons = arg.components[0].toJSON().components;
    expect(buttons).toHaveLength(3);
    expect(buttons[0].custom_id).toBe('distract:back:1700000000');
    expect(buttons[2].custom_id).toBe('distract:snooze:YouTube:1700000000');
    expect(markPublished).toHaveBeenCalledWith(77, expect.any(Number));
    await stop();
  });

  it('cognition_publish with components AND >2000-char content → splits body, buttons ride the final chunk', async () => {
    const client = makeFakeClient();
    const bus = new EventEmitter();
    const dmSend = vi.fn().mockResolvedValue(undefined);
    const fetchUser = vi.fn().mockResolvedValue({ createDM: vi.fn().mockResolvedValue({ send: dmSend }) });
    (client as any).users = { fetch: fetchUser };
    const markPublished = vi.fn();

    const { stop } = await startDiscordBot({
      token: 'test', whitelist: new Set(['123']),
      runChatRequest: vi.fn(),
      db: makeFakeDb() as any, historyLimit: 10, saveMessage: vi.fn(),
      memoryService: null, _client: client,
      reminderBus: bus,
      reminderService: { dismiss: vi.fn(), snooze: vi.fn(), list: vi.fn() } as any,
      permissionService: { hasPending: vi.fn(), resolveConfirm: vi.fn() } as any,
      planReviewService: { hasPending: vi.fn(), resolveReview: vi.fn() } as any,
      commandService: {
        clearHistory: vi.fn(), status: vi.fn(), listReminders: vi.fn(), listMemory: vi.fn(),
        listPermissionRules: vi.fn().mockReturnValue([]), revokePermissionRule: vi.fn(),
      } as any,
      cognitionService: {
        register: vi.fn(), start: vi.fn(), stop: vi.fn(),
        pause: vi.fn(), resume: vi.fn(),
        status: vi.fn(), markPublished,
      } as any,
    });

    // A morning-brief-sized body well over Discord's 2000-char limit.
    const longBody = 'слово '.repeat(700).trim(); // ~4200 chars
    bus.emit('push', {
      type: 'cognition_publish',
      runId: 88,
      handler: 'morningBrief',
      content: longBody,
      components: [
        {
          type: 'row',
          buttons: [{ customId: 'followup:done:42', label: '✓ Готово: оплатить счёт', style: 'success' }],
        },
      ],
    });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // More than one message → the body was split (an unsplit send would throw 50035).
    expect(dmSend.mock.calls.length).toBeGreaterThan(1);
    for (const call of dmSend.mock.calls) {
      expect((call[0].content as string).length).toBeLessThanOrEqual(2000);
    }
    // Every chunk before the last carries no components.
    for (const call of dmSend.mock.calls.slice(0, -1)) {
      expect(call[0].components).toBeUndefined();
    }
    // The final message carries the "✓ Готово" button.
    const lastArg = dmSend.mock.calls.at(-1)![0];
    expect(lastArg.components).toHaveLength(1);
    const buttons = lastArg.components[0].toJSON().components;
    expect(buttons[0].custom_id).toBe('followup:done:42');
    // Delivery succeeded → run marked published exactly once.
    expect(markPublished).toHaveBeenCalledWith(88, expect.any(Number));
    await stop();
  });
});

describe('cognition redelivery on (re)connect', () => {
  // A real store (in-memory db) so the publish_payload round-trip and the
  // published_at / fired_at filtering are exercised end-to-end, behind a
  // service shim whose markPublished is a spy that also mutates the store
  // (real idempotency).
  function makeService(store: CognitionStore) {
    const markPublished = vi.fn((runId: number, at: number) => store.markPublished(runId, at));
    const findUndeliveredPublishes = vi.fn((sinceMs: number) => store.findUndeliveredPublishes(sinceMs));
    const svc = {
      register: vi.fn(), start: vi.fn(), stop: vi.fn(),
      pause: vi.fn(), resume: vi.fn(), status: vi.fn(),
      markPublished, findUndeliveredPublishes,
    } as any;
    return { svc, markPublished, findUndeliveredPublishes };
  }

  function makeClientWithDM(dmSend = vi.fn().mockResolvedValue(undefined)) {
    const client = makeFakeClient();
    const fetchUser = vi.fn().mockResolvedValue({ createDM: vi.fn().mockResolvedValue({ send: dmSend }) });
    (client as any).users = { fetch: fetchUser };
    return { client, dmSend, fetchUser };
  }

  async function start(client: Client, svc: any, redeliverMaxAgeMs?: number) {
    return startDiscordBot({
      token: 'test', whitelist: new Set(['123']),
      runChatRequest: vi.fn(),
      db: makeFakeDb() as any, historyLimit: 10, saveMessage: vi.fn(),
      memoryService: null, _client: client,
      reminderBus: new EventEmitter(),
      cognitionService: svc,
      redeliverMaxAgeMs,
    });
  }

  function recordPublish(store: CognitionStore, firedAt: number, content = 'lost brief') {
    return store.recordHandlerRun({
      handlerName: 'morningBrief', firedAt, durationMs: 5,
      result: { publish: true, content },
    });
  }

  it('re-delivers a recent undelivered run on shardReady and marks it published', async () => {
    initDb(':memory:');
    const store = createCognitionStore({ db: getDb() });
    const runId = recordPublish(store, Date.now() - 60_000); // 1 min ago
    const { svc, markPublished } = makeService(store);
    const { client, dmSend } = makeClientWithDM();

    const { stop } = await start(client, svc);
    (client as any).emit('shardReady');
    for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));

    expect(dmSend).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('lost brief') }),
    );
    expect(markPublished).toHaveBeenCalledWith(runId, expect.any(Number));
    // published_at is now set → no longer eligible.
    expect(store.findUndeliveredPublishes(0)).toHaveLength(0);
    await stop();
  });

  it('re-delivers an undelivered embed run with components on shardResume', async () => {
    initDb(':memory:');
    const store = createCognitionStore({ db: getDb() });
    const runId = store.recordHandlerRun({
      handlerName: 'emailDigest', firedAt: Date.now() - 30_000, durationMs: 5,
      result: {
        publish: true,
        content: 'fallback',
        embed: { title: '📬 3 emails', fields: [{ name: 'From', value: 'a@b.com' }] },
        components: [{ type: 'row', buttons: [{ customId: 'x:1', label: 'Open', style: 'primary' }] }],
      },
    });
    const { svc, markPublished } = makeService(store);
    const { client, dmSend } = makeClientWithDM();

    const { stop } = await start(client, svc);
    (client as any).emit('shardResume');
    for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));

    expect(dmSend).toHaveBeenCalledTimes(1);
    const arg = dmSend.mock.calls[0]![0];
    expect(arg.embeds).toHaveLength(1);
    expect(arg.embeds[0].toJSON().title).toBe('📬 3 emails');
    expect(arg.components).toHaveLength(1);
    expect(markPublished).toHaveBeenCalledWith(runId, expect.any(Number));
    await stop();
  });

  it('re-delivers on clientReady (cold restart after an outage)', async () => {
    // The restart-after-outage case from the originating incident: no in-process
    // reconnect, the process boots fresh and clientReady (post DM pre-cache) is
    // the path that re-delivers. shardReady fires before isReady() on a cold
    // start, so this hook — not shardReady — is what actually delivers.
    initDb(':memory:');
    const store = createCognitionStore({ db: getDb() });
    const runId = recordPublish(store, Date.now() - 60_000);
    const { svc, markPublished } = makeService(store);
    const { client, dmSend } = makeClientWithDM();

    const { stop } = await start(client, svc);
    (client as any).emit('clientReady');
    for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));

    expect(dmSend).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('lost brief') }),
    );
    expect(markPublished).toHaveBeenCalledWith(runId, expect.any(Number));
    expect(store.findUndeliveredPublishes(0)).toHaveLength(0);
    await stop();
  });

  it('marks published once when one recipient fails and another succeeds', async () => {
    // marked flips only on the first *successful* send, so a partial failure
    // still re-delivers to the reachable recipient and marks the run once.
    initDb(':memory:');
    const store = createCognitionStore({ db: getDb() });
    const runId = recordPublish(store, Date.now() - 60_000);
    const markPublished = vi.fn((id: number, at: number) => store.markPublished(id, at));
    const findUndeliveredPublishes = vi.fn((sinceMs: number) => store.findUndeliveredPublishes(sinceMs));
    const svc = {
      register: vi.fn(), start: vi.fn(), stop: vi.fn(),
      pause: vi.fn(), resume: vi.fn(), status: vi.fn(),
      markPublished, findUndeliveredPublishes,
    } as any;

    const okSend = vi.fn().mockResolvedValue(undefined);
    const client = makeFakeClient();
    const fetchUser = vi.fn().mockImplementation(async (userId: string) => {
      if (userId === 'bad') throw new Error('getaddrinfo ENOTFOUND discord.com');
      return { createDM: vi.fn().mockResolvedValue({ send: okSend }) };
    });
    (client as any).users = { fetch: fetchUser };
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { stop } = await startDiscordBot({
      token: 'test', whitelist: new Set(['bad', 'good']),
      runChatRequest: vi.fn(),
      db: makeFakeDb() as any, historyLimit: 10, saveMessage: vi.fn(),
      memoryService: null, _client: client,
      reminderBus: new EventEmitter(),
      cognitionService: svc,
    });
    (client as any).emit('shardReady');
    for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));

    expect(okSend).toHaveBeenCalledTimes(1); // only the reachable recipient
    expect(markPublished).toHaveBeenCalledTimes(1);
    expect(markPublished).toHaveBeenCalledWith(runId, expect.any(Number));
    expect(errSpy).toHaveBeenCalled(); // the failed recipient is logged, not silent
    expect(store.findUndeliveredPublishes(0)).toHaveLength(0);
    errSpy.mockRestore();
    await stop();
  });

  it('does NOT deliver a stale run (older than the freshness window)', async () => {
    initDb(':memory:');
    const store = createCognitionStore({ db: getDb() });
    recordPublish(store, Date.now() - 7 * 60 * 60 * 1000); // 7h ago, default window 6h
    const { svc, markPublished } = makeService(store);
    const { client, dmSend } = makeClientWithDM();

    const { stop } = await start(client, svc);
    (client as any).emit('shardReady');
    for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));

    expect(dmSend).not.toHaveBeenCalled();
    expect(markPublished).not.toHaveBeenCalled();
    await stop();
  });

  it('skips an already-published run', async () => {
    initDb(':memory:');
    const store = createCognitionStore({ db: getDb() });
    const runId = recordPublish(store, Date.now() - 60_000);
    store.markPublished(runId, Date.now() - 50_000); // already delivered
    const { svc, markPublished } = makeService(store);
    const { client, dmSend } = makeClientWithDM();

    const { stop } = await start(client, svc);
    (client as any).emit('shardReady');
    for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));

    expect(dmSend).not.toHaveBeenCalled();
    expect(markPublished).not.toHaveBeenCalled();
    await stop();
  });

  it('leaves the run unpublished when re-send throws (eligible next reconnect, no crash)', async () => {
    initDb(':memory:');
    const store = createCognitionStore({ db: getDb() });
    const runId = recordPublish(store, Date.now() - 60_000);
    const { svc, markPublished } = makeService(store);
    const dmSend = vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND discord.com'));
    const { client } = makeClientWithDM(dmSend);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { stop } = await start(client, svc);
    (client as any).emit('shardReady');
    for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));

    expect(markPublished).not.toHaveBeenCalled();
    // The rejection is swallowed (logged, not rethrown) — guards against a
    // refactor that drops the per-chain .catch and leaks an unhandled rejection.
    expect(errSpy).toHaveBeenCalled();
    // Still eligible — a later reconnect can retry it.
    const remaining = store.findUndeliveredPublishes(0);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.runId).toBe(runId);
    errSpy.mockRestore();
    await stop();
  });

  it('does not double-flush when overlapping shard events fire (in-flight guard)', async () => {
    initDb(':memory:');
    const store = createCognitionStore({ db: getDb() });
    recordPublish(store, Date.now() - 60_000);
    const { svc, markPublished } = makeService(store);
    const { client, dmSend } = makeClientWithDM();

    const { stop } = await start(client, svc);
    // Two reconnect events back-to-back in the same tick.
    (client as any).emit('shardReady');
    (client as any).emit('shardResume');
    for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));

    expect(dmSend).toHaveBeenCalledTimes(1);
    expect(markPublished).toHaveBeenCalledTimes(1);
    await stop();
  });

  it('live cognition_publish path still delivers via the shared helper (regression)', async () => {
    initDb(':memory:');
    const store = createCognitionStore({ db: getDb() });
    const { svc, markPublished } = makeService(store);
    const { client, dmSend } = makeClientWithDM();
    const bus = new EventEmitter();

    const { stop } = await startDiscordBot({
      token: 'test', whitelist: new Set(['123']),
      runChatRequest: vi.fn(),
      db: makeFakeDb() as any, historyLimit: 10, saveMessage: vi.fn(),
      memoryService: null, _client: client,
      reminderBus: bus,
      cognitionService: svc,
    });

    bus.emit('push', { type: 'cognition_publish', runId: 5, handler: 'pulse', content: 'hi there' });
    for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));

    expect(dmSend).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('hi there') }),
    );
    expect(markPublished).toHaveBeenCalledWith(5, expect.any(Number));
    await stop();
  });

  it('queries with the configured freshness window (fired_at >= now - redeliverMaxAgeMs)', async () => {
    initDb(':memory:');
    const store = createCognitionStore({ db: getDb() });
    const { svc, findUndeliveredPublishes } = makeService(store);
    const { client } = makeClientWithDM();

    const { stop } = await start(client, svc, 60 * 60 * 1000); // 1h window
    const before = Date.now();
    (client as any).emit('shardReady');
    for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));

    expect(findUndeliveredPublishes).toHaveBeenCalledTimes(1);
    const sinceMs = findUndeliveredPublishes.mock.calls[0]![0];
    // ~ now - 1h, allowing a little slack for test execution time.
    expect(sinceMs).toBeGreaterThanOrEqual(before - 60 * 60 * 1000 - 5_000);
    expect(sinceMs).toBeLessThanOrEqual(before - 60 * 60 * 1000 + 5_000);
    await stop();
  });
});

describe('multi-turn coalescing', () => {
  async function flushMicrotasks(rounds = 8) {
    for (let i = 0; i < rounds; i++) {
      await Promise.resolve();
    }
  }

  function makeBurstMessage(content: string, channel: ReturnType<typeof makeDmChannel>) {
    return {
      author: { bot: false, id: '123' },
      channel,
      content,
    } as any;
  }

  it('three messages within the window collapse to one LLM call, three user saves', async () => {
    vi.useFakeTimers();
    try {
      const runChatRequest = vi.fn<any>().mockResolvedValue(undefined);
      const { client, saveMessage, db } = await setup({
        runChatRequest: runChatRequest as any,
        coalesceMs: 1500,
      });

      const channel = makeDmChannel();
      client.emit('messageCreate', makeBurstMessage('изменить user.nickname', channel));
      await vi.advanceTimersByTimeAsync(500);
      client.emit('messageCreate', makeBurstMessage('name', channel));
      await vi.advanceTimersByTimeAsync(500);
      client.emit('messageCreate', makeBurstMessage('изменить', channel));
      // Burst is over; advance past the full window from the last message.
      await vi.advanceTimersByTimeAsync(1500);
      await flushMicrotasks();

      expect(runChatRequest).toHaveBeenCalledTimes(1);
      // Three user rows saved on ingest (the runChatRequest mock emits no
      // `done` event, so no assistant save is appended).
      const userSaves = saveMessage.mock.calls.filter(
        (c: any[]) => (c[0] as { role: string }).role === 'user',
      );
      expect(userSaves).toHaveLength(3);
      const userContents = userSaves.map((c: any[]) => (c[0] as { content: string }).content);
      expect(userContents).toEqual(['изменить user.nickname', 'name', 'изменить']);

      const messages = (runChatRequest.mock.calls[0]![0] as {
        messages: Array<{ role: string; content: string }>;
      }).messages;
      const lastTurn = messages[messages.length - 1]!;
      expect(lastTurn.role).toBe('user');
      // All three burst messages must appear collapsed into one user turn.
      expect(lastTurn.content).toContain('изменить user.nickname');
      expect(lastTurn.content).toContain('name');
      expect(lastTurn.content).toContain('изменить');

      // Internal DB-backed rows should carry only the burst (no duplicates).
      expect((db as any)._rows.filter((r: { role: string }) => r.role === 'user')).toHaveLength(3);

      // currentUserMessageId must point at the LAST burst save — otherwise
      // memory_forget_last / indexTurn would anchor to the wrong message.
      const lastUserSave = userSaves[userSaves.length - 1][0] as { messageId: string; timestamp: number };
      const chatCall = runChatRequest.mock.calls[0]![0] as {
        currentUserMessageId: string;
        currentUserMessageTimestamp: number;
      };
      expect(chatCall.currentUserMessageId).toBe(lastUserSave.messageId);
      expect(chatCall.currentUserMessageTimestamp).toBe(lastUserSave.timestamp);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stop() drops pending timers so no LLM call fires after shutdown', async () => {
    vi.useFakeTimers();
    try {
      const runChatRequest = vi.fn<any>().mockResolvedValue(undefined);
      const { client, bot } = await setup({
        runChatRequest: runChatRequest as any,
        coalesceMs: 1500,
      });

      const channel = makeDmChannel();
      client.emit('messageCreate', makeBurstMessage('hello', channel));
      await vi.advanceTimersByTimeAsync(500);

      // Shutdown mid-burst. Pending timer must be cancelled.
      await bot.stop();

      await vi.advanceTimersByTimeAsync(5000);
      await flushMicrotasks();

      expect(runChatRequest).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('saveMessage failure on ingest sends an error DM and arms no timer', async () => {
    vi.useFakeTimers();
    try {
      const runChatRequest = vi.fn<any>().mockResolvedValue(undefined);
      const saveMessage = vi.fn(() => {
        throw new Error('db busy');
      });
      const { client } = await setup({
        runChatRequest: runChatRequest as any,
        saveMessage: saveMessage as any,
        coalesceMs: 1500,
      });

      const channel = makeDmChannel();
      client.emit('messageCreate', makeBurstMessage('hello', channel));
      await vi.advanceTimersByTimeAsync(5000);
      await flushMicrotasks();

      expect(runChatRequest).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('Something went wrong') }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('gap longer than the window starts a new burst → two LLM calls', async () => {
    vi.useFakeTimers();
    try {
      const runChatRequest = vi.fn<any>().mockResolvedValue(undefined);
      const { client } = await setup({
        runChatRequest: runChatRequest as any,
        coalesceMs: 1500,
      });

      const channel = makeDmChannel();
      client.emit('messageCreate', makeBurstMessage('first', channel));
      // 2s gap — past the 1.5s window, so firePending fires for `first`.
      await vi.advanceTimersByTimeAsync(2000);
      await flushMicrotasks();

      client.emit('messageCreate', makeBurstMessage('second', channel));
      await vi.advanceTimersByTimeAsync(2000);
      await flushMicrotasks();

      expect(runChatRequest).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('single message works as before — one LLM call after the debounce window', async () => {
    vi.useFakeTimers();
    try {
      const runChatRequest = vi.fn<any>().mockResolvedValue(undefined);
      const { client } = await setup({
        runChatRequest: runChatRequest as any,
        coalesceMs: 1500,
      });

      const channel = makeDmChannel();
      client.emit('messageCreate', makeBurstMessage('hello', channel));
      // Before the window elapses no LLM call should have been placed.
      await vi.advanceTimersByTimeAsync(1000);
      await flushMicrotasks();
      expect(runChatRequest).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(500);
      await flushMicrotasks();
      expect(runChatRequest).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('DISCORD_COALESCE_MS env var overrides the default window', async () => {
    vi.useFakeTimers();
    const saved = process.env.DISCORD_COALESCE_MS;
    process.env.DISCORD_COALESCE_MS = '500';
    try {
      const runChatRequest = vi.fn<any>().mockResolvedValue(undefined);
      // Explicitly omit coalesceMs override — the env path should win.
      const { client } = await setup({
        runChatRequest: runChatRequest as any,
        coalesceMs: undefined,
      });

      const channel = makeDmChannel();
      client.emit('messageCreate', makeBurstMessage('hello', channel));
      await vi.advanceTimersByTimeAsync(400);
      await flushMicrotasks();
      expect(runChatRequest).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(200);
      await flushMicrotasks();
      expect(runChatRequest).toHaveBeenCalledTimes(1);
    } finally {
      if (saved === undefined) delete process.env.DISCORD_COALESCE_MS;
      else process.env.DISCORD_COALESCE_MS = saved;
      vi.useRealTimers();
    }
  });

  it('assistant save timestamp anchors to last burst msg, not wall-clock', async () => {
    vi.useFakeTimers();
    try {
      const runChatRequest = vi.fn<any>().mockImplementation(async (args: any) => {
        args.onEvent({ type: 'text_delta', content: 'ok' });
        args.onEvent({ type: 'done' });
      });
      const { client, saveMessage } = await setup({
        runChatRequest: runChatRequest as any,
        coalesceMs: 1500,
      });

      const channel = makeDmChannel();
      client.emit('messageCreate', makeBurstMessage('a', channel));
      await vi.advanceTimersByTimeAsync(200);
      client.emit('messageCreate', makeBurstMessage('b', channel));
      await vi.advanceTimersByTimeAsync(1500);
      await flushMicrotasks(16);

      const userSaves = saveMessage.mock.calls.filter(
        (c: any[]) => (c[0] as { role: string }).role === 'user',
      );
      const assistantSaves = saveMessage.mock.calls.filter(
        (c: any[]) => (c[0] as { role: string }).role === 'assistant',
      );
      expect(userSaves).toHaveLength(2);
      expect(assistantSaves).toHaveLength(1);

      const lastUserTs = (userSaves[userSaves.length - 1][0] as { timestamp: number }).timestamp;
      const assistantTs = (assistantSaves[0][0] as { timestamp: number }).timestamp;
      // Without this anchor, a new burst arriving during the LLM call would be
      // saved with Date.now() BEFORE the assistant row and corrupt multi-turn
      // history for the next handleMessage.
      expect(assistantTs).toBe(lastUserTs + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('trailing assistant rows from reminders/web chat do not leave the LLM without a user turn', async () => {
    vi.useFakeTimers();
    try {
      // Simulate an external writer (reminder or web chat) persisting an
      // assistant row into chat_messages between the Discord burst ingest
      // and the debounce fire.
      const db = makeFakeDb();
      let assistantInjected = false;
      const saveMsgFn = vi.fn((params: { role: string; content: string }) => {
        const internal = (db as any)._rows;
        if (Array.isArray(internal)) {
          internal.unshift({ role: params.role, content: params.content });
          // Right after the first user ingest, pretend a reminder fired and
          // appended an assistant row with a newer timestamp.
          if (!assistantInjected && params.role === 'user') {
            assistantInjected = true;
            internal.unshift({ role: 'assistant', content: '⏰ reminder ring' });
          }
        }
      });

      const runChatRequest = vi.fn<any>().mockResolvedValue(undefined);
      const { client } = await setup({
        runChatRequest: runChatRequest as any,
        saveMessage: saveMsgFn as any,
        db: db as any,
        coalesceMs: 1500,
      });

      const channel = makeDmChannel();
      client.emit('messageCreate', makeBurstMessage('hello', channel));
      await vi.advanceTimersByTimeAsync(1500);
      await flushMicrotasks();

      expect(runChatRequest).toHaveBeenCalledTimes(1);
      const messages = (runChatRequest.mock.calls[0]![0] as {
        messages: Array<{ role: string; content: string }>;
      }).messages;
      // Critical: despite the injected trailing assistant row, the final
      // turn must be the user burst so Anthropic sees a fresh user prompt.
      expect(messages[messages.length - 1]!.role).toBe('user');
      expect(messages[messages.length - 1]!.content).toContain('hello');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('sendReply', () => {
  it('sends short text in one message with allowedMentions blocked', async () => {
    const ch = makeDmChannel();
    await sendReply(ch as any, 'short message');
    expect(ch.send).toHaveBeenCalledTimes(1);
    expect(ch.send).toHaveBeenCalledWith({
      content: 'short message',
      allowedMentions: { parse: [] },
    });
  });

  it('splits text longer than 2000 into multiple sends', async () => {
    const ch = makeDmChannel();
    const text = 'x'.repeat(4500);
    await sendReply(ch as any, text);
    expect(ch.send.mock.calls.length).toBeGreaterThanOrEqual(3);
    for (const call of ch.send.mock.calls) {
      expect(call[0].content.length).toBeLessThanOrEqual(2000);
      expect(call[0].allowedMentions).toEqual({ parse: [] });
    }
    const joined = ch.send.mock.calls.map((c: any) => c[0].content).join('');
    expect(joined).toBe(text);
  });
});
