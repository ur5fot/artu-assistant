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
  return {
    type: ChannelType.DM,
    send: vi.fn().mockResolvedValue(undefined),
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

  it('does not send on reminder_done (handled via embed edit in later task)', async () => {
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
        resolveConfirm: vi.fn(),
      } as any,
      reminderService: {
        dismiss: vi.fn(),
        snooze: vi.fn(),
        list: vi.fn(),
      } as any,
      planReviewService: {
        hasPending: vi.fn(),
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
        resolveConfirm: vi.fn(),
      } as any,
      reminderService: {
        dismiss: vi.fn(),
        snooze: vi.fn(),
        list: vi.fn(),
      } as any,
      planReviewService: {
        hasPending: vi.fn(),
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
        resolveConfirm: vi.fn(),
      } as any,
      planReviewService: {
        hasPending: vi.fn(),
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
