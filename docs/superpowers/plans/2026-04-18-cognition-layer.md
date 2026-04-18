# Cognition Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the cognition-layer infrastructure (heartbeat tick + dispatcher + single-worker queue + handler registry + SQLite store + `pulse` demo handler + `/heartbeat` Discord control) so future analytical handlers can be plugged in without re-architecting.

**Architecture:** Two layers — reflex (existing Discord/reminders/tools, untouched) and cognition (new `packages/server/src/cognition/`). The cognition heartbeat fires `setInterval(60_000)`, the dispatcher reads each registered handler's `trigger(state)`, enqueues jobs, and a single async worker calls `handler.run()` with a 60 s timeout. Results are persisted in SQLite (`cognition_state`, `cognition_ticks`, `cognition_handler_runs`); `publish: true` results emit a `cognition_publish` event on the shared `bus` that the Discord bot already listens to. `/heartbeat` slash command exposes status / pause / resume.

**Tech Stack:** TypeScript, Node.js 22, vitest, better-sqlite3, discord.js 14, EventEmitter (Node built-in).

---

## File Structure

### New files

| File | Responsibility |
|---|---|
| `packages/server/src/cognition/types.ts` | `Handler`, `HandlerState`, `HandlerContext`, `HandlerResult`, `CognitionStatus`. |
| `packages/server/src/cognition/store.ts` | `CognitionStore` — pause/resume, ticks, handler runs (DB IO). |
| `packages/server/src/cognition/registry.ts` | `HandlerRegistry` — Map-backed `register/get/list`. |
| `packages/server/src/cognition/queue.ts` | `JobQueue` — single-worker FIFO with timeout, persists outcome via store. |
| `packages/server/src/cognition/dispatcher.ts` | `Dispatcher.runTick` — evaluates triggers, enqueues triggered handlers. |
| `packages/server/src/cognition/heartbeat.ts` | `startHeartbeat` — `setInterval(60_000)` calling dispatcher. |
| `packages/server/src/cognition/service.ts` | `CognitionService` — public API composing the above. |
| `packages/server/src/cognition/handlers/pulse.ts` | Demo handler (5 min trigger, returns `skip`). |
| `packages/server/src/cognition/__tests__/store.test.ts` | Store unit tests. |
| `packages/server/src/cognition/__tests__/registry.test.ts` | Registry unit tests. |
| `packages/server/src/cognition/__tests__/queue.test.ts` | Queue unit tests. |
| `packages/server/src/cognition/__tests__/dispatcher.test.ts` | Dispatcher unit tests. |
| `packages/server/src/cognition/__tests__/heartbeat.test.ts` | Heartbeat tick test (fake timers). |
| `packages/server/src/cognition/__tests__/service.test.ts` | Service composition test. |
| `packages/server/src/cognition/__tests__/handlers/pulse.test.ts` | Pulse handler test. |

### Modified files

| File | Change |
|---|---|
| `packages/server/src/db.ts` | Add `CREATE TABLE IF NOT EXISTS` for `cognition_state`, `cognition_ticks`, `cognition_handler_runs` in `initDb()`. |
| `packages/server/src/index.ts` | Instantiate `cognitionService`, register `pulseHandler`, `start()`, pass to Discord deps; `cognitionService.stop()` on SIGTERM. |
| `packages/server/src/channels/discord/bot.ts` | Accept `cognitionService` in `DiscordBotDeps`, subscribe to `cognition_publish` events, pass to `routeInteraction`. |
| `packages/server/src/channels/discord/interactions.ts` | `InteractionDeps.cognitionService`; handle `name === 'heartbeat'` with `status` / `pause` / `resume` sub-commands. |
| `packages/server/src/channels/discord/slash-commands.ts` | Register `/heartbeat` with sub-commands. |
| `packages/server/src/channels/discord/__tests__/interactions.test.ts` | Tests for `/heartbeat status` / `pause` / `resume`. |
| `packages/server/src/channels/discord/__tests__/bot.test.ts` | Test that `cognition_publish` event triggers `dm.send`. |

---

## Conventions

- **Tests first.** Every task starts with a failing test.
- **Run tests:** `npx vitest run --root packages/server <path>`.
- **Commit per task.** Conventional-ish: `feat(cognition): …`, `feat(db): …`, `feat(discord): …`.
- **ESM imports with `.js`** (matches repo).
- **Time:** all timestamps are `ms` from `Date.now()`.
- **Tests use fake timers** (`vi.useFakeTimers()`) for anything timer-driven.

---

## Task 1: DB tables for cognition

**Files:**
- Modify: `packages/server/src/db.ts`
- Modify: `packages/server/src/db.test.ts`

- [x] **Step 1: Write failing tests**

Append to `packages/server/src/db.test.ts`:

```ts
import { getDb, initDb } from './db.js';

describe('cognition tables', () => {
  beforeEach(() => initDb(':memory:'));

  it('cognition_state has a single row with paused=0', () => {
    const row = getDb()
      .prepare('SELECT id, paused FROM cognition_state')
      .all() as Array<{ id: number; paused: number }>;
    expect(row).toEqual([{ id: 1, paused: 0 }]);
  });

  it('cognition_ticks accepts inserts and indexes by tick_at', () => {
    getDb().prepare('INSERT INTO cognition_ticks (tick_at) VALUES (?)').run(1000);
    getDb().prepare('INSERT INTO cognition_ticks (tick_at) VALUES (?)').run(2000);
    const rows = getDb()
      .prepare('SELECT tick_at FROM cognition_ticks ORDER BY tick_at')
      .all();
    expect(rows).toEqual([{ tick_at: 1000 }, { tick_at: 2000 }]);
  });

  it('cognition_handler_runs CHECK constraint rejects bad outcome', () => {
    expect(() =>
      getDb()
        .prepare(
          'INSERT INTO cognition_handler_runs (handler_name, fired_at, duration_ms, outcome) VALUES (?, ?, ?, ?)',
        )
        .run('x', 1, 0, 'bogus'),
    ).toThrow();
  });

  it('cognition_handler_runs accepts publish/skip/error', () => {
    const stmt = getDb().prepare(
      'INSERT INTO cognition_handler_runs (handler_name, fired_at, duration_ms, outcome) VALUES (?, ?, ?, ?)',
    );
    expect(() => stmt.run('x', 1, 0, 'publish')).not.toThrow();
    expect(() => stmt.run('x', 2, 0, 'skip')).not.toThrow();
    expect(() => stmt.run('x', 3, 0, 'error')).not.toThrow();
  });
});
```

- [x] **Step 2: Run test to verify it fails**

```bash
npx vitest run --root packages/server packages/server/src/db.test.ts
```

Expected: FAIL — `no such table: cognition_state`.

- [x] **Step 3: Implement**

In `packages/server/src/db.ts`, inside `initDb()`, add **after** the `prompt_overlays` CREATE TABLE block but **before** the migration block:

```ts
db.exec(`
  CREATE TABLE IF NOT EXISTS cognition_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    paused INTEGER NOT NULL DEFAULT 0,
    paused_at INTEGER
  )
`);
db.exec(`INSERT OR IGNORE INTO cognition_state (id, paused) VALUES (1, 0)`);

db.exec(`
  CREATE TABLE IF NOT EXISTS cognition_ticks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tick_at INTEGER NOT NULL
  )
`);
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_cognition_ticks_at
    ON cognition_ticks(tick_at)
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS cognition_handler_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    handler_name TEXT NOT NULL,
    fired_at INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('publish', 'skip', 'error')),
    content TEXT,
    reason TEXT,
    published_at INTEGER
  )
`);
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_cognition_handler_runs_name_at
    ON cognition_handler_runs(handler_name, fired_at DESC)
`);
```

- [x] **Step 4: Run tests** — all 4 passing.

- [x] **Step 5: Commit**

```bash
git add packages/server/src/db.ts packages/server/src/db.test.ts
git commit -m "feat(db): cognition tables (state, ticks, handler_runs)"
```

---

## Task 2: `cognition/types.ts`

**Files:**
- Create: `packages/server/src/cognition/types.ts`

This file has no logic, just type declarations — no separate test file. Type usage is exercised by all subsequent tasks' tests.

- [x] **Step 1: Implement**

Create `packages/server/src/cognition/types.ts`:

```ts
import type Database from 'better-sqlite3';

export type HandlerResult =
  | { publish: true; content: string }
  | { skip: true; reason: string }
  | { error: true; message: string };

export interface HandlerState {
  now: number;
  lastFiredAt: number | null;
  lastResult: HandlerResult | null;
}

export interface HandlerContext {
  db: Database.Database;
  signal: AbortSignal;
}

export interface Handler {
  name: string;
  trigger: (state: HandlerState) => boolean;
  run: (ctx: HandlerContext) => Promise<HandlerResult>;
}

export interface HandlerRunRecord {
  id: number;
  handlerName: string;
  firedAt: number;
  durationMs: number;
  outcome: 'publish' | 'skip' | 'error';
  content?: string;
  reason?: string;
  publishedAt?: number;
}

export interface CognitionStatus {
  paused: boolean;
  lastTickAt: number | null;
  ticks24h: number;
  queueSize: number;
  handlers: string[];
  recentRuns: HandlerRunRecord[];
}
```

- [x] **Step 2: Verify compile**

```bash
npx tsc -p packages/server --noEmit
```

Expected: no errors (types are unused yet but valid).

- [x] **Step 3: Commit**

```bash
git add packages/server/src/cognition/types.ts
git commit -m "feat(cognition): types module"
```

---

## Task 3: `CognitionStore` — pause + ticks

**Files:**
- Create: `packages/server/src/cognition/store.ts`
- Create: `packages/server/src/cognition/__tests__/store.test.ts`

- [x] **Step 1: Write failing tests**

Create `packages/server/src/cognition/__tests__/store.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { getDb, initDb } from '../../db.js';
import { createCognitionStore } from '../store.js';

beforeEach(() => initDb(':memory:'));

describe('CognitionStore — pause/resume', () => {
  it('isPaused returns false initially', () => {
    const store = createCognitionStore({ db: getDb() });
    expect(store.isPaused()).toBe(false);
  });

  it('pause sets paused=1 and timestamp', () => {
    const store = createCognitionStore({ db: getDb() });
    store.pause(12345);
    expect(store.isPaused()).toBe(true);
    const row = getDb()
      .prepare('SELECT paused, paused_at FROM cognition_state WHERE id = 1')
      .get() as { paused: number; paused_at: number };
    expect(row).toEqual({ paused: 1, paused_at: 12345 });
  });

  it('resume clears paused', () => {
    const store = createCognitionStore({ db: getDb() });
    store.pause(12345);
    store.resume();
    expect(store.isPaused()).toBe(false);
    const row = getDb()
      .prepare('SELECT paused, paused_at FROM cognition_state WHERE id = 1')
      .get() as { paused: number; paused_at: number | null };
    expect(row).toEqual({ paused: 0, paused_at: null });
  });
});

describe('CognitionStore — ticks', () => {
  it('recordTick inserts a row', () => {
    const store = createCognitionStore({ db: getDb() });
    store.recordTick(1000);
    expect(store.getLastTickAt()).toBe(1000);
  });

  it('countTicksSince counts ticks at or after the cutoff', () => {
    const store = createCognitionStore({ db: getDb() });
    store.recordTick(1000);
    store.recordTick(2000);
    store.recordTick(3000);
    expect(store.countTicksSince(1500)).toBe(2);
  });

  it('recordTick prunes ticks older than 7 days', () => {
    const store = createCognitionStore({ db: getDb() });
    const now = Date.now();
    const eightDaysAgo = now - 8 * 24 * 60 * 60 * 1000;
    store.recordTick(eightDaysAgo);
    store.recordTick(now);
    const count = (getDb().prepare('SELECT COUNT(*) AS n FROM cognition_ticks').get() as { n: number }).n;
    expect(count).toBe(1);
  });
});
```

- [x] **Step 2: Run test** — expect FAIL.

- [x] **Step 3: Implement (partial — pause + ticks only)**

Create `packages/server/src/cognition/store.ts`:

```ts
import type Database from 'better-sqlite3';
import type { HandlerResult, HandlerRunRecord } from './types.js';

const TICK_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface CognitionStore {
  db: Database.Database;
  isPaused(): boolean;
  pause(now: number): void;
  resume(): void;
  recordTick(now: number): void;
  countTicksSince(sinceMs: number): number;
  getLastTickAt(): number | null;
  recordHandlerRun(params: {
    handlerName: string;
    firedAt: number;
    durationMs: number;
    result: HandlerResult;
  }): number;
  markPublished(runId: number, publishedAt: number): void;
  getLastFiredAt(handlerName: string): number | null;
  getLastResult(handlerName: string): HandlerResult | null;
  recentRuns(limit: number): HandlerRunRecord[];
}

export function createCognitionStore(deps: { db: Database.Database }): CognitionStore {
  const { db } = deps;

  return {
    db,

    isPaused() {
      const row = db
        .prepare('SELECT paused FROM cognition_state WHERE id = 1')
        .get() as { paused: number } | undefined;
      return !!row && row.paused === 1;
    },

    pause(now) {
      db.prepare('UPDATE cognition_state SET paused = 1, paused_at = ? WHERE id = 1').run(now);
    },

    resume() {
      db.prepare('UPDATE cognition_state SET paused = 0, paused_at = NULL WHERE id = 1').run();
    },

    recordTick(now) {
      db.prepare('INSERT INTO cognition_ticks (tick_at) VALUES (?)').run(now);
      const cutoff = now - TICK_RETENTION_MS;
      db.prepare('DELETE FROM cognition_ticks WHERE tick_at < ?').run(cutoff);
    },

    countTicksSince(sinceMs) {
      const row = db
        .prepare('SELECT COUNT(*) AS n FROM cognition_ticks WHERE tick_at >= ?')
        .get(sinceMs) as { n: number };
      return row.n;
    },

    getLastTickAt() {
      const row = db
        .prepare('SELECT tick_at FROM cognition_ticks ORDER BY tick_at DESC LIMIT 1')
        .get() as { tick_at: number } | undefined;
      return row ? row.tick_at : null;
    },

    recordHandlerRun(_params) {
      throw new Error('not implemented yet — Task 4');
    },

    markPublished(_runId, _publishedAt) {
      throw new Error('not implemented yet — Task 4');
    },

    getLastFiredAt(_handlerName) {
      throw new Error('not implemented yet — Task 4');
    },

    getLastResult(_handlerName) {
      throw new Error('not implemented yet — Task 4');
    },

    recentRuns(_limit) {
      throw new Error('not implemented yet — Task 4');
    },
  };
}
```

The five throw-stubs ship in this commit so consumers can compile against the full interface. Task 4 fills them in.

- [x] **Step 4: Run tests** — all 6 in this task passing.

- [x] **Step 5: Commit**

```bash
git add packages/server/src/cognition/store.ts packages/server/src/cognition/__tests__/store.test.ts
git commit -m "feat(cognition): store — pause + ticks"
```

---

## Task 4: `CognitionStore` — handler runs

**Files:**
- Modify: `packages/server/src/cognition/store.ts`
- Modify: `packages/server/src/cognition/__tests__/store.test.ts`

- [x] **Step 1: Append failing tests**

Append to `packages/server/src/cognition/__tests__/store.test.ts`:

```ts
describe('CognitionStore — handler runs', () => {
  it('recordHandlerRun returns row id and persists outcome', () => {
    const store = createCognitionStore({ db: getDb() });
    const id = store.recordHandlerRun({
      handlerName: 'pulse',
      firedAt: 1000,
      durationMs: 5,
      result: { skip: true, reason: 'alive' },
    });
    expect(id).toBeGreaterThan(0);
    const row = getDb()
      .prepare('SELECT handler_name, outcome, reason FROM cognition_handler_runs WHERE id = ?')
      .get(id) as { handler_name: string; outcome: string; reason: string };
    expect(row).toEqual({ handler_name: 'pulse', outcome: 'skip', reason: 'alive' });
  });

  it('recordHandlerRun stores publish content', () => {
    const store = createCognitionStore({ db: getDb() });
    const id = store.recordHandlerRun({
      handlerName: 'reflect',
      firedAt: 2000,
      durationMs: 1234,
      result: { publish: true, content: 'noticed X' },
    });
    const row = getDb()
      .prepare('SELECT outcome, content FROM cognition_handler_runs WHERE id = ?')
      .get(id) as { outcome: string; content: string };
    expect(row).toEqual({ outcome: 'publish', content: 'noticed X' });
  });

  it('recordHandlerRun stores error message in reason', () => {
    const store = createCognitionStore({ db: getDb() });
    const id = store.recordHandlerRun({
      handlerName: 'broken',
      firedAt: 3000,
      durationMs: 10,
      result: { error: true, message: 'boom' },
    });
    const row = getDb()
      .prepare('SELECT outcome, reason FROM cognition_handler_runs WHERE id = ?')
      .get(id) as { outcome: string; reason: string };
    expect(row).toEqual({ outcome: 'error', reason: 'boom' });
  });

  it('markPublished sets published_at', () => {
    const store = createCognitionStore({ db: getDb() });
    const id = store.recordHandlerRun({
      handlerName: 'reflect',
      firedAt: 1,
      durationMs: 1,
      result: { publish: true, content: 'x' },
    });
    store.markPublished(id, 9999);
    const row = getDb()
      .prepare('SELECT published_at FROM cognition_handler_runs WHERE id = ?')
      .get(id) as { published_at: number };
    expect(row.published_at).toBe(9999);
  });

  it('getLastFiredAt returns latest fired_at for handler', () => {
    const store = createCognitionStore({ db: getDb() });
    store.recordHandlerRun({
      handlerName: 'a',
      firedAt: 100,
      durationMs: 0,
      result: { skip: true, reason: '' },
    });
    store.recordHandlerRun({
      handlerName: 'a',
      firedAt: 500,
      durationMs: 0,
      result: { skip: true, reason: '' },
    });
    store.recordHandlerRun({
      handlerName: 'b',
      firedAt: 999,
      durationMs: 0,
      result: { skip: true, reason: '' },
    });
    expect(store.getLastFiredAt('a')).toBe(500);
    expect(store.getLastFiredAt('missing')).toBe(null);
  });

  it('getLastResult round-trips publish/skip/error', () => {
    const store = createCognitionStore({ db: getDb() });
    store.recordHandlerRun({
      handlerName: 'a',
      firedAt: 1,
      durationMs: 0,
      result: { publish: true, content: 'hi' },
    });
    expect(store.getLastResult('a')).toEqual({ publish: true, content: 'hi' });
    store.recordHandlerRun({
      handlerName: 'a',
      firedAt: 2,
      durationMs: 0,
      result: { skip: true, reason: 'why' },
    });
    expect(store.getLastResult('a')).toEqual({ skip: true, reason: 'why' });
    store.recordHandlerRun({
      handlerName: 'a',
      firedAt: 3,
      durationMs: 0,
      result: { error: true, message: 'boom' },
    });
    expect(store.getLastResult('a')).toEqual({ error: true, message: 'boom' });
  });

  it('recentRuns returns rows ordered by fired_at desc, limited', () => {
    const store = createCognitionStore({ db: getDb() });
    for (let i = 1; i <= 5; i++) {
      store.recordHandlerRun({
        handlerName: 'h',
        firedAt: i * 100,
        durationMs: 0,
        result: { skip: true, reason: `r${i}` },
      });
    }
    const recent = store.recentRuns(3);
    expect(recent.map((r) => r.firedAt)).toEqual([500, 400, 300]);
    expect(recent[0].outcome).toBe('skip');
    expect(recent[0].reason).toBe('r5');
  });
});
```

- [x] **Step 2: Run test** — expect FAIL (stubs throw).

- [x] **Step 3: Replace the five stubs in `store.ts`**

Replace the throw-stubs with:

```ts
recordHandlerRun({ handlerName, firedAt, durationMs, result }) {
  let outcome: 'publish' | 'skip' | 'error';
  let content: string | null = null;
  let reason: string | null = null;
  if ('publish' in result) {
    outcome = 'publish';
    content = result.content;
  } else if ('skip' in result) {
    outcome = 'skip';
    reason = result.reason;
  } else {
    outcome = 'error';
    reason = result.message;
  }
  const r = db
    .prepare(
      `INSERT INTO cognition_handler_runs
         (handler_name, fired_at, duration_ms, outcome, content, reason)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(handlerName, firedAt, durationMs, outcome, content, reason);
  return Number(r.lastInsertRowid);
},

markPublished(runId, publishedAt) {
  db.prepare('UPDATE cognition_handler_runs SET published_at = ? WHERE id = ?')
    .run(publishedAt, runId);
},

getLastFiredAt(handlerName) {
  const row = db
    .prepare(
      'SELECT fired_at FROM cognition_handler_runs WHERE handler_name = ? ORDER BY fired_at DESC LIMIT 1',
    )
    .get(handlerName) as { fired_at: number } | undefined;
  return row ? row.fired_at : null;
},

getLastResult(handlerName) {
  const row = db
    .prepare(
      'SELECT outcome, content, reason FROM cognition_handler_runs WHERE handler_name = ? ORDER BY fired_at DESC LIMIT 1',
    )
    .get(handlerName) as { outcome: string; content: string | null; reason: string | null } | undefined;
  if (!row) return null;
  if (row.outcome === 'publish') return { publish: true, content: row.content ?? '' };
  if (row.outcome === 'skip') return { skip: true, reason: row.reason ?? '' };
  return { error: true, message: row.reason ?? '' };
},

recentRuns(limit) {
  const rows = db
    .prepare(
      `SELECT id, handler_name, fired_at, duration_ms, outcome, content, reason, published_at
       FROM cognition_handler_runs
       ORDER BY fired_at DESC LIMIT ?`,
    )
    .all(limit) as Array<{
      id: number; handler_name: string; fired_at: number; duration_ms: number;
      outcome: string; content: string | null; reason: string | null; published_at: number | null;
    }>;
  return rows.map((r) => ({
    id: r.id,
    handlerName: r.handler_name,
    firedAt: r.fired_at,
    durationMs: r.duration_ms,
    outcome: r.outcome as 'publish' | 'skip' | 'error',
    content: r.content ?? undefined,
    reason: r.reason ?? undefined,
    publishedAt: r.published_at ?? undefined,
  }));
},
```

- [x] **Step 4: Run tests** — all passing.

- [x] **Step 5: Commit**

```bash
git add packages/server/src/cognition/store.ts packages/server/src/cognition/__tests__/store.test.ts
git commit -m "feat(cognition): store — handler runs CRUD"
```

---

## Task 5: `HandlerRegistry`

**Files:**
- Create: `packages/server/src/cognition/registry.ts`
- Create: `packages/server/src/cognition/__tests__/registry.test.ts`

- [ ] **Step 1: Write failing test**

Create `packages/server/src/cognition/__tests__/registry.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createHandlerRegistry } from '../registry.js';
import type { Handler } from '../types.js';

const noop: Handler = {
  name: 'x',
  trigger: () => false,
  run: async () => ({ skip: true, reason: '' }),
};

describe('HandlerRegistry', () => {
  it('register + get + list', () => {
    const reg = createHandlerRegistry();
    reg.register({ ...noop, name: 'a' });
    reg.register({ ...noop, name: 'b' });
    expect(reg.get('a')?.name).toBe('a');
    expect(reg.list().map((h) => h.name)).toEqual(['a', 'b']);
  });

  it('duplicate name throws', () => {
    const reg = createHandlerRegistry();
    reg.register({ ...noop, name: 'a' });
    expect(() => reg.register({ ...noop, name: 'a' })).toThrow(/already registered/);
  });

  it('get returns null for unknown', () => {
    const reg = createHandlerRegistry();
    expect(reg.get('nope')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test** — expect FAIL.

- [ ] **Step 3: Implement**

Create `packages/server/src/cognition/registry.ts`:

```ts
import type { Handler } from './types.js';

export interface HandlerRegistry {
  register(handler: Handler): void;
  get(name: string): Handler | null;
  list(): Handler[];
}

export function createHandlerRegistry(): HandlerRegistry {
  const map = new Map<string, Handler>();
  return {
    register(handler) {
      if (map.has(handler.name)) {
        throw new Error(`Handler "${handler.name}" already registered`);
      }
      map.set(handler.name, handler);
    },
    get(name) {
      return map.get(name) ?? null;
    },
    list() {
      return [...map.values()];
    },
  };
}
```

- [ ] **Step 4: Run tests** — passing.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/cognition/registry.ts packages/server/src/cognition/__tests__/registry.test.ts
git commit -m "feat(cognition): handler registry"
```

---

## Task 6: `JobQueue`

**Files:**
- Create: `packages/server/src/cognition/queue.ts`
- Create: `packages/server/src/cognition/__tests__/queue.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/server/src/cognition/__tests__/queue.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { initDb, getDb } from '../../db.js';
import { createCognitionStore } from '../store.js';
import { createHandlerRegistry } from '../registry.js';
import { createJobQueue } from '../queue.js';
import type { Handler } from '../types.js';

function setup(handlers: Handler[]) {
  initDb(':memory:');
  const store = createCognitionStore({ db: getDb() });
  const registry = createHandlerRegistry();
  for (const h of handlers) registry.register(h);
  const bus = new EventEmitter();
  const events: any[] = [];
  bus.on('push', (e) => events.push(e));
  return { store, registry, bus, events };
}

describe('JobQueue', () => {
  it('processes a job and persists skip outcome', async () => {
    const handler: Handler = {
      name: 'h',
      trigger: () => true,
      run: async () => ({ skip: true, reason: 'noop' }),
    };
    const { store, registry, bus } = setup([handler]);
    const q = createJobQueue({ registry, store, bus });
    q.start();
    q.enqueue({ handlerName: 'h' });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(store.recentRuns(1)[0]).toMatchObject({ handlerName: 'h', outcome: 'skip', reason: 'noop' });
    q.stop();
  });

  it('emits cognition_publish when handler returns publish', async () => {
    const handler: Handler = {
      name: 'h',
      trigger: () => true,
      run: async () => ({ publish: true, content: 'hello' }),
    };
    const { store, registry, bus, events } = setup([handler]);
    const q = createJobQueue({ registry, store, bus });
    q.start();
    q.enqueue({ handlerName: 'h' });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const e = events.find((x) => x.type === 'cognition_publish');
    expect(e).toMatchObject({ handler: 'h', content: 'hello' });
    expect(typeof e.runId).toBe('number');
    q.stop();
  });

  it('handler error is captured and worker continues', async () => {
    const bad: Handler = {
      name: 'bad',
      trigger: () => true,
      run: async () => { throw new Error('boom'); },
    };
    const ok: Handler = {
      name: 'ok',
      trigger: () => true,
      run: async () => ({ skip: true, reason: 'fine' }),
    };
    const { store, registry, bus } = setup([bad, ok]);
    const q = createJobQueue({ registry, store, bus });
    q.start();
    q.enqueue({ handlerName: 'bad' });
    q.enqueue({ handlerName: 'ok' });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const recent = store.recentRuns(2);
    const names = recent.map((r) => r.handlerName).sort();
    expect(names).toEqual(['bad', 'ok']);
    const badRow = recent.find((r) => r.handlerName === 'bad')!;
    expect(badRow.outcome).toBe('error');
    expect(badRow.reason).toContain('boom');
    q.stop();
  });

  it('size reflects queued jobs before processing', async () => {
    const slow: Handler = {
      name: 'slow',
      trigger: () => true,
      run: () => new Promise((resolve) => setTimeout(() => resolve({ skip: true, reason: '' }), 100)),
    };
    const { store, registry, bus } = setup([slow]);
    const q = createJobQueue({ registry, store, bus });
    q.start();
    q.enqueue({ handlerName: 'slow' });
    q.enqueue({ handlerName: 'slow' });
    expect(q.size()).toBeGreaterThan(0);
    q.stop();
  });
});
```

- [ ] **Step 2: Run test** — expect FAIL.

- [ ] **Step 3: Implement**

Create `packages/server/src/cognition/queue.ts`:

```ts
import type { EventEmitter } from 'node:events';
import type { CognitionStore } from './store.js';
import type { HandlerRegistry } from './registry.js';
import type { HandlerResult } from './types.js';

export interface Job {
  handlerName: string;
}

export interface JobQueue {
  enqueue(job: Job): void;
  size(): number;
  start(): void;
  stop(): void;
}

interface Deps {
  registry: HandlerRegistry;
  store: CognitionStore;
  bus: EventEmitter;
  workerTimeoutMs?: number;
}

export function createJobQueue(deps: Deps): JobQueue {
  const { registry, store, bus } = deps;
  const timeoutMs = deps.workerTimeoutMs ?? 60_000;
  const jobs: Job[] = [];
  let running = false;
  let inFlight: Promise<void> = Promise.resolve();

  async function pump(): Promise<void> {
    while (running && jobs.length > 0) {
      const job = jobs.shift()!;
      const handler = registry.get(job.handlerName);
      if (!handler) continue;

      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      const startedAt = Date.now();
      let result: HandlerResult;
      try {
        result = await handler.run({ db: store.db, signal: ac.signal });
      } catch (err) {
        result = { error: true, message: err instanceof Error ? err.message : String(err) };
      } finally {
        clearTimeout(timer);
      }

      const runId = store.recordHandlerRun({
        handlerName: handler.name,
        firedAt: startedAt,
        durationMs: Date.now() - startedAt,
        result,
      });

      if ('publish' in result && result.publish) {
        bus.emit('push', {
          type: 'cognition_publish',
          runId,
          handler: handler.name,
          content: result.content,
        });
      }
    }
  }

  return {
    enqueue(job) {
      jobs.push(job);
      if (running) {
        inFlight = inFlight
          .then(pump)
          .catch((err) =>
            console.error('[cognition] worker error:', err instanceof Error ? err.message : err),
          );
      }
    },
    size: () => jobs.length,
    start() {
      running = true;
      inFlight = pump();
    },
    stop() {
      running = false;
    },
  };
}
```

- [ ] **Step 4: Run tests** — all passing.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/cognition/queue.ts packages/server/src/cognition/__tests__/queue.test.ts
git commit -m "feat(cognition): single-worker job queue"
```

---

## Task 7: `Dispatcher`

**Files:**
- Create: `packages/server/src/cognition/dispatcher.ts`
- Create: `packages/server/src/cognition/__tests__/dispatcher.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/server/src/cognition/__tests__/dispatcher.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db.js';
import { createCognitionStore } from '../store.js';
import { createHandlerRegistry } from '../registry.js';
import { createDispatcher } from '../dispatcher.js';
import type { Handler } from '../types.js';

beforeEach(() => initDb(':memory:'));

function fakeQueue() {
  const enqueued: string[] = [];
  return {
    queue: {
      enqueue: (job: { handlerName: string }) => enqueued.push(job.handlerName),
      size: () => enqueued.length,
      start: vi.fn(),
      stop: vi.fn(),
    },
    enqueued,
  };
}

describe('Dispatcher', () => {
  it('enqueues only triggered handlers', async () => {
    const store = createCognitionStore({ db: getDb() });
    const registry = createHandlerRegistry();
    registry.register({ name: 'on', trigger: () => true, run: async () => ({ skip: true, reason: '' }) });
    registry.register({ name: 'off', trigger: () => false, run: async () => ({ skip: true, reason: '' }) });
    const { queue, enqueued } = fakeQueue();
    const d = createDispatcher({ registry, queue, store });
    await d.runTick(1000);
    expect(enqueued).toEqual(['on']);
  });

  it('passes HandlerState (now, lastFiredAt, lastResult) to trigger', async () => {
    const store = createCognitionStore({ db: getDb() });
    store.recordHandlerRun({
      handlerName: 'h',
      firedAt: 50,
      durationMs: 0,
      result: { skip: true, reason: 'r' },
    });
    const seen: any[] = [];
    const registry = createHandlerRegistry();
    registry.register({
      name: 'h',
      trigger: (s) => { seen.push(s); return false; },
      run: async () => ({ skip: true, reason: '' }),
    });
    const { queue } = fakeQueue();
    const d = createDispatcher({ registry, queue, store });
    await d.runTick(2000);
    expect(seen[0]).toMatchObject({
      now: 2000,
      lastFiredAt: 50,
      lastResult: { skip: true, reason: 'r' },
    });
  });

  it('trigger throw does not break the loop', async () => {
    const store = createCognitionStore({ db: getDb() });
    const registry = createHandlerRegistry();
    registry.register({ name: 'bad', trigger: () => { throw new Error('x'); }, run: async () => ({ skip: true, reason: '' }) });
    registry.register({ name: 'good', trigger: () => true, run: async () => ({ skip: true, reason: '' }) });
    const { queue, enqueued } = fakeQueue();
    const d = createDispatcher({ registry, queue, store });
    await d.runTick(1000);
    expect(enqueued).toEqual(['good']);
  });
});
```

- [ ] **Step 2: Run test** — expect FAIL.

- [ ] **Step 3: Implement**

Create `packages/server/src/cognition/dispatcher.ts`:

```ts
import type { CognitionStore } from './store.js';
import type { HandlerRegistry } from './registry.js';
import type { JobQueue } from './queue.js';
import type { HandlerState } from './types.js';

export interface Dispatcher {
  runTick(now: number): Promise<void>;
}

interface Deps {
  registry: HandlerRegistry;
  queue: JobQueue;
  store: CognitionStore;
}

export function createDispatcher(deps: Deps): Dispatcher {
  const { registry, queue, store } = deps;
  return {
    async runTick(now) {
      for (const handler of registry.list()) {
        const state: HandlerState = {
          now,
          lastFiredAt: store.getLastFiredAt(handler.name),
          lastResult: store.getLastResult(handler.name),
        };
        let triggered = false;
        try {
          triggered = handler.trigger(state);
        } catch (err) {
          console.error(
            `[cognition] trigger ${handler.name} threw:`,
            err instanceof Error ? err.message : err,
          );
        }
        if (triggered) queue.enqueue({ handlerName: handler.name });
      }
    },
  };
}
```

- [ ] **Step 4: Run tests** — all passing.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/cognition/dispatcher.ts packages/server/src/cognition/__tests__/dispatcher.test.ts
git commit -m "feat(cognition): dispatcher"
```

---

## Task 8: `Heartbeat`

**Files:**
- Create: `packages/server/src/cognition/heartbeat.ts`
- Create: `packages/server/src/cognition/__tests__/heartbeat.test.ts`

- [ ] **Step 1: Write failing test**

Create `packages/server/src/cognition/__tests__/heartbeat.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { initDb, getDb } from '../../db.js';
import { createCognitionStore } from '../store.js';
import { startHeartbeat, HEARTBEAT_TICK_MS } from '../heartbeat.js';
import type { Dispatcher } from '../dispatcher.js';

beforeEach(() => initDb(':memory:'));
afterEach(() => vi.useRealTimers());

describe('Heartbeat', () => {
  it('fires runTick every tick interval and records ticks', async () => {
    vi.useFakeTimers();
    const store = createCognitionStore({ db: getDb() });
    const runTick = vi.fn().mockResolvedValue(undefined);
    const dispatcher: Dispatcher = { runTick };
    const hb = startHeartbeat({ dispatcher, store });
    await vi.advanceTimersByTimeAsync(HEARTBEAT_TICK_MS * 2);
    expect(runTick).toHaveBeenCalledTimes(2);
    expect(store.getLastTickAt()).not.toBeNull();
    hb.stop();
  });

  it('paused state skips runTick AND skips recordTick', async () => {
    vi.useFakeTimers();
    const store = createCognitionStore({ db: getDb() });
    store.pause(0);
    const runTick = vi.fn().mockResolvedValue(undefined);
    const dispatcher: Dispatcher = { runTick };
    const hb = startHeartbeat({ dispatcher, store });
    await vi.advanceTimersByTimeAsync(HEARTBEAT_TICK_MS * 2);
    expect(runTick).not.toHaveBeenCalled();
    expect(store.getLastTickAt()).toBeNull();
    hb.stop();
  });

  it('stop clears the timer', async () => {
    vi.useFakeTimers();
    const store = createCognitionStore({ db: getDb() });
    const runTick = vi.fn().mockResolvedValue(undefined);
    const hb = startHeartbeat({ dispatcher: { runTick }, store });
    hb.stop();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_TICK_MS * 5);
    expect(runTick).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test** — expect FAIL.

- [ ] **Step 3: Implement**

Create `packages/server/src/cognition/heartbeat.ts`:

```ts
import type { Dispatcher } from './dispatcher.js';
import type { CognitionStore } from './store.js';

export const HEARTBEAT_TICK_MS = 60_000;

interface Deps {
  dispatcher: Dispatcher;
  store: CognitionStore;
}

export function startHeartbeat(deps: Deps): { stop(): void } {
  const tick = async () => {
    const now = Date.now();
    try {
      if (deps.store.isPaused()) return;
      deps.store.recordTick(now);
      await deps.dispatcher.runTick(now);
    } catch (err) {
      console.error('[cognition] tick failed:', err instanceof Error ? err.message : err);
    }
  };
  const timer = setInterval(tick, HEARTBEAT_TICK_MS);
  return {
    stop() {
      clearInterval(timer);
    },
  };
}
```

- [ ] **Step 4: Run tests** — passing.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/cognition/heartbeat.ts packages/server/src/cognition/__tests__/heartbeat.test.ts
git commit -m "feat(cognition): heartbeat tick (60s)"
```

---

## Task 9: `CognitionService`

**Files:**
- Create: `packages/server/src/cognition/service.ts`
- Create: `packages/server/src/cognition/__tests__/service.test.ts`

- [ ] **Step 1: Write failing test**

Create `packages/server/src/cognition/__tests__/service.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { initDb, getDb } from '../../db.js';
import { createCognitionService } from '../service.js';
import type { Handler } from '../types.js';

beforeEach(() => initDb(':memory:'));

const noop: Handler = {
  name: 'noop',
  trigger: () => false,
  run: async () => ({ skip: true, reason: '' }),
};

describe('CognitionService', () => {
  it('register adds a handler that shows up in status.handlers', () => {
    const svc = createCognitionService({ db: getDb(), bus: new EventEmitter() });
    svc.register(noop);
    expect(svc.status().handlers).toEqual(['noop']);
  });

  it('pause flips status.paused and resume clears it', () => {
    const svc = createCognitionService({ db: getDb(), bus: new EventEmitter() });
    expect(svc.status().paused).toBe(false);
    svc.pause();
    expect(svc.status().paused).toBe(true);
    svc.resume();
    expect(svc.status().paused).toBe(false);
  });

  it('status reports queueSize, lastTickAt, ticks24h, recentRuns', () => {
    const svc = createCognitionService({ db: getDb(), bus: new EventEmitter() });
    const s = svc.status();
    expect(s).toMatchObject({
      paused: false,
      lastTickAt: null,
      ticks24h: 0,
      queueSize: 0,
      handlers: [],
      recentRuns: [],
    });
  });

  it('markPublished delegates to store', () => {
    const svc = createCognitionService({ db: getDb(), bus: new EventEmitter() });
    // Insert a row directly via store-like SQL
    const id = (getDb()
      .prepare(
        `INSERT INTO cognition_handler_runs (handler_name, fired_at, duration_ms, outcome, content)
         VALUES (?, ?, ?, 'publish', ?)`,
      )
      .run('x', 1, 0, 'c').lastInsertRowid as bigint | number);
    svc.markPublished(Number(id), 9999);
    const row = getDb()
      .prepare('SELECT published_at FROM cognition_handler_runs WHERE id = ?')
      .get(Number(id)) as { published_at: number };
    expect(row.published_at).toBe(9999);
  });
});
```

- [ ] **Step 2: Run test** — expect FAIL.

- [ ] **Step 3: Implement**

Create `packages/server/src/cognition/service.ts`:

```ts
import type Database from 'better-sqlite3';
import type { EventEmitter } from 'node:events';
import { createCognitionStore, type CognitionStore } from './store.js';
import { createHandlerRegistry, type HandlerRegistry } from './registry.js';
import { createJobQueue, type JobQueue } from './queue.js';
import { createDispatcher } from './dispatcher.js';
import { startHeartbeat } from './heartbeat.js';
import type { Handler, CognitionStatus } from './types.js';

export interface CognitionService {
  register(handler: Handler): void;
  start(): void;
  stop(): void;
  pause(): void;
  resume(): void;
  status(): CognitionStatus;
  markPublished(runId: number, publishedAt: number): void;
}

interface Deps {
  db: Database.Database;
  bus: EventEmitter;
  workerTimeoutMs?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function createCognitionService(deps: Deps): CognitionService {
  const store: CognitionStore = createCognitionStore({ db: deps.db });
  const registry: HandlerRegistry = createHandlerRegistry();
  const queue: JobQueue = createJobQueue({
    registry,
    store,
    bus: deps.bus,
    workerTimeoutMs: deps.workerTimeoutMs,
  });
  const dispatcher = createDispatcher({ registry, queue, store });
  let heartbeat: { stop(): void } | null = null;

  return {
    register(handler) {
      registry.register(handler);
    },
    start() {
      queue.start();
      heartbeat = startHeartbeat({ dispatcher, store });
    },
    stop() {
      heartbeat?.stop();
      heartbeat = null;
      queue.stop();
    },
    pause() {
      store.pause(Date.now());
    },
    resume() {
      store.resume();
    },
    status() {
      const now = Date.now();
      return {
        paused: store.isPaused(),
        lastTickAt: store.getLastTickAt(),
        ticks24h: store.countTicksSince(now - DAY_MS),
        queueSize: queue.size(),
        handlers: registry.list().map((h) => h.name),
        recentRuns: store.recentRuns(10),
      };
    },
    markPublished(runId, publishedAt) {
      store.markPublished(runId, publishedAt);
    },
  };
}
```

- [ ] **Step 4: Run tests** — all passing.

- [ ] **Step 5: Commit**

```ts
git add packages/server/src/cognition/service.ts packages/server/src/cognition/__tests__/service.test.ts
git commit -m "feat(cognition): service composing store/registry/queue/dispatcher/heartbeat"
```

---

## Task 10: `pulse` handler

**Files:**
- Create: `packages/server/src/cognition/handlers/pulse.ts`
- Create: `packages/server/src/cognition/__tests__/handlers/pulse.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/server/src/cognition/__tests__/handlers/pulse.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { pulseHandler } from '../../handlers/pulse.js';

describe('pulse handler', () => {
  it('trigger=true on first run (lastFiredAt=null)', () => {
    expect(pulseHandler.trigger({ now: 0, lastFiredAt: null, lastResult: null })).toBe(true);
  });

  it('trigger=false within 5 min', () => {
    const now = 10_000_000;
    expect(pulseHandler.trigger({ now, lastFiredAt: now - 4 * 60 * 1000, lastResult: null })).toBe(false);
  });

  it('trigger=true after 5 min', () => {
    const now = 10_000_000;
    expect(pulseHandler.trigger({ now, lastFiredAt: now - 5 * 60 * 1000, lastResult: null })).toBe(true);
  });

  it('run returns skip with ISO timestamp', async () => {
    const ctx = { db: {} as any, signal: new AbortController().signal };
    const result = await pulseHandler.run(ctx);
    expect(result).toMatchObject({ skip: true });
    if ('skip' in result) {
      expect(result.reason).toMatch(/^alive at \d{4}-\d{2}-\d{2}T/);
    }
  });
});
```

- [ ] **Step 2: Run test** — expect FAIL.

- [ ] **Step 3: Implement**

Create `packages/server/src/cognition/handlers/pulse.ts`:

```ts
import type { Handler } from '../types.js';

const FIVE_MINUTES = 5 * 60 * 1000;

export const pulseHandler: Handler = {
  name: 'pulse',
  trigger: (state) => {
    if (state.lastFiredAt === null) return true;
    return state.now - state.lastFiredAt >= FIVE_MINUTES;
  },
  run: async () => ({
    skip: true,
    reason: `alive at ${new Date().toISOString()}`,
  }),
};
```

- [ ] **Step 4: Run tests** — passing.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/cognition/handlers packages/server/src/cognition/__tests__/handlers
git commit -m "feat(cognition): pulse demo handler"
```

---

## Task 11: Wire `cognitionService` in `index.ts`

**Files:**
- Modify: `packages/server/src/index.ts`

- [ ] **Step 1: Edit imports**

Add at the top, near other cognition-relatable imports:

```ts
import { createCognitionService } from './cognition/service.js';
import { pulseHandler } from './cognition/handlers/pulse.js';
```

- [ ] **Step 2: Instantiate after `reminderBus` line**

Find the existing line `const reminderBus = ...` and after the `startScheduler` call, add:

```ts
const cognitionService = createCognitionService({
  db: getDb(),
  bus: reminderBus,
});
cognitionService.register(pulseHandler);
cognitionService.start();
```

- [ ] **Step 3: Pass to Discord deps**

In the existing `startDiscordBot({ ... })` deps object, add:

```ts
cognitionService,
```

(near `reminderBus`).

- [ ] **Step 4: Stop on SIGTERM**

In the existing `process.on('SIGTERM', async () => {...})` block, add before `await discordBot?.stop()`:

```ts
cognitionService.stop();
```

- [ ] **Step 5: Run server tests**

```bash
npx vitest run --root packages/server
```

Expected: green. (Existing tests should not regress; this introduces a new field on `DiscordBotDeps` only — added in Task 12.)

If tests fail with `cognitionService` missing on `DiscordBotDeps`, that's expected — Task 12 adds it. To proceed clean, complete Task 12 before re-running.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/index.ts
git commit -m "chore(index): wire cognitionService + register pulse handler"
```

---

## Task 12: Discord bot — accept `cognitionService` + listen for `cognition_publish`

**Files:**
- Modify: `packages/server/src/channels/discord/bot.ts`
- Modify: `packages/server/src/channels/discord/__tests__/bot.test.ts`

- [ ] **Step 1: Write failing test**

Append to `bot.test.ts`:

```ts
describe('cognition_publish handling', () => {
  it('emits cognition_publish on bus → DM is sent and markPublished called', async () => {
    const client = makeFakeClient();
    const bus = new EventEmitter();
    const dmSend = vi.fn().mockResolvedValue(undefined);
    const fetchUser = vi.fn().mockResolvedValue({ createDM: vi.fn().mockResolvedValue({ send: dmSend }) });
    (client as any).users = { fetch: fetchUser };
    const markPublished = vi.fn();

    const { stop } = await startDiscordBot({
      token: 'test', whitelist: new Set(['123']),
      runChatRequest: vi.fn(),
      db: makeFakeDb() as any, historyLimit: 10, saveMessage: vi.fn(),
      memoryService: null, _client: client,
      reminderBus: bus,
      reminderService: { dismiss: vi.fn(), snooze: vi.fn(), list: vi.fn() } as any,
      permissionService: { hasPending: vi.fn(), resolveConfirm: vi.fn() } as any,
      planReviewService: { hasPending: vi.fn(), resolveReview: vi.fn() } as any,
      commandService: {
        clearHistory: vi.fn(), status: vi.fn(), listReminders: vi.fn(), listMemory: vi.fn(),
        listPermissionRules: vi.fn().mockReturnValue([]), revokePermissionRule: vi.fn(),
      } as any,
      cognitionService: {
        register: vi.fn(), start: vi.fn(), stop: vi.fn(),
        pause: vi.fn(), resume: vi.fn(),
        status: vi.fn(), markPublished,
      } as any,
    });

    bus.emit('push', { type: 'cognition_publish', runId: 7, handler: 'pulse', content: 'hello' });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(dmSend).toHaveBeenCalledWith(expect.stringContaining('hello'));
    expect(markPublished).toHaveBeenCalledWith(7, expect.any(Number));
    await stop();
  });
});
```

- [ ] **Step 2: Run test** — expect FAIL.

- [ ] **Step 3: Implement**

Edit `packages/server/src/channels/discord/bot.ts`:

(a) Add import:

```ts
import type { CognitionService } from '../../cognition/service.js';
```

(b) Add field to `DiscordBotDeps`:

```ts
cognitionService?: CognitionService;
```

(c) Inside `startDiscordBot`, alongside the existing `reminderListener` setup, add:

```ts
let cognitionListener: ((e: any) => void) | null = null;
if (deps.reminderBus) {
  cognitionListener = (event: any) => {
    if (event.type !== 'cognition_publish') return;
    if (!client.isReady()) return;
    for (const userId of deps.whitelist) {
      client.users.fetch(userId)
        .then((u) => u.createDM())
        .then((dm) => dm.send(`💭 _from ${event.handler}_\n${event.content}`))
        .then(() => {
          deps.cognitionService?.markPublished(event.runId, Date.now());
        })
        .catch((err) => console.error(
          '[discord] cognition publish failed:',
          err instanceof Error ? err.message : err,
        ));
    }
  };
  deps.reminderBus.on('push', cognitionListener);
}
```

(d) In the `stop()` returned function, add cleanup:

```ts
if (cognitionListener && deps.reminderBus) {
  deps.reminderBus.off('push', cognitionListener);
}
```

- [ ] **Step 4: Run tests** — all passing.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/channels/discord/bot.ts packages/server/src/channels/discord/__tests__/bot.test.ts
git commit -m "feat(discord): bot listens for cognition_publish events"
```

---

## Task 13: `/heartbeat` slash command + register

**Files:**
- Modify: `packages/server/src/channels/discord/slash-commands.ts`

- [ ] **Step 1: Edit**

In `slash-commands.ts`, append to `SLASH_COMMAND_DEFINITIONS` array (before the `.map(b => b.toJSON())`):

```ts
new SlashCommandBuilder()
  .setName('heartbeat')
  .setDescription('R2 cognition layer control')
  .setDMPermission(true)
  .addSubcommand((sub) => sub.setName('status').setDescription('Show heartbeat status'))
  .addSubcommand((sub) => sub.setName('pause').setDescription('Pause heartbeat'))
  .addSubcommand((sub) => sub.setName('resume').setDescription('Resume heartbeat')),
```

- [ ] **Step 2: Run server tests**

```bash
npx vitest run --root packages/server
```

Expected: green (no slash-command shape test asserts the new command yet — added in Task 14).

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/channels/discord/slash-commands.ts
git commit -m "feat(discord): register /heartbeat slash command"
```

---

## Task 14: `/heartbeat` interaction handler + tests

**Files:**
- Modify: `packages/server/src/channels/discord/interactions.ts`
- Modify: `packages/server/src/channels/discord/__tests__/interactions.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `interactions.test.ts`:

```ts
describe('routeInteraction — /heartbeat', () => {
  function makeCogService(overrides: Record<string, any> = {}) {
    return {
      register: vi.fn(), start: vi.fn(), stop: vi.fn(),
      pause: vi.fn(), resume: vi.fn(),
      status: vi.fn().mockReturnValue({
        paused: false,
        lastTickAt: 1700000000000,
        ticks24h: 1440,
        queueSize: 0,
        handlers: ['pulse'],
        recentRuns: [],
      }),
      markPublished: vi.fn(),
      ...overrides,
    } as any;
  }

  function makeSlash(overrides: Record<string, any> = {}) {
    return {
      isButton: () => false,
      isChatInputCommand: () => true,
      user: { id: 'user-1' },
      commandName: 'heartbeat',
      options: { getSubcommand: vi.fn().mockReturnValue('status'), getString: vi.fn() },
      reply: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    } as any;
  }

  it('status: ephemeral reply with paused/last tick/handlers', async () => {
    const cognitionService = makeCogService();
    const deps = makeDeps({ cognitionService });
    const ixn = makeSlash();
    await routeInteraction(ixn, deps);
    expect(cognitionService.status).toHaveBeenCalled();
    const arg = (ixn.reply as any).mock.calls[0][0];
    expect(arg.flags).toBeDefined();
    expect(arg.content).toContain('alive');
    expect(arg.content).toContain('pulse');
  });

  it('pause: calls service.pause + ephemeral confirmation', async () => {
    const cognitionService = makeCogService();
    const deps = makeDeps({ cognitionService });
    const ixn = makeSlash({ options: { getSubcommand: vi.fn().mockReturnValue('pause'), getString: vi.fn() } });
    await routeInteraction(ixn, deps);
    expect(cognitionService.pause).toHaveBeenCalled();
    expect((ixn.reply as any).mock.calls[0][0].content).toContain('paused');
  });

  it('resume: calls service.resume + ephemeral confirmation', async () => {
    const cognitionService = makeCogService();
    const deps = makeDeps({ cognitionService });
    const ixn = makeSlash({ options: { getSubcommand: vi.fn().mockReturnValue('resume'), getString: vi.fn() } });
    await routeInteraction(ixn, deps);
    expect(cognitionService.resume).toHaveBeenCalled();
    expect((ixn.reply as any).mock.calls[0][0].content).toContain('resumed');
  });
});
```

Update the `makeDeps` helper at the top of `interactions.test.ts` to include `cognitionService` in its default object:

```ts
cognitionService: {
  register: vi.fn(), start: vi.fn(), stop: vi.fn(),
  pause: vi.fn(), resume: vi.fn(),
  status: vi.fn().mockReturnValue({
    paused: false, lastTickAt: null, ticks24h: 0, queueSize: 0, handlers: [], recentRuns: [],
  }),
  markPublished: vi.fn(),
} as any,
```

- [ ] **Step 2: Run tests** — expect FAIL.

- [ ] **Step 3: Implement**

Edit `packages/server/src/channels/discord/interactions.ts`:

(a) Add to `InteractionDeps` interface:

```ts
cognitionService: import('../../cognition/service.js').CognitionService;
```

(or add `import type { CognitionService } from '../../cognition/service.js';` then `cognitionService: CognitionService;`).

(b) Inside `routeSlashCommand`, append before the closing `}`:

```ts
if (name === 'heartbeat') {
  const sub = (ixn as any).options.getSubcommand();
  if (sub === 'status') {
    const s = deps.cognitionService.status();
    const lines = [
      `**Heartbeat: ${s.paused ? '⏸️ paused' : '🫀 alive'}**`,
      `Last tick: ${s.lastTickAt ? new Date(s.lastTickAt).toISOString() : 'never'}`,
      `Ticks (last 24h): ${s.ticks24h}`,
      `Queue depth: ${s.queueSize}`,
      `Registered handlers: ${s.handlers.length > 0 ? s.handlers.join(', ') : '(none)'}`,
    ];
    if (s.recentRuns.length > 0) {
      lines.push('', 'Recent runs:');
      for (const r of s.recentRuns.slice(0, 10)) {
        const t = new Date(r.firedAt).toISOString().slice(11, 19);
        const note = r.outcome === 'publish' ? r.content : r.reason;
        lines.push(`\`${t}\` ${r.handlerName} — ${r.outcome}${note ? ` (${note.slice(0, 80)})` : ''}`);
      }
    }
    await (ixn as any).reply({ flags: MessageFlags.Ephemeral, content: lines.join('\n') });
    return;
  }
  if (sub === 'pause') {
    deps.cognitionService.pause();
    await (ixn as any).reply({ flags: MessageFlags.Ephemeral, content: '⏸️ Heartbeat paused.' });
    return;
  }
  if (sub === 'resume') {
    deps.cognitionService.resume();
    await (ixn as any).reply({ flags: MessageFlags.Ephemeral, content: '🫀 Heartbeat resumed.' });
    return;
  }
}
```

(c) In `bot.ts` (already added cognitionService to `DiscordBotDeps` in Task 12) — pass it to `routeInteraction`:

In the `client.on('interactionCreate', ...)` handler:

```ts
await routeInteraction(interaction, {
  whitelist: deps.whitelist,
  reminderService: deps.reminderService,
  permissionService: deps.permissionService,
  planReviewService: deps.planReviewService,
  commandService: deps.commandService,
  cognitionService: deps.cognitionService!,  // NEW (non-null because index.ts always provides)
});
```

- [ ] **Step 4: Run tests** — all passing.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/channels/discord/interactions.ts packages/server/src/channels/discord/__tests__/interactions.test.ts packages/server/src/channels/discord/bot.ts
git commit -m "feat(discord): /heartbeat status/pause/resume handler"
```

---

## Task 15: Full suite + typecheck

**Files:** all

- [ ] **Step 1: Run full server tests**

```bash
npx vitest run --root packages/server
```

Expected: all green. If anything fails, the most likely cause is stub coverage in interactions/bot/command-service tests for the new methods. Add the missing `cognitionService` field to those test setups.

- [ ] **Step 2: Typecheck**

```bash
npx tsc -p packages/shared --noEmit && npx tsc -p packages/server --noEmit
```

Expected: clean.

- [ ] **Step 3: Commit any test-stub fixes (if needed)**

```bash
git add -A
git commit -m "chore(test): add cognitionService stub to existing test deps"
```

(If nothing changed, skip.)

---

## Task 16: Manual E2E

**Goal:** Verify heartbeat lives, status reports, pause/resume work, pulse fires.

- [ ] **Step 1: Start dev server**

```bash
cd /Users/dim/code/R2-D2 && npm run dev
```

Confirm server log shows `[discord] bot started` and `[discord] slash commands registered`. There is no specific cognition log line; the heartbeat is silent.

- [ ] **Step 2: Initial status**

In Discord DM:

```
/heartbeat status
```

Verify ephemeral reply:
- `🫀 alive`
- `Last tick: <ISO>` (within last 60 s)
- `Ticks (last 24h): 1` (or low number, since just started)
- `Registered handlers: pulse`
- `Recent runs:` either empty (if pulse hasn't fired yet) or `pulse — skip (alive at …)` if first run already happened.

- [ ] **Step 3: Wait for pulse to fire**

Wait ~5 minutes. Run `/heartbeat status` again. Verify `Recent runs` now contains a `pulse — skip (alive at YYYY-MM-DDTHH:MM:SS.sssZ)` entry.

- [ ] **Step 4: Pause and verify no new ticks/runs**

```
/heartbeat pause
```

Verify reply: `⏸️ Heartbeat paused.`

Wait 2-3 minutes. Run `/heartbeat status`. Verify:
- `⏸️ paused`
- `Last tick:` is **not** updated (matches the value from before pause)

- [ ] **Step 5: Resume**

```
/heartbeat resume
```

Verify reply: `🫀 Heartbeat resumed.` Wait 60 s. `/heartbeat status` shows updated `Last tick`.

- [ ] **Step 6: Restart persistence**

Stop dev server (Ctrl-C), `/heartbeat pause` first if still running. Start `npm run dev` again. Run `/heartbeat status` — verify still `⏸️ paused` (state survived restart). Resume.

- [ ] **Step 7: Document findings**

Append a "Manual E2E results" block to `docs/superpowers/specs/2026-04-18-cognition-layer-design.md`. Commit.

```bash
git add docs/superpowers/specs/2026-04-18-cognition-layer-design.md
git commit -m "docs(spec): mark cognition layer E2E verified"
```

---

## Self-Review Notes

Checked against `docs/superpowers/specs/2026-04-18-cognition-layer-design.md`:

- §1 architecture (two-layer split) → covered by isolating `cognition/` directory + reusing `reminderBus` for events; reflexes untouched.
- §2 module layout → Tasks 2-9 + 10.
- §3 handler interface → Task 2 (types), exercised by all subsequent tests.
- §4 tick interval + dispatcher → Tasks 7, 8.
- §5 single-worker queue → Task 6.
- §6 storage + retention → Tasks 1, 3, 4.
- §7 CognitionService + status semantics → Task 9; pause-skips-recordTick verified in Task 8 test.
- §8 pulse handler → Task 10.
- §9 Discord control surface (`/heartbeat` + `cognition_publish` listener) → Tasks 12, 13, 14.
- §10 wiring → Task 11.
- §11 file list → matches the tasks.
- §12 testing → tests live in each task.
- §13 risks (bus naming, drift, opportunistic markPublished) → handled implicitly; no spec contradiction.

No TODOs / placeholders. All types defined in Task 2 (`Handler`, `HandlerState`, `HandlerContext`, `HandlerResult`, `HandlerRunRecord`, `CognitionStatus`) and consistently referenced through Tasks 3-14. The `markPublished` method appears on `CognitionStore` (Task 4), exposed on `CognitionService` (Task 9), and called by the bot listener (Task 12) — chain checked.
