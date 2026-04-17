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
import { createEmbeddingsClient } from './memory/embeddings.js';
import { createMemoryService, type MemoryService } from './memory/service.js';
import { errorHandler } from './errors.js';
import { createPiiProxy, createPassthroughProxy } from './pii/proxy.js';
import { PiiVault } from './pii/vault.js';
import { startDiscordBot } from './channels/discord/bot.js';
import { runChatRequest } from './ai/router.js';
import crypto from 'node:crypto';
import fs from 'node:fs';

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

// Setup
const client = createClaudeClient();
const localLlmMode = (process.env.LOCAL_LLM_MODE || 'enabled') as 'enabled' | 'disabled';
const memoryEnabled = (process.env.MEMORY_ENABLED ?? 'true') !== 'false';

const routerNeedsOllama = localLlmMode !== 'disabled';
const memoryNeedsOllama = memoryEnabled;

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
          `To skip Ollama entirely, set both LOCAL_LLM_MODE=disabled and MEMORY_ENABLED=false.`,
      );
    }
  } catch (err) {
    if (err instanceof TypeError) {
      throw new Error(`OLLAMA_URL is not a valid URL: ${rawUrl}`);
    }
    throw err;
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

const registry = createRegistry();
const pendingConfirms: PendingConfirms = new Map();
const permissionService = createPermissionService({ pending: pendingConfirms });
const pendingPlanReviews: PendingPlanReviews = new Map();
const planReviewService = createPlanReviewService({ pending: pendingPlanReviews });

let memoryService: MemoryService | null = null;
if (memoryEnabled && ollamaForMemory) {
  const embeddings = createEmbeddingsClient({
    url: process.env.OLLAMA_URL || 'http://localhost:11434',
    model: process.env.MEMORY_EMBED_MODEL || 'nomic-embed-text',
  });
  const parsedMaxTokens = Number(process.env.MEMORY_MAX_CONTEXT_TOKENS);
  const maxContextTokens = Number.isFinite(parsedMaxTokens) && parsedMaxTokens > 0 ? parsedMaxTokens : 2000;
  memoryService = createMemoryService({
    db: getDb(),
    embeddings,
    ollama: ollamaForMemory,
    extractorModel: process.env.MEMORY_EXTRACT_MODEL || 'qwen2.5:7b',
    maxContextTokens,
  });
  console.log('[memory] enabled with model', process.env.MEMORY_EMBED_MODEL || 'nomic-embed-text');
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
  modelName: process.env.MODEL_NAME || 'claude-opus-4-7',
  startedAt: serverStartedAt,
});
// Bound runLoop closure — tool factories use this for recursive agent calls
const runLoopFn = (params: {
  messages: any;
  onEvent: (event: any) => void;
  signal?: AbortSignal;
  pendingConfirms?: PendingConfirms;
  pendingPlanReviews?: PendingPlanReviews;
}) =>
  runToolLoop({
    messages: params.messages,
    client,
    registry,
    onEvent: params.onEvent,
    signal: params.signal,
    pendingConfirms: params.pendingConfirms,
    pendingPlanReviews: params.pendingPlanReviews,
    piiProxy,
  });

// Now discover tools with deps (fills registry in-place)
await discoverTools(registry, {
  runLoop: runLoopFn,
  client,
  registry,
  piiProxy,
  memoryService,
  reminderStore,
});

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
      reminderService,
      permissionService,
      planReviewService,
      commandService,
      requestTimeoutMs: (() => {
        const n = Number(process.env.DISCORD_REQUEST_TIMEOUT_MS);
        return Number.isFinite(n) && n > 0 ? n : 300_000;
      })(),
    });
    console.log(`[discord] bot started, whitelist size: ${whitelist.size}`);
  } catch (err) {
    console.error('[discord] bot failed to start:', err instanceof Error ? err.message : err);
    discordBot = null;
  }
}

const chatRouter = createChatRouter({
  runLoop: ({ messages, onEvent, signal, pendingConfirms: pc, pendingPlanReviews: ppr, piiProxy: pp }) =>
    runToolLoop({ messages, client, registry, onEvent, signal, pendingConfirms: pc, pendingPlanReviews: ppr, piiProxy: pp }),
  pendingConfirms,
  pendingPlanReviews,
  piiProxy,
  ollama: ollamaForRouter,
  registry,
  memoryService,
});

app.use('/api', chatRouter);
app.use('/api', createConfirmRouter({ service: permissionService }));
app.use('/api', createPlanReviewRouter({ service: planReviewService }));
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
  await discordBot?.stop().catch(() => {});
  server.close(() => {
    closeDb();
    process.exit(0);
  });
});
