import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { ChannelType, Client } from 'discord.js';
import type { SSEEvent } from '@r2/shared';
import { startDiscordBot, sendReply, isRetryableError, type DiscordBotDeps } from '../bot.js';

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
  return {
    prepare: vi.fn().mockReturnValue({
      all: vi.fn().mockReturnValue([...rows]),
    }),
  };
}

async function setup(overrides: Partial<DiscordBotDeps> = {}) {
  const client = overrides._client ?? makeFakeClient();
  const runChatRequest = overrides.runChatRequest ?? vi.fn<any>().mockResolvedValue(undefined);
  const db = overrides.db ?? makeFakeDb();
  const saveMsgFn = overrides.saveMessage ?? vi.fn();

  const deps: DiscordBotDeps = {
    token: 'test-token',
    whitelist: new Set(['123']),
    runChatRequest: runChatRequest as any,
    db: db as any,
    historyLimit: 50,
    saveMessage: saveMsgFn as any,
    memoryService: null,
    _client: client as Client,
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

    expect(channel.send).toHaveBeenCalledWith('hello world');
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
      expect((call[0] as string).length).toBeLessThanOrEqual(2000);
    }

    const concatenated = channel.send.mock.calls.map((c: any) => c[0]).join(' ');
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

    expect(channel.send).toHaveBeenCalledWith('⚠️ Something went wrong. Please try again later.');
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
    expect(channel.send).toHaveBeenCalledWith('ok');
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
    expect(channel.send).toHaveBeenCalledWith('⚠️ Something went wrong. Please try again later.');
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
    const textsSent = calls
      .map((c: any[]) => (typeof c[0] === 'string' ? c[0] : ''))
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
      .map((c: any[]) => (typeof c[0] === 'string' ? c[0] : ''))
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
      .filter((c: any[]) => typeof c[0] === 'string');
    expect(textCalls.length).toBe(1);
    expect(textCalls[0][0]).toBe('🔵 claude\n\nhi world');
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
      .filter((c: any[]) => typeof c[0] === 'string');
    expect(textCalls.length).toBe(1);
    expect(textCalls[0][0]).toBe('hello');
  });
});

describe('sendReply', () => {
  it('sends short text in one message', async () => {
    const ch = makeDmChannel();
    await sendReply(ch as any, 'short message');
    expect(ch.send).toHaveBeenCalledTimes(1);
    expect(ch.send).toHaveBeenCalledWith('short message');
  });

  it('splits text longer than 2000 into multiple sends', async () => {
    const ch = makeDmChannel();
    const text = 'x'.repeat(4500);
    await sendReply(ch as any, text);
    expect(ch.send.mock.calls.length).toBeGreaterThanOrEqual(3);
    for (const call of ch.send.mock.calls) {
      expect((call[0] as string).length).toBeLessThanOrEqual(2000);
    }
    const joined = ch.send.mock.calls.map((c: any) => c[0]).join('');
    expect(joined).toBe(text);
  });
});
