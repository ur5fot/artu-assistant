import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { ChannelType, Client } from 'discord.js';
import type { SSEEvent } from '@r2/shared';
import { startDiscordBot, sendReply, type DiscordBotDeps } from '../bot.js';

function makeFakeClient() {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    login: vi.fn().mockResolvedValue('token'),
    destroy: vi.fn().mockResolvedValue(undefined),
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

  it('calls runChatRequest with source and loaded history for whitelisted DM', async () => {
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

    const call = runChatRequest.mock.calls[0]![0] as { source: string; messages: Array<{ role: string; content: string }> };
    expect(call.source).toBe('discord:123');
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
