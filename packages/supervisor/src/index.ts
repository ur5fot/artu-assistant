import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkerManager } from './worker-manager.js';
import { StatusWsServer } from './ws-server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '..', '..', '..', '.env') });

const WS_PORT = parseInt(process.env.R2_SUPERVISOR_PORT || '3100', 10);
const SHUTDOWN_TIMEOUT = parseInt(process.env.R2_SHUTDOWN_TIMEOUT || '5000', 10);

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

// Wire WS commands → WorkerManager
wsServer.onCommand((cmd) => {
  if (cmd.type === 'restart') {
    console.log('[supervisor] Restart requested via WebSocket');
    manager.restart();
  }
  if (cmd.type === 'status') {
    // Current status already sent on connect
  }
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[supervisor] Received SIGTERM, shutting down...');
  manager.stop();
  wsServer.close();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('[supervisor] Received SIGINT, shutting down...');
  manager.stop();
  wsServer.close();
  process.exit(0);
});

// Start
console.log(`[supervisor] R2 supervisor v0.1.0`);
console.log(`[supervisor] WebSocket status on ws://localhost:${WS_PORT}`);
manager.start();
