import {
  Client,
  GatewayIntentBits,
  Partials,
  ChannelType,
  type Message,
  type DMChannel,
} from 'discord.js';
import crypto from 'node:crypto';
import type { SSEEvent, ServerPushEvent } from '@r2/shared';
import type { EventEmitter } from 'node:events';
import type Database from 'better-sqlite3';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';
import type { MemoryService } from '../../memory/service.js';
import { truncateMessages } from '../../routes/chat.js';

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
  /** Chat context budget in chars (default 60000). */
  contextBudgetChars?: number;
  /** Override the Client instance (testing only). */
  _client?: Client;
  /** Optional reminder event bus — when provided, reminder events are forwarded as Discord DMs. */
  reminderBus?: EventEmitter;
}

const RETRY_DELAYS = [1000, 3000];

export function isRetryableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes('timeout') ||
    msg.includes('econnrefused') ||
    msg.includes('econnreset') ||
    msg.includes('enotfound') ||
    msg.includes('socket hang up') ||
    msg.includes('fetch failed') ||
    msg.includes('network') ||
    msg.includes('connect timeout')
  );
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
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel, Partials.Message, Partials.User, Partials.GuildMember, Partials.ThreadMember, Partials.Reaction],
    });

  const timeoutMs = deps.requestTimeoutMs ?? 120_000;
  const userQueues = new Map<string, Promise<void>>();

  client.on('error', (err) => {
    console.error('[discord] client error:', err instanceof Error ? err.message : err);
  });
  client.on('clientReady', async () => {
    console.log('[discord] ready as', client.user?.tag);
    // Pre-cache DM channels for whitelisted users. Without this, discord.js
    // drops the first DM silently: MessageCreateAction.getChannel() can't
    // resolve a DM channel from a MESSAGE_CREATE payload because the payload
    // carries message.type, not channel.type — so createChannel() (Channels.js)
    // returns undefined and the messageCreate event never fires.
    for (const userId of deps.whitelist) {
      try {
        const user = await client.users.fetch(userId);
        await user.createDM();
      } catch (err) {
        console.warn('[discord] failed to pre-cache DM for', userId, ':', err instanceof Error ? err.message : err);
      }
    }
  });
  client.on('warn', (m) => console.warn('[discord] warn:', m));
  client.on('shardDisconnect', (e, id) => console.warn('[discord] shardDisconnect', id, e.code, e.reason));
  client.on('shardError', (e) => console.error('[discord] shardError:', e.message));

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

      // Unified history: read all chat_messages regardless of source so the
      // Discord channel and the web UI share one continuous conversation.
      // The `source` field is still stored on each row for origin tracking
      // and per-channel clearing, but is NOT used as a read filter anymore.
      const rows = deps.db
        .prepare(
          'SELECT role, content FROM chat_messages ORDER BY timestamp DESC, id DESC LIMIT ?',
        )
        .all(deps.historyLimit) as Array<{
        role: string;
        content: string;
      }>;
      rows.reverse();
      while (rows.length > 0 && rows[0].role === 'assistant') rows.shift();

      const built: Array<{ role: 'user' | 'assistant'; content: string }> = [];
      for (const r of rows) {
        const role = r.role as 'user' | 'assistant';
        const last = built[built.length - 1];
        if (last && last.role === role) {
          last.content += '\n' + r.content;
        } else {
          built.push({ role, content: r.content });
        }
      }
      built.push({ role: 'user', content: msg.content });

      const budgetRaw = deps.contextBudgetChars ?? Number(process.env.CHAT_CONTEXT_BUDGET_CHARS);
      const contextBudget = Number.isFinite(budgetRaw) && budgetRaw > 0 ? budgetRaw : 60000;
      const messages: MessageParam[] = truncateMessages(built, contextBudget);

      deps.saveMessage({
        messageId: crypto.randomUUID(),
        role: 'user',
        content: msg.content,
        timestamp: Date.now(),
        source,
      });

      let buffer = '';
      let replyPromise: Promise<void> | null = null;
      let errorSent = false;

      for (let attempt = 0; ; attempt++) {
        buffer = '';
        replyPromise = null;
        errorSent = false;

        try {
          await deps.runChatRequest({
            messages,
            signal: ac.signal,
            onEvent: (event: SSEEvent) => {
              if (event.type === 'text_delta') {
                buffer += event.content;
              } else if (event.type === 'done' && !errorSent) {
                const text = buffer || '(No response generated.)';
                replyPromise = sendReply(dmChannel, text)
                  .then(() => { sendSucceeded = true; })
                  .catch((err) => {
                    console.error('[discord] failed to send reply:', err);
                  });
              } else if (event.type === 'error' && !errorSent) {
                errorSent = true;
                console.error('[discord] chat error event:', event.message);
                dmChannel
                  .send('⚠️ Something went wrong. Please try again later.')
                  .catch((err) =>
                    console.error('[discord] failed to send error:', err),
                  );
              }
            },
          });
          break;
        } catch (err) {
          if (attempt >= RETRY_DELAYS.length || ac.signal.aborted || !isRetryableError(err)) {
            throw err;
          }
          const delay = RETRY_DELAYS[attempt]!;
          console.warn(`[discord] retrying in ${delay}ms (attempt ${attempt + 1}/${RETRY_DELAYS.length}):`, err instanceof Error ? err.message : err);
          await new Promise((r) => setTimeout(r, delay));
        }
      }

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

  // Subscribe to reminder events and forward to Discord DMs
  let reminderListener: ((event: ServerPushEvent) => void) | null = null;
  if (deps.reminderBus) {
    reminderListener = (event: ServerPushEvent) => {
      if (event.type !== 'reminder_ring' && event.type !== 'reminder_done') return;
      const text = event.type === 'reminder_ring'
        ? `⏰ ${event.text}`
        : `⏰ пропущено: напоминание #${event.id}`;
      for (const userId of deps.whitelist) {
        const user = client.users.cache.get(userId);
        if (!user) continue;
        user.createDM().then((dm) => dm.send(text)).catch((err) =>
          console.error('[discord] reminder DM failed:', err instanceof Error ? err.message : err),
        );
      }
    };
    deps.reminderBus.on('push', reminderListener);
  }

  const LOGIN_TIMEOUT_MS = 30_000;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      client.login(deps.token).then((v) => {
        clearTimeout(timeoutId);
        return v;
      }),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('Discord login timed out')), LOGIN_TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    client.destroy().catch(() => {});
    throw err;
  }

  return {
    stop: async () => {
      if (reminderListener && deps.reminderBus) {
        deps.reminderBus.off('push', reminderListener);
      }
      await client.destroy();
    },
  };
}
