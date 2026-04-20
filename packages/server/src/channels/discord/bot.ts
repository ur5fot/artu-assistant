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
import type { ReminderService } from '../../services/reminder-service.js';
import type { PermissionService } from '../../services/permission-service.js';
import type { PlanReviewService } from '../../services/plan-review-service.js';
import type { MemoryConfirmService } from '../../services/memory-confirm-service.js';
import type { CommandService } from '../../services/command-service.js';
import type { CognitionService } from '../../cognition/service.js';
import { truncateMessages } from '../../routes/chat.js';
import { buildReminderEmbed, buildPermissionEmbed, buildPlanReviewChunks } from './embeds.js';
import { buildToolCallEmbed, buildDiffAttachment, SILENT_TOOLS } from './tool-embeds.js';
import { routeInteraction } from './interactions.js';
import { SLASH_COMMAND_DEFINITIONS } from './slash-commands.js';

export interface DiscordBotDeps {
  token: string;
  whitelist: Set<string>;
  runChatRequest: (params: {
    messages: MessageParam[];
    onEvent: (event: SSEEvent) => void;
    signal?: AbortSignal;
    currentUserMessageId?: string;
    currentUserMessageTimestamp?: number;
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
  /** Debounce window (ms) for coalescing burst user messages into one LLM
   *  call. Default: DISCORD_COALESCE_MS env or 1500. Set to 0 in tests to
   *  minimise the wait. */
  coalesceMs?: number;
  /** Override the Client instance (testing only). */
  _client?: Client;
  /** Optional reminder event bus — when provided, reminder events are forwarded as Discord DMs. */
  reminderBus?: EventEmitter;
  /** Reminder service — resolves reminder actions (dismiss/snooze) triggered by Discord buttons. */
  reminderService?: ReminderService;
  /** Permission service — resolves tool confirm requests triggered by Discord buttons. */
  permissionService?: PermissionService;
  /** Plan review service — resolves plan reviews triggered by Discord buttons. */
  planReviewService?: PlanReviewService;
  /** Memory confirm service — resolves memory_forget / memory_update / memory_forget_last confirms. */
  memoryConfirmService?: MemoryConfirmService;
  /** Command service — slash command implementations. */
  commandService?: CommandService;
  /** Cognition service — heartbeat/handler runs; bot listens for `cognition_publish` events on the reminder bus and marks runs published after DM delivery. */
  cognitionService?: CognitionService;
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

const SECRET_KEY_RE = /(token|secret|password|passwd|authorization|auth|api[_-]?key|credential|private[_-]?key|session|cookie)/i;

function summarizeArgs(input: Record<string, unknown>): string {
  const pairs: string[] = [];
  let total = 0;
  for (const [k, v] of Object.entries(input)) {
    let short: string;
    if (SECRET_KEY_RE.test(k)) {
      short = '[redacted]';
    } else {
      let val: string;
      try {
        val = typeof v === 'string' ? v : JSON.stringify(v);
      } catch {
        val = '[unserializable]';
      }
      short = val.length > 100 ? val.slice(0, 100) + '…' : val;
    }
    const line = `${k}: \`${short}\``;
    if (total + line.length + 1 > 1500) break;
    pairs.push(line);
    total += line.length + 1;
  }
  return pairs.join('\n');
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
  const envCoalesce = Number(process.env.DISCORD_COALESCE_MS);
  const coalesceMs = deps.coalesceMs ?? (Number.isFinite(envCoalesce) && envCoalesce >= 0 ? envCoalesce : 1500);
  const userQueues = new Map<string, Promise<void>>();
  // Coalescing: each incoming DM is saved to the chat_messages table immediately,
  // then a debounce timer is armed. Subsequent messages from the same user within
  // `coalesceMs` reset the timer and replace `lastMsg`/`lastMessageId`. When the
  // timer fires, handleMessage runs once with the entire burst already sitting
  // in history — the existing history-builder collapses consecutive same-role
  // rows into a single user turn so the LLM sees the full intent.
  interface PendingEntry {
    timer: ReturnType<typeof setTimeout>;
    lastMsg: Message;
    lastMessageId: string;
    lastTimestamp: number;
  }
  const pendingMessages = new Map<string, PendingEntry>();
  // Shared across all requests — a modal interaction can fire long after the
  // original request's handleMessage() returned, so the lookup must outlive
  // any per-request closure. Entries are deleted when the confirm is resolved
  // (approve/deny/submit) or when the request's finally block expires it.
  const memoryConfirmInitialValues = new Map<string, string>();

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
        const dm = await user.createDM();
        console.log('[discord] pre-cached DM channel for', userId, '→', dm.id);
      } catch (err) {
        console.warn('[discord] failed to pre-cache DM for', userId, ':', err instanceof Error ? err.message : err);
      }
    }
    try {
      if (client.application) {
        await client.application.commands.set(SLASH_COMMAND_DEFINITIONS);
        console.log('[discord] slash commands registered');
      }
    } catch (err) {
      console.error('[discord] slash command registration failed:', err instanceof Error ? err.message : err);
    }
  });
  client.on('warn', (m) => console.warn('[discord] warn:', m));
  client.on('shardDisconnect', (e, id) => console.warn('[discord] shardDisconnect', id, e.code, e.reason));
  client.on('shardError', (e) => console.error('[discord] shardError:', e.message));

  client.on('interactionCreate', async (interaction) => {
    try {
      if (!deps.reminderService || !deps.permissionService || !deps.planReviewService || !deps.commandService || !deps.cognitionService) {
        console.warn('[discord] interaction received but services not wired');
        return;
      }
      await routeInteraction(interaction, {
        whitelist: deps.whitelist,
        reminderService: deps.reminderService,
        permissionService: deps.permissionService,
        planReviewService: deps.planReviewService,
        commandService: deps.commandService,
        cognitionService: deps.cognitionService,
        memoryConfirmService: deps.memoryConfirmService,
        memoryConfirmInitialValues,
      });
    } catch (err) {
      console.error('[discord] interaction error:', err instanceof Error ? err.message : err);
    }
  });

  const firePending = (userId: string) => {
    const entry = pendingMessages.get(userId);
    if (!entry) return;
    pendingMessages.delete(userId);
    const prev = userQueues.get(userId) ?? Promise.resolve();
    const safe = prev.then(() => handleMessage(entry.lastMsg, {
      alreadySaved: true,
      userMessageId: entry.lastMessageId,
      userMessageTimestamp: entry.lastTimestamp,
    })).catch(() => {});
    userQueues.set(userId, safe);
    safe.then(() => {
      if (userQueues.get(userId) === safe) {
        userQueues.delete(userId);
      }
    });
  };

  client.on('messageCreate', async (msg: Message) => {
    if (msg.author.bot) return;
    if (msg.channel.type !== ChannelType.DM) return;
    if (!deps.whitelist.has(msg.author.id)) return;
    if (!msg.content.trim()) return;

    const userId = msg.author.id;
    const source = `discord:${userId}`;
    const messageId = crypto.randomUUID();
    const timestamp = Date.now();
    try {
      deps.saveMessage({
        messageId,
        role: 'user',
        content: msg.content,
        timestamp,
        source,
      });
    } catch (err) {
      console.error(
        '[discord] saveMessage failed on ingest:',
        err instanceof Error ? err.message : err,
      );
      return;
    }

    const prev = pendingMessages.get(userId);
    if (prev) clearTimeout(prev.timer);
    pendingMessages.set(userId, {
      timer: setTimeout(() => firePending(userId), coalesceMs),
      lastMsg: msg,
      lastMessageId: messageId,
      lastTimestamp: timestamp,
    });
  });

  interface HandleMessageOpts {
    alreadySaved?: boolean;
    userMessageId?: string;
    userMessageTimestamp?: number;
  }

  async function handleMessage(msg: Message, opts: HandleMessageOpts = {}): Promise<void> {
    let typingInterval: ReturnType<typeof setInterval> | undefined;
    let sendSucceeded = false;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    type PendingEmbed =
      | { callId: string; kind: 'perm'; messageIds: string[]; toolName: string; argsSummary: string }
      | { callId: string; kind: 'plan'; messageIds: string[] }
      | { callId: string; kind: 'memconfirm'; messageIds: string[]; preview: string };
    const pendingEmbedMsgs: PendingEmbed[] = [];
    type ToolCallEntry = {
      messageId: string;
      toolName: string;
      toolInput: Record<string, unknown>;
      final: boolean;
      lastEditAt: number;
      pendingTimer: ReturnType<typeof setTimeout> | null;
      latestProgress: string | null;
    };
    const toolCallMessages = new Map<string, ToolCallEntry>();
    const PROGRESS_DEBOUNCE_MS = 800;

    const applyProgressEdit = async (callId: string, progress: string) => {
      const entry = toolCallMessages.get(callId);
      if (!entry || entry.final) return;
      // Update lastEditAt up-front: if the edit fails, the cooldown still
      // applies so we don't hammer Discord by retrying on every subsequent
      // progress event.
      entry.lastEditAt = Date.now();
      try {
        const dmChannel = msg.channel as DMChannel;
        const msgRef = await dmChannel.messages.fetch(entry.messageId);
        // Re-check final AFTER the async fetch: a tool_call_result that runs
        // while the fetch is in flight would otherwise be clobbered by this
        // edit, flipping a completed embed back to "progress".
        if (entry.final) return;
        const embed = buildToolCallEmbed({
          state: 'progress',
          toolCall: {
            id: callId,
            name: entry.toolName,
            input: entry.toolInput,
            status: 'running',
          },
          progress,
        });
        if (embed) await msgRef.edit({ embeds: [embed] });
      } catch {
        // Message deleted or Discord hiccup — ignore.
      }
    };

    const onProgress = (callId: string, progress: string) => {
      const entry = toolCallMessages.get(callId);
      if (!entry || entry.final) return;
      const elapsed = Date.now() - entry.lastEditAt;
      if (elapsed >= PROGRESS_DEBOUNCE_MS) {
        void applyProgressEdit(callId, progress);
        return;
      }
      entry.latestProgress = progress;
      if (!entry.pendingTimer) {
        const delay = PROGRESS_DEBOUNCE_MS - elapsed;
        entry.pendingTimer = setTimeout(() => {
          entry.pendingTimer = null;
          const latest = entry.latestProgress ?? progress;
          entry.latestProgress = null;
          void applyProgressEdit(callId, latest);
        }, delay);
      }
    };
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
      // If the message (and any burst siblings) was already saved by the
      // coalescing path, the DB read above already carries the current user
      // turn — appending msg.content here would duplicate the latest line.
      if (!opts.alreadySaved) {
        built.push({ role: 'user', content: msg.content });
      }

      const budgetRaw = deps.contextBudgetChars ?? Number(process.env.CHAT_CONTEXT_BUDGET_CHARS);
      const contextBudget = Number.isFinite(budgetRaw) && budgetRaw > 0 ? budgetRaw : 60000;
      const messages: MessageParam[] = truncateMessages(built, contextBudget);

      const userMessageId = opts.alreadySaved && opts.userMessageId
        ? opts.userMessageId
        : crypto.randomUUID();
      const userMessageTimestamp = opts.alreadySaved && typeof opts.userMessageTimestamp === 'number'
        ? opts.userMessageTimestamp
        : Date.now();
      if (!opts.alreadySaved) {
        deps.saveMessage({
          messageId: userMessageId,
          role: 'user',
          content: msg.content,
          timestamp: userMessageTimestamp,
          source,
        });
      }

      let buffer = '';
      let assistantText = '';
      let errorSent = false;
      let sendChain: Promise<void> = Promise.resolve();
      // First error observed inside the chain — we surface it after the
      // stream finishes so retry/outer-catch can send a user-visible fallback
      // instead of silently leaving sendSucceeded=false.
      let sendError: unknown = null;
      let sawOllama = false;
      let escalated = false;

      const flush = async () => {
        if (!buffer) return;
        let text = buffer;
        if (escalated) {
          text = `🔵 claude\n\n${text}`;
          escalated = false;
        }
        await sendReply(dmChannel, text);
        sendSucceeded = true;
        buffer = '';
      };

      for (let attempt = 0; ; attempt++) {
        // If the previous attempt already produced visible output (text, embeds,
        // tool-call embeds) do not retry — the user would see duplicated text
        // or the freshly-sent embeds from attempt N+1 would leave attempt N's
        // tool-call embeds orphaned in "running" state forever.
        if (attempt > 0 && (sendSucceeded || pendingEmbedMsgs.length > 0 || toolCallMessages.size > 0)) {
          throw new Error('retry aborted: prior attempt already emitted output');
        }
        buffer = '';
        assistantText = '';
        errorSent = false;
        sendChain = Promise.resolve();
        sendError = null;
        sawOllama = false;
        escalated = false;

        try {
          await deps.runChatRequest({
            messages,
            signal: ac.signal,
            currentUserMessageId: userMessageId,
            currentUserMessageTimestamp: userMessageTimestamp,
            onEvent: (event: SSEEvent) => {
              sendChain = sendChain.then(async () => {
                if (event.type === 'text_delta') {
                  buffer += event.content;
                  assistantText += event.content;
                  return;
                }
                if (event.type === 'assistant_source') {
                  if (event.source === 'ollama') {
                    sawOllama = true;
                  } else if (event.source === 'claude' && sawOllama) {
                    escalated = true;
                  }
                  return;
                }
                if (event.type === 'tool_call_start') {
                  if (SILENT_TOOLS.includes(event.toolCall.name)) return;
                  const embed = buildToolCallEmbed({ state: 'running', toolCall: event.toolCall });
                  if (!embed) return;
                  await flush();
                  const sent = await dmChannel.send({ embeds: [embed] });
                  toolCallMessages.set(event.toolCall.id, {
                    messageId: sent.id,
                    toolName: event.toolCall.name,
                    toolInput: event.toolCall.input,
                    final: false,
                    lastEditAt: Date.now(),
                    pendingTimer: null,
                    latestProgress: null,
                  });
                  return;
                }
                if (event.type === 'tool_progress') {
                  onProgress(event.id, event.message);
                  return;
                }
                if (event.type === 'tool_call_result') {
                  const entry = toolCallMessages.get(event.id);
                  if (!entry || entry.final) return;
                  if (entry.pendingTimer) {
                    clearTimeout(entry.pendingTimer);
                    entry.pendingTimer = null;
                    entry.latestProgress = null;
                  }
                  // Mark terminal BEFORE the async fetch so any in-flight
                  // applyProgressEdit short-circuits after its own fetch
                  // instead of racing to overwrite the terminal embed.
                  entry.final = true;
                  const isSuccess = event.result.success;
                  const state = isSuccess ? ('done' as const) : ('error' as const);
                  const toolCallSnapshot = {
                    id: event.id,
                    name: entry.toolName,
                    input: entry.toolInput,
                    status: state,
                    result: event.result,
                  };
                  const embed = buildToolCallEmbed({ state, toolCall: toolCallSnapshot });
                  try {
                    const msgRef = await dmChannel.messages.fetch(entry.messageId);
                    if (embed) await msgRef.edit({ embeds: [embed] });
                  } catch {
                    // Message gone or no permission — ignore.
                  }

                  if (isSuccess && entry.toolName === 'code_task') {
                    const data = (event.result.data ?? {}) as {
                      fullDiff?: string;
                      commit?: string;
                    };
                    if (typeof data.fullDiff === 'string' && data.fullDiff.length > 0) {
                      const diff = buildDiffAttachment({
                        callId: event.id,
                        fullDiff: data.fullDiff,
                        commit: data.commit,
                      });
                      if (diff && 'attachment' in diff) {
                        try {
                          await dmChannel.send({ files: [{ attachment: diff.attachment, name: diff.name }] });
                        } catch (err) {
                          console.error('[discord] diff attachment failed:',
                            err instanceof Error ? err.message : err);
                        }
                      } else if (diff && 'oversize' in diff) {
                        const suffix = data.commit
                          ? `, saved in commit \`${data.commit.slice(0, 7)}\``
                          : '';
                        try {
                          await dmChannel.send(`⚠️ diff too large to attach${suffix}`);
                        } catch {
                          // ignore
                        }
                      }
                    }
                  }
                  return;
                }
                if (event.type === 'tool_confirm_request') {
                  await flush();
                  const argsSummary = summarizeArgs(event.toolCall.input);
                  const { embed, components } = buildPermissionEmbed({
                    callId: event.toolCall.id,
                    toolName: event.toolCall.name,
                    argsSummary,
                    state: 'pending',
                  });
                  const sent = await dmChannel.send({ embeds: [embed], components });
                  pendingEmbedMsgs.push({
                    callId: event.toolCall.id,
                    kind: 'perm',
                    messageIds: [sent.id],
                    toolName: event.toolCall.name,
                    argsSummary,
                  });
                  return;
                }
                if (event.type === 'tool_plan_review') {
                  await flush();
                  const chunks = buildPlanReviewChunks({ callId: event.id, plan: event.plan });
                  const sentIds: string[] = [];
                  for (const c of chunks) {
                    const sent = await dmChannel.send({
                      content: c.content ?? '',
                      components: c.components ?? [],
                    });
                    sentIds.push(sent.id);
                  }
                  pendingEmbedMsgs.push({
                    callId: event.id,
                    kind: 'plan',
                    messageIds: sentIds,
                  });
                  return;
                }
                if (event.type === 'tool_memory_confirm') {
                  await flush();
                  const p = event.payload;
                  // Discord hard-caps a message at 2000 chars. memory_forget_last
                  // previews a list of facts (key=value, up to 565 chars each)
                  // that can blow past the cap on verbose turns. Without this
                  // truncation, `dmChannel.send` throws, the tool handler keeps
                  // awaiting the confirm that will never resolve, and the user
                  // waits for the 120s timeout before seeing any feedback. The
                  // ~1800 budget also leaves headroom for the "\n\n✅ Approved"
                  // suffix appended on button click without re-hitting the cap.
                  const MEMCONFIRM_CONTENT_MAX = 1800;
                  const rawContent = `🧠 **Memory ${p.tool}**\n${p.preview}`;
                  const content = rawContent.length > MEMCONFIRM_CONTENT_MAX
                    ? rawContent.slice(0, MEMCONFIRM_CONTENT_MAX - 1) + '…'
                    : rawContent;
                  const buttons: Array<Record<string, unknown>> = [
                    { type: 2, style: 3, label: '✅ Approve', custom_id: `memconfirm:approve:${p.id}` },
                  ];
                  if (p.editableField) {
                    buttons.push({
                      type: 2,
                      style: 1,
                      label: '✏️ Edit & approve',
                      custom_id: `memconfirm:edit:${p.id}:${p.editableField}`,
                    });
                  }
                  buttons.push({
                    type: 2,
                    style: 4,
                    label: '❌ Deny',
                    custom_id: `memconfirm:deny:${p.id}`,
                  });
                  const row = { type: 1, components: buttons };
                  // Set the prefill entry AFTER the send succeeds so a thrown
                  // send doesn't leave a map entry that the finally-cleanup
                  // loop (which iterates pendingEmbedMsgs) will never see.
                  let sent;
                  try {
                    sent = await dmChannel.send({ content, components: [row] as any });
                  } catch (err) {
                    // If the send fails (DM closed, permission revoked, etc.),
                    // the tool handler is still awaiting requestMemoryConfirm
                    // with no UI visible to the user. Without short-circuiting,
                    // the promise only resolves when the 120s abort timer fires,
                    // leaving the chat loop idle that whole time. Deny the
                    // pending confirm immediately so the tool handler unblocks
                    // and the error propagates to the user via normal paths.
                    deps.memoryConfirmService?.resolve(p.id, false);
                    throw err;
                  }
                  if (p.editableField && typeof p.initialValue === 'string') {
                    memoryConfirmInitialValues.set(p.id, p.initialValue);
                  }
                  pendingEmbedMsgs.push({
                    callId: p.id,
                    kind: 'memconfirm',
                    messageIds: [sent.id],
                    preview: content,
                  });
                  return;
                }
                if (event.type === 'done' && !errorSent) {
                  await flush();
                  return;
                }
                if (event.type === 'error' && !errorSent) {
                  errorSent = true;
                  console.error('[discord] chat error event:', event.message);
                  await flush();
                  await dmChannel.send('⚠️ Something went wrong. Please try again later.');
                  return;
                }
              }).catch((err) => {
                // Capture (don't swallow) the first chain error. Previously we
                // only console.error'd here, which let the request complete
                // with sendSucceeded=false and no user-visible error — the
                // user would receive neither assistant output nor a failure
                // message. The captured error is rethrown after `await
                // sendChain` so retry/outer-catch can produce a fallback.
                if (!sendError) sendError = err;
                console.error('[discord] onEvent chain error:', err);
              });
            },
          });
          await sendChain;
          if (sendError) throw sendError;
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

      if (ac.signal.aborted && !sendSucceeded) {
        await sendReply(dmChannel, '⏱️ Request timed out. Please try again.');
      } else if (assistantText && sendSucceeded) {
        deps.saveMessage({
          messageId: crypto.randomUUID(),
          role: 'assistant',
          content: assistantText,
          timestamp: Date.now(),
          source,
        });

        if (deps.memoryService) {
          deps.memoryService
            .indexTurn({
              userMessage: msg.content,
              userMessageId,
              assistantMessage: assistantText,
              timestamp: Date.now(),
            })
            .catch((err) =>
              console.warn('[discord] indexTurn failed:', err instanceof Error ? err.message : err),
            );
        }
      }
    } catch (err) {
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
    } finally {
      clearInterval(typingInterval);
      clearTimeout(timer);
      // Cancel any pending debounced progress edits and mark all live tool
      // entries terminal so timer callbacks already in flight short-circuit.
      // Without this, a setTimeout scheduled at request shutdown can fire
      // 800 ms later and edit a Discord message belonging to a request that
      // has already been considered done.
      for (const entry of toolCallMessages.values()) {
        if (entry.pendingTimer) {
          clearTimeout(entry.pendingTimer);
          entry.pendingTimer = null;
          entry.latestProgress = null;
        }
      }
      // Expire any pending permission/plan-review embeds that the user never
      // resolved. Runs on all exit paths (success, error, timeout) so
      // aborted-but-not-thrown flows (e.g. AbortController fires mid-stream
      // and runChatRequest returns without throwing) don't leave dangling
      // "Allow / Deny" buttons in the DM.
      try {
        const dmChannel = msg.channel as DMChannel;
        // Edit any tool-call embed still in "running"/"progress" state to an
        // error embed. Otherwise a request that throws mid-stream (e.g.
        // network error after tool_call_start, retry-aborted attempt) leaves
        // a perpetual 🔧 running… embed in the DM.
        for (const [callId, entry] of toolCallMessages) {
          if (entry.final) continue;
          entry.final = true;
          try {
            const m = await dmChannel.messages.fetch(entry.messageId);
            const embed = buildToolCallEmbed({
              state: 'error',
              toolCall: {
                id: callId,
                name: entry.toolName,
                input: entry.toolInput,
                status: 'error',
                result: { success: false, error: 'request ended before tool finished' },
              },
            });
            if (embed) await m.edit({ embeds: [embed] });
          } catch {
            // message gone or no permission — ignore
          }
        }
        for (const pe of pendingEmbedMsgs) {
          if (pe.kind === 'perm' && deps.permissionService?.isResolvedByUser(pe.callId)) {
            continue;
          }
          if (pe.kind === 'plan' && deps.planReviewService?.isResolvedByUser(pe.callId)) {
            continue;
          }
          if (pe.kind === 'memconfirm' && deps.memoryConfirmService?.isResolvedByUser(pe.callId)) {
            memoryConfirmInitialValues.delete(pe.callId);
            continue;
          }
          if (pe.kind === 'perm') {
            for (const mid of pe.messageIds) {
              try {
                const m = await dmChannel.messages.fetch(mid);
                const { embed } = buildPermissionEmbed({
                  callId: pe.callId,
                  toolName: pe.toolName,
                  argsSummary: pe.argsSummary,
                  state: 'expired',
                });
                await m.edit({ embeds: [embed], components: [] });
              } catch {
                // message gone or no permission — ignore
              }
            }
          } else if (pe.kind === 'plan') {
            // Plan review: earlier chunks carry the plan text (inside code
            // fences) and have no buttons. Overwriting them with "expired"
            // deletes the plan the user may still want to read. Only the last
            // chunk has the Approve/Reject buttons — edit that one to clear
            // components and mark the review as expired.
            const lastId = pe.messageIds[pe.messageIds.length - 1];
            if (lastId) {
              try {
                const m = await dmChannel.messages.fetch(lastId);
                await m.edit({ components: [], content: '⚠️ Plan review expired' });
              } catch {
                // message gone or no permission — ignore
              }
            }
          } else {
            memoryConfirmInitialValues.delete(pe.callId);
            const lastId = pe.messageIds[pe.messageIds.length - 1];
            if (lastId) {
              try {
                const m = await dmChannel.messages.fetch(lastId);
                await m.edit({ components: [], content: pe.preview + '\n\n⚠️ Expired' });
              } catch {
                // message gone or no permission — ignore
              }
            }
          }
        }
      } catch {
        // channel unreachable — ignore
      }
    }
  }

  // Track per-user message ids for reminder embeds so we can edit only the
  // owning user's DM on dismiss/snooze/done. Flat arrays without userId
  // scoping cause O(users²) cross-user fetches that always 404 silently.
  const reminderMessages = new Map<number, Array<{ userId: string; msgId: string }>>();
  // Terminal state per reminder id. Set when editStored runs so that
  // late-arriving DM sends (whose `.then` callback may fire AFTER dismiss/
  // snooze/done was already handled) can edit themselves to the final state
  // instead of being appended to an already-deleted messages list and left
  // stuck in "ringing".
  // Relies on JS Map insertion-order iteration: delete-then-set on an existing
  // key moves it to the end, so a single Map doubles as both state store and
  // LRU queue. A separate FIFO array would let duplicate ids accumulate (via
  // recurring reminders reusing the same id), and evicting the stale duplicate
  // would kill the freshly-set terminal state.
  const reminderTerminal = new Map<number, 'dismissed' | 'missed' | 'snoozed'>();
  const REMINDER_TERMINAL_MAX = 1024;

  let reminderListener: ((event: ServerPushEvent) => void) | null = null;
  if (deps.reminderBus) {
    const markTerminal = (id: number, state: 'dismissed' | 'missed' | 'snoozed') => {
      reminderTerminal.delete(id);
      reminderTerminal.set(id, state);
      while (reminderTerminal.size > REMINDER_TERMINAL_MAX) {
        const oldest = reminderTerminal.keys().next().value as number | undefined;
        if (oldest === undefined) break;
        reminderTerminal.delete(oldest);
      }
    };

    const editStored = async (
      id: number,
      state: 'dismissed' | 'missed' | 'snoozed',
    ) => {
      markTerminal(id, state);
      const entries = reminderMessages.get(id) ?? [];
      if (entries.length === 0) {
        reminderMessages.delete(id);
        return;
      }
      for (const { userId, msgId } of entries) {
        try {
          const user = await client.users.fetch(userId);
          const dm = await user.createDM();
          const stored = await dm.messages.fetch(msgId);
          const currentTitle = stored.embeds?.[0]?.title ?? '';
          const currentText = currentTitle.replace(/^⏰\s*/, '');
          const { embed } = buildReminderEmbed({ id, text: currentText, state });
          await stored.edit({ embeds: [embed], components: [] });
        } catch (err) {
          // user/dm/message gone or no permission — ignore
        }
      }
      reminderMessages.delete(id);
    };

    reminderListener = (event: ServerPushEvent) => {
      if (!client.isReady()) return;
      if (event.type === 'reminder_ring') {
        // Recurring reminders keep the same id across cycles. A prior
        // dismissed/missed/snoozed would otherwise leave a stale terminal
        // entry here, causing the freshly-sent DM for this new cycle to be
        // instantly edited to terminal state with no actionable buttons.
        reminderTerminal.delete(event.id);
        const { embed, components } = buildReminderEmbed({
          id: event.id,
          text: event.text,
          state: 'ringing',
        });
        // Initialize the per-reminder list synchronously *before* launching
        // any fetches. The .then() callbacks below run on different ticks; if
        // each one did `get(id) ?? []` it could race with a sibling and
        // overwrite its push, losing a user's msgId.
        let list = reminderMessages.get(event.id);
        if (!list) {
          list = [];
          reminderMessages.set(event.id, list);
        }
        const ringId = event.id;
        const ringText = event.text;
        for (const userId of deps.whitelist) {
          client.users
            .fetch(userId)
            .then((u) => u.createDM())
            .then((dm) => dm.send({ embeds: [embed], components }))
            .then(async (sent) => {
              // If the reminder resolved (dismiss/snooze/done) while this
              // DM was still in flight, editStored already ran and deleted
              // the message list — push would be orphaned and the button
              // would stay stuck. Edit this just-sent message to the final
              // state instead.
              const terminal = reminderTerminal.get(ringId);
              if (terminal) {
                const { embed: finalEmbed } = buildReminderEmbed({
                  id: ringId,
                  text: ringText,
                  state: terminal,
                });
                try {
                  await sent.edit({ embeds: [finalEmbed], components: [] });
                } catch {
                  // message gone or no permission — ignore
                }
                return;
              }
              list!.push({ userId, msgId: sent.id });
            })
            .catch((err) =>
              console.error('[discord] reminder DM failed:', err instanceof Error ? err.message : err),
            );
        }
      } else if (event.type === 'reminder_done') {
        editStored(event.id, 'missed').catch((err) =>
          console.error('[discord] reminder edit failed:', err instanceof Error ? err.message : err),
        );
      } else if (event.type === 'reminder_dismissed') {
        editStored(event.id, 'dismissed').catch((err) =>
          console.error('[discord] reminder edit failed:', err instanceof Error ? err.message : err),
        );
      } else if (event.type === 'reminder_snoozed') {
        editStored(event.id, 'snoozed').catch((err) =>
          console.error('[discord] reminder edit failed:', err instanceof Error ? err.message : err),
        );
      }
      // `reminder_stop_ring` is intentionally ignored: the scheduler emits it
      // on every ringing→paused transition within a multi-cycle reminder,
      // which is not user-initiated snooze. User snooze emits the distinct
      // `reminder_snoozed` event handled above.
    };
    deps.reminderBus.on('push', reminderListener);
  }

  let cognitionListener: ((e: any) => void) | null = null;
  if (deps.reminderBus) {
    cognitionListener = (event: any) => {
      if (event.type !== 'cognition_publish') return;
      if (!client.isReady()) return;
      // Mark the run as published exactly once — on the first successful DM.
      // Calling markPublished per-whitelist-user would overwrite
      // published_at N times and could falsely mark a run as published even
      // when earlier recipients' sends failed.
      let marked = false;
      const body = `💭 _from ${event.handler}_\n${event.content}`;
      for (const userId of deps.whitelist) {
        client.users.fetch(userId)
          .then((u) => u.createDM())
          .then((dm) => sendReply(dm as unknown as DMChannel, body))
          .then(() => {
            if (marked) return;
            // Attempt DB write first; only set `marked` if it actually
            // succeeds. Otherwise a transient DB failure here would leave
            // `marked=true`, silently skipping later successful recipients.
            deps.cognitionService?.markPublished(event.runId, Date.now());
            marked = true;
          })
          .catch((err) => console.error(
            '[discord] cognition publish failed:',
            err instanceof Error ? err.message : err,
          ));
      }
    };
    deps.reminderBus.on('push', cognitionListener);
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
    if (reminderListener && deps.reminderBus) {
      deps.reminderBus.off('push', reminderListener);
    }
    if (cognitionListener && deps.reminderBus) {
      deps.reminderBus.off('push', cognitionListener);
    }
    client.destroy().catch(() => {});
    throw err;
  }

  return {
    stop: async () => {
      // Drop any pending coalescing timers — their incoming messages are
      // already persisted to chat_messages, so a future session will pick
      // them up in history. Firing handleMessage against a destroyed client
      // would throw inside DM send. (Full graceful-flush-on-SIGTERM is out
      // of scope; the persistence side is what matters.)
      for (const entry of pendingMessages.values()) {
        clearTimeout(entry.timer);
      }
      pendingMessages.clear();
      if (reminderListener && deps.reminderBus) {
        deps.reminderBus.off('push', reminderListener);
      }
      if (cognitionListener && deps.reminderBus) {
        deps.reminderBus.off('push', cognitionListener);
      }
      await client.destroy();
    },
  };
}
