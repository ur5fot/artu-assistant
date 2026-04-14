# Reminder Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Добавить alarm-style напоминания: пользователь создаёт напоминание голосом/текстом (one-shot или recurring daily/weekly/monthly), сервер вовремя запускает цикл звонка (60s ring × 3 с 2-мин паузами), UI играет Web Audio tone и показывает модалку с Dismiss/Snooze.

**Architecture:** Новый пакет `@r2/tool-reminder` с тремя tool'ами (create/list/delete), server-side scheduler на setInterval с state-machine в SQLite (idempotent на рестарт), SSE `/api/events` для server→client push (без WebSocket), отдельный ReminderAlarm компонент в client'е. Prompt guard в конце — чтобы qwen не имитировал действия при отсутствии tool'а.

**Tech Stack:** TypeScript monorepo, pnpm workspaces, Vitest, better-sqlite3, Express, React (client), Web Audio API.

**Spec:** `docs/superpowers/specs/2026-04-14-reminder-tool-design.md`

---

## File Structure

**Create:**
- `packages/tool-reminder/package.json`
- `packages/tool-reminder/tsconfig.json`
- `packages/tool-reminder/src/index.ts` — tool definitions + `createTool(deps)`
- `packages/tool-reminder/src/schedule-types.ts` — Schedule discriminated union
- `packages/server/src/reminders/recurrence.ts` — `computeNextFire(schedule, now) → number | null`
- `packages/server/src/reminders/__tests__/recurrence.test.ts`
- `packages/server/src/reminders/store.ts` — CRUD + state-machine actions over SQLite
- `packages/server/src/reminders/__tests__/store.test.ts`
- `packages/server/src/reminders/scheduler.ts` — background tick
- `packages/server/src/reminders/__tests__/scheduler.test.ts`
- `packages/server/src/reminders/bus.ts` — EventEmitter singleton for SSE broadcast
- `packages/server/src/routes/events.ts` — SSE `/api/events` endpoint
- `packages/server/src/routes/reminder.ts` — POST `/dismiss`, POST `/snooze`
- `packages/server/src/routes/__tests__/reminder.test.ts`
- `packages/client/src/lib/alarm-audio.ts` — Web Audio wrapper
- `packages/client/src/components/ReminderAlarm.tsx` — singleton modal + EventSource listener
- `packages/client/src/components/__tests__/ReminderAlarm.test.tsx`

**Modify:**
- `packages/server/src/db.ts` — add `reminders` table DDL + exported CRUD helpers (or these live in store.ts and db.ts stays minimal — see Task 2)
- `packages/server/src/tools/base.ts` — add `reminderStore?: ReminderStore` to `ToolDeps`
- `packages/server/src/index.ts` — build `reminderStore`, start scheduler, mount routers
- `packages/server/src/ai/prompts.ts` — prompt guard against fabricated tool actions
- `packages/shared/src/types.ts` — new server-push event types
- `packages/client/src/App.tsx` — mount `<ReminderAlarm />`
- `AGENTS.md` — document Phase 5 / reminder feature

---

## Task 1: Recurrence Calculator

**Files:**
- Create: `packages/server/src/reminders/recurrence.ts`
- Create: `packages/server/src/reminders/__tests__/recurrence.test.ts`
- Create: `packages/tool-reminder/src/schedule-types.ts` (needed by recurrence for the type)

TDD: write the failing tests first, then implement. This task is pure functions, no side effects — easy to test.

### Step 1.1: Create shared schedule type

- [x] Create `packages/tool-reminder/src/schedule-types.ts`:

```ts
export type Schedule =
  | { kind: 'once'; at_iso: string }
  | { kind: 'daily'; hour: number; minute: number }
  | { kind: 'weekly'; weekdays: number[]; hour: number; minute: number }
  | { kind: 'monthly'; day_of_month: number; hour: number; minute: number };
```

### Step 1.2: Create minimal `packages/tool-reminder/package.json`

Needed so TypeScript can resolve the import from the server package even though no tool factory exists yet.

- [x] Create `packages/tool-reminder/package.json`:

```json
{
  "name": "@r2/tool-reminder",
  "version": "0.1.0",
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "dependencies": {
    "@r2/shared": "*"
  },
  "devDependencies": {
    "typescript": "^5.7.0"
  }
}
```

- [x] Create `packages/tool-reminder/tsconfig.json`:

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

- [x] Create a placeholder `packages/tool-reminder/src/index.ts`:

```ts
export type { Schedule } from './schedule-types.js';
```

(Real tool definitions come in Task 3.)

- [x] Install workspace: `cd /Users/dim/code/R2-D2 && npm install` (syncs the new workspace).

Expected output: no errors, `@r2/tool-reminder` symlinked in `node_modules`.

### Step 1.3: Write failing tests for `computeNextFire`

- [x] Create `packages/server/src/reminders/__tests__/recurrence.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { computeNextFire } from '../recurrence.js';
import type { Schedule } from '@r2/tool-reminder/src/schedule-types.js';

// Helper: build a Date at the system local timezone.
function local(year: number, month: number, day: number, hour = 0, minute = 0): Date {
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

describe('computeNextFire', () => {
  describe('once', () => {
    it('returns parsed timestamp for a future at_iso', () => {
      const now = local(2026, 4, 14, 10, 0).getTime();
      const future = local(2026, 4, 14, 12, 0).toISOString();
      const schedule: Schedule = { kind: 'once', at_iso: future };
      expect(computeNextFire(schedule, now)).toBe(Date.parse(future));
    });

    it('returns null for a past at_iso', () => {
      const now = local(2026, 4, 14, 10, 0).getTime();
      const past = local(2026, 4, 14, 9, 0).toISOString();
      const schedule: Schedule = { kind: 'once', at_iso: past };
      expect(computeNextFire(schedule, now)).toBeNull();
    });

    it('returns null for invalid at_iso', () => {
      const now = local(2026, 4, 14, 10, 0).getTime();
      const schedule: Schedule = { kind: 'once', at_iso: 'not-a-date' };
      expect(computeNextFire(schedule, now)).toBeNull();
    });
  });

  describe('daily', () => {
    it('returns today at H:M when now is before that time', () => {
      const now = local(2026, 4, 14, 8, 30).getTime();
      const schedule: Schedule = { kind: 'daily', hour: 9, minute: 0 };
      expect(computeNextFire(schedule, now)).toBe(local(2026, 4, 14, 9, 0).getTime());
    });

    it('returns tomorrow at H:M when now is after that time', () => {
      const now = local(2026, 4, 14, 10, 0).getTime();
      const schedule: Schedule = { kind: 'daily', hour: 9, minute: 0 };
      expect(computeNextFire(schedule, now)).toBe(local(2026, 4, 15, 9, 0).getTime());
    });

    it('returns tomorrow at H:M when now equals that time exactly', () => {
      // When now === next_fire we want to roll forward; the scheduler treats
      // `next_fire_at_ms <= now` as "fire now", so returning the same ms would
      // immediately re-fire on the next tick. Roll forward by one period.
      const now = local(2026, 4, 14, 9, 0).getTime();
      const schedule: Schedule = { kind: 'daily', hour: 9, minute: 0 };
      expect(computeNextFire(schedule, now)).toBe(local(2026, 4, 15, 9, 0).getTime());
    });
  });

  describe('weekly', () => {
    it('returns nearest future weekday from the list', () => {
      // 2026-04-14 is a Tuesday (weekday=2). Asking for Mon/Wed/Fri [1,3,5] at 18:30.
      const now = local(2026, 4, 14, 10, 0).getTime();
      const schedule: Schedule = { kind: 'weekly', weekdays: [1, 3, 5], hour: 18, minute: 30 };
      // Next match: Wednesday 2026-04-15 at 18:30.
      expect(computeNextFire(schedule, now)).toBe(local(2026, 4, 15, 18, 30).getTime());
    });

    it('returns today when today is in weekdays and H:M is still in future', () => {
      // 2026-04-14 Tuesday (weekday=2), schedule Tuesday at 18:00, now 10:00.
      const now = local(2026, 4, 14, 10, 0).getTime();
      const schedule: Schedule = { kind: 'weekly', weekdays: [2], hour: 18, minute: 0 };
      expect(computeNextFire(schedule, now)).toBe(local(2026, 4, 14, 18, 0).getTime());
    });

    it('rolls to next week when today matches but time already passed', () => {
      // Tuesday 2026-04-14 at 20:00, schedule Tuesday at 18:00.
      const now = local(2026, 4, 14, 20, 0).getTime();
      const schedule: Schedule = { kind: 'weekly', weekdays: [2], hour: 18, minute: 0 };
      expect(computeNextFire(schedule, now)).toBe(local(2026, 4, 21, 18, 0).getTime());
    });

    it('returns null for empty weekdays', () => {
      const now = local(2026, 4, 14, 10, 0).getTime();
      const schedule: Schedule = { kind: 'weekly', weekdays: [], hour: 18, minute: 0 };
      expect(computeNextFire(schedule, now)).toBeNull();
    });
  });

  describe('monthly', () => {
    it('returns this month at day H:M when still in future', () => {
      const now = local(2026, 4, 1, 10, 0).getTime();
      const schedule: Schedule = { kind: 'monthly', day_of_month: 15, hour: 12, minute: 0 };
      expect(computeNextFire(schedule, now)).toBe(local(2026, 4, 15, 12, 0).getTime());
    });

    it('returns next month when this month day already passed', () => {
      const now = local(2026, 4, 20, 10, 0).getTime();
      const schedule: Schedule = { kind: 'monthly', day_of_month: 15, hour: 12, minute: 0 };
      expect(computeNextFire(schedule, now)).toBe(local(2026, 5, 15, 12, 0).getTime());
    });

    it('clamps day 31 to last day of February', () => {
      const now = local(2026, 2, 1, 10, 0).getTime();
      const schedule: Schedule = { kind: 'monthly', day_of_month: 31, hour: 12, minute: 0 };
      // 2026 is not a leap year → February has 28 days.
      expect(computeNextFire(schedule, now)).toBe(local(2026, 2, 28, 12, 0).getTime());
    });

    it('clamps day 31 to last day of February (leap year)', () => {
      const now = local(2028, 2, 1, 10, 0).getTime();
      const schedule: Schedule = { kind: 'monthly', day_of_month: 31, hour: 12, minute: 0 };
      // 2028 is a leap year → February has 29 days.
      expect(computeNextFire(schedule, now)).toBe(local(2028, 2, 29, 12, 0).getTime());
    });

    it('clamps day 31 to 30 for April', () => {
      const now = local(2026, 4, 1, 10, 0).getTime();
      const schedule: Schedule = { kind: 'monthly', day_of_month: 31, hour: 12, minute: 0 };
      expect(computeNextFire(schedule, now)).toBe(local(2026, 4, 30, 12, 0).getTime());
    });
  });
});
```

### Step 1.4: Verify tests fail

- [x] Run:

```bash
cd /Users/dim/code/R2-D2/packages/server && npx vitest run src/reminders/__tests__/recurrence.test.ts
```

Expected: FAIL — "Failed to resolve import '../recurrence.js'".

### Step 1.5: Implement `computeNextFire`

- [x] Create `packages/server/src/reminders/recurrence.ts`:

```ts
import type { Schedule } from '@r2/tool-reminder/src/schedule-types.js';

/**
 * Return the next timestamp (ms since epoch) at which the given schedule
 * should fire, strictly greater than `now`. Returns `null` if the schedule
 * has no future fire (one-shot in the past, weekly with empty weekdays, or
 * an unparseable ISO string).
 *
 * All math uses JS `Date` in the system local timezone. DST transitions may
 * produce surprising results on the affected day (we document this in the
 * spec and accept it as an edge case rather than pulling in a TZ library).
 */
export function computeNextFire(schedule: Schedule, now: number): number | null {
  switch (schedule.kind) {
    case 'once': {
      const ts = Date.parse(schedule.at_iso);
      if (!Number.isFinite(ts)) return null;
      return ts > now ? ts : null;
    }

    case 'daily': {
      const d = new Date(now);
      d.setHours(schedule.hour, schedule.minute, 0, 0);
      if (d.getTime() > now) return d.getTime();
      d.setDate(d.getDate() + 1);
      return d.getTime();
    }

    case 'weekly': {
      if (schedule.weekdays.length === 0) return null;
      // Try each of the next 7 days; pick the first whose weekday matches.
      for (let offset = 0; offset < 14; offset++) {
        const d = new Date(now);
        d.setDate(d.getDate() + offset);
        d.setHours(schedule.hour, schedule.minute, 0, 0);
        if (!schedule.weekdays.includes(d.getDay())) continue;
        if (d.getTime() > now) return d.getTime();
      }
      return null; // unreachable given non-empty weekdays, but TS needs it
    }

    case 'monthly': {
      // Try this month, then next month.
      for (let offset = 0; offset < 2; offset++) {
        const d = new Date(now);
        d.setMonth(d.getMonth() + offset, 1); // set to 1st to avoid overflow
        // Clamp day_of_month to last day of the target month.
        const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
        const day = Math.min(schedule.day_of_month, lastDay);
        d.setDate(day);
        d.setHours(schedule.hour, schedule.minute, 0, 0);
        if (d.getTime() > now) return d.getTime();
      }
      return null;
    }
  }
}
```

### Step 1.6: Verify tests pass

- [x] Run:

```bash
cd /Users/dim/code/R2-D2/packages/server && npx vitest run src/reminders/__tests__/recurrence.test.ts
```

Expected: PASS — all 14 tests green.

### Step 1.7: Commit

- [x] Run:

```bash
cd /Users/dim/code/R2-D2
git add packages/tool-reminder/package.json packages/tool-reminder/tsconfig.json packages/tool-reminder/src/schedule-types.ts packages/tool-reminder/src/index.ts packages/server/src/reminders/recurrence.ts packages/server/src/reminders/__tests__/recurrence.test.ts
git commit -m "$(cat <<'EOF'
feat(reminder): scaffold tool-reminder package + recurrence calculator

Adds the `@r2/tool-reminder` workspace package with the Schedule
discriminated union and a placeholder index.ts (full tool definitions
come in a later task), plus `computeNextFire(schedule, now)` in the
server's reminders module with 14 unit tests covering once/daily/weekly/
monthly, including clamping day 31 to month-end and rolling forward when
`now` is exactly at the fire time.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Reminder Store + State Machine + DB Schema

**Files:**
- Modify: `packages/server/src/db.ts` — add DDL for `reminders` table
- Create: `packages/server/src/reminders/store.ts`
- Create: `packages/server/src/reminders/__tests__/store.test.ts`
- Create: `packages/server/src/reminders/bus.ts`
- Create: `packages/server/src/reminders/scheduler.ts`
- Create: `packages/server/src/reminders/__tests__/scheduler.test.ts`

### Step 2.1: Add `reminders` DDL to `db.ts`

- [x] Open `packages/server/src/db.ts`. Find the block that creates tables (look for `CREATE TABLE IF NOT EXISTS memory_entries`). Add the new DDL right after the existing table creations, BEFORE any `sqlite-vec` virtual table creation:

```ts
  db.exec(`
    CREATE TABLE IF NOT EXISTS reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL,
      schedule_json TEXT NOT NULL,
      next_fire_at_ms INTEGER NOT NULL,
      cycle_stage TEXT NOT NULL DEFAULT 'idle',
      cycle_num INTEGER NOT NULL DEFAULT 0,
      cycle_stage_ends_at_ms INTEGER,
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_reminders_next_fire
      ON reminders(next_fire_at_ms)
      WHERE active = 1
  `);
```

### Step 2.2: Write failing tests for `ReminderStore`

- [x] Create `packages/server/src/reminders/__tests__/store.test.ts`:

```ts
import { describe, expect, it, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createReminderStore } from '../store.js';
import type { Schedule } from '@r2/tool-reminder/src/schedule-types.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL,
      schedule_json TEXT NOT NULL,
      next_fire_at_ms INTEGER NOT NULL,
      cycle_stage TEXT NOT NULL DEFAULT 'idle',
      cycle_num INTEGER NOT NULL DEFAULT 0,
      cycle_stage_ends_at_ms INTEGER,
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    )
  `);
  return db;
}

describe('ReminderStore', () => {
  let db: Database.Database;
  const fakeNow = 1_700_000_000_000; // fixed "now" in ms

  beforeEach(() => {
    db = freshDb();
  });

  it('create: inserts a row and computes next_fire_at_ms', () => {
    const store = createReminderStore({ db, now: () => fakeNow });
    const schedule: Schedule = { kind: 'once', at_iso: new Date(fakeNow + 60_000).toISOString() };
    const id = store.create('выпить воды', schedule);
    expect(id).toBeGreaterThan(0);

    const row = db.prepare('SELECT * FROM reminders WHERE id = ?').get(id) as any;
    expect(row.text).toBe('выпить воды');
    expect(row.active).toBe(1);
    expect(row.cycle_stage).toBe('idle');
    expect(row.next_fire_at_ms).toBe(fakeNow + 60_000);
  });

  it('create: rejects a schedule with no future fire', () => {
    const store = createReminderStore({ db, now: () => fakeNow });
    const schedule: Schedule = { kind: 'once', at_iso: new Date(fakeNow - 60_000).toISOString() };
    expect(() => store.create('past', schedule)).toThrow(/no future fire/);
  });

  it('list: returns only active reminders', () => {
    const store = createReminderStore({ db, now: () => fakeNow });
    const id1 = store.create('a', { kind: 'once', at_iso: new Date(fakeNow + 60_000).toISOString() });
    const id2 = store.create('b', { kind: 'once', at_iso: new Date(fakeNow + 120_000).toISOString() });
    store.delete(id1);
    const list = store.list();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(id2);
    expect(list[0].text).toBe('b');
  });

  it('delete: sets active=0 and returns true for existing, false for missing', () => {
    const store = createReminderStore({ db, now: () => fakeNow });
    const id = store.create('a', { kind: 'once', at_iso: new Date(fakeNow + 60_000).toISOString() });
    expect(store.delete(id)).toBe(true);
    expect(store.delete(9999)).toBe(false);
    const row = db.prepare('SELECT active FROM reminders WHERE id = ?').get(id) as any;
    expect(row.active).toBe(0);
  });

  it('findDue: returns idle reminders whose next_fire is <= now', () => {
    const store = createReminderStore({ db, now: () => fakeNow });
    store.create('past', { kind: 'once', at_iso: new Date(fakeNow + 1).toISOString() });
    store.create('future', { kind: 'once', at_iso: new Date(fakeNow + 600_000).toISOString() });

    const due = store.findDueIdle(fakeNow + 10_000);
    expect(due).toHaveLength(1);
    expect(due[0].text).toBe('past');
  });

  it('beginRing: transitions idle → ringing and sets cycle_stage_ends_at', () => {
    const store = createReminderStore({ db, now: () => fakeNow });
    const id = store.create('a', { kind: 'once', at_iso: new Date(fakeNow + 1000).toISOString() });
    store.beginRing(id, fakeNow + 1000);
    const row = db.prepare('SELECT * FROM reminders WHERE id = ?').get(id) as any;
    expect(row.cycle_stage).toBe('ringing');
    expect(row.cycle_num).toBe(0);
    expect(row.cycle_stage_ends_at_ms).toBe(fakeNow + 1000 + 60_000);
  });

  it('advanceRinging: transitions ringing → paused after 60s', () => {
    const store = createReminderStore({ db, now: () => fakeNow });
    const id = store.create('a', { kind: 'once', at_iso: new Date(fakeNow + 1000).toISOString() });
    store.beginRing(id, fakeNow + 1000);
    store.advanceRingingToPaused(id, fakeNow + 61_000);
    const row = db.prepare('SELECT * FROM reminders WHERE id = ?').get(id) as any;
    expect(row.cycle_stage).toBe('paused');
    expect(row.cycle_stage_ends_at_ms).toBe(fakeNow + 61_000 + 120_000);
  });

  it('advancePausedToRinging: increments cycle_num', () => {
    const store = createReminderStore({ db, now: () => fakeNow });
    const id = store.create('a', { kind: 'once', at_iso: new Date(fakeNow + 1000).toISOString() });
    store.beginRing(id, fakeNow + 1000);
    store.advanceRingingToPaused(id, fakeNow + 61_000);
    store.advancePausedToRinging(id, fakeNow + 181_000);
    const row = db.prepare('SELECT * FROM reminders WHERE id = ?').get(id) as any;
    expect(row.cycle_stage).toBe('ringing');
    expect(row.cycle_num).toBe(1);
  });

  it('finishCycle: one-shot reminder is deactivated', () => {
    const store = createReminderStore({ db, now: () => fakeNow });
    const id = store.create('a', { kind: 'once', at_iso: new Date(fakeNow + 1000).toISOString() });
    store.finishCycle(id, fakeNow + 10_000);
    const row = db.prepare('SELECT * FROM reminders WHERE id = ?').get(id) as any;
    expect(row.active).toBe(0);
    expect(row.cycle_stage).toBe('done');
  });

  it('finishCycle: daily reminder rolls to next fire and returns to idle', () => {
    const store = createReminderStore({ db, now: () => fakeNow });
    // Daily 09:00 relative to a known UTC anchor.
    const anchor = new Date(fakeNow);
    const schedule: Schedule = { kind: 'daily', hour: anchor.getHours(), minute: (anchor.getMinutes() + 1) % 60 };
    const id = store.create('daily', schedule);
    store.finishCycle(id, fakeNow + 10_000);
    const row = db.prepare('SELECT * FROM reminders WHERE id = ?').get(id) as any;
    expect(row.active).toBe(1);
    expect(row.cycle_stage).toBe('idle');
    expect(row.cycle_num).toBe(0);
    expect(row.next_fire_at_ms).toBeGreaterThan(fakeNow + 10_000);
  });

  it('dismiss: stops current ring and recomputes next_fire for recurring', () => {
    const store = createReminderStore({ db, now: () => fakeNow });
    const schedule: Schedule = { kind: 'daily', hour: 9, minute: 0 };
    const id = store.create('a', schedule);
    store.beginRing(id, fakeNow + 1000);
    store.dismiss(id, fakeNow + 5000);
    const row = db.prepare('SELECT * FROM reminders WHERE id = ?').get(id) as any;
    expect(row.cycle_stage).toBe('idle');
    expect(row.active).toBe(1);
    expect(row.next_fire_at_ms).toBeGreaterThan(fakeNow + 5000);
  });

  it('dismiss: deactivates one-shot', () => {
    const store = createReminderStore({ db, now: () => fakeNow });
    const schedule: Schedule = { kind: 'once', at_iso: new Date(fakeNow + 1000).toISOString() };
    const id = store.create('a', schedule);
    store.beginRing(id, fakeNow + 1000);
    store.dismiss(id, fakeNow + 5000);
    const row = db.prepare('SELECT * FROM reminders WHERE id = ?').get(id) as any;
    expect(row.active).toBe(0);
  });

  it('snooze: creates a new one-shot 10 min later with the same text', () => {
    const store = createReminderStore({ db, now: () => fakeNow });
    const schedule: Schedule = { kind: 'daily', hour: 9, minute: 0 };
    const id = store.create('выпить воды', schedule);
    store.beginRing(id, fakeNow + 1000);
    const newId = store.snooze(id, fakeNow + 5000);
    expect(newId).not.toBe(id);
    const snoozed = db.prepare('SELECT * FROM reminders WHERE id = ?').get(newId) as any;
    expect(snoozed.text).toBe('выпить воды');
    expect(JSON.parse(snoozed.schedule_json).kind).toBe('once');
    expect(snoozed.next_fire_at_ms).toBe(fakeNow + 5000 + 10 * 60_000);
    // Original still active and in idle.
    const original = db.prepare('SELECT * FROM reminders WHERE id = ?').get(id) as any;
    expect(original.active).toBe(1);
    expect(original.cycle_stage).toBe('idle');
  });
});
```

### Step 2.3: Verify tests fail

- [x] Run:

```bash
cd /Users/dim/code/R2-D2/packages/server && npx vitest run src/reminders/__tests__/store.test.ts
```

Expected: FAIL — "Failed to resolve import '../store.js'".

### Step 2.4: Implement `ReminderStore`

- [x] Create `packages/server/src/reminders/store.ts`:

```ts
import type Database from 'better-sqlite3';
import type { Schedule } from '@r2/tool-reminder/src/schedule-types.js';
import { computeNextFire } from './recurrence.js';

export interface ReminderRow {
  id: number;
  text: string;
  schedule: Schedule;
  next_fire_at_ms: number;
  cycle_stage: 'idle' | 'ringing' | 'paused' | 'done';
  cycle_num: number;
  cycle_stage_ends_at_ms: number | null;
  active: boolean;
  created_at: number;
}

export interface ReminderStore {
  create(text: string, schedule: Schedule): number;
  list(): ReminderRow[];
  delete(id: number): boolean;
  findDueIdle(now: number): ReminderRow[];
  findDueRinging(now: number): ReminderRow[];
  findDuePaused(now: number): ReminderRow[];
  beginRing(id: number, now: number): void;
  advanceRingingToPaused(id: number, now: number): void;
  advancePausedToRinging(id: number, now: number): void;
  finishCycle(id: number, now: number): { nextFire: number | null };
  dismiss(id: number, now: number): void;
  snooze(id: number, now: number): number;
  getById(id: number): ReminderRow | null;
}

const RING_DURATION_MS = 60_000;
const PAUSE_DURATION_MS = 120_000;
const MAX_CYCLES = 3;
const SNOOZE_DELAY_MS = 10 * 60_000;

interface StoreDeps {
  db: Database.Database;
  now?: () => number;
}

function rowToReminder(raw: any): ReminderRow {
  return {
    id: raw.id,
    text: raw.text,
    schedule: JSON.parse(raw.schedule_json),
    next_fire_at_ms: raw.next_fire_at_ms,
    cycle_stage: raw.cycle_stage,
    cycle_num: raw.cycle_num,
    cycle_stage_ends_at_ms: raw.cycle_stage_ends_at_ms,
    active: raw.active === 1,
    created_at: raw.created_at,
  };
}

export function createReminderStore(deps: StoreDeps): ReminderStore {
  const { db } = deps;
  const now = deps.now ?? (() => Date.now());

  return {
    create(text, schedule) {
      const nowMs = now();
      const nextFire = computeNextFire(schedule, nowMs);
      if (nextFire === null) {
        throw new Error('Reminder has no future fire time');
      }
      const stmt = db.prepare(`
        INSERT INTO reminders (text, schedule_json, next_fire_at_ms, created_at)
        VALUES (?, ?, ?, ?)
      `);
      const result = stmt.run(text, JSON.stringify(schedule), nextFire, nowMs);
      return Number(result.lastInsertRowid);
    },

    list() {
      const rows = db.prepare(`
        SELECT * FROM reminders WHERE active = 1 ORDER BY next_fire_at_ms ASC
      `).all();
      return rows.map(rowToReminder);
    },

    delete(id) {
      const result = db.prepare(`
        UPDATE reminders SET active = 0 WHERE id = ? AND active = 1
      `).run(id);
      return result.changes > 0;
    },

    findDueIdle(nowMs) {
      const rows = db.prepare(`
        SELECT * FROM reminders
        WHERE active = 1 AND cycle_stage = 'idle' AND next_fire_at_ms <= ?
      `).all(nowMs);
      return rows.map(rowToReminder);
    },

    findDueRinging(nowMs) {
      const rows = db.prepare(`
        SELECT * FROM reminders
        WHERE active = 1 AND cycle_stage = 'ringing' AND cycle_stage_ends_at_ms <= ?
      `).all(nowMs);
      return rows.map(rowToReminder);
    },

    findDuePaused(nowMs) {
      const rows = db.prepare(`
        SELECT * FROM reminders
        WHERE active = 1 AND cycle_stage = 'paused' AND cycle_stage_ends_at_ms <= ?
      `).all(nowMs);
      return rows.map(rowToReminder);
    },

    beginRing(id, nowMs) {
      db.prepare(`
        UPDATE reminders
        SET cycle_stage = 'ringing',
            cycle_num = 0,
            cycle_stage_ends_at_ms = ?
        WHERE id = ?
      `).run(nowMs + RING_DURATION_MS, id);
    },

    advanceRingingToPaused(id, nowMs) {
      db.prepare(`
        UPDATE reminders
        SET cycle_stage = 'paused',
            cycle_stage_ends_at_ms = ?
        WHERE id = ?
      `).run(nowMs + PAUSE_DURATION_MS, id);
    },

    advancePausedToRinging(id, nowMs) {
      db.prepare(`
        UPDATE reminders
        SET cycle_stage = 'ringing',
            cycle_num = cycle_num + 1,
            cycle_stage_ends_at_ms = ?
        WHERE id = ?
      `).run(nowMs + RING_DURATION_MS, id);
    },

    finishCycle(id, nowMs) {
      const row = db.prepare('SELECT * FROM reminders WHERE id = ?').get(id) as any;
      if (!row) return { nextFire: null };
      const schedule = JSON.parse(row.schedule_json) as Schedule;
      const nextFire = computeNextFire(schedule, nowMs);
      if (nextFire === null || schedule.kind === 'once') {
        db.prepare(`
          UPDATE reminders
          SET active = 0,
              cycle_stage = 'done',
              cycle_num = 0,
              cycle_stage_ends_at_ms = NULL
          WHERE id = ?
        `).run(id);
        return { nextFire: null };
      }
      db.prepare(`
        UPDATE reminders
        SET cycle_stage = 'idle',
            cycle_num = 0,
            cycle_stage_ends_at_ms = NULL,
            next_fire_at_ms = ?
        WHERE id = ?
      `).run(nextFire, id);
      return { nextFire };
    },

    dismiss(id, nowMs) {
      const row = db.prepare('SELECT * FROM reminders WHERE id = ?').get(id) as any;
      if (!row) return;
      const schedule = JSON.parse(row.schedule_json) as Schedule;
      if (schedule.kind === 'once') {
        db.prepare(`
          UPDATE reminders
          SET active = 0,
              cycle_stage = 'done',
              cycle_stage_ends_at_ms = NULL
          WHERE id = ?
        `).run(id);
        return;
      }
      const nextFire = computeNextFire(schedule, nowMs);
      if (nextFire === null) {
        db.prepare('UPDATE reminders SET active = 0 WHERE id = ?').run(id);
        return;
      }
      db.prepare(`
        UPDATE reminders
        SET cycle_stage = 'idle',
            cycle_num = 0,
            cycle_stage_ends_at_ms = NULL,
            next_fire_at_ms = ?
        WHERE id = ?
      `).run(nextFire, id);
    },

    snooze(id, nowMs) {
      const row = db.prepare('SELECT * FROM reminders WHERE id = ?').get(id) as any;
      if (!row) throw new Error(`Reminder ${id} not found`);
      const snoozedSchedule: Schedule = {
        kind: 'once',
        at_iso: new Date(nowMs + SNOOZE_DELAY_MS).toISOString(),
      };
      const stmt = db.prepare(`
        INSERT INTO reminders (text, schedule_json, next_fire_at_ms, created_at)
        VALUES (?, ?, ?, ?)
      `);
      const result = stmt.run(
        row.text,
        JSON.stringify(snoozedSchedule),
        nowMs + SNOOZE_DELAY_MS,
        nowMs,
      );
      // Stop the current ring on the original so it's not still playing.
      db.prepare(`
        UPDATE reminders
        SET cycle_stage = 'idle', cycle_num = 0, cycle_stage_ends_at_ms = NULL
        WHERE id = ?
      `).run(id);
      return Number(result.lastInsertRowid);
    },

    getById(id) {
      const row = db.prepare('SELECT * FROM reminders WHERE id = ?').get(id) as any;
      return row ? rowToReminder(row) : null;
    },
  };
}
```

### Step 2.5: Verify store tests pass

- [x] Run:

```bash
cd /Users/dim/code/R2-D2/packages/server && npx vitest run src/reminders/__tests__/store.test.ts
```

Expected: PASS — 13 tests green.

### Step 2.6: Add server push event type to shared + create event bus

Both the scheduler (bus emitter) and the SSE route (Task 4) need to agree on the exact shape of events. Declare `ServerPushEvent` once in `@r2/shared` and import it from there, so any future divergence surfaces as a type error.

- [x] Open `packages/shared/src/types.ts`. Append at the bottom of the file:

```ts
export type ServerPushEvent =
  | { type: 'reminder_ring'; id: number; text: string }
  | { type: 'reminder_stop_ring'; id: number }
  | { type: 'reminder_done'; id: number };
```

- [x] Create `packages/server/src/reminders/bus.ts`:

```ts
import { EventEmitter } from 'node:events';
import type { ServerPushEvent } from '@r2/shared';

export type ReminderPushEvent = ServerPushEvent;

/**
 * Singleton event emitter that the scheduler broadcasts to and the
 * `/api/events` SSE route subscribes to. Kept in a dedicated module so
 * circular imports between scheduler → routes don't arise. Events are
 * always `ServerPushEvent` from `@r2/shared`.
 */
export const reminderBus = new EventEmitter();
```

### Step 2.7: Write failing tests for scheduler

- [x] Create `packages/server/src/reminders/__tests__/scheduler.test.ts`:

```ts
import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createReminderStore } from '../store.js';
import { advanceScheduler } from '../scheduler.js';
import { reminderBus, type ReminderPushEvent } from '../bus.js';
import type { Schedule } from '@r2/tool-reminder/src/schedule-types.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL,
      schedule_json TEXT NOT NULL,
      next_fire_at_ms INTEGER NOT NULL,
      cycle_stage TEXT NOT NULL DEFAULT 'idle',
      cycle_num INTEGER NOT NULL DEFAULT 0,
      cycle_stage_ends_at_ms INTEGER,
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      tool_calls TEXT,
      pii_entities TEXT,
      timestamp INTEGER NOT NULL,
      source TEXT
    );
  `);
  return db;
}

describe('advanceScheduler', () => {
  let db: Database.Database;
  let events: ReminderPushEvent[];
  let listener: (e: ReminderPushEvent) => void;
  const t0 = 1_700_000_000_000;

  beforeEach(() => {
    db = freshDb();
    events = [];
    listener = (e) => events.push(e);
    reminderBus.on('push', listener);
  });

  afterEach(() => {
    reminderBus.off('push', listener);
  });

  function runTick(now: number) {
    const store = createReminderStore({ db, now: () => now });
    advanceScheduler({ store, db, now, bus: reminderBus });
  }

  it('idle → ringing: fires at the scheduled time and emits reminder_ring', () => {
    const store = createReminderStore({ db, now: () => t0 });
    const schedule: Schedule = { kind: 'once', at_iso: new Date(t0 + 1000).toISOString() };
    const id = store.create('drink water', schedule);

    runTick(t0 + 2000);

    const row = db.prepare('SELECT * FROM reminders WHERE id = ?').get(id) as any;
    expect(row.cycle_stage).toBe('ringing');
    expect(events).toEqual([{ type: 'reminder_ring', id, text: 'drink water' }]);

    const msgs = db.prepare('SELECT content FROM chat_messages ORDER BY id').all() as any[];
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('⏰ drink water');
  });

  it('ringing → paused after 60s', () => {
    const store = createReminderStore({ db, now: () => t0 });
    store.create('a', { kind: 'once', at_iso: new Date(t0 + 1000).toISOString() });

    runTick(t0 + 2000);        // → ringing, cycle 0
    events.length = 0;
    runTick(t0 + 2000 + 60_001); // → paused

    const row = db.prepare('SELECT * FROM reminders').get() as any;
    expect(row.cycle_stage).toBe('paused');
    expect(events).toEqual([{ type: 'reminder_stop_ring', id: row.id }]);
  });

  it('paused → ringing cycle 1, then cycle 2, then done', () => {
    const store = createReminderStore({ db, now: () => t0 });
    store.create('a', { kind: 'once', at_iso: new Date(t0 + 1000).toISOString() });

    let t = t0 + 2000;
    runTick(t);                   // ringing cycle 0
    t += 60_001;
    runTick(t);                   // paused
    t += 120_001;
    runTick(t);                   // ringing cycle 1
    const rowCycle1 = db.prepare('SELECT cycle_num, cycle_stage FROM reminders').get() as any;
    expect(rowCycle1).toEqual({ cycle_num: 1, cycle_stage: 'ringing' });

    t += 60_001;
    runTick(t);                   // paused
    t += 120_001;
    runTick(t);                   // ringing cycle 2
    const rowCycle2 = db.prepare('SELECT cycle_num, cycle_stage FROM reminders').get() as any;
    expect(rowCycle2).toEqual({ cycle_num: 2, cycle_stage: 'ringing' });

    t += 60_001;
    runTick(t);                   // paused
    t += 120_001;
    runTick(t);                   // done — one-shot deactivated

    const finalRow = db.prepare('SELECT active, cycle_stage FROM reminders').get() as any;
    expect(finalRow.active).toBe(0);
    expect(finalRow.cycle_stage).toBe('done');
    const doneEvt = events.find((e) => e.type === 'reminder_done');
    expect(doneEvt).toBeTruthy();
  });

  it('daily reminder: after done, next_fire rolls to tomorrow and returns to idle', () => {
    const store = createReminderStore({ db, now: () => t0 });
    const d = new Date(t0);
    const schedule: Schedule = {
      kind: 'daily',
      hour: d.getHours(),
      minute: (d.getMinutes() + 1) % 60, // 1 minute from now
    };
    store.create('daily', schedule);

    // Walk through the full cycle.
    let t = t0 + 60_000 + 1000;
    for (let i = 0; i < 10; i++) {
      runTick(t);
      t += 60_001;
    }
    // After all cycles finish, state should be idle with a future next_fire.
    const row = db.prepare('SELECT * FROM reminders').get() as any;
    expect(row.active).toBe(1);
    expect(row.cycle_stage).toBe('idle');
    expect(row.next_fire_at_ms).toBeGreaterThan(t);
  });

  it('is idempotent on restart: stale ringing row advances on next tick', () => {
    // Simulate a crash: insert directly a ringing row with a stale end-time.
    const staleEnd = t0 - 1000;
    db.prepare(`
      INSERT INTO reminders (text, schedule_json, next_fire_at_ms, cycle_stage, cycle_num, cycle_stage_ends_at_ms, active, created_at)
      VALUES (?, ?, ?, 'ringing', 0, ?, 1, ?)
    `).run('crashed', JSON.stringify({ kind: 'once', at_iso: new Date(t0 - 60_000).toISOString() }), t0 - 60_000, staleEnd, t0 - 60_000);

    runTick(t0);

    const row = db.prepare('SELECT cycle_stage FROM reminders').get() as any;
    expect(row.cycle_stage).toBe('paused');
  });
});
```

### Step 2.8: Verify scheduler tests fail

- [x] Run:

```bash
cd /Users/dim/code/R2-D2/packages/server && npx vitest run src/reminders/__tests__/scheduler.test.ts
```

Expected: FAIL — "Failed to resolve import '../scheduler.js'".

### Step 2.9: Implement `scheduler.ts`

- [x] Create `packages/server/src/reminders/scheduler.ts`:

```ts
import type Database from 'better-sqlite3';
import crypto from 'node:crypto';
import type { EventEmitter } from 'node:events';
import type { ReminderStore } from './store.js';
import type { ReminderPushEvent } from './bus.js';

const MAX_CYCLES = 3;
export const SCHEDULER_TICK_MS = 15_000;

interface AdvanceParams {
  store: ReminderStore;
  db: Database.Database;
  now: number;
  bus: EventEmitter;
}

/**
 * Advance the reminder state machine by one tick. Exported separately from
 * the interval wiring so tests can drive it with fake timers.
 */
export function advanceScheduler(params: AdvanceParams): void {
  const { store, db, now, bus } = params;

  // 1. idle → ringing
  for (const r of store.findDueIdle(now)) {
    store.beginRing(r.id, now);
    persistChatMessage(db, `⏰ ${r.text}`, now);
    emit(bus, { type: 'reminder_ring', id: r.id, text: r.text });
  }

  // 2. ringing → paused (auto stop after 60s)
  for (const r of store.findDueRinging(now)) {
    store.advanceRingingToPaused(r.id, now);
    emit(bus, { type: 'reminder_stop_ring', id: r.id });
  }

  // 3. paused → ringing (next cycle) OR paused → done (finish)
  for (const r of store.findDuePaused(now)) {
    if (r.cycle_num + 1 < MAX_CYCLES) {
      store.advancePausedToRinging(r.id, now);
      emit(bus, { type: 'reminder_ring', id: r.id, text: r.text });
    } else {
      store.finishCycle(r.id, now);
      persistChatMessage(db, `⏰ пропущено: ${r.text}`, now);
      emit(bus, { type: 'reminder_done', id: r.id });
    }
  }
}

function emit(bus: EventEmitter, event: ReminderPushEvent): void {
  bus.emit('push', event);
}

function persistChatMessage(db: Database.Database, content: string, now: number): void {
  db.prepare(`
    INSERT INTO chat_messages (message_id, role, content, timestamp, source)
    VALUES (?, 'assistant', ?, ?, 'claude')
  `).run(crypto.randomUUID(), content, now);
}

/**
 * Start the scheduler's background tick. Returns a cleanup function that
 * `clearInterval`s the timer. Callers should invoke it on server shutdown.
 */
export function startScheduler(params: {
  store: ReminderStore;
  db: Database.Database;
  bus: EventEmitter;
}): () => void {
  const timer = setInterval(() => {
    try {
      advanceScheduler({ store: params.store, db: params.db, now: Date.now(), bus: params.bus });
    } catch (err) {
      console.error('[reminder] scheduler tick failed:', err instanceof Error ? err.message : err);
    }
  }, SCHEDULER_TICK_MS);
  return () => clearInterval(timer);
}
```

### Step 2.10: Verify scheduler tests pass

- [x] Run:

```bash
cd /Users/dim/code/R2-D2/packages/server && npx vitest run src/reminders
```

Expected: PASS — all tests (recurrence + store + scheduler) green.

### Step 2.11: Full server vitest sanity check

- [x] Run:

```bash
cd /Users/dim/code/R2-D2/packages/server && npx tsc --noEmit && npx vitest run
```

Expected: tsc clean, all existing + new tests pass.

### Step 2.12: Commit

- [x] Run:

```bash
cd /Users/dim/code/R2-D2
git add packages/server/src/db.ts packages/server/src/reminders/
git commit -m "$(cat <<'EOF'
feat(reminder): store + scheduler state machine with SQLite persistence

Adds the `reminders` table DDL to db.ts and implements the state
machine (idle → ringing → paused → ringing ×3 → done) in
`packages/server/src/reminders/`. The store exposes CRUD plus typed
transitions (beginRing / advanceRinging / advancePaused / finishCycle
/ dismiss / snooze). The scheduler is split into a pure
`advanceScheduler()` for fake-timer tests and a `startScheduler()`
wrapper that owns the real setInterval. Both tests cover happy path,
all three rings, recurring-daily rollover, and idempotent restart
from a stale ringing row.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Tool Package + Dismiss/Snooze Routes

**Files:**
- Modify: `packages/tool-reminder/src/index.ts` — replace placeholder with real `createTool(deps)` factory
- Modify: `packages/server/src/tools/base.ts` — add `reminderStore?: ReminderStore` to `ToolDeps`
- Modify: `packages/server/src/index.ts` — build store and pass it into `discoverTools`; mount reminder routes and scheduler
- Create: `packages/server/src/routes/reminder.ts`
- Create: `packages/server/src/routes/__tests__/reminder.test.ts`

### Step 3.1: Write failing tests for the reminder routes

- [x] Create `packages/server/src/routes/__tests__/reminder.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import Database from 'better-sqlite3';
import { createReminderRouter } from '../reminder.js';
import { createReminderStore } from '../../reminders/store.js';
import { reminderBus } from '../../reminders/bus.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL,
      schedule_json TEXT NOT NULL,
      next_fire_at_ms INTEGER NOT NULL,
      cycle_stage TEXT NOT NULL DEFAULT 'idle',
      cycle_num INTEGER NOT NULL DEFAULT 0,
      cycle_stage_ends_at_ms INTEGER,
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    );
  `);
  return db;
}

async function post(app: express.Express, path: string, body: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    const req: any = {
      method: 'POST',
      url: path,
      headers: { 'content-type': 'application/json' },
      body,
    };
    const chunks: string[] = [];
    const res: any = {
      statusCode: 200,
      setHeader: () => {},
      status(code: number) { res.statusCode = code; return res; },
      json(obj: any) { chunks.push(JSON.stringify(obj)); resolve({ status: res.statusCode, body: obj }); return res; },
      send(data: any) { chunks.push(String(data)); resolve({ status: res.statusCode, body: data }); return res; },
    };
    app.handle(req, res);
  });
}

describe('reminder routes', () => {
  let db: Database.Database;
  let app: express.Express;

  beforeEach(() => {
    db = freshDb();
    const store = createReminderStore({ db });
    app = express();
    app.use(express.json());
    app.use('/api/reminder', createReminderRouter({ store, bus: reminderBus }));
  });

  it('POST /api/reminder/dismiss returns ok for an existing reminder', async () => {
    const store = createReminderStore({ db });
    const id = store.create('drink', { kind: 'once', at_iso: new Date(Date.now() + 60_000).toISOString() });
    store.beginRing(id, Date.now());
    const res = await post(app, '/api/reminder/dismiss', { id });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    const row = db.prepare('SELECT active FROM reminders WHERE id = ?').get(id) as any;
    expect(row.active).toBe(0);
  });

  it('POST /api/reminder/dismiss 400 when body missing id', async () => {
    const res = await post(app, '/api/reminder/dismiss', {});
    expect(res.status).toBe(400);
  });

  it('POST /api/reminder/snooze creates a new one-shot 10 minutes out', async () => {
    const store = createReminderStore({ db });
    const id = store.create('drink', { kind: 'daily', hour: 9, minute: 0 });
    store.beginRing(id, Date.now());
    const res = await post(app, '/api/reminder/snooze', { id });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.newId).toBe('number');
    const rows = db.prepare('SELECT id, schedule_json FROM reminders').all() as any[];
    expect(rows).toHaveLength(2);
    const snoozed = rows.find((r) => r.id !== id)!;
    expect(JSON.parse(snoozed.schedule_json).kind).toBe('once');
  });
});
```

### Step 3.2: Verify tests fail

- [x] Run:

```bash
cd /Users/dim/code/R2-D2/packages/server && npx vitest run src/routes/__tests__/reminder.test.ts
```

Expected: FAIL — "Failed to resolve import '../reminder.js'".

### Step 3.3: Implement `packages/server/src/routes/reminder.ts`

- [x] Create `packages/server/src/routes/reminder.ts`:

```ts
import { Router, type Request, type Response } from 'express';
import type { EventEmitter } from 'node:events';
import type { ReminderStore } from '../reminders/store.js';

interface ReminderRouterDeps {
  store: ReminderStore;
  bus: EventEmitter;
}

export function createReminderRouter(deps: ReminderRouterDeps): Router {
  const { store, bus } = deps;
  const router = Router();

  router.post('/dismiss', (req: Request, res: Response) => {
    const id = Number((req.body ?? {}).id);
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json({ error: 'id is required' });
      return;
    }
    const existed = store.getById(id);
    if (!existed) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    store.dismiss(id, Date.now());
    bus.emit('push', { type: 'reminder_stop_ring', id });
    res.json({ ok: true });
  });

  router.post('/snooze', (req: Request, res: Response) => {
    const id = Number((req.body ?? {}).id);
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json({ error: 'id is required' });
      return;
    }
    const existed = store.getById(id);
    if (!existed) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const newId = store.snooze(id, Date.now());
    bus.emit('push', { type: 'reminder_stop_ring', id });
    res.json({ ok: true, newId });
  });

  return router;
}
```

### Step 3.4: Verify route tests pass

- [x] Run:

```bash
cd /Users/dim/code/R2-D2/packages/server && npx vitest run src/routes/__tests__/reminder.test.ts
```

Expected: PASS — 3 tests green.

### Step 3.5: Replace tool-reminder placeholder with real tool definitions

- [x] Overwrite `packages/tool-reminder/src/index.ts`:

```ts
import type { ToolDefinition, ToolResult } from '@r2/shared';
import type { Schedule } from './schedule-types.js';

export type { Schedule } from './schedule-types.js';

export interface ReminderStoreLike {
  create(text: string, schedule: Schedule): number;
  list(): Array<{ id: number; text: string; schedule: Schedule; next_fire_at_ms: number }>;
  delete(id: number): boolean;
}

interface ReminderDeps {
  reminderStore: ReminderStoreLike | null;
}

function requireStore(deps: ReminderDeps): ReminderStoreLike {
  if (!deps.reminderStore) {
    throw new Error('Reminder store is not available');
  }
  return deps.reminderStore;
}

const SCHEDULE_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['once'] },
        at_iso: { type: 'string', description: 'ISO 8601 datetime in the future' },
      },
      required: ['kind', 'at_iso'],
    },
    {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['daily'] },
        hour: { type: 'integer', minimum: 0, maximum: 23 },
        minute: { type: 'integer', minimum: 0, maximum: 59 },
      },
      required: ['kind', 'hour', 'minute'],
    },
    {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['weekly'] },
        weekdays: {
          type: 'array',
          items: { type: 'integer', minimum: 0, maximum: 6 },
          description: '0 = Sunday, 6 = Saturday',
        },
        hour: { type: 'integer', minimum: 0, maximum: 23 },
        minute: { type: 'integer', minimum: 0, maximum: 59 },
      },
      required: ['kind', 'weekdays', 'hour', 'minute'],
    },
    {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['monthly'] },
        day_of_month: { type: 'integer', minimum: 1, maximum: 31 },
        hour: { type: 'integer', minimum: 0, maximum: 23 },
        minute: { type: 'integer', minimum: 0, maximum: 59 },
      },
      required: ['kind', 'day_of_month', 'hour', 'minute'],
    },
  ],
};

export function createReminderCreateTool(deps: ReminderDeps): ToolDefinition {
  return {
    name: 'reminder_create',
    description:
      'Создать напоминание с будильником (60s звон × 3 цикла). schedule — once/daily/weekly/monthly. Переводи натуральную речь ("через 5 часов", "каждый день в 9", "по пн и ср в 18:30") в структуру schedule. Используй текущее время из system prompt для расчёта at_iso в "once".',
    permissionLevel: 'auto',
    provider: 'claude',
    command: {
      name: 'нагадай',
      description: 'Створити нагадування',
      params: [{ name: 'text', required: true, description: 'Що нагадати' }],
    },
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Текст напоминания' },
        schedule: SCHEDULE_SCHEMA,
      },
      required: ['text', 'schedule'],
    },
    async handler(input): Promise<ToolResult> {
      const store = requireStore(deps);
      const text = String(input.text ?? '').trim();
      const schedule = input.schedule as Schedule;
      if (!text) return { success: false, error: 'text is required' };
      try {
        const id = store.create(text, schedule);
        return {
          success: true,
          data: { id, text, schedule },
          display: { type: 'text', content: `⏰ Напоминание #${id} создано: ${text}` },
        };
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Failed to create reminder',
        };
      }
    },
  };
}

export function createReminderListTool(deps: ReminderDeps): ToolDefinition {
  return {
    name: 'reminder_list',
    description: 'Показать активные напоминания пользователя.',
    permissionLevel: 'auto',
    provider: 'all',
    command: {
      name: 'нагадування',
      description: 'Список активних нагадувань',
      params: [],
    },
    parameters: { type: 'object', properties: {} },
    async handler(): Promise<ToolResult> {
      const store = requireStore(deps);
      const items = store.list();
      if (items.length === 0) {
        return { success: true, data: [], display: { type: 'text', content: 'Активных напоминаний нет' } };
      }
      const lines = items.map((r) => {
        const when = new Date(r.next_fire_at_ms).toLocaleString('uk-UA');
        return `#${r.id} — ${r.text} (следующее: ${when}, ${r.schedule.kind})`;
      });
      return {
        success: true,
        data: items,
        display: { type: 'text', content: lines.join('\n') },
      };
    },
  };
}

export function createReminderDeleteTool(deps: ReminderDeps): ToolDefinition {
  return {
    name: 'reminder_delete',
    description: 'Удалить напоминание по id.',
    permissionLevel: 'auto',
    provider: 'all',
    parameters: {
      type: 'object',
      properties: { id: { type: 'integer', description: 'ID напоминания' } },
      required: ['id'],
    },
    async handler(input): Promise<ToolResult> {
      const store = requireStore(deps);
      const id = Number(input.id);
      if (!Number.isFinite(id) || id <= 0) {
        return { success: false, error: 'id is required and must be a positive integer' };
      }
      const ok = store.delete(id);
      return ok
        ? { success: true, data: { id }, display: { type: 'text', content: `Напоминание #${id} удалено` } }
        : { success: false, error: `Напоминание #${id} не найдено` };
    },
  };
}

export function createTool(deps: ReminderDeps): ToolDefinition[] {
  return [
    createReminderCreateTool(deps),
    createReminderListTool(deps),
    createReminderDeleteTool(deps),
  ];
}

export default createTool;
```

### Step 3.6: Add `reminderStore` to `ToolDeps`

- [x] Modify `packages/server/src/tools/base.ts`. Find the `ToolDeps` interface and add the new field:

```ts
import type { ReminderStore } from '../reminders/store.js';

// ... existing imports

export interface ToolDeps {
  runLoop: RunLoopFn;
  client: ClaudeClient;
  registry: ToolRegistry;
  piiProxy: PiiProxy;
  memoryService: MemoryService | null;
  reminderStore: ReminderStore | null;
}
```

Note: adding `reminderStore: ReminderStore | null` as a required property means every caller passing `ToolDeps` must provide it. Update all call sites in the next step.

### Step 3.7: Wire store + router + scheduler into `packages/server/src/index.ts`

- [x] Open `packages/server/src/index.ts`. Add these imports near the existing relative imports:

```ts
import { createReminderStore } from './reminders/store.js';
import { startScheduler } from './reminders/scheduler.js';
import { reminderBus } from './reminders/bus.js';
import { createReminderRouter } from './routes/reminder.js';
```

- [x] After `initDb(...)` is called (search for `initDb(`), build the store and start the scheduler:

```ts
const reminderStore = createReminderStore({ db: getDb() });
const stopScheduler = startScheduler({ store: reminderStore, db: getDb(), bus: reminderBus });
```

- [x] Find the call to `discoverTools(...)` and the construction of `ToolDeps`. Pass `reminderStore`:

```ts
const toolDeps: ToolDeps = {
  runLoop: runLoopFn,
  client,
  registry,
  piiProxy,
  memoryService,
  reminderStore,
};
```

(Exact variable name for `toolDeps` may differ — follow the existing file's style. The point is `reminderStore` must appear wherever `memoryService` already appears.)

- [x] Mount the router alongside existing routers. Search for `app.use('/api', ...)` or similar and add:

```ts
app.use('/api/reminder', createReminderRouter({ store: reminderStore, bus: reminderBus }));
```

- [x] On graceful shutdown (search for `process.on('SIGTERM'` or `closeDb`), add `stopScheduler()`:

```ts
process.on('SIGTERM', () => {
  stopScheduler();
  closeDb();
  // ... existing shutdown logic
});
```

(If no SIGTERM handler exists, wire `stopScheduler()` alongside existing cleanup.)

### Step 3.8: Verify typecheck and full test run

- [x] Run:

```bash
cd /Users/dim/code/R2-D2/packages/server && npx tsc --noEmit
```

Expected: no errors.

- [x] Run:

```bash
cd /Users/dim/code/R2-D2/packages/server && npx vitest run
```

Expected: all tests pass, including the new reminder tests and existing suites. If any existing test breaks because of the new `reminderStore` field in `ToolDeps`, update its mock to include `reminderStore: null`.

### Step 3.9: Commit

- [x] Run:

```bash
cd /Users/dim/code/R2-D2
git add packages/tool-reminder/src/index.ts packages/server/src/tools/base.ts packages/server/src/index.ts packages/server/src/routes/reminder.ts packages/server/src/routes/__tests__/reminder.test.ts
git commit -m "$(cat <<'EOF'
feat(reminder): tool-reminder package + HTTP routes + server wiring

Replaces the tool-reminder placeholder with three tools
(reminder_create claude-only; reminder_list and reminder_delete
provider='all'). Adds `reminderStore` to ToolDeps, builds it in
index.ts, starts the background scheduler, and mounts
/api/reminder/dismiss and /api/reminder/snooze HTTP routes with
unit tests.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: SSE `/api/events` + Client UI

**Files:**
- Create: `packages/server/src/routes/events.ts`
- Modify: `packages/shared/src/types.ts` — export push event types
- Create: `packages/client/src/lib/alarm-audio.ts`
- Create: `packages/client/src/components/ReminderAlarm.tsx`
- Create: `packages/client/src/components/__tests__/ReminderAlarm.test.tsx`
- Modify: `packages/client/src/App.tsx` — mount `<ReminderAlarm />`

### Step 4.1: Implement SSE events route

`ServerPushEvent` is already exported from `@r2/shared` (added in Task 2 step 2.6). Just import it here.

- [x] Create `packages/server/src/routes/events.ts`:

```ts
import { Router, type Request, type Response } from 'express';
import type { EventEmitter } from 'node:events';
import type { ServerPushEvent } from '@r2/shared';

interface EventsRouterDeps {
  bus: EventEmitter;
}

/**
 * Server-Sent Events endpoint for server→client push (reminder alarms,
 * future real-time events). One connection per browser tab, kept open.
 * Clients use `new EventSource('/api/events')`.
 */
export function createEventsRouter(deps: EventsRouterDeps): Router {
  const router = Router();
  const { bus } = deps;

  router.get('/', (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    // Send a comment frame immediately so the client considers the stream "open"
    // and proxies don't time out while waiting for the first event.
    res.write(':ok\n\n');

    const listener = (event: ServerPushEvent) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    bus.on('push', listener);

    // Heartbeat every 20s to keep intermediaries from closing an idle connection.
    const heartbeat = setInterval(() => {
      res.write(':heartbeat\n\n');
    }, 20_000);

    const cleanup = () => {
      bus.off('push', listener);
      clearInterval(heartbeat);
    };
    _req.on('close', cleanup);
    _req.on('aborted', cleanup);
  });

  return router;
}
```

### Step 4.2: Mount the events router in `index.ts`

- [x] In `packages/server/src/index.ts`, add import:

```ts
import { createEventsRouter } from './routes/events.js';
```

- [x] Mount it alongside other routers:

```ts
app.use('/api/events', createEventsRouter({ bus: reminderBus }));
```

### Step 4.3: Smoke test the SSE endpoint (manual)

- [x] Restart the dev server (tsx watch handles this automatically after edits).

- [x] In one terminal, subscribe:

```bash
curl -N http://localhost:3004/api/events
```

Expected: immediately see `:ok` frame. Heartbeat `:heartbeat` every 20s. No disconnect.

- [x] In another terminal, push a fake event:

```bash
cd /Users/dim/code/R2-D2/packages/server
node -e "
  const path = require('path');
  // Use the running server via a direct fetch to trigger a reminder — but since
  // this requires LLM, skip and instead seed a reminder in DB directly:
  const Database = require('better-sqlite3');
  const db = new Database(path.resolve(__dirname, '../../data/r2.db'));
  const at = new Date(Date.now() + 5000).toISOString();
  db.prepare('INSERT INTO reminders (text, schedule_json, next_fire_at_ms, created_at) VALUES (?, ?, ?, ?)')
    .run('smoke-test', JSON.stringify({kind:'once',at_iso:at}), Date.now()+5000, Date.now());
  console.log('inserted; wait ~15s for scheduler tick');
"
```

Expected: within ~15–20 seconds the first terminal prints a `data: {"type":"reminder_ring",...}` line.

### Step 4.4: Create alarm-audio wrapper

- [x] Create `packages/client/src/lib/alarm-audio.ts`:

```ts
/**
 * Thin Web Audio API wrapper used by ReminderAlarm to play a pulsed tone
 * during an active reminder ring. No mp3 asset — just a 880 Hz sine pulsed
 * at 500 ms on / 500 ms off. Browsers require a prior user gesture before
 * allowing audio; we resume the suspended AudioContext on start.
 */
export interface AlarmAudio {
  startLoop(): void;
  stopLoop(): void;
}

export function createAlarmAudio(): AlarmAudio {
  let ctx: AudioContext | null = null;
  let osc: OscillatorNode | null = null;
  let gain: GainNode | null = null;
  let pulseTimer: number | null = null;
  let active = false;

  return {
    startLoop() {
      if (active) return;
      active = true;
      const AudioContextCtor: typeof AudioContext =
        (window as unknown as { AudioContext: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
          .AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      ctx = new AudioContextCtor();
      if (ctx.state === 'suspended') {
        void ctx.resume();
      }
      osc = ctx.createOscillator();
      gain = ctx.createGain();
      osc.frequency.value = 880;
      osc.type = 'sine';
      gain.gain.value = 0;
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      let on = false;
      pulseTimer = window.setInterval(() => {
        on = !on;
        if (gain) gain.gain.value = on ? 0.2 : 0;
      }, 500);
    },

    stopLoop() {
      if (!active) return;
      active = false;
      if (pulseTimer !== null) {
        window.clearInterval(pulseTimer);
        pulseTimer = null;
      }
      try { osc?.stop(); } catch { /* already stopped */ }
      osc?.disconnect();
      gain?.disconnect();
      void ctx?.close();
      osc = null;
      gain = null;
      ctx = null;
    },
  };
}
```

### Step 4.5: Write failing tests for `ReminderAlarm`

- [x] Create `packages/client/src/components/__tests__/ReminderAlarm.test.tsx`:

```tsx
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, act, fireEvent, cleanup } from '@testing-library/react';
import { ReminderAlarm } from '../ReminderAlarm';

// Mock EventSource
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  listeners: Record<string, Array<(e: any) => void>> = {};
  readyState = 1;
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(event: string, fn: (e: any) => void) {
    (this.listeners[event] ||= []).push(fn);
  }
  close() { this.readyState = 2; }
  fire(eventName: string, data: any) {
    const list = this.listeners[eventName] || this.listeners.message || [];
    for (const fn of list) fn({ data: JSON.stringify(data) });
  }
}

const mockAudio = {
  startLoop: vi.fn(),
  stopLoop: vi.fn(),
};

vi.mock('../../lib/alarm-audio', () => ({
  createAlarmAudio: () => mockAudio,
}));

beforeEach(() => {
  (globalThis as any).EventSource = FakeEventSource;
  FakeEventSource.instances = [];
  mockAudio.startLoop.mockClear();
  mockAudio.stopLoop.mockClear();
  global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) }) as any;
});

afterEach(() => {
  cleanup();
});

describe('ReminderAlarm', () => {
  it('is invisible until a reminder_ring event arrives', () => {
    render(<ReminderAlarm />);
    expect(screen.queryByText(/Выключить/)).toBeNull();
  });

  it('shows modal and starts audio on reminder_ring', () => {
    render(<ReminderAlarm />);
    const src = FakeEventSource.instances[0];
    act(() => {
      src.fire('message', { type: 'reminder_ring', id: 42, text: 'выпить воды' });
    });
    expect(screen.getByText(/выпить воды/)).toBeTruthy();
    expect(mockAudio.startLoop).toHaveBeenCalledOnce();
  });

  it('stops audio on reminder_stop_ring but keeps modal', () => {
    render(<ReminderAlarm />);
    const src = FakeEventSource.instances[0];
    act(() => {
      src.fire('message', { type: 'reminder_ring', id: 42, text: 'a' });
      src.fire('message', { type: 'reminder_stop_ring', id: 42 });
    });
    expect(mockAudio.stopLoop).toHaveBeenCalled();
    expect(screen.getByText(/a/)).toBeTruthy();
  });

  it('removes entry on reminder_done', () => {
    render(<ReminderAlarm />);
    const src = FakeEventSource.instances[0];
    act(() => {
      src.fire('message', { type: 'reminder_ring', id: 42, text: 'a' });
      src.fire('message', { type: 'reminder_done', id: 42 });
    });
    expect(screen.queryByText(/a/)).toBeNull();
  });

  it('clicking Dismiss POSTs to /api/reminder/dismiss', async () => {
    render(<ReminderAlarm />);
    const src = FakeEventSource.instances[0];
    act(() => {
      src.fire('message', { type: 'reminder_ring', id: 42, text: 'a' });
    });
    const btn = screen.getByRole('button', { name: /Выключить/ });
    fireEvent.click(btn);
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/reminder/dismiss',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('clicking Snooze POSTs to /api/reminder/snooze', async () => {
    render(<ReminderAlarm />);
    const src = FakeEventSource.instances[0];
    act(() => {
      src.fire('message', { type: 'reminder_ring', id: 42, text: 'a' });
    });
    const btn = screen.getByRole('button', { name: /Через 10 мин/ });
    fireEvent.click(btn);
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/reminder/snooze',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
```

### Step 4.6: Verify tests fail

- [x] Run:

```bash
cd /Users/dim/code/R2-D2/packages/client && npx vitest run src/components/__tests__/ReminderAlarm.test.tsx
```

Expected: FAIL — "Cannot find module '../ReminderAlarm'".

### Step 4.7: Implement `ReminderAlarm` component

- [x] Create `packages/client/src/components/ReminderAlarm.tsx`:

```tsx
import { useEffect, useRef, useState, useCallback } from 'react';
import { createAlarmAudio, type AlarmAudio } from '../lib/alarm-audio';

type ReminderPush =
  | { type: 'reminder_ring'; id: number; text: string }
  | { type: 'reminder_stop_ring'; id: number }
  | { type: 'reminder_done'; id: number };

interface ActiveAlarm {
  id: number;
  text: string;
  ringing: boolean;
}

export function ReminderAlarm() {
  const [alarms, setAlarms] = useState<ActiveAlarm[]>([]);
  const audioRef = useRef<AlarmAudio | null>(null);

  // Lazily create audio once per component.
  if (audioRef.current === null) {
    audioRef.current = createAlarmAudio();
  }
  const audio = audioRef.current;

  const updateAudio = useCallback((next: ActiveAlarm[]) => {
    const anyRinging = next.some((a) => a.ringing);
    if (anyRinging) audio.startLoop();
    else audio.stopLoop();
  }, [audio]);

  useEffect(() => {
    const src = new EventSource('/api/events');
    const onMessage = (ev: MessageEvent) => {
      let data: ReminderPush;
      try {
        data = JSON.parse(ev.data);
      } catch {
        return;
      }
      setAlarms((prev) => {
        let next = prev;
        if (data.type === 'reminder_ring') {
          const existing = prev.find((a) => a.id === data.id);
          if (existing) {
            next = prev.map((a) => (a.id === data.id ? { ...a, ringing: true } : a));
          } else {
            next = [...prev, { id: data.id, text: data.text, ringing: true }];
          }
        } else if (data.type === 'reminder_stop_ring') {
          next = prev.map((a) => (a.id === data.id ? { ...a, ringing: false } : a));
        } else if (data.type === 'reminder_done') {
          next = prev.filter((a) => a.id !== data.id);
        }
        updateAudio(next);
        return next;
      });
    };
    src.addEventListener('message', onMessage);
    return () => {
      src.close();
      audio.stopLoop();
    };
  }, [audio, updateAudio]);

  const handleDismiss = async (id: number) => {
    await fetch('/api/reminder/dismiss', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    setAlarms((prev) => {
      const next = prev.filter((a) => a.id !== id);
      updateAudio(next);
      return next;
    });
  };

  const handleSnooze = async (id: number) => {
    await fetch('/api/reminder/snooze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    setAlarms((prev) => {
      const next = prev.filter((a) => a.id !== id);
      updateAudio(next);
      return next;
    });
  };

  if (alarms.length === 0) return null;

  return (
    <div
      role="dialog"
      aria-label="Напоминания"
      style={{
        position: 'fixed',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
        zIndex: 1000,
        background: 'var(--bg-panel, #1f1f1f)',
        color: 'var(--text-primary, #f5f5f5)',
        border: '2px solid #c55',
        borderRadius: 12,
        padding: 24,
        minWidth: 320,
        boxShadow: '0 12px 48px rgba(0,0,0,0.5)',
      }}
    >
      {alarms.map((a) => (
        <div key={a.id} style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 18, marginBottom: 8 }}>
            ⏰ {a.text} {a.ringing ? '(звонит…)' : '(пауза)'}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => handleDismiss(a.id)}>✓ Выключить</button>
            <button onClick={() => handleSnooze(a.id)}>😴 Через 10 мин</button>
          </div>
        </div>
      ))}
    </div>
  );
}
```

### Step 4.8: Verify client tests pass

- [x] Run:

```bash
cd /Users/dim/code/R2-D2/packages/client && npx vitest run src/components/__tests__/ReminderAlarm.test.tsx
```

Expected: PASS — 6 tests green.

### Step 4.9: Mount `<ReminderAlarm />` in App.tsx

- [x] Open `packages/client/src/App.tsx`. Add the import at the top:

```tsx
import { ReminderAlarm } from './components/ReminderAlarm';
```

- [x] Inside the JSX returned by `App`, add `<ReminderAlarm />` at the top level (sibling to the chat layout), so it floats above everything:

```tsx
return (
  <>
    <ReminderAlarm />
    {/* ... existing chat UI ... */}
  </>
);
```

(If `App` already returns a fragment or a single wrapper `<div>`, place `<ReminderAlarm />` as the first child.)

### Step 4.10: Full server + client test run

- [x] Run:

```bash
cd /Users/dim/code/R2-D2/packages/server && npx tsc --noEmit && npx vitest run
```

Expected: green.

- [x] Run:

```bash
cd /Users/dim/code/R2-D2/packages/client && npx tsc --noEmit && npx vitest run
```

Expected: green.

### Step 4.11: Commit

- [x] Run:

```bash
cd /Users/dim/code/R2-D2
git add packages/shared/src/types.ts packages/server/src/routes/events.ts packages/server/src/index.ts packages/client/src/lib/alarm-audio.ts packages/client/src/components/ReminderAlarm.tsx packages/client/src/components/__tests__/ReminderAlarm.test.tsx packages/client/src/App.tsx
git commit -m "$(cat <<'EOF'
feat(reminder): SSE events endpoint + ReminderAlarm UI

Adds `/api/events` Server-Sent Events route that forwards reminder
bus events to all connected browser tabs (with a 20s heartbeat).
Adds Web Audio API alarm wrapper (880 Hz pulsed tone, no binary
asset) and a singleton ReminderAlarm React component that listens
to `/api/events`, displays a modal with Dismiss/Snooze buttons,
and starts/stops the alarm loop in response to bus events. Six
client unit tests cover ring/stop/done events and button clicks.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Prompt Guard + Docs + Manual E2E

**Files:**
- Modify: `packages/server/src/ai/prompts.ts`
- Modify: `AGENTS.md` — document reminder feature
- Manual: end-to-end smoke test in running dev server

### Step 5.1: Add prompt guard to both system prompts

- [ ] Open `packages/server/src/ai/prompts.ts`. Find the Ollama base prompt string (`getLocalSystemPrompt` → the block containing `ОБМЕЖЕННЯ:`). Replace the existing `ОБМЕЖЕННЯ:` block with:

```ts
  const base = `Ти — R2, персональний AI-асистент. Ти працюєш для свого власника.
Твоя задача — робити рутину, щоб власник міг думати про важливе.

Зараз: ${formatNow()}.

${BASE_RULES}

ДОСТУПНІ TOOLS (використовуй ТІЛЬКИ ці назви, НІКОЛИ не вигадуй свої):
${toolList}

ЯК ВИКЛИКАТИ TOOL:
Використовуй нативний механізм tool_calls. НІКОЛИ не пиши JSON як текст повідомлення —
це не спрацює. Система сама викличе tool якщо ти використаєш правильний tool_calls канал.

ВИБІР ПРАВИЛЬНОГО TOOL (російські/українські запити → tool name):
  - "створи/запиши файл", "збережи список", "нотатки" → file_write
  - "прочитай файл", "покажи вміст" → file_read
  - "список файлів", "які є файли" → file_list
  - "видали файл" → file_delete
  - "перемісти/переіменуй файл" → file_move
  - "пошук в інтернеті", "знайди", "новини", "погода", "курс" → web_search
  - "список напоминаний", "активні нагадування" → reminder_list
  - "видали напоминание", "забудь напоминание" → reminder_delete

КРИТИЧНО ВАЖЛИВО — НЕ БРЕШИ:
Коли ти описуєш результат виконаної дії (file_write, web_search тощо),
кажи ТІЛЬКИ те що реально сталось. Не описуй форматування якого немає,
не вигадуй вміст файлів, не додавай bullet points якщо ти їх не записав.
Якщо ти записав "а, б, в" — так і кажи, не перетворюй це в список.
Якщо користувач просить красиве форматування — передай literal \\n в
параметр content (наприклад "1. Хліб\\n2. Молоко"), а потім чесно опиши
що саме записав.

**НЕ ІМІТУЙ ДІЇ ЯКИХ ТИ НЕ ЗРОБИВ.**
Якщо у списку ДОСТУПНІ TOOLS немає потрібного інструменту — НІКОЛИ не пиши
що "запланував / зробив / надіслав / створив". Скажи чесно: "в мене немає
такого інструменту" або поверни \`[need tool: <опис>]\`. Брехня про виконання
заборонена.

Для питань які потребують актуальних даних — новини, погода, курси валют,
ціни, котирування, розклади, спортивні результати, факти після дати твого
навчання — ЗАВЖДИ викликай web_search. НІКОЛИ не відповідай з пам'яті на
такі питання — твоя пам'ять застаріла і ти вигадаєш неправду.

ОБМЕЖЕННЯ:
У тебе НЕМАЄ доступу до bash, баз даних, API чи програмування.
Якщо потрібна задача програмування або інша складна дія — поверни РІВНО один рядок:

  [need tool: <що саме потрібно зробити>]

На прості фактичні питання зі своєї пам'яті відповідай напряму, коротко.
Ніколи не змішуй маркер з іншим текстом — або маркер сам, або звичайна відповідь.`;
```

- [ ] Find the Claude base prompt in `getSystemPrompt`. Append a compact version of the guard to `BASE_RULES` OR to the prompt string directly:

Replace:

```ts
const BASE_RULES = `Правила:
1. Якщо можеш зробити сам — роби. Не питай зайвих питань.
2. Якщо потрібен дозвіл — коротко поясни що хочеш зробити і чому.
3. Відповідай тією мовою, якою до тебе звертаються.
4. Будь лаконічним. Факти > вода.
5. Якщо чогось не знаєш — скажи. Не вигадуй.
6. Веди список зроблених дій щоб власник бачив що було зроблено.`;
```

with:

```ts
const BASE_RULES = `Правила:
1. Якщо можеш зробити сам — роби. Не питай зайвих питань.
2. Якщо потрібен дозвіл — коротко поясни що хочеш зробити і чому.
3. Відповідай тією мовою, якою до тебе звертаються.
4. Будь лаконічним. Факти > вода.
5. Якщо чогось не знаєш — скажи. Не вигадуй.
6. Веди список зроблених дій щоб власник бачив що було зроблено.
7. НЕ ІМІТУЙ дії яких не зробив. Якщо потрібного tool немає — скажи чесно, не вигадуй успіх.`;
```

This constant is shared by both `getSystemPrompt` and `getLocalSystemPrompt`, so one edit covers both.

### Step 5.2: Run prompt tests

- [ ] Run:

```bash
cd /Users/dim/code/R2-D2/packages/server && npx vitest run src/ai/__tests__/prompts.test.ts
```

Expected: green. If any test pins the old rules string, update the expected string to match.

### Step 5.3: Update `AGENTS.md`

- [ ] Open `AGENTS.md`. Find the Phase 4G block. After the Phase 4G bullets, add a new Phase 5 section:

```markdown
- **5A) Reminder tool** ✓ — alarm-style one-shot and recurring (daily/weekly/monthly) reminders
  - `packages/tool-reminder` — tool definitions (create claude-only; list/delete provider='all')
  - `packages/server/src/reminders/` — `recurrence.ts` (next-fire calculator), `store.ts` (SQLite CRUD + state machine), `scheduler.ts` (idempotent background tick), `bus.ts` (EventEmitter singleton)
  - `packages/server/src/routes/events.ts` — Server-Sent Events endpoint `/api/events` (20s heartbeat, EventSource-compatible)
  - `packages/server/src/routes/reminder.ts` — POST `/api/reminder/dismiss`, POST `/api/reminder/snooze`
  - `packages/client/src/components/ReminderAlarm.tsx` + `lib/alarm-audio.ts` — singleton modal + Web Audio API pulsed tone (880 Hz, no binary asset)
  - Alarm cycle: 60s ring → 2 min pause → 60s ring → 2 min pause → 60s ring → done (3 rings total before "пропущено")
  - Schedule discriminated union: `once` / `daily` / `weekly` / `monthly`, LLM translates natural language → structured params (qwen escalates `reminder_create` to Claude via `provider: 'claude'` because qwen2.5 is unreliable at datetime arithmetic / weekday numbering)
  - State machine is idempotent across server restarts: state lives in SQLite, scheduler tick resumes from whatever row state it finds on next tick after reboot
  - Runtime override of `provider` (to force reminder_create onto Ollama after upgrading models) is a backlog item ("Tool provider overrides")
```

### Step 5.4: Manual end-to-end verification

- [ ] Make sure the dev server is running (`tsx watch` auto-restarts on edits).

- [ ] **Test one-shot:** In the chat UI type: `напомни через 1 минуту выпить воды`.
  - Expect: assistant response from Claude confirming creation with id.
  - After ~60–75 seconds: modal appears with "⏰ выпить воды (звонит…)", Web Audio tone plays, a chat message `⏰ выпить воды` appears in history.
  - Click `✓ Выключить`: tone stops, modal closes.

- [ ] **Test snooze:** Create another one-shot for 1 minute. When it rings, click `😴 Через 10 мин`. Modal closes. Check in SQLite that a new reminder row exists with `kind: 'once'` 10 min in the future.

```bash
sqlite3 /Users/dim/code/R2-D2/data/r2.db "SELECT id, text, datetime(next_fire_at_ms/1000, 'unixepoch') FROM reminders WHERE active = 1 ORDER BY id DESC LIMIT 5;"
```

- [ ] **Test 3-cycle:** Create a one-shot for 1 minute. When it rings, do NOT click anything for 10 minutes. Expect three separate ring phases (60s on, 2 min off, 60s on, 2 min off, 60s on), then a final `⏰ пропущено: <text>` chat message and the modal disappears.

- [ ] **Test daily:** `напомни каждый день в <текущий час+2>:00 зарядка`.
  - In chat: confirm id.
  - `/нагадування` — shows the daily reminder with `(следующее: ..., daily)`.
  - `/нагадування видалити <id>` — removed.

- [ ] **Test prompt guard:** Ask qwen something for which there is no tool: `забронируй мне столик в ресторане на 7 вечера`. Expect: qwen replies honestly (`в меня нет такого инструмента` or `[need tool: ...]`). It must NOT say "забронировал" or "сделано".

- [ ] **Test prompt guard (claude):** Same prompt, but escalate to Claude (e.g. `/клод забронируй ...`). Claude should also decline honestly.

If any of the above fail, fix the issue and re-run the failing check. Do not mark the task complete on partial success.

### Step 5.5: Commit

- [ ] Run:

```bash
cd /Users/dim/code/R2-D2
git add packages/server/src/ai/prompts.ts AGENTS.md
git commit -m "$(cat <<'EOF'
feat(reminder): prompt guard against fabricated actions + AGENTS.md docs

Adds rule #7 to BASE_RULES ("НЕ ІМІТУЙ дії яких не зробив…") so both
Claude and Ollama system prompts tell the model to refuse honestly
when no suitable tool exists, instead of hallucinating success like
qwen did on "напомни через 5 часов выпить воды" before the reminder
tool existed. Also expands the Ollama prompt's tool-selection hints
with reminder_list / reminder_delete examples and documents Phase 5A
(reminder tool) in AGENTS.md.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Done Criteria

- `packages/tool-reminder/` package exists with real tool definitions (create claude-only, list/delete provider='all').
- `reminders` table created in `data/r2.db` on server start; `/api/reminder/dismiss` and `/api/reminder/snooze` routes respond.
- `/api/events` SSE endpoint streams reminder events.
- `ReminderAlarm` component is mounted and renders the modal with working Dismiss/Snooze buttons.
- Web Audio API tone plays on ring, stops on pause/dismiss/done.
- All automated tests pass: `cd packages/server && npx vitest run` green; `cd packages/client && npx vitest run` green; `npx tsc --noEmit` clean in both packages.
- Manual e2e in Task 5 passes: one-shot ring, snooze creates +10min reminder, 3-cycle finishes with "пропущено" message, daily reminder rolls over, prompt guard prevents fabricated actions.
- Commits on the feature branch (one per task):
  1. `feat(reminder): scaffold tool-reminder package + recurrence calculator`
  2. `feat(reminder): store + scheduler state machine with SQLite persistence`
  3. `feat(reminder): tool-reminder package + HTTP routes + server wiring`
  4. `feat(reminder): SSE events endpoint + ReminderAlarm UI`
  5. `feat(reminder): prompt guard against fabricated actions + AGENTS.md docs`
- Feature branch merged through dev → master (fast-forward).
