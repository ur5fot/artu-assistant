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
  private restarting = false;
  private crashTimestamps: number[] = [];
  private restartCount = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private killTimer: ReturnType<typeof setTimeout> | null = null;

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
    this.restarting = true;
    if (this.worker) {
      this._status = 'restarting';
      this.emit('worker_restarting', 0);
      await this.killWorkerAsync();
    }
    this.restarting = false;
    if (this.stopping) return;
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
      this.clearKillTimer();

      if (this.stopping || this.restarting) {
        if (this.stopping) this._status = 'stopped';
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

  private clearKillTimer(): void {
    if (this.killTimer) {
      clearTimeout(this.killTimer);
      this.killTimer = null;
    }
  }

  private killWorker(): void {
    if (!this.worker) return;
    this.worker.kill('SIGTERM');
    const pid = this.worker.pid;
    this.clearKillTimer();
    this.killTimer = setTimeout(() => {
      this.killTimer = null;
      try {
        if (pid) process.kill(pid, 0); // check if still alive
        if (pid) process.kill(pid, 'SIGKILL');
      } catch {
        // already dead
      }
    }, this.shutdownTimeoutMs);
    this.killTimer.unref();
  }

  private killWorkerAsync(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.worker) {
        resolve();
        return;
      }
      const timeout = setTimeout(() => resolve(), this.shutdownTimeoutMs + 1000);
      timeout.unref();
      this.worker.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
      this.killWorker();
    });
  }
}
