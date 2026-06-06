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
import { initDb, cleanupAuditLog, cleanupOldChatMessages, getChatHistoryLimit, closeDb, getDb, saveMessage, setTopicDetector } from './db.js';
import { createTopicStore } from './topics/store.js';
import { createTopicDetector, TOPIC_GAP_MS } from './topics/detector.js';
import { autocloseStaleOpenTopics } from './topics/startup.js';
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
import { createEmailSuppressionStore } from './emails/suppression-store.js';
import { createEmailFeedbackStore } from './emails/feedback-store.js';
import { fetchNewMessages, fetchFullBody, getMaxUid, getUidValidity, fetchHeaders, fetchFlagsForUids, markAnswered } from './emails/imap-client.js';
import { fetchThread } from './emails/thread-fetcher.js';
import { sendReply as sendSmtpReply } from './emails/smtp-client.js';
import { scoreBatch } from './emails/scorer.js';
import { startEmailPoller } from './emails/multi-account-poller.js';
import { createEmailDigestHandler } from './cognition/handlers/emailDigest.js';
import { createEmailUrgentHandler } from './cognition/handlers/emailUrgent.js';
import { createEmailActionMatchHandler } from './cognition/handlers/emailActionMatch.js';
import { createActionActivityMatchHandler } from './cognition/handlers/actionActivityMatch.js';
import { createDraftReplyService, type DraftState } from './services/draft-reply-service.js';
import { MORNING_FALLBACK_HOUR } from './cognition/handlers/emailDigest.helpers.js';
import { createTopicFinalizerHandler } from './topics/finalizer.js';
import { createEmailSentLog } from './emails/sent-log.js';
import { createWindowHistoryStore } from './observers/window-history-store.js';
import { createContextPingStore } from './observers/context-switch-detector.js';
import { createOsascriptProvider } from './observers/window-snapshot.js';
import { startWindowLogger } from './observers/window-logger.js';
import { createIoregIdleSource } from './observers/idle-source.js';
import { createPresenceStore } from './observers/presence-store.js';
import { createContextSwitchHandler } from './cognition/handlers/contextSwitch.js';
import { createDistractionEvalStore } from './observers/distraction-eval-store.js';
import { createDistractionHandler } from './cognition/handlers/distractionPullback.js';
import { fetchForecast, geocode, formatBriefOutlook, wmoToRu } from './weather/open-meteo.js';
import { resolveCoords } from './weather/coords.js';
import { createWeatherAlertStore, type WeatherAlertStore } from './weather/alert-store.js';
import { createWeatherAlertHandler } from './cognition/handlers/weatherAlert.js';
import type { BriefWeatherDeps } from './cognition/handlers/morningBrief.helpers.js';
import type { WeatherClientForTool, ResolveUserCoordsFn } from './tools/base.js';
import type { Coords } from './weather/types.js';
import { envInt } from './env-utils.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { handleFatalSignal } from './net/fatal-signal.js';
import { startReconnectLoop, guardOnce } from './net/reconnect-loop.js';

// Process-level safety net (root cause #1): a flapping network surfaces raw
// `ws` 'error' events / unhandled rejections below the discord.js Client layer.
// Without a handler Node aborts the whole worker. Transient blips are logged
// and swallowed; genuine faults exit(1) so the supervisor restarts cleanly.
const fatalSignalDeps = {
  onExit: (code: number) => process.exit(code),
  log: (level: 'warn' | 'error', msg: string, err: unknown) => {
    if (level === 'warn') console.warn(msg, err);
    else console.error(msg, err);
  },
};
process.on('uncaughtException', (err) => handleFatalSignal('uncaughtException', err, fatalSignalDeps));
process.on('unhandledRejection', (reason) => handleFatalSignal('unhandledRejection', reason, fatalSignalDeps));

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

// Topic store + detector: wired into saveMessage so every chat turn is
// linked to its conversation topic for later compaction/summarization.
const topicStore = createTopicStore({ db: getDb() });
const topicDetector = createTopicDetector({ store: topicStore, gapMs: TOPIC_GAP_MS });
setTopicDetector(topicDetector);
{
  const autoclosed = autocloseStaleOpenTopics(topicStore, TOPIC_GAP_MS, Date.now());
  if (autoclosed > 0) {
    console.log(`[topics] autoclosed ${autoclosed} stale open topics`);
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
const emailSentLog = createEmailSentLog({ db: getDb() });
const emailSuppressionStore = createEmailSuppressionStore({ db: getDb() });
// Hold zone before SMTP send for outgoing draft replies. 0 = bypass (instant
// send, restores pre-iter-3 behaviour — kill switch). Max 300s keeps under
// Discord's 15-min ephemeral webhook window with comfortable margin.
const emailSendHoldSeconds = envInt(process.env.EMAIL_SEND_HOLD_SECONDS, 30, 0, 300);
const imapAccounts = (() => {
  try {
    return parseImapAccounts(process.env.IMAP_ACCOUNTS);
  } catch (err) {
    console.error('[emails] IMAP_ACCOUNTS invalid:', err instanceof Error ? err.message : err);
    return [];
  }
})();
const emailEnabled = (process.env.EMAIL_ENABLED || 'true') !== 'false' && imapAccounts.length > 0;

// Implicit-feedback (Pain #1 iter 4) — learn from how the user reacts to urgent
// pings and auto-demote senders that keep getting ignored. Hard-gated on the
// feature flag AND email being enabled, so the default (flag unset) is zero
// behaviour change: no feedback rows recorded, no auto-suppression created, the
// urgent path untouched. All four knobs fall back to sane defaults via envInt.
const emailFeedbackEnabled =
  process.env.EMAIL_FEEDBACK_ENABLED === 'true' && emailEnabled;
const emailFeedbackStore = emailFeedbackEnabled
  ? createEmailFeedbackStore({ db: getDb() })
  : null;
const emailFeedbackIgnoreHours = envInt(process.env.EMAIL_FEEDBACK_IGNORE_HOURS, 24, 1, 168);
const emailFeedbackSuppressAfter = envInt(process.env.EMAIL_FEEDBACK_SUPPRESS_AFTER, 3, 1, 20);
const emailFeedbackSuppressTtlDays = envInt(process.env.EMAIL_FEEDBACK_SUPPRESS_TTL_DAYS, 7, 1, 90);
const emailFeedbackMaxRepoll = envInt(process.env.EMAIL_FEEDBACK_MAX_REPOLL, 50, 1, 500);
// After this many consecutive failed ticks an account is "blind" and we alert
// once (latched until the next successful poll clears the streak). Default 3 ×
// the 5-min interval ≈ 15 min of silence before escalating.
const emailBlindAlertAfter = envInt(process.env.EMAIL_ACCOUNT_BLIND_ALERT_AFTER, 3, 1, 100);
// When the feature is disabled, hand `null` to tool-emails so `emails_list` /
// `emails_get` return a clear "not enabled" error instead of empty data or
// references to stale accounts.
const emailStoreForTool = emailEnabled ? emailStore : null;
const imapClientForTool = emailEnabled
  ? {
      fetchNewMessages,
      fetchFullBody,
      getAccount: (id: string) => imapAccounts.find((a) => a.id === id) ?? null,
      listAccounts: () => imapAccounts,
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

// Email draft reply state lives in-memory only — drafts disappear on restart by
// design (force redo rather than persist half-written replies, see plan).
const pendingDrafts = new Map<string, DraftState>();
const draftReplyService = createDraftReplyService({ pendingDrafts });
const imapAccountsById = new Map(imapAccounts.map((a) => [a.id, a] as const));

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

      // Topic finalizer needs memoryService (for embedding + facts) and the
      // Claude Haiku model for summarization. Register inside the memory block
      // so the handler is only wired when memory is actually available — without
      // it summaries would have nowhere to go. The Haiku model is always the
      // *Claude* extractor: an Ollama text provider would not return reliable
      // structured JSON at the size and quality the summary spec needs.
      //
      // The finalizer sends raw topic transcripts to Anthropic. When memory is
      // configured local-only (Ollama), the upstream MEMORY_ALLOW_REMOTE_PII
      // gate has NOT been required of the operator, so registering Claude here
      // would leak PII the operator explicitly opted out of. Gate registration
      // on the same acknowledgement.
      if (usingOllamaText && process.env.MEMORY_ALLOW_REMOTE_PII !== '1') {
        console.warn(
          '[topicFinalizer] skipped: memory text provider is Ollama (local-only) ' +
            'and MEMORY_ALLOW_REMOTE_PII is not set. Topic summarization requires ' +
            'sending raw chat content to Anthropic Haiku. Set MEMORY_ALLOW_REMOTE_PII=1 ' +
            'to opt in, or topics will accumulate but never be summarized.',
        );
      } else {
        const haikuModel = process.env.MEMORY_EXTRACT_MODEL_CLAUDE || 'claude-haiku-4-5-20251001';
        const finalizerBufferMs = envInt(
          process.env.TOPIC_FINALIZER_BUFFER_MS,
          10 * 60_000,
          0,
        );
        const finalizerBatch = envInt(process.env.TOPIC_FINALIZER_BATCH, 5, 1, 50);
        const finalizerMaxFailures = envInt(
          process.env.TOPIC_FINALIZER_MAX_FAILURES,
          5,
          1,
          100,
        );
        cognitionService.register(
          createTopicFinalizerHandler({
            store: topicStore,
            memoryService,
            anthropic: client.anthropic,
            extractorModel: haikuModel,
            bufferMs: finalizerBufferMs,
            finalizeBatch: finalizerBatch,
            maxFailures: finalizerMaxFailures,
          }),
        );
        console.log('[topicFinalizer] registered');
      }
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
  emailStore: emailEnabled ? emailStore : undefined,
  emailSentLog: emailEnabled ? emailSentLog : undefined,
  emailSuppressionStore: emailEnabled ? emailSuppressionStore : undefined,
  emailFeedbackStore: emailFeedbackStore ?? undefined,
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

// ---- Weather (Open-Meteo) — bootstrap ----
// Constructed before discoverTools so the `weather` tool and morningBrief can
// share the same client + coordinate-resolver closures. Everything is gated on
// WEATHER_ENABLED; when off, all weather deps stay null (zero behaviour change:
// the tool reports "not enabled", the brief renders "погода недоступна", no
// alert handler is registered).
const weatherEnabled = process.env.WEATHER_ENABLED === 'true';
const weatherTz = process.env.WEATHER_TZ || 'Europe/Kyiv';
// Manual coordinate override — pins exact lat/lon when Open-Meteo doesn't know
// a small village (see Post-Completion). Both must be present and finite to take
// effect. Empty strings (WEATHER_LAT=) are the documented "off" form and must NOT
// override — Number('') is 0, which is finite, so trim+reject empty before parsing.
const weatherLatStr = (process.env.WEATHER_LAT ?? '').trim();
const weatherLonStr = (process.env.WEATHER_LON ?? '').trim();
const weatherLatRaw = Number(weatherLatStr);
const weatherLonRaw = Number(weatherLonStr);
const weatherOverride =
  weatherLatStr !== '' &&
  weatherLonStr !== '' &&
  Number.isFinite(weatherLatRaw) &&
  Number.isFinite(weatherLonRaw)
    ? { lat: weatherLatRaw, lon: weatherLonRaw }
    : undefined;
// Detection + alert knobs (out-of-range → default via envInt).
const weatherTempSwingC = envInt(process.env.WEATHER_TEMP_SWING_C, 8, 1, 30);
const weatherPrecipProbPct = envInt(process.env.WEATHER_PRECIP_PROB_PCT, 60, 0, 100);
const weatherLeadHours = envInt(process.env.WEATHER_LEAD_HOURS, 6, 1, 48);
const weatherCheckIntervalH = envInt(process.env.WEATHER_CHECK_INTERVAL_H, 3, 1, 24);
const weatherAlertDedupeH = envInt(process.env.WEATHER_ALERT_DEDUPE_H, 12, 1, 168);
const weatherQuietStart = envInt(process.env.WEATHER_QUIET_START, 22, 0, 23);
const weatherQuietEnd = envInt(process.env.WEATHER_QUIET_END, 8, 0, 23);

// Lookup the user's city the same way morningBrief.gatherData does — bypass the
// freshness window since location rarely gets re-mentioned but weather needs it.
function readUserCity(): string | null {
  const row = getDb()
    .prepare(
      "SELECT value FROM memory_facts WHERE key IN ('user.city','user.location') AND superseded_by IS NULL AND forgotten = 0 ORDER BY key = 'user.city' DESC, last_mentioned_at DESC LIMIT 1",
    )
    .get() as { value: string } | undefined;
  return row?.value ?? null;
}

let morningBriefWeather: BriefWeatherDeps | null = null;
let weatherClientForTool: WeatherClientForTool | null = null;
let resolveUserCoordsForTool: ResolveUserCoordsFn | null = null;
let weatherAlertStore: WeatherAlertStore | null = null;
if (weatherEnabled) {
  // Single home-city geocode closure (UA-biased) + resolver, shared by the
  // brief, the on-demand tool, and the alert boot below — one definition so the
  // `country: 'UA'` bias and the env override can't drift between copies.
  const geocodeHome = (name: string) => geocode(name, { country: 'UA' });
  const resolveUserCoords = async (): Promise<Coords | null> => {
    const city = readUserCity();
    if (city) {
      return resolveCoords(getDb(), city, geocodeHome, { override: weatherOverride });
    }
    // No city stored but coordinates pinned via env → still answer.
    if (weatherOverride) {
      return { city: 'сохранённые координаты', lat: weatherOverride.lat, lon: weatherOverride.lon };
    }
    return null;
  };
  morningBriefWeather = {
    // city may be null (no user.city/user.location fact). resolveCoords needs a
    // name to geocode, so when there's no city fall back to the env override
    // directly — same "pinned coords still answer" path as resolveUserCoords, so
    // the override stays authoritative for the brief too.
    resolveCoords: (db, city) => {
      if (city) {
        return resolveCoords(db, city, geocodeHome, { override: weatherOverride });
      }
      if (weatherOverride) {
        return Promise.resolve({
          city: 'сохранённые координаты',
          lat: weatherOverride.lat,
          lon: weatherOverride.lon,
        });
      }
      return Promise.resolve(null);
    },
    // Pin the configured forecast tz (WEATHER_TZ) so the brief buckets the
    // outlook the same way the on-demand tool and alert handler do — the
    // brief's civil/display TZ is a separate concern handled in gatherData.
    fetchForecast: (lat, lon) => fetchForecast(lat, lon, weatherTz),
  };
  weatherClientForTool = {
    tz: weatherTz,
    fetchForecast: (lat, lon, tz, days) => fetchForecast(lat, lon, tz, days),
    // Unpinned: the on-demand tool resolves any city worldwide (README contract).
    geocode: (name) => geocode(name),
    formatBriefOutlook,
    wmoToRu,
  };
  resolveUserCoordsForTool = resolveUserCoords;
  weatherAlertStore = createWeatherAlertStore({ db: getDb() });
  console.log(
    `[weather] enabled (tz=${weatherTz}${weatherOverride ? ', override coords' : ''})`,
  );
} else {
  console.log('[weather] disabled (WEATHER_ENABLED not true)');
}

// Digital Observer stores — created unconditionally (cheap prepared statements
// over always-migrated tables) and hoisted above discoverTools so the `activity`
// tool can read them, and so the Discord bot's "Show titles" button + the
// distract:* button handlers (constructed below) share one store instance. The
// poller + context-switch + distraction handlers that *write* stay gated on the
// feature flags below, so a disabled feature still produces no rows.
// Same-(app,title) samples only extend the latest session row when the pause
// since its last_seen_at is within this gap; a longer pause (e.g. an away gap)
// starts a fresh session so a focused-but-idle window can't stitch across it.
// Default 90s = 3× the 30s sampling interval. Floor 35s keeps it above one
// interval (avoids spurious splits on a single missed tick).
const windowSessionMaxGapMs = envInt(process.env.WINDOW_SESSION_MAX_GAP_MS, 90_000, 35_000, 600_000);
const windowStore = createWindowHistoryStore({ db: getDb(), maxGapMs: windowSessionMaxGapMs });
const distractionEvalStore = createDistractionEvalStore({ db: getDb() });
// Presence (away) store — created unconditionally over the always-migrated
// presence_log table (cheap prepared statements), so the `activity` tool can
// read away spans. The window logger that WRITES away spans stays gated on the
// feature flag below, so a disabled observer still records nothing.
const presenceStore = createPresenceStore({ db: getDb() });
// `activity` tool gate: with the Digital Observer off, inject a null store so the
// tool answers with a clear "observer disabled" instead of an empty digest.
const windowLoggerEnabled = process.env.WINDOW_LOGGER_ENABLED === 'true';

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
  weatherClient: weatherClientForTool,
  resolveUserCoords: resolveUserCoordsForTool,
  store: windowLoggerEnabled ? windowStore : null,
  evalStore: windowLoggerEnabled ? distractionEvalStore : null,
  presence: windowLoggerEnabled ? presenceStore : null,
});

// Email poller lifecycle handles (hoisted so SIGTERM can clean them up).
let stopEmailPoller: (() => void) | null = null;
let emailPollerAbort: AbortController | null = null;

// Window logger (Digital Observer) lifecycle handle, hoisted for SIGTERM.
let stopWindowLogger: (() => void) | null = null;
const distractionSnoozeMin = envInt(process.env.DISTRACTION_SNOOZE_MIN, 60, 5, 480);

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
    // Read mailbox UIDVALIDITY before each fetch so a provider mailbox-recreate
    // (UIDVALIDITY change → UIDs restart low) is detected instead of silently
    // blinding the watcher to all new mail.
    validityProbe: getUidValidity,
    // \Seen sync: every tick, re-check IMAP flags for awaiting (queue-visible,
    // non-urgent-pinged) emails and auto-dismiss any the user already read or
    // moved out of INBOX in Gmail — zero manual input, always-on (not gated on
    // EMAIL_FEEDBACK_ENABLED). Same underlying fetch as the feedback re-poll.
    flagFetcher: (acc, uids) => fetchFlagsForUids(acc, uids),
    onUidValidityReset: ({ account, previous, current }) => {
      console.warn(
        `[emails] UIDVALIDITY reset handled for ${account}: ${previous} → ${current}; watermark reset to current maxUid (backlog skipped).`,
      );
      // Sentinel runId: -1 — the poller is not a cognition handler and has no
      // cognition_handler_runs row. The bot's markPublished(-1) updates 0 rows
      // (harmless) and firePublished(-1) is a no-op; we only reuse the existing
      // cognition_publish → Discord DM render path. One reset event → one DM
      // (next tick sees stored == current and does not re-alert).
      reminderBus.emit('push', {
        type: 'cognition_publish',
        runId: -1,
        handler: 'email-poller',
        content: `⚠️ [emails] UIDVALIDITY сброс для ${account}: ${previous} → ${current}. Ящик пересоздан провайдером — watermark сброшен на текущий maxUid (backlog пропущен), ингест продолжится со следующего нового письма.`,
      });
    },
    // Blind-account escalation: after `blindAlertAfter` consecutive failed ticks
    // an account is stuck (R2 sees only the healthy mailbox). Alert once per
    // blind episode; the poller latches via `blind_alerted` and a successful
    // poll resets the streak so a recovered-then-re-blinded account alerts again.
    blindAlertAfter: emailBlindAlertAfter,
    onAccountBlind: ({ account, consecutive, lastError }) => {
      console.warn(
        `[emails] account BLIND: ${account} failed ${consecutive} consecutive ticks; last error: ${lastError}`,
      );
      // Only escalate to Discord when the bot is actually live (nobody consumes
      // cognition_publish otherwise — the warning above is the durable record).
      // The poller starts before the Discord bot, but a blind alert fires only
      // after several failed ticks, by which point the bot is up if it will be.
      if (discordBot === null) return;
      // Sentinel runId: -1 — see the onUidValidityReset note above. Reuses the
      // existing cognition_publish → Discord DM render path.
      reminderBus.emit('push', {
        type: 'cognition_publish',
        runId: -1,
        handler: 'email-poller',
        content: `⚠️ Почта ${account}: не поллится ${consecutive} тиков подряд — ${lastError}. Похоже, ящик ослеп (R2 видит только второй аккаунт). Проверь IMAP-доступ/пароль.`,
      });
    },
    scorer: (msgs) =>
      scoreBatch(msgs, {
        piiProxy,
        ollama: ollamaForRouter,
        anthropic: client.anthropic,
        signal: pollerAbort.signal,
      }),
    intervalMs: envInt(process.env.EMAIL_POLL_INTERVAL_MS, 300_000, 1_000),
    // Importance cutoff (scorer scale 1-5): emails scored >= this become pending;
    // below it they're fetched, scored, then dropped. Default 3 surfaces the
    // "worth noticing" tier and up; was the poller's hardcoded DEFAULT_CUTOFF (4,
    // action-required+). Out-of-range / unset → 3 (see envInt).
    importanceCutoff: envInt(process.env.EMAIL_IMPORTANCE_CUTOFF, 3, 1, 5),
    // Implicit-feedback resolution wiring. Absent (flag off) → the poll tick
    // skips the flag re-poll / finalization entirely (zero extra IMAP work).
    feedback: emailFeedbackStore
      ? {
          store: emailFeedbackStore,
          flagFetcher: (acc, uids) => fetchFlagsForUids(acc, uids),
          ignoreHours: emailFeedbackIgnoreHours,
          maxRepoll: emailFeedbackMaxRepoll,
          scorer: {
            suppressionStore: emailSuppressionStore,
            config: {
              // Count negatives over the same horizon the suppression lasts —
              // no separate lookback knob, so the window tracks the TTL.
              lookbackMs: emailFeedbackSuppressTtlDays * 86_400_000,
              suppressAfter: emailFeedbackSuppressAfter,
              suppressTtlDays: emailFeedbackSuppressTtlDays,
            },
          },
        }
      : undefined,
  });
  console.log(
    `[emails] poller started for ${imapAccounts.length} account(s)` +
      (emailFeedbackStore ? ' (implicit feedback enabled)' : ''),
  );
} else {
  console.log('[emails] disabled (EMAIL_ENABLED=false or IMAP_ACCOUNTS empty)');
}

// Discord bot (optional — only starts if DISCORD_BOT_TOKEN is set).
//
// Connect resilience (root #2): the first attempt runs inline (fast path). If it
// fails — a flapping VPN/DNS can keep Discord login from reaching the gateway — we
// do NOT leave R2 channel-less until a manual restart. A background loop retries
// with capped exponential backoff and, on the first success, registers every
// Discord-gated handler exactly once (guardOnce). The rest of R2 (HTTP, pollers)
// has already started, so it runs degraded until Discord attaches in the background.
let discordBot: { stop(): Promise<void> } | null = null;
let stopDiscordReconnect: (() => void) | null = null;
const discordToken = process.env.DISCORD_BOT_TOKEN;

// Every handler that publishes via the cognition bus and needs a live Discord
// consumer (morningBrief, emailDigest/actionMatch/urgent, window-logger +
// context-switch + action-activity, distraction, weatherAlert). guardOnce so the
// fast path and a later background reconnect can both call it without
// double-registering the handlers.
const registerDiscordGatedHandlers = guardOnce(async () => {
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
        // Open-Meteo forecast for the brief (null when WEATHER_ENABLED unset →
        // brief renders "погода недоступна" and falls back to web_search prose).
        weather: morningBriefWeather,
        // Open pending actions → "✓ Готово" buttons in the brief.
        topicStore,
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

      // Auto-close pending actions when a confirmation email arrives. Gated on
      // email like the digest (it reads email_pending); publishes a reversible
      // "↩ Вернуть" notice via the cognition bus, so it lives in the
      // Discord-started block alongside emailDigest.
      cognitionService.register(
        createEmailActionMatchHandler({
          emailStore,
          topicStore,
          anthropic: client.anthropic,
          ollama: ollamaForRouter,
          piiProxy,
          lookbackHours: envInt(process.env.EMAIL_ACTION_MATCH_LOOKBACK_H, 72, 1, 720),
        }),
      );
    }

  // emailUrgent gate. Distinct from the digest gate because the urgent handler
// re-triggers every tick on the same row until `onPublished` flips
// `urgent_pinged_at`; without a working Discord publisher that callback never
// fires, so the registration is hard-gated on `discordBot` being live.
{
  const urgentFlag = process.env.EMAIL_URGENT_ENABLED === 'true';
  const discordReady = discordBot !== null;
  if (emailEnabled && urgentFlag && discordReady) {
    cognitionService.register(
      createEmailUrgentHandler({
        store: emailStore,
        suppressionStore: emailSuppressionStore,
        feedbackStore: emailFeedbackStore ?? undefined,
        tz: 'Europe/Kyiv',
        quietStart: envInt(process.env.EMAIL_QUIET_HOUR_START, 22, MORNING_FALLBACK_HOUR + 1, 23),
      }),
    );
    console.log('[emails] urgent handler registered');
  } else if (emailEnabled) {
    console.log(`[emails] urgent handler disabled (flag=${urgentFlag}, discord=${discordReady})`);
  }
}

// Digital Observer (Pain #2 iter 1) — macOS-only window poller + context-switch
// detector. Three hard gates: feature flag, darwin platform (osascript is
// Apple-only), and a live Discord bot (the contextSwitch handler publishes via
// the cognition bus and there is nobody else to consume it — mirror emailUrgent).
{
  const windowFlag = process.env.WINDOW_LOGGER_ENABLED === 'true';
  const isDarwin = process.platform === 'darwin';
  const discordReady = discordBot !== null;
  // Old "restore when you come back" handler — gated behind its own flag
  // (default false) so it stays silent unless explicitly re-enabled. The
  // proactive distractionPullback handler (registered below) supersedes it.
  const contextSwitchFlag = process.env.CONTEXT_SWITCH_ENABLED === 'true';
  const windowIntervalMs = envInt(process.env.WINDOW_LOGGER_INTERVAL_MS, 30_000, 5_000, 300_000);
  const longSessionMin = envInt(process.env.CONTEXT_SWITCH_LONG_SESSION_MIN, 30, 10, 240);
  const switchGapMin = envInt(process.env.CONTEXT_SWITCH_GAP_MIN, 5, 1, 60);
  const stableNewMin = envInt(process.env.CONTEXT_SWITCH_STABLE_NEW_MIN, 5, 1, 60);
  const dedupeWindowH = envInt(process.env.CONTEXT_SWITCH_DEDUPE_WINDOW_H, 8, 1, 168);
  const blindAlertAfter = envInt(process.env.WINDOW_LOGGER_BLIND_ALERT_AFTER, 10, 1, 2880);
  // Idle seconds at or above which the user counts as "away" — that time is not
  // recorded as activity but written to presence_log instead. Default 5 min;
  // floor 1 min, ceiling 1h.
  const idleThresholdSec = envInt(process.env.IDLE_THRESHOLD_SEC, 300, 60, 3600);

  if (windowFlag && isDarwin && discordReady) {
    // Reuse the hoisted windowStore (also handed to the Discord bot above) so
    // the poller's writes and the "Show titles" button's reads share one store.
    const pingStore = createContextPingStore({ db: getDb() });
    const provider = createOsascriptProvider({ timeoutMs: 5_000 });
    // Real input-idle signal (macOS ioreg HIDIdleTime). Drives the away state
    // machine in the logger together with presenceStore + idleThresholdSec.
    const idleSource = createIoregIdleSource({ timeoutMs: 5_000 });
    stopWindowLogger = startWindowLogger({
      store: windowStore,
      provider,
      intervalMs: windowIntervalMs,
      idleSource,
      presence: presenceStore,
      idleThresholdSec,
      onError: (e) => console.error('[window-logger]', e instanceof Error ? e.message : e),
      blindAlertAfter,
      onBlind: ({ consecutive }) => {
        const mins = Math.round((consecutive * windowIntervalMs) / 60000);
        console.warn(
          `[window-logger] BLIND: no snapshot for ${consecutive} consecutive ticks (~${mins}m). Likely lost macOS Automation permission for System Events. Re-grant: System Settings → Privacy & Security → Automation → R2/node → System Events.`,
        );
        // Sentinel runId: -1 — the poller is not a cognition handler and has no
        // cognition_handler_runs row. The bot's markPublished(-1) updates 0 rows
        // (harmless) and firePublished(-1) is a no-op; we only reuse the existing
        // cognition_publish → Discord DM render path.
        reminderBus.emit('push', {
          type: 'cognition_publish',
          runId: -1,
          handler: 'window-logger',
          content: `⚠️ Digital Observer ослеп: нет снимков окна ~${mins} мин (${consecutive} тиков подряд). Похоже, потеряна Automation-привилегия (System Events). Re-grant: System Settings → Privacy & Security → Automation.`,
        });
      },
      // Recovery is log-only (don't spam Discord).
      onRecover: ({ blindFor }) =>
        console.warn(`[window-logger] recovered after ${blindFor} blind ticks; sampling resumed.`),
    });
    if (contextSwitchFlag) {
      cognitionService.register(
        createContextSwitchHandler({
          store: windowStore,
          pingStore,
          longSessionMin,
          switchGapMin,
          stableNewMin,
          dedupeWindowH,
        }),
      );
      console.log('[context-switch] handler registered');
    } else {
      console.log('[context-switch] handler disabled (CONTEXT_SWITCH_ENABLED unset)');
    }
    // Auto-close pending actions when the owner actually visits the page the
    // action points to (Pain #2 iter 3). Reads window_history URLs (captured by
    // the poller above) and matches host+path against each open action's
    // target_url; publishes a reversible "↩ Вернуть" notice via the cognition
    // bus, so it lives here alongside the poller it depends on.
    cognitionService.register(
      createActionActivityMatchHandler({
        windowHistoryStore: windowStore,
        topicStore,
        lookbackHours: envInt(process.env.ACTION_ACTIVITY_MATCH_LOOKBACK_H, 72, 1, 720),
      }),
    );
    console.log('[action-activity-match] handler registered');
    console.log(
      `[window-logger] started (interval=${Math.round(windowIntervalMs / 1000)}s, blind-alert=${blindAlertAfter}, idle-threshold=${idleThresholdSec}s, max-gap=${Math.round(windowSessionMaxGapMs / 1000)}s)`,
    );
  } else {
    console.log(
      `[window-logger] disabled (flag=${windowFlag}, darwin=${isDarwin}, discord=${discordReady})`,
    );
  }
}

// Distraction-pullback (Pain #2 iter 2) — proactive "catch the залип in the
// moment" handler. Same three gates as the window poller: feature flag, darwin,
// live Discord (it publishes a nudge via the cognition bus). Reads window_history
// (populated by the poller above, gated on WINDOW_LOGGER_ENABLED) so both flags
// must be on for it to see data — logged separately so a misconfig is visible.
{
  const distractionFlag = process.env.DISTRACTION_ENABLED === 'true';
  const isDarwin = process.platform === 'darwin';
  const discordReady = discordBot !== null;
  if (distractionFlag && isDarwin && discordReady) {
    cognitionService.register(
      createDistractionHandler({
        store: windowStore,
        evalStore: distractionEvalStore,
        anthropic: client.anthropic,
        model: process.env.DISTRACTION_JUDGE_MODEL || 'claude-haiku-4-5',
        dwellMin: envInt(process.env.DISTRACTION_DWELL_MIN, 25, 5, 240),
        workLookbackMin: envInt(process.env.DISTRACTION_WORK_LOOKBACK_MIN, 120, 10, 480),
        judgeLookbackMin: envInt(process.env.DISTRACTION_JUDGE_LOOKBACK_MIN, 60, 10, 480),
        dedupeH: envInt(process.env.DISTRACTION_DEDUPE_H, 3, 1, 168),
        reevalMin: envInt(process.env.DISTRACTION_REEVAL_MIN, 30, 5, 240),
        confidencePct: envInt(process.env.DISTRACTION_CONFIDENCE_PCT, 70, 0, 100),
        dailyCap: envInt(process.env.DISTRACTION_DAILY_LLM_CAP, 40, 1, 1000),
        // Reject a stale "last good" window row (logger went blind/stopped) once
        // it's older than 3 poll intervals — re-read the interval env the window
        // poller block uses so the two stay in lockstep without shared scope.
        freshnessMs: envInt(process.env.WINDOW_LOGGER_INTERVAL_MS, 30_000, 5_000, 300_000) * 3,
        snoozeMin: distractionSnoozeMin,
      }),
    );
    console.log('[distraction] pullback handler registered');
  } else {
    console.log(
      `[distraction] disabled (flag=${distractionFlag}, darwin=${isDarwin}, discord=${discordReady})`,
    );
  }
}

// weatherAlert (proactive change alert). Three gates: WEATHER_ALERT_ENABLED,
// resolvable coordinates (city stored or WEATHER_LAT/LON override), and a live
// Discord bot — it publishes the nudge via the cognition bus and there is
// nobody else to consume it (mirror emailUrgent). Coords are resolved once at
// startup so the per-tick `trigger` stays cheap (no network). Requires
// WEATHER_ENABLED (weatherAlertStore is null otherwise).
{
  const alertFlag = process.env.WEATHER_ALERT_ENABLED === 'true';
  const discordReady = discordBot !== null;
  if (weatherEnabled && alertFlag && discordReady && weatherAlertStore) {
    let coords: Coords | null = null;
    try {
      // Same resolver the on-demand tool uses (city → cached/geocoded coords,
      // env override wins) — shared so the alert and tool can't diverge.
      coords = (await resolveUserCoordsForTool?.()) ?? null;
    } catch (err) {
      console.warn(
        '[weatherAlert] coordinate resolution failed:',
        err instanceof Error ? err.message : err,
      );
    }
    if (coords) {
      cognitionService.register(
        createWeatherAlertHandler({
          store: weatherAlertStore,
          coords,
          tz: weatherTz,
          checkIntervalH: weatherCheckIntervalH,
          dedupeH: weatherAlertDedupeH,
          leadHours: weatherLeadHours,
          quietStart: weatherQuietStart,
          quietEnd: weatherQuietEnd,
          thresholds: {
            tempSwingC: weatherTempSwingC,
            precipProbPct: weatherPrecipProbPct,
          },
        }),
      );
      console.log(`[weatherAlert] handler registered (coords=${coords.lat},${coords.lon})`);
    } else {
      console.log('[weatherAlert] disabled (no resolvable coordinates — set city or WEATHER_LAT/LON)');
    }
  } else if (weatherEnabled && alertFlag) {
    console.log(`[weatherAlert] disabled (discord=${discordReady})`);
  }
}
});

if (discordToken) {
  const rawIds = process.env.DISCORD_ALLOWED_USER_IDS || '';
  const ids = rawIds.split(',').map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) {
    throw new Error('DISCORD_BOT_TOKEN set but DISCORD_ALLOWED_USER_IDS empty');
  }
  const whitelist = new Set(ids);
  // Single connect thunk reused by the fast path and the background retry loop.
  const connectDiscord = () =>
    startDiscordBot({
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
      topicStore,
      reminderBus,
      cognitionService,
      // Re-deliver undelivered proactive pushes on Discord (re)connect, but
      // only if fired within this window (default 6h) — don't surface a stale
      // brief. Valid range 5m..48h; out-of-range falls back to the 6h default.
      redeliverMaxAgeMs: envInt(process.env.REDELIVER_MAX_AGE_MS, 6 * 60 * 60 * 1000, 5 * 60 * 1000, 48 * 60 * 60 * 1000),
      reminderService,
      permissionService,
      planReviewService,
      memoryConfirmService,
      commandService,
      draftReplyService,
      emailStore: emailEnabled ? emailStore : undefined,
      // markAnswered exists only to feed the implicit-feedback resolver, so
      // only wire it when feedback is enabled — otherwise EMAIL_FEEDBACK_ENABLED=false
      // would still write \Answered to the mailbox, breaking the "zero behaviour
      // change when off" guarantee.
      imapClient: emailEnabled
        ? { fetchHeaders, ...(emailFeedbackEnabled ? { markAnswered } : {}) }
        : undefined,
      threadFetcher: emailEnabled ? { fetchThread } : undefined,
      anthropic: client.anthropic,
      imapAccounts: emailEnabled ? imapAccountsById : undefined,
      smtpClient: emailEnabled ? { sendReply: sendSmtpReply } : undefined,
      emailSendHoldSeconds,
      emailSentLog: emailEnabled ? emailSentLog : undefined,
      emailSuppressionStore: emailEnabled ? emailSuppressionStore : undefined,
      // Always pass piiProxy — at runtime it's a real anonymizer or a
      // passthrough depending on PII_GATEWAY_MODE. The interactions handler
      // anonymizes the email thread before sending to Claude (plan: outbound
      // draft prompt goes through PII proxy when memory uses Claude).
      piiProxy,
      // Read by the `window:show` button to reveal session titles as an
      // ephemeral. Passed unconditionally — when the feature is off no pings
      // (and thus no buttons) are ever created, so the store is never queried.
      windowHistoryStore: windowStore,
      // distract:* button feedback (back/work/snooze) writes here. Passed
      // unconditionally for the same reason as windowHistoryStore — no pings and
      // thus no buttons when the feature is off, so the store is never touched.
      distractionEvalStore,
      distractionSnoozeMin,
      requestTimeoutMs: (() => {
        const n = Number(process.env.DISCORD_REQUEST_TIMEOUT_MS);
        return Number.isFinite(n) && n > 0 ? n : 300_000;
      })(),
    });
  // Keep the connect attempt and the handler registration in separate steps.
  // If we wrapped both in one try and connect succeeded but registration threw,
  // the catch would null out an already-connected bot (leaking it) and spin up a
  // second one in the background — while guardOnce, having latched on the failed
  // first call, would never register the handlers at all (silent, channel-live
  // but proactive-handler-less). So: only the connect failure starts the retry
  // loop; registration runs after, and a genuine registration bug is allowed to
  // surface (the process net exits → supervisor restart) rather than be hidden.
  try {
    discordBot = await connectDiscord();
  } catch (err) {
    // Don't block bootstrap or null out the channel for good — hand off to a
    // background loop that keeps retrying with capped exponential backoff and
    // registers the gated handlers (exactly once) on the first success.
    console.error(
      '[discord] initial connect failed — starting background retry:',
      err instanceof Error ? err.message : err,
    );
    discordBot = null;
    // Backoff floor/ceiling (ms). Defaults 5s/300s; validated ranges so a bad
    // env can't wedge the loop into hammering or sleeping forever.
    const reconnectBaseMs = envInt(process.env.DISCORD_RECONNECT_BASE_MS, 5_000, 1_000, 60_000);
    const reconnectCapMs = envInt(process.env.DISCORD_RECONNECT_CAP_MS, 300_000, 5_000, 1_800_000);
    stopDiscordReconnect = startReconnectLoop({
      connect: connectDiscord,
      onConnect: async (bot) => {
        discordBot = bot;
        console.log('[discord] reconnected in background — registering gated handlers');
        await registerDiscordGatedHandlers();
      },
      baseMs: reconnectBaseMs,
      capMs: reconnectCapMs,
      log: (msg, e) => console.warn(msg, e instanceof Error ? e.message : e),
    });
  }
  if (discordBot) {
    console.log(`[discord] bot started, whitelist size: ${whitelist.size}`);
    await registerDiscordGatedHandlers();
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
  topicStore,
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

// Graceful shutdown, shared by SIGTERM and parent-death (IPC disconnect).
let shuttingDown = false;
async function gracefulShutdown(reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Worker shutting down (${reason})...`);
  setTimeout(() => process.exit(1), 5000);
  stopScheduler();
  stopEmailPoller?.();
  emailPollerAbort?.abort();
  stopWindowLogger?.();
  // Halt the Discord background connect-retry loop (no-op if the fast path
  // connected) so it can't keep firing during/after shutdown.
  stopDiscordReconnect?.();
  await cognitionService.stop().catch(() => {});
  await discordBot?.stop().catch(() => {});
  server.close(() => {
    closeDb();
    process.exit(0);
  });
}

// Graceful shutdown on SIGTERM (from supervisor on restart/stop).
process.on('SIGTERM', () => {
  void gracefulShutdown('SIGTERM');
});

// If the supervisor dies non-gracefully (SIGKILL/crash), the worker is reparented
// to launchd and keeps holding the server port — which blocks the wrapper's port
// guard and stops launchd from healing the supervisor. fork() gives us an IPC
// channel; its 'disconnect' fires when the parent goes away, so self-terminate to
// release the port. (No-op when run standalone without a supervisor: no channel.)
process.on('disconnect', () => {
  void gracefulShutdown('supervisor disconnected');
});
