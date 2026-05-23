import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '..', '..', '..', '.env') });
import express from 'express';
import cors from 'cors';
import { createChatRouter } from './routes/chat.js';
import { createConfirmRouter, type PendingConfirms } from './routes/confirm.js';
import { createPlanReviewRouter, type PendingPlanReviews } from './routes/plan-review.js';
import { createMemoryConfirmRouter, type PendingMemoryConfirms } from './routes/memory-confirm.js';
import { createMemoryConfirmService } from './services/memory-confirm-service.js';
import { createPermissionsRouter } from './routes/permissions.js';
import { createPiiRouter } from './routes/pii.js';
import { createMessagesRouter } from './routes/messages.js';
import { createMergeRouter } from './routes/merge.js';
import { createCommandsRouter } from './routes/commands.js';
import { createReminderStore } from './reminders/store.js';
import { startScheduler } from './reminders/scheduler.js';
import { reminderBus } from './reminders/bus.js';
import { createReminderRouter } from './routes/reminder.js';
import { createReminderService } from './services/reminder-service.js';
import { createPermissionService } from './services/permission-service.js';
import { createPlanReviewService } from './services/plan-review-service.js';
import { createCommandService } from './services/command-service.js';
import { createEventsRouter } from './routes/events.js';
import { createClaudeClient } from './ai/claude.js';
import { createOllamaClient, type OllamaClient } from './ai/ollama.js';
import { runToolLoop } from './ai/tool-loop.js';
import { createRegistry, discoverTools } from './tools/registry.js';
import { initDb, cleanupAuditLog, cleanupOldChatMessages, getChatHistoryLimit, closeDb, getDb, saveMessage } from './db.js';
import { createOllamaEmbeddingsClient, type EmbeddingsClient } from './memory/embeddings.js';
import { createVoyageEmbeddingsClient } from './memory/voyageEmbeddings.js';
import { ensureEmbedModelMatches } from './memory/migration.js';
import { createOllamaTextProvider, createClaudeTextProvider, type TextProvider } from './memory/textProvider.js';
import { createMemoryService, type MemoryService } from './memory/service.js';
import type Anthropic from '@anthropic-ai/sdk';
import { errorHandler } from './errors.js';
import { createPiiProxy, createPassthroughProxy } from './pii/proxy.js';
import { PiiVault } from './pii/vault.js';
import { startDiscordBot } from './channels/discord/bot.js';
import { runChatRequest } from './ai/router.js';
import { createCognitionService } from './cognition/service.js';
import { pulseHandler } from './cognition/handlers/pulse.js';
import { createMorningBriefHandler } from './cognition/handlers/morningBrief.js';
import { parseImapAccounts } from './emails/config.js';
import { createEmailStore } from './emails/store.js';
import { fetchNewMessages, fetchFullBody, getMaxUid } from './emails/imap-client.js';
import { scoreBatch } from './emails/scorer.js';
import { startEmailPoller } from './emails/multi-account-poller.js';
import { createEmailDigestHandler } from './cognition/handlers/emailDigest.js';
import { MORNING_FALLBACK_HOUR } from './cognition/handlers/emailDigest.helpers.js';
import crypto from 'node:crypto';
import fs from 'node:fs';

function envInt(raw: string | undefined, fallback: number, min: number, max?: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < min) return fallback;
  if (max !== undefined && i > max) return fallback;
  return i;
}

const app = express();
const PORT = process.env.PORT || 3001;

const clientPort = process.env.CLIENT_PORT || '5173';
const corsOrigin: cors.CorsOptions['origin'] = (origin, cb) => {
  if (!origin) return cb(null, true);
  try {
    const u = new URL(origin);
    if (u.port !== clientPort) return cb(new Error('CORS: port mismatch'));
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return cb(null, true);
    if (u.hostname.endsWith('.ts.net')) return cb(null, true);
    return cb(new Error('CORS: origin not allowed'));
  } catch {
    return cb(new Error('CORS: bad origin'));
  }
};
app.use(cors({ origin: corsOrigin }));
app.use(express.json({ limit: '10mb' }));

// Initialize database
initDb();
cleanupAuditLog();
{
  const deleted = cleanupOldChatMessages();
  if (deleted > 0) {
    console.log(`[db] cleanupOldChatMessages: deleted ${deleted} rows older than CHAT_HISTORY_RETENTION_DAYS`);
  }
}

// Initialize PII proxy
const piiMode = (process.env.PII_MODE || 'optional') as 'required' | 'optional' | 'disabled';
let piiProxy;
let piiVault: PiiVault | null = null;
if (piiMode === 'disabled') {
  piiProxy = createPassthroughProxy();
} else {
  let encryptionKey = process.env.PII_ENCRYPTION_KEY;
  if (!encryptionKey) {
    encryptionKey = crypto.randomBytes(32).toString('hex');
    console.log('Generated PII_ENCRYPTION_KEY — add to .env to persist across restarts');
    try {
      const envPath = path.resolve(__dirname, '..', '..', '..', '.env');
      if (fs.existsSync(envPath)) {
        const envContent = fs.readFileSync(envPath, 'utf8');
        if (/^PII_ENCRYPTION_KEY=/m.test(envContent)) {
          fs.writeFileSync(envPath, envContent.replace(/^PII_ENCRYPTION_KEY=.*/m, `PII_ENCRYPTION_KEY=${encryptionKey}`));
        } else {
          fs.appendFileSync(envPath, `\nPII_ENCRYPTION_KEY=${encryptionKey}\n`);
        }
      }
    } catch (err) {
      console.warn('Could not persist PII_ENCRYPTION_KEY to .env:', err instanceof Error ? err.message : err);
    }
  }
  piiVault = new PiiVault(encryptionKey);
  piiVault.clearExpired();
  const entityTypes = (process.env.PII_ENTITY_TYPES || 'EMAIL_ADDRESS,PHONE_NUMBER,CREDIT_CARD,IBAN_CODE').split(',');
  const languages = (process.env.PII_LANGUAGES || 'en,ru,uk').split(',').map((s) => s.trim()).filter(Boolean);
  if (languages.length === 0) {
    throw new Error('PII_LANGUAGES must contain at least one language code');
  }
  const supportedLanguages = new Set(['en', 'ru', 'uk']);
  const invalidLanguages = languages.filter((l) => !supportedLanguages.has(l));
  if (invalidLanguages.length > 0) {
    throw new Error(
      `PII_LANGUAGES contains unsupported codes: ${invalidLanguages.join(', ')}. Supported: en, ru, uk`,
    );
  }
  piiProxy = createPiiProxy({
    encryptionKey,
    analyzerUrl: process.env.PRESIDIO_ANALYZER_URL || 'http://localhost:5002',
    anonymizerUrl: process.env.PRESIDIO_ANONYMIZER_URL || 'http://localhost:5001',
    entityTypes,
    languages,
    mode: piiMode,
  });
}

const VALID_EMBEDDING_MODES = ['auto', 'ollama', 'voyage'] as const;
const VALID_TEXT_MODES = ['auto', 'ollama', 'claude'] as const;
type EmbeddingProviderMode = (typeof VALID_EMBEDDING_MODES)[number];
type TextProviderMode = (typeof VALID_TEXT_MODES)[number];

function parseProviderMode<T extends string>(
  name: string,
  raw: string | undefined,
  valid: readonly T[],
): T {
  const value = (raw ?? 'auto') as T;
  if (!valid.includes(value)) {
    throw new Error(
      `Invalid ${name}=${raw}. Valid values: ${valid.join(', ')}`,
    );
  }
  return value;
}

// Setup
const client = createClaudeClient();
const localLlmMode = (process.env.LOCAL_LLM_MODE || 'enabled') as 'enabled' | 'disabled';
const memoryEnabled = (process.env.MEMORY_ENABLED ?? 'true') !== 'false';

const routerNeedsOllama = localLlmMode !== 'disabled';
// Validate provider modes up-front. Doing this before the loopback-PII guards
// below ensures a typo like `EMBEDDING_PROVIDER=voygae` surfaces as a clear
// "Invalid EMBEDDING_PROVIDER=voygae" error instead of being misclassified as
// "not ollama, not auto → remote provider" and falsely triggering the
// MEMORY_ALLOW_REMOTE_PII acknowledgement requirement.
const embeddingMode = memoryEnabled
  ? parseProviderMode('EMBEDDING_PROVIDER', process.env.EMBEDDING_PROVIDER, VALID_EMBEDDING_MODES)
  : 'auto';
const textMode = memoryEnabled
  ? parseProviderMode('MEMORY_TEXT_PROVIDER', process.env.MEMORY_TEXT_PROVIDER, VALID_TEXT_MODES)
  : 'auto';
// `auto` mode for both halves of memory must honor whether the operator
// actually configured an Ollama endpoint. Without OLLAMA_URL we cannot assume
// localhost — that would silently disable the documented auto→Voyage / auto→
// Claude fallback for laptop / API-only deployments (see README "Running R2
// without Ollama"). Explicit `=ollama` still creates a client and lets the
// provider factory surface a runtime error if the endpoint is unreachable.
const ollamaConfigured = !!process.env.OLLAMA_URL;
const embedUsesOllama =
  embeddingMode === 'ollama' ||
  (embeddingMode === 'auto' && ollamaConfigured);
const textUsesOllama =
  textMode === 'ollama' ||
  (textMode === 'auto' && ollamaConfigured && localLlmMode !== 'disabled');
const memoryNeedsOllama = memoryEnabled && (embedUsesOllama || textUsesOllama);

// Router intentionally skips PII anonymization for the Ollama path on the
// assumption that Ollama runs on the user's machine. If OLLAMA_URL points at a
// non-loopback host, that assumption breaks and raw user content (including
// PII) would cross the network. Refuse to start unless the operator has
// explicitly opted in via OLLAMA_ALLOW_REMOTE=1.
if (routerNeedsOllama || memoryNeedsOllama) {
  const rawUrl = process.env.OLLAMA_URL || 'http://localhost:11434';
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase();
    const isLoopback =
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host === '[::1]' ||
      host.endsWith('.localhost');
    if (!isLoopback && process.env.OLLAMA_ALLOW_REMOTE !== '1') {
      throw new Error(
        `OLLAMA_URL=${rawUrl} is not loopback. The Ollama path sends unmasked PII. ` +
          `Set OLLAMA_ALLOW_REMOTE=1 to acknowledge this risk. ` +
          `To skip Ollama entirely, set LOCAL_LLM_MODE=disabled, EMBEDDING_PROVIDER=voyage, MEMORY_TEXT_PROVIDER=claude.`,
      );
    }
  } catch (err) {
    if (err instanceof TypeError) {
      throw new Error(`OLLAMA_URL is not a valid URL: ${rawUrl}`);
    }
    throw err;
  }
}

// When memory uses Voyage or Claude, raw chat content and extracted facts
// (which can include emails, phone numbers, addresses) cross the network to
// those providers. The memory pipeline does NOT route through the PII proxy
// the way the Claude chat path does (see tool-loop.ts), so this is a real
// data boundary. Choosing a provider via env is not the same as accepting
// that PII leaves the machine — mirror the OLLAMA_ALLOW_REMOTE pattern and
// require an explicit acknowledgement via MEMORY_ALLOW_REMOTE_PII=1.
if (memoryEnabled) {
  // Use the same `embed/textUsesOllama` predicates computed above so the guard
  // tracks the actual resolved provider, including the auto→Voyage / auto→
  // Claude fallbacks when OLLAMA_URL is unset.
  const embeddingHalfRemote = !embedUsesOllama;
  const textHalfRemote = !textUsesOllama;
  const memoryUsesRemoteApi = embeddingHalfRemote || textHalfRemote;

  if (memoryUsesRemoteApi && process.env.MEMORY_ALLOW_REMOTE_PII !== '1') {
    throw new Error(
      `Memory is configured to use a remote provider ` +
        `(embedding=${embeddingMode}, text=${textMode}). ` +
        `Raw chat content and extracted facts — including any PII like emails, ` +
        `phone numbers, or addresses — will be sent to Voyage and/or Anthropic ` +
        `without anonymization. Set MEMORY_ALLOW_REMOTE_PII=1 to acknowledge this, ` +
        `or run memory locally via Ollama (EMBEDDING_PROVIDER=ollama, MEMORY_TEXT_PROVIDER=ollama).`,
    );
  }
}

const ollamaForRouter: OllamaClient | null = routerNeedsOllama ? createOllamaClient() : null;
const ollamaForMemory: OllamaClient | null = memoryNeedsOllama ? createOllamaClient() : null;

if (ollamaForRouter) {
  console.log('[router] Local LLM enabled via Ollama at', process.env.OLLAMA_URL || 'http://localhost:11434');
} else {
  console.log('[router] Local LLM disabled — all chat goes to Claude');
}
const reminderStore = createReminderStore({ db: getDb() });
const reminderService = createReminderService({ store: reminderStore, bus: reminderBus });
const stopScheduler = startScheduler({ store: reminderStore, db: getDb(), bus: reminderBus });

const emailStore = createEmailStore({ db: getDb() });
const imapAccounts = (() => {
  try {
    return parseImapAccounts(process.env.IMAP_ACCOUNTS);
  } catch (err) {
    console.error('[emails] IMAP_ACCOUNTS invalid:', err instanceof Error ? err.message : err);
    return [];
  }
})();
const emailEnabled = (process.env.EMAIL_ENABLED || 'true') !== 'false' && imapAccounts.length > 0;
// When the feature is disabled, hand `null` to tool-emails so `emails_list` /
// `emails_get` return a clear "not enabled" error instead of empty data or
// references to stale accounts.
const emailStoreForTool = emailEnabled ? emailStore : null;
const imapClientForTool = emailEnabled
  ? {
      fetchNewMessages,
      fetchFullBody,
      getAccount: (id: string) => imapAccounts.find((a) => a.id === id) ?? null,
    }
  : null;

const cognitionService = createCognitionService({
  db: getDb(),
  bus: reminderBus,
});
cognitionService.register(pulseHandler);
cognitionService.start();
// morningBrief is registered conditionally below — only after Discord bot
// actually starts. Otherwise nobody consumes `cognition_publish`, the brief
// is computed and `outcome='publish'` is recorded, but the user never sees
// it (and re-runs would burn tokens). See morningBrief code review #1.

const registry = createRegistry();
const pendingConfirms: PendingConfirms = new Map();
const permissionService = createPermissionService({ pending: pendingConfirms });
const pendingPlanReviews: PendingPlanReviews = new Map();
const planReviewService = createPlanReviewService({ pending: pendingPlanReviews });
const pendingMemoryConfirms: PendingMemoryConfirms = new Map();
const memoryConfirmService = createMemoryConfirmService({ pending: pendingMemoryConfirms });

function pickEmbeddingProvider(opts: {
  mode: EmbeddingProviderMode;
  ollama: OllamaClient | null;
  ollamaUrl: string;
  ollamaModel: string;
  voyageKey: string | undefined;
  voyageModel: string;
}): EmbeddingsClient | null {
  const { mode, ollama, ollamaUrl, ollamaModel, voyageKey, voyageModel } = opts;

  if (mode === 'ollama') {
    if (!ollama) {
      throw new Error('EMBEDDING_PROVIDER=ollama requires an Ollama client (memory must be enabled)');
    }
    return createOllamaEmbeddingsClient({ url: ollamaUrl, model: ollamaModel });
  }

  if (mode === 'voyage') {
    if (!voyageKey) throw new Error('EMBEDDING_PROVIDER=voyage requires VOYAGE_API_KEY');
    return createVoyageEmbeddingsClient({ apiKey: voyageKey, model: voyageModel });
  }

  // auto: prefer local Ollama if available, otherwise fall back to Voyage.
  if (ollama) {
    return createOllamaEmbeddingsClient({ url: ollamaUrl, model: ollamaModel });
  }
  if (voyageKey) {
    return createVoyageEmbeddingsClient({ apiKey: voyageKey, model: voyageModel });
  }
  return null;
}

function pickTextProvider(opts: {
  mode: TextProviderMode;
  ollama: OllamaClient | null;
  anthropic: Anthropic;
  localLlmMode: 'enabled' | 'disabled';
}): TextProvider {
  const { mode, ollama, anthropic, localLlmMode } = opts;

  if (mode === 'ollama') {
    if (!ollama || localLlmMode === 'disabled') {
      throw new Error('MEMORY_TEXT_PROVIDER=ollama requires ollama client and LOCAL_LLM_MODE!=disabled');
    }
    return createOllamaTextProvider(ollama);
  }

  if (mode === 'claude') {
    return createClaudeTextProvider(anthropic);
  }

  // auto: prefer local Ollama if both available, otherwise Claude.
  if (ollama && localLlmMode !== 'disabled') {
    return createOllamaTextProvider(ollama);
  }
  return createClaudeTextProvider(anthropic);
}

let memoryService: MemoryService | null = null;
if (memoryEnabled) {
  // Provider factories fail loudly on explicit-mode misconfiguration (e.g.
  // EMBEDDING_PROVIDER=voyage without VOYAGE_API_KEY). Auto mode returns null
  // when no provider is available, which is handled below.
  //
  // Only hand the Ollama client to the half that the bootstrap predicates
  // already resolved to Ollama. `ollamaForMemory` may have been created for
  // the *other* half (e.g. text=ollama + embed=auto with no OLLAMA_URL), and
  // letting the auto branch see a non-null client there would silently pick
  // Ollama@default-localhost, bypassing the auto→Voyage / auto→Claude fallback
  // the PII guard above already validated against.
  const embeddings: EmbeddingsClient | null = pickEmbeddingProvider({
    mode: embeddingMode,
    ollama: embedUsesOllama ? ollamaForMemory : null,
    ollamaUrl: process.env.OLLAMA_URL || 'http://localhost:11434',
    ollamaModel: process.env.MEMORY_EMBED_MODEL || 'mxbai-embed-large',
    voyageKey: process.env.VOYAGE_API_KEY,
    voyageModel: process.env.VOYAGE_MODEL || 'voyage-3',
  });

  // Resolve text provider before migration. Cheap, immediate check — running
  // ensureEmbedModelMatches first would spend embedding API calls (and Voyage
  // credits) on a DB rebuild that would then be discarded if text provider
  // construction throws.
  const textProvider: TextProvider = pickTextProvider({
    mode: textMode,
    ollama: textUsesOllama ? ollamaForMemory : null,
    anthropic: client.anthropic,
    localLlmMode,
  });

  if (!embeddings) {
    console.log('[memory] disabled — no embedding provider configured (set OLLAMA_URL or VOYAGE_API_KEY)');
  } else {
    let migrationOk = false;
    try {
      await ensureEmbedModelMatches(getDb(), embeddings);
      migrationOk = true;
    } catch (err) {
      console.error('[memory] migration failed, disabling memory:', err instanceof Error ? err.message : err);
    }

    if (migrationOk) {
      // Use the same predicate that gated `ollamaForMemory` into pickTextProvider
      // above. Recomputing from `!!ollamaForMemory` is unsafe: that client is
      // also non-null when only the embeddings half is Ollama, which would
      // mismatch the Claude provider with an Ollama model name (e.g.
      // `EMBEDDING_PROVIDER=ollama` + `MEMORY_TEXT_PROVIDER=auto` + no
      // OLLAMA_URL set → textProvider is Claude but extractorModel would be
      // qwen2.5:7b, causing every fact extraction to 404).
      const usingOllamaText = textUsesOllama;
      const extractorModel = usingOllamaText
        ? process.env.MEMORY_EXTRACT_MODEL || 'qwen2.5:7b'
        : process.env.MEMORY_EXTRACT_MODEL_CLAUDE || 'claude-haiku-4-5-20251001';

      const parsedMaxTokens = Number(process.env.MEMORY_MAX_CONTEXT_TOKENS);
      const maxContextTokens =
        Number.isFinite(parsedMaxTokens) && parsedMaxTokens > 0 ? parsedMaxTokens : 2000;

      memoryService = createMemoryService({
        db: getDb(),
        embeddings,
        textProvider,
        extractorModel,
        maxContextTokens,
      });
      console.log(
        `[memory] enabled (embeddings=${embeddings.identity}, text=${usingOllamaText ? 'ollama' : 'claude'}, model=${extractorModel})`,
      );
    }
  }
} else {
  console.log('[memory] disabled');
}

const serverStartedAt = Date.now();
const commandService = createCommandService({
  db: getDb(),
  reminderService,
  permissionService,
  memoryService,
  pendingConfirmsCount: () => pendingConfirms.size,
  pendingPlanReviewsCount: () => pendingPlanReviews.size,
  startedAt: serverStartedAt,
});
// Bound runLoop closure — tool factories use this for recursive agent calls
const runLoopFn = (params: {
  messages: any;
  onEvent: (event: any) => void;
  signal?: AbortSignal;
  pendingConfirms?: PendingConfirms;
  pendingPlanReviews?: PendingPlanReviews;
  pendingMemoryConfirms?: PendingMemoryConfirms;
  currentUserMessageId?: string;
  currentUserMessageTimestamp?: number;
}) =>
  runToolLoop({
    messages: params.messages,
    client,
    registry,
    onEvent: params.onEvent,
    signal: params.signal,
    pendingConfirms: params.pendingConfirms,
    pendingPlanReviews: params.pendingPlanReviews,
    pendingMemoryConfirms: params.pendingMemoryConfirms,
    piiProxy,
    currentUserMessageId: params.currentUserMessageId,
    currentUserMessageTimestamp: params.currentUserMessageTimestamp,
  });

// Now discover tools with deps (fills registry in-place)
await discoverTools(registry, {
  runLoop: runLoopFn,
  client,
  registry,
  piiProxy,
  memoryService,
  reminderStore,
  emailStore: emailStoreForTool,
  imapClient: imapClientForTool,
});

// Email poller lifecycle handles (hoisted so SIGTERM can clean them up).
let stopEmailPoller: (() => void) | null = null;
let emailPollerAbort: AbortController | null = null;

// Polling runs independently of Discord. email_pending feeds on-demand tools
// (emails_list/emails_get) as well as the digest handler; gating it on the
// Discord bot would leave those tools silently empty if Discord is off or
// fails to start at boot.
if (emailEnabled) {
  emailPollerAbort = new AbortController();
  const pollerAbort = emailPollerAbort;
  stopEmailPoller = startEmailPoller({
    accounts: imapAccounts,
    store: emailStore,
    fetcher: (acc, sinceUid, limit) => fetchNewMessages(acc, sinceUid, limit),
    maxUidProbe: getMaxUid,
    scorer: (msgs) =>
      scoreBatch(msgs, {
        piiProxy,
        ollama: ollamaForRouter,
        anthropic: client.anthropic,
        signal: pollerAbort.signal,
      }),
    intervalMs: envInt(process.env.EMAIL_POLL_INTERVAL_MS, 300_000, 1_000),
  });
  console.log(`[emails] poller started for ${imapAccounts.length} account(s)`);
} else {
  console.log('[emails] disabled (EMAIL_ENABLED=false or IMAP_ACCOUNTS empty)');
}

// Discord bot (optional — only starts if DISCORD_BOT_TOKEN is set)
let discordBot: { stop(): Promise<void> } | null = null;
const discordToken = process.env.DISCORD_BOT_TOKEN;
if (discordToken) {
  const rawIds = process.env.DISCORD_ALLOWED_USER_IDS || '';
  const ids = rawIds.split(',').map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) {
    throw new Error('DISCORD_BOT_TOKEN set but DISCORD_ALLOWED_USER_IDS empty');
  }
  const whitelist = new Set(ids);
  try {
    discordBot = await startDiscordBot({
      token: discordToken,
      whitelist,
      runChatRequest: (params) =>
        runChatRequest({
          ...params,
          signal: params.signal,
          pendingConfirms,
          pendingPlanReviews,
          pendingMemoryConfirms,
          piiProxy,
          ollama: ollamaForRouter,
          registry,
          memoryService,
          runLoop: runLoopFn,
        }),
      db: getDb(),
      historyLimit: getChatHistoryLimit(),
      saveMessage,
      memoryService,
      reminderBus,
      cognitionService,
      reminderService,
      permissionService,
      planReviewService,
      memoryConfirmService,
      commandService,
      requestTimeoutMs: (() => {
        const n = Number(process.env.DISCORD_REQUEST_TIMEOUT_MS);
        return Number.isFinite(n) && n > 0 ? n : 300_000;
      })(),
    });
    console.log(`[discord] bot started, whitelist size: ${whitelist.size}`);
    const webSearchTool = registry.get('web_search') ?? null;
    if (!webSearchTool) {
      console.warn('[morningBrief] web_search tool not registered — brief will run without weather lookup');
    }
    cognitionService.register(
      createMorningBriefHandler({
        piiProxy,
        anthropic: client.anthropic,
        ollama: ollamaForRouter,
        webSearchTool,
      }),
    );

    // Digest handler stays gated on Discord — it publishes via the cognition
    // bus and there is nobody else to consume the event today. Polling is
    // hoisted above so email_pending keeps filling regardless.
    if (emailEnabled) {
      cognitionService.register(
        createEmailDigestHandler({
          store: emailStore,
          tz: 'Europe/Kyiv',
          threshold: envInt(process.env.EMAIL_DIGEST_THRESHOLD, 3, 1),
          cooldownMs: envInt(process.env.EMAIL_DIGEST_COOLDOWN_MS, 7200_000, 0),
          // quietStart must exceed MORNING_FALLBACK_HOUR — otherwise the
          // evening-quiet window overlaps the morning fallback release and the
          // digest is permanently gated (inQuietHours and morningBriefPublishedToday
          // both trip on the same hour). quietStart=0 would also silently disable
          // the digest since `hour >= 0` is always true.
          quietStart: envInt(process.env.EMAIL_QUIET_HOUR_START, 22, MORNING_FALLBACK_HOUR + 1, 23),
        }),
      );
    }
  } catch (err) {
    console.error('[discord] bot failed to start:', err instanceof Error ? err.message : err);
    discordBot = null;
  }
}

const chatRouter = createChatRouter({
  runLoop: ({ messages, onEvent, signal, pendingConfirms: pc, pendingPlanReviews: ppr, pendingMemoryConfirms: pmc, piiProxy: pp, currentUserMessageId, currentUserMessageTimestamp }) =>
    runToolLoop({ messages, client, registry, onEvent, signal, pendingConfirms: pc, pendingPlanReviews: ppr, pendingMemoryConfirms: pmc, piiProxy: pp, currentUserMessageId, currentUserMessageTimestamp }),
  pendingConfirms,
  pendingPlanReviews,
  pendingMemoryConfirms,
  piiProxy,
  ollama: ollamaForRouter,
  registry,
  memoryService,
});

app.use('/api', chatRouter);
app.use('/api', createConfirmRouter({ service: permissionService }));
app.use('/api', createPlanReviewRouter({ service: planReviewService }));
app.use('/api', createMemoryConfirmRouter({ service: memoryConfirmService }));
app.use('/api', createPermissionsRouter());
app.use('/api', createMessagesRouter());
app.use('/api', createMergeRouter());
app.use('/api', createCommandsRouter(registry));
app.use('/api/reminder', createReminderRouter({ service: reminderService }));
app.use('/api/events', createEventsRouter({ bus: reminderBus, store: reminderStore }));
if (piiVault) {
  app.use('/api', createPiiRouter(piiVault));
}

app.get('/api/health', (_req, res) => {
  res.json({ status: 'R2 online', timestamp: new Date().toISOString() });
});

app.use(errorHandler);

const server = app.listen(Number(PORT), '127.0.0.1', () => {
  console.log(`R2 server running on http://localhost:${PORT}`);
  // Signal supervisor that worker is ready (no-op without supervisor)
  process.send?.({ type: 'ready' });
});

// Graceful shutdown on SIGTERM (from supervisor)
process.on('SIGTERM', async () => {
  console.log('Worker received SIGTERM, shutting down...');
  setTimeout(() => process.exit(1), 5000);
  stopScheduler();
  stopEmailPoller?.();
  emailPollerAbort?.abort();
  await cognitionService.stop().catch(() => {});
  await discordBot?.stop().catch(() => {});
  server.close(() => {
    closeDb();
    process.exit(0);
  });
});
