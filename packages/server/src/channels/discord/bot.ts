import {
  Client,
  GatewayIntentBits,
  Partials,
  ChannelType,
  type Message,
  type DMChannel,
} from 'discord.js';
import crypto from 'node:crypto';
import type { SSEEvent } from '@r2/shared';
import type Database from 'better-sqlite3';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';
import type { MemoryService } from '../../memory/service.js';

export interface DiscordBotDeps {
  token: string;
  whitelist: Set<string>;
  runChatRequest: (params: {
    messages: MessageParam[];
    onEvent: (event: SSEEvent) => void;
    signal?: AbortSignal;
  }) => Promise<void>;
  db: Database.Database;
  historyLimit: number;
  saveMessage: (params: {
    messageId: string;
    role: 'user' | 'assistant';
    content: string;
    timestamp: number;
    source: string;
  }) => void;
  memoryService: MemoryService | null;
  /** Request timeout in ms (default 120_000). Prevents hangs when
   *  confirm/plan-review tools fire with no UI to resolve them. */
  requestTimeoutMs?: number;
  /** Override the Client instance (testing only). */
  _client?: Client;
}

export async function sendReply(channel: DMChannel, text: string): Promise<void> {
  const MAX = 2000;
  if (text.length <= MAX) {
    await channel.send(text);
    return;
  }

  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX) {
      await channel.send(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf(' ', MAX);
    if (splitAt <= 0) splitAt = MAX;
    await channel.send(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
}

export async function startDiscordBot(
  deps: DiscordBotDeps,
): Promise<{ stop(): Promise<void> }> {
  const client =
    deps._client ??
    new Client({
      intents: [
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.Guilds,
      ],
      partials: [Partials.Channel, Partials.Message],
    });

  const timeoutMs = deps.requestTimeoutMs ?? 120_000;
  const userQueues = new Map<string, Promise<void>>();

  client.on('error', (err) => {
    console.error('[discord] client error:', err instanceof Error ? err.message : err);
  });

  client.on('messageCreate', async (msg: Message) => {
    if (msg.author.bot) return;
    if (msg.channel.type !== ChannelType.DM) return;
    if (!deps.whitelist.has(msg.author.id)) return;
    if (!msg.content.trim()) return;

    const userId = msg.author.id;
    const prev = userQueues.get(userId) ?? Promise.resolve();
    const safe = prev.then(() => handleMessage(msg)).catch(() => {});
    userQueues.set(userId, safe);
    safe.then(() => {
      if (userQueues.get(userId) === safe) {
        userQueues.delete(userId);
      }
    });
  });

  async function handleMessage(msg: Message): Promise<void> {
    let typingInterval: ReturnType<typeof setInterval> | undefined;
    let sendSucceeded = false;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const dmChannel = msg.channel as DMChannel;
      await dmChannel.sendTyping();
      typingInterval = setInterval(() => {
        dmChannel.sendTyping().catch(() => {});
      }, 8_000);

      const source = `discord:${msg.author.id}`;

      const rows = deps.db
        .prepare(
          'SELECT role, content FROM chat_messages WHERE source = ? ORDER BY timestamp DESC, id DESC LIMIT ?',
        )
        .all(source, deps.historyLimit) as Array<{
        role: string;
        content: string;
      }>;
      rows.reverse();
      while (rows.length > 0 && rows[0].role === 'assistant') rows.shift();

      const messages: MessageParam[] = rows.map((r) => ({
        role: r.role as 'user' | 'assistant',
        content: r.content,
      }));
      messages.push({ role: 'user', content: msg.content });

      deps.saveMessage({
        messageId: crypto.randomUUID(),
        role: 'user',
        content: msg.content,
        timestamp: Date.now(),
        source,
      });

      let buffer = '';
      let replyPromise: Promise<void> | null = null;

      await deps.runChatRequest({
        messages,
        signal: ac.signal,
        onEvent: (event: SSEEvent) => {
          if (event.type === 'text_delta') {
            buffer += event.content;
          } else if (event.type === 'done') {
            if (buffer) {
              replyPromise = sendReply(dmChannel, buffer)
                .then(() => { sendSucceeded = true; })
                .catch((err) => {
                  console.error('[discord] failed to send reply:', err);
                });
            }
          } else if (event.type === 'error') {
            console.error('[discord] chat error event:', event.message);
            dmChannel
              .send('⚠️ Something went wrong. Please try again later.')
              .catch((err) =>
                console.error('[discord] failed to send error:', err),
              );
          }
        },
      });

      clearInterval(typingInterval);
      clearTimeout(timer);

      await replyPromise;

      if (ac.signal.aborted && !sendSucceeded) {
        await sendReply(dmChannel, '⏱️ Request timed out. Please try again.');
      } else if (buffer && sendSucceeded) {
        deps.saveMessage({
          messageId: crypto.randomUUID(),
          role: 'assistant',
          content: buffer,
          timestamp: Date.now(),
          source,
        });

        if (deps.memoryService) {
          deps.memoryService
            .indexTurn({
              userMessage: msg.content,
              assistantMessage: buffer,
              timestamp: Date.now(),
            })
            .catch((err) =>
              console.warn('[discord] indexTurn failed:', err instanceof Error ? err.message : err),
            );
        }
      }
    } catch (err) {
      clearInterval(typingInterval);
      clearTimeout(timer);
      console.error(
        '[discord] messageCreate handler error:',
        err instanceof Error ? err.message : err,
      );
      if (!sendSucceeded) {
        try {
          const dmChannel = msg.channel as DMChannel;
          await dmChannel.send('⚠️ Something went wrong. Please try again later.');
        } catch {
          // ignore send failure
        }
      }
    }
  }

  await client.login(deps.token);

  return {
    stop: async () => {
      await client.destroy();
    },
  };
}
