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
import { createClaudeClient } from './ai/claude.js';
import { runToolLoop } from './ai/tool-loop.js';
import { discoverTools } from './tools/registry.js';
import { initDb, cleanupAuditLog, closeDb } from './db.js';
import { errorHandler } from './errors.js';
import { createPiiProxy, createPassthroughProxy } from './pii/proxy.js';
import { PiiVault } from './pii/vault.js';
import crypto from 'node:crypto';
import fs from 'node:fs';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: `http://localhost:${process.env.CLIENT_PORT || 5173}` }));
app.use(express.json({ limit: '10mb' }));

// Initialize database
initDb();
cleanupAuditLog();

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
  piiProxy = createPiiProxy({
    encryptionKey,
    analyzerUrl: process.env.PRESIDIO_ANALYZER_URL || 'http://localhost:5002',
    anonymizerUrl: process.env.PRESIDIO_ANONYMIZER_URL || 'http://localhost:5001',
    entityTypes,
    mode: piiMode,
  });
}

// Setup
const client = createClaudeClient();
const registry = await discoverTools();
const pendingConfirms: PendingConfirms = new Map();
const pendingPlanReviews: PendingPlanReviews = new Map();

const chatRouter = createChatRouter({
  runLoop: ({ messages, onEvent, signal, pendingConfirms: pc, pendingPlanReviews: ppr, piiProxy: pp }) =>
    runToolLoop({ messages, client, registry, onEvent, signal, pendingConfirms: pc, pendingPlanReviews: ppr, piiProxy: pp }),
  pendingConfirms,
  pendingPlanReviews,
  piiProxy,
});

app.use('/api', chatRouter);
app.use('/api', createConfirmRouter(pendingConfirms));
app.use('/api', createPlanReviewRouter(pendingPlanReviews));
app.use('/api', createPermissionsRouter());
app.use('/api', createMessagesRouter());
app.use('/api', createMergeRouter());
if (piiVault) {
  app.use('/api', createPiiRouter(piiVault));
}

app.get('/api/health', (_req, res) => {
  res.json({ status: 'R2 online', timestamp: new Date().toISOString() });
});

app.use(errorHandler);

const server = app.listen(PORT, () => {
  console.log(`R2 server running on http://localhost:${PORT}`);
  // Signal supervisor that worker is ready (no-op without supervisor)
  process.send?.({ type: 'ready' });
});

// Graceful shutdown on SIGTERM (from supervisor)
process.on('SIGTERM', () => {
  console.log('Worker received SIGTERM, shutting down...');
  server.close(() => {
    closeDb();
    process.exit(0);
  });
  // Force exit if close takes too long
  setTimeout(() => process.exit(1), 5000);
});
