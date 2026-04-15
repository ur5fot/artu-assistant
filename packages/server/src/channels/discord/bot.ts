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

export interface DiscordBotDeps {
  token: string;
  whitelist: Set<string>;
  runChatRequest: (params: {
    messages: MessageParam[];
    source: string;
    onEvent: (event: SSEEvent) => void;
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

  client.on('messageCreate', async (msg: Message) => {
    try {
      if (msg.author.bot) return;
      if (msg.channel.type !== ChannelType.DM) return;
      if (!deps.whitelist.has(msg.author.id)) return;

      if (!msg.content.trim()) return;

      const dmChannel = msg.channel as DMChannel;
      await dmChannel.sendTyping();

      const source = `discord:${msg.author.id}`;

      const rows = deps.db
        .prepare(
          'SELECT role, content FROM chat_messages WHERE source = ? ORDER BY timestamp DESC LIMIT ?',
        )
        .all(source, deps.historyLimit) as Array<{
        role: string;
        content: string;
      }>;
      rows.reverse();

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
        source,
        onEvent: (event: SSEEvent) => {
          if (event.type === 'text_delta') {
            buffer += event.content;
          } else if (event.type === 'done') {
            if (buffer) {
              replyPromise = sendReply(dmChannel, buffer).catch((err) => {
                console.error('[discord] failed to send reply:', err);
              });
            }
          } else if (event.type === 'error') {
            dmChannel
              .send(`⚠️ error: ${event.message}`)
              .catch((err) =>
                console.error('[discord] failed to send error:', err),
              );
          }
        },
      });

      await replyPromise;

      if (buffer) {
        deps.saveMessage({
          messageId: crypto.randomUUID(),
          role: 'assistant',
          content: buffer,
          timestamp: Date.now(),
          source,
        });
      }
    } catch (err) {
      console.error(
        '[discord] messageCreate handler error:',
        err instanceof Error ? err.message : err,
      );
      try {
        const dmChannel = msg.channel as DMChannel;
        await dmChannel.send(
          `⚠️ error: ${err instanceof Error ? err.message : 'unknown error'}`,
        );
      } catch {
        // ignore send failure
      }
    }
  });

  await client.login(deps.token);

  return {
    stop: async () => {
      await client.destroy();
    },
  };
}
