import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkerManager } from './worker-manager.js';
import { StatusWsServer } from './ws-server.js';
import { startGitWatcher } from './git-watcher.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '..', '..', '..', '.env') });

const WS_PORT = parseInt(process.env.R2_SUPERVISOR_PORT || '3100', 10);
const SHUTDOWN_TIMEOUT = parseInt(process.env.R2_SHUTDOWN_TIMEOUT || '5000', 10);
const GIT_POLL_INTERVAL = parseInt(process.env.R2_GIT_POLL_INTERVAL || '60000', 10);
const GIT_WATCH_BRANCH = process.env.R2_GIT_WATCH_BRANCH || 'master';
const GIT_REPO_PATH = process.env.R2_GIT_REPO_PATH || path.resolve(__dirname, '..', '..', '..');

// Resolve worker entry point
const workerPath = path.resolve(__dirname, '..', '..', 'server', 'dist', 'index.js');

const manager = new WorkerManager({
  workerPath,
  shutdownTimeoutMs: SHUTDOWN_TIMEOUT,
});

const wsServer = new StatusWsServer({ port: WS_PORT });

// Wire WorkerManager events → WS broadcast
manager.on('worker_starting', () => {
  console.log('[supervisor] Worker starting...');
  wsServer.broadcast({ type: 'worker_starting' });
});

manager.on('worker_ready', () => {
  console.log('[supervisor] Worker ready');
  wsServer.broadcast({ type: 'worker_ready' });
});

manager.on('worker_crashed', (code: number | null, signal: string | null) => {
  console.log(`[supervisor] Worker crashed (code=${code}, signal=${signal})`);
  wsServer.broadcast({ type: 'worker_crashed', code, signal });
});

manager.on('worker_restarting', (delayMs: number) => {
  console.log(`[supervisor] Restarting worker in ${delayMs}ms...`);
  wsServer.broadcast({ type: 'worker_restarting', delayMs });
});

manager.on('worker_stopped', () => {
  console.log('[supervisor] Worker stopped');
  wsServer.broadcast({ type: 'worker_stopped' });
});

// Wire WS commands → WorkerManager
wsServer.onCommand((cmd) => {
  if (cmd.type === 'restart') {
    console.log('[supervisor] Restart requested via WebSocket');
    manager.restart();
  }
});

let stopWatcher: (() => void) | null = null;

// Graceful shutdown
function shutdown(signal: string) {
  console.log(`[supervisor] Received ${signal}, shutting down...`);
  stopWatcher?.();
  manager.stop();
  wsServer.close();
  // Allow event loop to drain for worker cleanup, then exit
  setTimeout(() => process.exit(0), SHUTDOWN_TIMEOUT + 1000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Start
console.log(`[supervisor] R2 supervisor v0.1.0`);
console.log(`[supervisor] WebSocket status on ws://localhost:${WS_PORT}`);
manager.start();

if (GIT_POLL_INTERVAL > 0) {
  stopWatcher = startGitWatcher({
    repoPath: GIT_REPO_PATH,
    branch: GIT_WATCH_BRANCH,
    intervalMs: GIT_POLL_INTERVAL,
    onNewCommit: (hash) => {
      console.log(
        `[supervisor] New commit on ${GIT_WATCH_BRANCH}: ${hash.slice(0, 7)} — restarting worker`,
      );
      manager.restart().catch((err) => {
        console.error('[supervisor] restart() failed:', err instanceof Error ? err.message : err);
      });
    },
  });
  console.log(
    `[supervisor] Git watcher polling ${GIT_WATCH_BRANCH} every ${GIT_POLL_INTERVAL}ms`,
  );
}
