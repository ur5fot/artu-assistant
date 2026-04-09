# Supervisor + Worker Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split R2 into supervisor (process manager on port 3100) and worker (existing Express server on port 3001) with WebSocket status events and auto-restart.

**Architecture:** New `@r2/supervisor` package manages worker lifecycle via child_process.fork(). Supervisor broadcasts worker status over WebSocket. Client connects to both: worker for chat (HTTP/SSE), supervisor for status (WS). Dev workflow unchanged — supervisor is prod-only.

**Tech Stack:** Node.js child_process, ws (WebSocket), EventEmitter, Vitest

---

### Task 1: Scaffold `@r2/supervisor` package

**Files:**
- Create: `packages/supervisor/package.json`
- Create: `packages/supervisor/tsconfig.json`
- Create: `packages/supervisor/src/index.ts` (placeholder)

- [ ] **Step 1: Create package.json**

Create `packages/supervisor/package.json`:

```json
{
  "name": "@r2/supervisor",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "start": "node dist/index.js",
    "build": "tsc",
    "dev": "tsx src/index.ts",
    "test": "vitest run"
  },
  "dependencies": {
    "ws": "^8.16.0",
    "dotenv": "^16.4.0"
  },
  "devDependencies": {
    "@types/ws": "^8.5.10",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

Create `packages/supervisor/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create placeholder entry point**

Create `packages/supervisor/src/index.ts`:

```typescript
console.log('R2 supervisor starting...');
```

- [ ] **Step 4: Install dependencies**

Run: `npm install`
Expected: workspaces resolve, no errors.

- [ ] **Step 5: Verify typecheck**

Run: `npx tsc --noEmit -p packages/supervisor/tsconfig.json`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/supervisor/
git commit -m "feat: scaffold @r2/supervisor package"
```

---

### Task 2: WorkerManager — spawn and IPC ready signal

**Files:**
- Create: `packages/supervisor/src/worker-manager.ts`
- Create: `packages/supervisor/src/worker-manager.test.ts`

- [ ] **Step 1: Write failing tests for spawn and ready**

Create `packages/supervisor/src/worker-manager.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { WorkerManager } from './worker-manager.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('WorkerManager', () => {
  let manager: WorkerManager;

  afterEach(() => {
    manager?.stop();
  });

  it('spawns worker and receives ready signal', async () => {
    // Use a small test script that sends ready immediately
    const testWorker = path.resolve(__dirname, '__fixtures__/mock-worker.ts');
    manager = new WorkerManager({ workerPath: testWorker, useTsx: true });

    const readyPromise = new Promise<void>((resolve) => {
      manager.on('worker_ready', () => resolve());
    });

    manager.start();
    await readyPromise;

    expect(manager.status).toBe('running');
  });

  it('emits worker_starting on start', () => {
    const testWorker = path.resolve(__dirname, '__fixtures__/mock-worker.ts');
    manager = new WorkerManager({ workerPath: testWorker, useTsx: true });

    const events: string[] = [];
    manager.on('worker_starting', () => events.push('starting'));

    manager.start();
    expect(events).toContain('starting');
  });

  it('emits worker_crashed when worker exits with non-zero code', async () => {
    const testWorker = path.resolve(__dirname, '__fixtures__/crash-worker.ts');
    manager = new WorkerManager({
      workerPath: testWorker,
      useTsx: true,
      maxCrashesInWindow: 10, // high limit so no pause
    });

    const crashPromise = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      manager.on('worker_crashed', (code, signal) => resolve({ code, signal }));
    });

    manager.start();
    const result = await crashPromise;

    expect(result.code).toBe(1);
    expect(manager.status).toBe('restarting');
  });

  it('does not auto-restart when stopped gracefully', async () => {
    const testWorker = path.resolve(__dirname, '__fixtures__/mock-worker.ts');
    manager = new WorkerManager({ workerPath: testWorker, useTsx: true });

    await new Promise<void>((resolve) => {
      manager.on('worker_ready', () => resolve());
      manager.start();
    });

    const restartEvents: string[] = [];
    manager.on('worker_restarting', () => restartEvents.push('restarting'));

    manager.stop();

    // Wait a bit to confirm no restart
    await new Promise((r) => setTimeout(r, 200));
    expect(restartEvents).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Create test fixtures**

Create `packages/supervisor/src/__fixtures__/mock-worker.ts`:

```typescript
// Simulates a worker that starts and sends ready
process.send?.({ type: 'ready' });

// Keep alive until killed
const interval = setInterval(() => {}, 60000);
process.on('SIGTERM', () => {
  clearInterval(interval);
  process.exit(0);
});
```

Create `packages/supervisor/src/__fixtures__/crash-worker.ts`:

```typescript
// Simulates a worker that crashes immediately
process.exit(1);
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd packages/supervisor && npx vitest run src/worker-manager.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement WorkerManager**

Create `packages/supervisor/src/worker-manager.ts`:

```typescript
import { fork, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

export interface WorkerManagerOptions {
  workerPath: string;
  useTsx?: boolean;
  shutdownTimeoutMs?: number;
  maxCrashesInWindow?: number;
  crashWindowMs?: number;
  pauseAfterMaxCrashesMs?: number;
}

type WorkerStatus = 'stopped' | 'starting' | 'running' | 'restarting' | 'crashed';

const BACKOFF_DELAYS = [0, 2000, 5000];

export class WorkerManager extends EventEmitter {
  private worker: ChildProcess | null = null;
  private _status: WorkerStatus = 'stopped';
  private stopping = false;
  private crashTimestamps: number[] = [];
  private restartCount = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly workerPath: string;
  private readonly useTsx: boolean;
  private readonly shutdownTimeoutMs: number;
  private readonly maxCrashesInWindow: number;
  private readonly crashWindowMs: number;
  private readonly pauseAfterMaxCrashesMs: number;

  constructor(options: WorkerManagerOptions) {
    super();
    this.workerPath = options.workerPath;
    this.useTsx = options.useTsx ?? false;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? 5000;
    this.maxCrashesInWindow = options.maxCrashesInWindow ?? 3;
    this.crashWindowMs = options.crashWindowMs ?? 60000;
    this.pauseAfterMaxCrashesMs = options.pauseAfterMaxCrashesMs ?? 30000;
  }

  get status(): WorkerStatus {
    return this._status;
  }

  start(): void {
    if (this.worker) return;
    this.stopping = false;
    this.spawn();
  }

  stop(): void {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.worker) {
      this.killWorker();
    }
    this._status = 'stopped';
  }

  async restart(): Promise<void> {
    this.stopping = false;
    if (this.worker) {
      this._status = 'restarting';
      this.emit('worker_restarting', 0);
      await this.killWorkerAsync();
    }
    this.spawn();
  }

  private spawn(): void {
    this._status = 'starting';
    this.emit('worker_starting');

    const execArgv = this.useTsx
      ? ['--import', 'tsx']
      : [];

    this.worker = fork(this.workerPath, [], {
      stdio: ['pipe', 'inherit', 'inherit', 'ipc'],
      execArgv,
      env: { ...process.env },
    });

    this.worker.on('message', (msg: unknown) => {
      if (typeof msg === 'object' && msg !== null && 'type' in msg) {
        const typed = msg as { type: string };
        if (typed.type === 'ready') {
          this._status = 'running';
          this.restartCount = 0;
          this.emit('worker_ready');
        }
      }
    });

    this.worker.on('exit', (code, signal) => {
      this.worker = null;

      if (this.stopping) {
        this._status = 'stopped';
        return;
      }

      this._status = 'crashed';
      this.emit('worker_crashed', code, signal);
      this.scheduleRestart();
    });
  }

  private scheduleRestart(): void {
    const now = Date.now();
    this.crashTimestamps.push(now);
    this.crashTimestamps = this.crashTimestamps.filter((t) => now - t < this.crashWindowMs);

    let delayMs: number;
    if (this.crashTimestamps.length >= this.maxCrashesInWindow) {
      delayMs = this.pauseAfterMaxCrashesMs;
      this.crashTimestamps = [];
      this.restartCount = 0;
      console.log(`[supervisor] ${this.maxCrashesInWindow} crashes in ${this.crashWindowMs / 1000}s — pausing ${delayMs / 1000}s`);
    } else {
      delayMs = BACKOFF_DELAYS[Math.min(this.restartCount, BACKOFF_DELAYS.length - 1)];
      this.restartCount++;
    }

    this._status = 'restarting';
    this.emit('worker_restarting', delayMs);

    if (delayMs === 0) {
      this.spawn();
    } else {
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        this.spawn();
      }, delayMs);
    }
  }

  private killWorker(): void {
    if (!this.worker) return;
    this.worker.kill('SIGTERM');
    const pid = this.worker.pid;
    setTimeout(() => {
      try {
        if (pid) process.kill(pid, 0); // check if still alive
        if (pid) process.kill(pid, 'SIGKILL');
      } catch {
        // already dead
      }
    }, this.shutdownTimeoutMs);
  }

  private killWorkerAsync(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.worker) {
        resolve();
        return;
      }
      const onExit = () => resolve();
      this.worker.once('exit', onExit);
      this.killWorker();
    });
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/supervisor && npx vitest run src/worker-manager.test.ts`
Expected: all 4 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/supervisor/src/worker-manager.ts packages/supervisor/src/worker-manager.test.ts packages/supervisor/src/__fixtures__/
git commit -m "feat: add WorkerManager with spawn, IPC ready, and auto-restart"
```

---

### Task 3: WebSocket server for status broadcast

**Files:**
- Create: `packages/supervisor/src/ws-server.ts`
- Create: `packages/supervisor/src/ws-server.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/supervisor/src/ws-server.test.ts`:

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import { StatusWsServer } from './ws-server.js';
import WebSocket from 'ws';

describe('StatusWsServer', () => {
  let server: StatusWsServer;

  afterEach(() => {
    server?.close();
  });

  it('accepts connections and sends current status on connect', async () => {
    server = new StatusWsServer({ port: 0 }); // random port
    const port = server.port;

    const ws = new WebSocket(`ws://localhost:${port}`);
    const message = await new Promise<string>((resolve) => {
      ws.on('message', (data) => resolve(data.toString()));
    });

    const parsed = JSON.parse(message);
    expect(parsed.type).toBe('worker_stopped');
    ws.close();
  });

  it('broadcasts events to all connected clients', async () => {
    server = new StatusWsServer({ port: 0 });
    const port = server.port;

    const ws1 = new WebSocket(`ws://localhost:${port}`);
    const ws2 = new WebSocket(`ws://localhost:${port}`);

    // Wait for initial status messages
    await Promise.all([
      new Promise<void>((r) => ws1.on('message', () => r())),
      new Promise<void>((r) => ws2.on('message', () => r())),
    ]);

    // Broadcast an event
    const messages: string[] = [];
    ws1.on('message', (data) => messages.push(data.toString()));
    ws2.on('message', (data) => messages.push(data.toString()));

    server.broadcast({ type: 'worker_ready' });

    // Wait for delivery
    await new Promise((r) => setTimeout(r, 100));

    expect(messages.filter((m) => JSON.parse(m).type === 'worker_ready')).toHaveLength(2);

    ws1.close();
    ws2.close();
  });

  it('handles restart command from client', async () => {
    server = new StatusWsServer({ port: 0 });
    const port = server.port;

    const commands: string[] = [];
    server.onCommand((cmd) => commands.push(cmd.type));

    const ws = new WebSocket(`ws://localhost:${port}`);
    await new Promise<void>((r) => ws.on('open', () => r()));

    // Skip initial status message
    await new Promise<void>((r) => ws.on('message', () => r()));

    ws.send(JSON.stringify({ type: 'restart' }));

    await new Promise((r) => setTimeout(r, 100));
    expect(commands).toContain('restart');

    ws.close();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/supervisor && npx vitest run src/ws-server.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement WebSocket server**

Create `packages/supervisor/src/ws-server.ts`:

```typescript
import { WebSocketServer, WebSocket } from 'ws';

export interface SupervisorEvent {
  type: 'worker_starting' | 'worker_ready' | 'worker_crashed' | 'worker_restarting' | 'worker_stopped';
  code?: number | null;
  signal?: string | null;
  delayMs?: number;
}

export interface SupervisorCommand {
  type: 'restart' | 'status';
}

export class StatusWsServer {
  private wss: WebSocketServer;
  private currentStatus: SupervisorEvent = { type: 'worker_stopped' };
  private commandHandler: ((cmd: SupervisorCommand) => void) | null = null;

  constructor(options: { port: number }) {
    this.wss = new WebSocketServer({ port: options.port });

    this.wss.on('connection', (ws) => {
      // Send current status on connect
      ws.send(JSON.stringify(this.currentStatus));

      ws.on('message', (data) => {
        try {
          const cmd = JSON.parse(data.toString()) as SupervisorCommand;
          if (cmd.type && this.commandHandler) {
            this.commandHandler(cmd);
          }
        } catch {
          // ignore invalid messages
        }
      });
    });
  }

  get port(): number {
    const addr = this.wss.address();
    if (typeof addr === 'object' && addr !== null) {
      return addr.port;
    }
    return 0;
  }

  broadcast(event: SupervisorEvent): void {
    this.currentStatus = event;
    const data = JSON.stringify(event);
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  }

  onCommand(handler: (cmd: SupervisorCommand) => void): void {
    this.commandHandler = handler;
  }

  close(): void {
    for (const client of this.wss.clients) {
      client.close();
    }
    this.wss.close();
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/supervisor && npx vitest run src/ws-server.test.ts`
Expected: all 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/supervisor/src/ws-server.ts packages/supervisor/src/ws-server.test.ts
git commit -m "feat: add WebSocket server for supervisor status broadcast"
```

---

### Task 4: Supervisor entry point — wire everything together

**Files:**
- Modify: `packages/supervisor/src/index.ts`

- [ ] **Step 1: Implement supervisor entry point**

Replace `packages/supervisor/src/index.ts`:

```typescript
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
```

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit -p packages/supervisor/tsconfig.json`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/supervisor/src/index.ts
git commit -m "feat: wire supervisor entry point with WorkerManager and WS server"
```

---

### Task 5: Worker changes — IPC ready signal and graceful shutdown

**Files:**
- Modify: `packages/server/src/index.ts`

- [ ] **Step 1: Add IPC ready signal and SIGTERM handler**

In `packages/server/src/index.ts`, replace the `app.listen` block (lines 95-97) with:

```typescript
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
```

- [ ] **Step 2: Run existing server tests**

Run: `cd packages/server && npx vitest run`
Expected: all existing tests PASS (changes are in startup code, not tested directly).

- [ ] **Step 3: Run typecheck**

Run: `npx tsc --noEmit -p packages/server/tsconfig.json`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/index.ts
git commit -m "feat: add IPC ready signal and graceful shutdown to worker"
```

---

### Task 6: Root package.json — production start script

**Files:**
- Modify: `package.json` (root)
- Modify: `.env.example`

- [ ] **Step 1: Add start scripts to root package.json**

In the root `package.json`, add to `scripts`:

```json
{
  "scripts": {
    "dev": "docker compose up -d; concurrently \"npm run dev:server\" \"npm run dev:client\"",
    "dev:server": "npm run dev -w @r2/server",
    "dev:client": "npm run dev -w @r2/client",
    "start": "node packages/supervisor/dist/index.js",
    "start:build": "npm run build -w @r2/shared && npm run build -w @r2/server && npm run build -w @r2/supervisor && npm start",
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

- [ ] **Step 2: Add supervisor env vars to .env.example**

Append to `.env.example`:

```bash
# Supervisor (Phase 3A)
R2_SUPERVISOR_PORT=3100
R2_SHUTDOWN_TIMEOUT=5000
```

- [ ] **Step 3: Commit**

```bash
git add package.json .env.example
git commit -m "feat: add production start scripts and supervisor env vars"
```

---

### Task 7: Client — useSupervisor hook and status indicator

**Files:**
- Create: `packages/client/src/hooks/useSupervisor.ts`
- Modify: `packages/client/src/App.tsx`

- [ ] **Step 1: Create useSupervisor hook**

Create `packages/client/src/hooks/useSupervisor.ts`:

```typescript
import { useState, useEffect, useRef, useCallback } from 'react';

type WorkerStatus = 'running' | 'starting' | 'crashed' | 'restarting' | 'unknown';

interface SupervisorState {
  workerStatus: WorkerStatus;
  connected: boolean;
}

const WS_URL = import.meta.env.VITE_SUPERVISOR_WS_URL || 'ws://localhost:3100';
const RECONNECT_DELAYS = [1000, 2000, 5000, 10000];

function eventToStatus(type: string): WorkerStatus {
  switch (type) {
    case 'worker_ready': return 'running';
    case 'worker_starting': return 'starting';
    case 'worker_crashed': return 'crashed';
    case 'worker_restarting': return 'restarting';
    case 'worker_stopped': return 'starting';
    default: return 'unknown';
  }
}

export function useSupervisor(): SupervisorState {
  const [state, setState] = useState<SupervisorState>({
    workerStatus: 'running',
    connected: false,
  });
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttempt = useRef(0);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN || wsRef.current?.readyState === WebSocket.CONNECTING) {
      return;
    }

    try {
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        reconnectAttempt.current = 0;
        setState((prev) => ({ ...prev, connected: true }));
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type) {
            setState({
              workerStatus: eventToStatus(data.type),
              connected: true,
            });
          }
        } catch {
          // ignore invalid messages
        }
      };

      ws.onclose = () => {
        wsRef.current = null;
        setState({ workerStatus: 'running', connected: false });
        scheduleReconnect();
      };

      ws.onerror = () => {
        ws.close();
      };
    } catch {
      setState({ workerStatus: 'running', connected: false });
      scheduleReconnect();
    }
  }, []);

  const scheduleReconnect = useCallback(() => {
    const delay = RECONNECT_DELAYS[Math.min(reconnectAttempt.current, RECONNECT_DELAYS.length - 1)];
    reconnectAttempt.current++;
    reconnectTimer.current = setTimeout(() => {
      reconnectTimer.current = null;
      connect();
    }, delay);
  }, [connect]);

  useEffect(() => {
    connect();
    return () => {
      wsRef.current?.close();
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current);
      }
    };
  }, [connect]);

  return state;
}
```

- [ ] **Step 2: Add status indicator to App.tsx**

Replace `packages/client/src/App.tsx`:

```tsx
import { Chat } from './components/Chat';
import { useSupervisor } from './hooks/useSupervisor';

function StatusBar({ workerStatus }: { workerStatus: string }) {
  if (workerStatus === 'running' || workerStatus === 'unknown') return null;

  const isCrash = workerStatus === 'crashed';
  const bg = isCrash ? '#fee2e2' : '#fef3c7';
  const color = isCrash ? '#991b1b' : '#92400e';
  const text = isCrash ? 'R2 crashed, restarting...' : 'R2 is restarting...';

  return (
    <div style={{
      padding: '8px 16px',
      background: bg,
      color,
      fontSize: 13,
      fontWeight: 500,
      textAlign: 'center',
      animation: 'pulse 2s ease-in-out infinite',
    }}>
      {text}
      <style>{`@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.6; } }`}</style>
    </div>
  );
}

export default function App() {
  const { workerStatus } = useSupervisor();

  return (
    <div style={{
      maxWidth: 640,
      margin: '0 auto',
      height: '100dvh',
      display: 'flex',
      flexDirection: 'column',
    }}>
      <StatusBar workerStatus={workerStatus} />
      <header style={{
        padding: '16px 20px',
        borderBottom: '1px solid #e5e5e5',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
      }}>
        <div style={{
          width: 36, height: 36, borderRadius: '50%',
          background: '#2A5A8A', display: 'flex',
          alignItems: 'center', justifyContent: 'center',
          color: '#fff', fontWeight: 600, fontSize: 14,
        }}>R2</div>
        <div>
          <div style={{ fontWeight: 600, fontSize: 15 }}>R2</div>
          <div style={{ fontSize: 12, color: '#888' }}>Personal assistant</div>
        </div>
      </header>
      <Chat />
    </div>
  );
}
```

- [ ] **Step 3: Run client typecheck**

Run: `npx tsc --noEmit -p packages/client/tsconfig.json`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/client/src/hooks/useSupervisor.ts packages/client/src/App.tsx
git commit -m "feat: add useSupervisor hook and worker status indicator"
```

---

### Task 8: Full typecheck and test suite

**Files:**
- All modified files

- [ ] **Step 1: Full typecheck across all packages**

Run: `npx tsc --noEmit -p packages/shared/tsconfig.json && npx tsc --noEmit -p packages/server/tsconfig.json && npx tsc --noEmit -p packages/supervisor/tsconfig.json`
Expected: no type errors.

- [ ] **Step 2: Run all server tests**

Run: `cd packages/server && npx vitest run`
Expected: all tests PASS.

- [ ] **Step 3: Run all supervisor tests**

Run: `cd packages/supervisor && npx vitest run`
Expected: all tests PASS.

- [ ] **Step 4: Fix any issues found**

If any type errors or test failures, fix them.

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "chore: Phase 3A — supervisor + worker split complete"
```
