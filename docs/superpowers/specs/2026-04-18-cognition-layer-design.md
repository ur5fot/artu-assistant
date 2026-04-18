# Cognition Layer — heartbeat infra (MVP)

## Problem

R2 today is purely reactive: it answers when spoken to, executes tools when asked, fires reminders on schedule. There is no surface for *autonomous* behaviour — no place where R2 can "think" on its own, notice a pattern, or decide to volunteer something.

The vision (project_vision, EPICs 5-7) requires R2 to:
- Periodically reflect on past conversations and extract patterns
- Detect open loops (things the user said they'd do but didn't)
- Make proactive suggestions
- Eventually act autonomously based on observations

All of these are *cognition* (R2 thinking unprompted), distinct from *reflexes* (Discord reply, reminder ring, tool execution).

This spec defines the **infrastructure** for the cognition layer: a heartbeat tick that runs handlers on triggers, isolated from the reflex layer. It ships as pure infrastructure with one demo handler (`pulse`) that proves the pipeline end-to-end without producing user-visible noise. Real analytical handlers (reflection, pattern detection, etc.) are deliberately out of scope and will land as separate specs once the foundation is proven.

## Non-goals

- Any analytical handler (reflection, summary, open-loops detector) — separate specs.
- LLM-driven dispatcher (R2 deciding *what* to think about each tick) — too expensive; we use rule-based triggers.
- Multi-worker concurrency — single worker is enough for current handler cadence (every-hour-ish).
- Per-handler scheduling (cron) — overkill; trigger functions own their timing.
- Web UI for cognition status — Discord-only per `project_primary_channel`.
- Energy budget / publish-rate limiter — premature without real handlers to rate-limit.
- Persistence of in-flight queue jobs — restart drops the queue; tick re-enqueues on next trigger.
- Replacing or modifying the existing reminder scheduler.

## Design

### 1. Architecture: two layers

```
R2 process
├── Reflex layer (existing, unchanged)
│   ├── Discord bot          ← event-driven, instant
│   ├── Reminder scheduler   ← own setInterval loop
│   └── Tool execution       ← invoked by chat pipeline
└── Cognition layer (NEW)
    ├── Heartbeat tick (60s)
    ├── Dispatcher  ← evaluates triggers on each tick
    ├── Job queue   ← single async worker, in-memory FIFO
    ├── Handler registry
    └── Store       ← pause state, ticks, handler runs (SQLite)
```

The cognition layer is **isolated**: if the heartbeat dies, reflexes keep working. Publication happens through the existing shared `bus` (`'cognition_publish'` event), the same pattern reminders use for `'reminder_ring'`. The Discord bot subscribes to that event the same way.

### 2. Module layout

```
packages/server/src/cognition/
├── types.ts                — Handler, HandlerState, HandlerContext, HandlerResult
├── store.ts                — CognitionStore (DB IO)
├── registry.ts             — HandlerRegistry (Map + register/get/list)
├── queue.ts                — JobQueue (single worker, FIFO)
├── dispatcher.ts           — Dispatcher.runTick
├── heartbeat.ts            — startHeartbeat (setInterval)
├── service.ts              — CognitionService (composes everything; public API)
├── handlers/
│   └── pulse.ts            — demo handler (no publish)
└── __tests__/
```

### 3. Handler interface

Triggers are separated from execution: the tick can quickly evaluate dozens of triggers without ever calling an LLM, and only enqueue the ones that actually fire.

```ts
export interface Handler {
  name: string;
  trigger: (state: HandlerState) => boolean;
  run: (ctx: HandlerContext) => Promise<HandlerResult>;
}

export interface HandlerState {
  now: number;
  lastFiredAt: number | null;     // ms timestamp from cognition_handler_runs
  lastResult: HandlerResult | null;
}

export interface HandlerContext {
  db: Database.Database;
  signal: AbortSignal;            // worker timeout abort
}

export type HandlerResult =
  | { publish: true; content: string }
  | { skip: true; reason: string }
  | { error: true; message: string };
```

Constraints:
- `trigger()` MUST be synchronous and fast (millisecond range). Throwing is caught and logged but does not stop the tick.
- `run()` SHOULD respect `ctx.signal` so worker timeouts can abort.
- Handler names are unique; `registry.register(handler)` throws on duplicates.

### 4. Tick interval and dispatcher

```ts
export const HEARTBEAT_TICK_MS = 60_000;

// heartbeat.ts
export function startHeartbeat(deps: {
  dispatcher: Dispatcher;
  store: CognitionStore;
}): { stop(): void } {
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
  return { stop() { clearInterval(timer); } };
}
```

```ts
// dispatcher.ts
export function createDispatcher(deps: {
  registry: HandlerRegistry;
  queue: JobQueue;
  store: CognitionStore;
}): Dispatcher {
  return {
    async runTick(now: number) {
      for (const handler of deps.registry.list()) {
        const state: HandlerState = {
          now,
          lastFiredAt: deps.store.getLastFiredAt(handler.name),
          lastResult: deps.store.getLastResult(handler.name),
        };
        let triggered = false;
        try {
          triggered = handler.trigger(state);
        } catch (err) {
          console.error(`[cognition] trigger ${handler.name} threw:`, err instanceof Error ? err.message : err);
        }
        if (triggered) deps.queue.enqueue({ handlerName: handler.name });
      }
    },
  };
}
```

### 5. Single-worker queue

```ts
// queue.ts
export interface Job { handlerName: string; }

export function createJobQueue(deps: {
  registry: HandlerRegistry;
  store: CognitionStore;
  bus: EventEmitter;
  workerTimeoutMs?: number;
}): JobQueue {
  const jobs: Job[] = [];
  let running = false;
  const timeoutMs = deps.workerTimeoutMs ?? 60_000;
  let inFlight: Promise<void> = Promise.resolve();

  async function pump() {
    while (running && jobs.length > 0) {
      const job = jobs.shift()!;
      const handler = deps.registry.get(job.handlerName);
      if (!handler) continue;

      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      const startedAt = Date.now();
      let result: HandlerResult;
      try {
        result = await handler.run({ db: deps.store.db, signal: ac.signal });
      } catch (err) {
        result = { error: true, message: err instanceof Error ? err.message : String(err) };
      } finally {
        clearTimeout(timer);
      }

      const runId = deps.store.recordHandlerRun({
        handlerName: handler.name,
        firedAt: startedAt,
        durationMs: Date.now() - startedAt,
        result,
      });

      if ('publish' in result && result.publish) {
        deps.bus.emit('push', {
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
      if (running) inFlight = inFlight.then(pump).catch((err) =>
        console.error('[cognition] worker error:', err instanceof Error ? err.message : err),
      );
    },
    size: () => jobs.length,
    start() { running = true; inFlight = pump(); },
    stop() { running = false; },
  };
}
```

- **Single worker** — `inFlight` chain ensures only one `pump` invocation processes the queue at a time.
- **Worker timeout** default 60 s, abort via `AbortController`. Handlers SHOULD respect the signal.
- **Errors caught** — handler crash records as `error` outcome and the worker continues.
- **Restart drops in-flight queue.** Triggers re-enqueue on the next tick if conditions hold.

### 6. Storage

Three new SQLite tables, all created via `CREATE TABLE IF NOT EXISTS` in the existing `initDb()` flow:

```sql
CREATE TABLE IF NOT EXISTS cognition_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  paused INTEGER NOT NULL DEFAULT 0,
  paused_at INTEGER
);
INSERT OR IGNORE INTO cognition_state (id, paused) VALUES (1, 0);

CREATE TABLE IF NOT EXISTS cognition_ticks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tick_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cognition_ticks_at ON cognition_ticks(tick_at);

CREATE TABLE IF NOT EXISTS cognition_handler_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  handler_name TEXT NOT NULL,
  fired_at INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('publish', 'skip', 'error')),
  content TEXT,
  reason TEXT,
  published_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_cognition_handler_runs_name_at
  ON cognition_handler_runs(handler_name, fired_at DESC);
```

`recordTick` cleans up tick rows older than 7 days on each insert (≈10 080 rows steady-state at 60 s tick). `cognition_handler_runs` is left to grow; cleanup is deferred until real handlers exist.

`CognitionStore` interface:

```ts
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
  }): number;  // returns row id
  markPublished(runId: number, publishedAt: number): void;
  getLastFiredAt(handlerName: string): number | null;
  getLastResult(handlerName: string): HandlerResult | null;
  recentRuns(limit: number): Array<{
    id: number;
    handlerName: string;
    firedAt: number;
    durationMs: number;
    outcome: 'publish' | 'skip' | 'error';
    content?: string;
    reason?: string;
    publishedAt?: number;
  }>;
}
```

`getLastResult` reconstructs `HandlerResult` from the persisted `outcome` + `content`/`reason`/`message` columns (mapping `outcome='error'` + `reason` → `{ error: true, message }`).

### 7. CognitionService — public API

```ts
export interface CognitionService {
  register(handler: Handler): void;
  start(): void;
  stop(): void;
  pause(): void;
  resume(): void;
  status(): CognitionStatus;
}

export interface CognitionStatus {
  paused: boolean;
  lastTickAt: number | null;
  ticks24h: number;
  queueSize: number;
  handlers: string[];
  recentRuns: Array<{
    handlerName: string;
    firedAt: number;
    outcome: 'publish' | 'skip' | 'error';
    reason?: string;
  }>;
}
```

`createCognitionService(deps)` composes `CognitionStore`, `HandlerRegistry`, `JobQueue`, `Dispatcher`, and the heartbeat. `start()` starts the queue and the heartbeat; `stop()` stops both. `pause()` flips the persisted state. When paused, `tick` returns early *before* both `recordTick` and dispatcher — so the `cognition_ticks` table represents only active time and `/heartbeat status` ticks-24h reflects when R2 was actually thinking.

### 8. `pulse` demo handler

```ts
// cognition/handlers/pulse.ts
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

- Trigger: every 5 min (or on first run after start).
- Run: returns `skip` with a timestamp. Recorded in `cognition_handler_runs` as `outcome='skip'`. No Discord publication.
- Purpose: prove the full pipeline works (tick → trigger → enqueue → worker → recordHandlerRun) and serve as a copy-paste template for future handlers.

### 9. Discord control surface

#### `/heartbeat` slash command (with sub-commands)

```ts
new SlashCommandBuilder()
  .setName('heartbeat')
  .setDescription('R2 cognition layer control')
  .setDMPermission(true)
  .addSubcommand((sub) => sub.setName('status').setDescription('Show heartbeat status'))
  .addSubcommand((sub) => sub.setName('pause').setDescription('Pause heartbeat'))
  .addSubcommand((sub) => sub.setName('resume').setDescription('Resume heartbeat'))
```

Handler in `interactions.ts routeSlashCommand`:

- **status** → ephemeral message with paused state, last tick at, ticks-in-last-24h, queue depth, registered handlers, recent runs (last 10).
- **pause** → `cognitionService.pause()` → `⏸️ Heartbeat paused.`
- **resume** → `cognitionService.resume()` → `🫀 Heartbeat resumed.`

Whitelist check at top of `routeInteraction` already covers authorization.

#### Discord bot subscribes to `cognition_publish` events

Even though `pulse` never publishes, wire the listener now so future handlers light up immediately:

```ts
// startDiscordBot
let cognitionListener: ((e: any) => void) | null = null;
if (deps.bus) {
  cognitionListener = async (event: any) => {
    if (event.type !== 'cognition_publish') return;
    if (!client.isReady()) return;
    for (const userId of deps.whitelist) {
      try {
        const user = await client.users.fetch(userId);
        const dm = await user.createDM();
        await dm.send(`💭 _from ${event.handler}_\n${event.content}`);
        deps.cognitionService?.markPublished?.(event.runId, Date.now());
      } catch (err) {
        console.error('[discord] cognition publish failed:',
          err instanceof Error ? err.message : err);
      }
    }
  };
  deps.bus.on('push', cognitionListener);
}
```

Removed in `stop()` alongside `reminderListener`.

### 10. Wiring (index.ts)

```ts
import { createCognitionService } from './cognition/service.js';
import { pulseHandler } from './cognition/handlers/pulse.js';

const cognitionService = createCognitionService({
  db: getDb(),
  bus: reminderBus,  // shared bus
});
cognitionService.register(pulseHandler);
cognitionService.start();

// pass to Discord deps:
//   cognitionService,

// SIGTERM:
process.on('SIGTERM', async () => {
  // ... existing
  cognitionService.stop();
});
```

`reminderBus` is reused as the shared event bus; renaming to `bus` is out of scope for this spec (a follow-up cleanup).

### 11. Files

**New:**
- `packages/server/src/cognition/types.ts`
- `packages/server/src/cognition/store.ts`
- `packages/server/src/cognition/registry.ts`
- `packages/server/src/cognition/queue.ts`
- `packages/server/src/cognition/dispatcher.ts`
- `packages/server/src/cognition/heartbeat.ts`
- `packages/server/src/cognition/service.ts`
- `packages/server/src/cognition/handlers/pulse.ts`
- `packages/server/src/cognition/__tests__/store.test.ts`
- `packages/server/src/cognition/__tests__/registry.test.ts`
- `packages/server/src/cognition/__tests__/queue.test.ts`
- `packages/server/src/cognition/__tests__/dispatcher.test.ts`
- `packages/server/src/cognition/__tests__/heartbeat.test.ts`
- `packages/server/src/cognition/__tests__/service.test.ts`
- `packages/server/src/cognition/__tests__/handlers/pulse.test.ts`

**Modified:**

| File | Change |
|---|---|
| `db.ts` | `CREATE TABLE` blocks for the three cognition tables in `initDb()`. |
| `index.ts` | Instantiate `cognitionService`, register `pulseHandler`, `start()`, pass to Discord deps; `stop()` on SIGTERM. |
| `channels/discord/bot.ts` | Accept `cognitionService` in `DiscordBotDeps`; subscribe to `cognition_publish` event; pass to `routeInteraction`. |
| `channels/discord/interactions.ts` | `InteractionDeps` gains `cognitionService`; handle `name === 'heartbeat'` with `status`/`pause`/`resume` sub-commands. |
| `channels/discord/slash-commands.ts` | Register `/heartbeat` with sub-commands. |
| `channels/discord/__tests__/interactions.test.ts` | Tests for `/heartbeat status`/`pause`/`resume`. |
| `channels/discord/__tests__/bot.test.ts` | Test that `cognition_publish` event triggers DM send. |

### 12. Testing

**Unit:**
- `store.test.ts` — pause/resume toggle persists, recordTick + retention deletes >7d rows, recordHandlerRun returns row id, getLastFiredAt picks latest, recentRuns ordered desc, getLastResult round-trips publish/skip/error variants.
- `registry.test.ts` — register adds handler, get returns by name, list returns all, duplicate name throws.
- `queue.test.ts` — enqueue + start processes FIFO, error in handler.run records error and continues, timeout (mock fake-timer) aborts via signal, multiple enqueues during in-flight chain serially.
- `dispatcher.test.ts` — runTick calls trigger for every registered handler, enqueues only triggered ones, handler whose trigger throws does not break the loop.
- `heartbeat.test.ts` — setInterval fires runTick, paused state skips runTick AND skips recordTick, stop() clears timer.
- `service.test.ts` — start composes queue.start + startHeartbeat; stop composes both stops; pause/resume delegates to store.
- `handlers/pulse.test.ts` — trigger=true on lastFiredAt=null; trigger=true after 5min; trigger=false at 4min; run returns skip with ISO timestamp.

**Integration:**
- `interactions.test.ts` — mock `cognitionService.status()` returns canned status, assert ephemeral reply contains all fields. `pause`/`resume` calls service.
- `bot.test.ts` — emit `cognition_publish` on bus → `dm.send` called with formatted message.
- `index.ts` smoke (covered by full server suite passing) — startup wires cognition without crashing.

### 13. Risks / open points

- **Pulse audit row volume.** 5-min interval = 288 rows/day; 100k+/year. Small. Defer cleanup until first real handler ships.
- **Worker timeout default 60 s.** `pulse` doesn't need it. Future analytical handlers may want longer; we'll add per-handler `timeoutMs` on the registration in a follow-up if needed.
- **`bus` is named `reminderBus`.** We reuse it for cognition events. Renaming to a generic `bus` is a separate, mechanical refactor — not in this spec.
- **Tick drift / process suspend.** macOS may suspend the process under load; `setInterval` will catch up but not exactly hit 60 s boundaries. Cognition handlers are time-of-day-tolerant by construction.
- **markPublished is opportunistic.** If Discord send fails, `published_at` stays NULL. We don't retry — the audit row records the publish intent and the failure is logged.
