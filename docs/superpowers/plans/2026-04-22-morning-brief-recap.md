# Morning Brief Recap + Gap Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Расширить `morningBrief` handler анализом прошлого периода (вчера или gap) через LLM на сыром срезе данных + detect пропущенных дней и ловить первое возвращение юзера.

**Architecture:** Меняются только `morningBrief.ts` / `morningBrief.helpers.ts` (+ тесты). Новые helpers `getLastBriefPublishAt`, `computeGapDays`, `gatherPreviousPeriod` дополняют существующий `gatherData`. Trigger получает второй путь для gap-return scenario. Промпт переписан на свободный анализ "что висит / повторяется / упустил" с опциональной gap-preamble.

**Tech Stack:** TypeScript, vitest, better-sqlite3, существующий cognition handler API.

**Spec:** `docs/superpowers/specs/2026-04-22-morning-brief-recap-design.md`

---

## File Structure

- **Modify:** `packages/server/src/cognition/handlers/morningBrief.helpers.ts`
  - Add: `getLastBriefPublishAt`, `computeGapDays`, `gatherPreviousPeriod`, `truncateBundle`
  - Modify: `gatherData` (returns `BriefData` with `previousPeriod` + `gapDays`), `composePrompt`
- **Modify:** `packages/server/src/cognition/handlers/morningBrief.ts`
  - Modify: `trigger` (add gap-return branch)
- **Modify:** `packages/server/src/cognition/__tests__/handlers/morningBrief.helpers.test.ts`
  - Add tests for all new helpers + updated `gatherData` / `composePrompt`
- **Modify:** `packages/server/src/cognition/__tests__/handlers/morningBrief.test.ts`
  - Add tests for gap-return trigger scenarios

All changes are additive to existing API — no file splits, no renames.

---

## Testing Strategy

- **Unit tests mandatory** per task. Project uses vitest only — no e2e.
- `initDb(':memory:')` per test (matches existing pattern).
- Fake timers not needed here (no debounce/interval logic — trigger is pure function of inputs).
- Run after each task: `npm -w @r2/server test -- morningBrief` to scope.

---

## Progress Tracking

- `[x]` as soon as a step is done.
- ➕ for newly found tasks.
- ⚠️ for blockers.

---

## Task 1: `getLastBriefPublishAt` helper

**Files:**
- Modify: `packages/server/src/cognition/handlers/morningBrief.helpers.ts`
- Test: `packages/server/src/cognition/__tests__/handlers/morningBrief.helpers.test.ts`

- [ ] **Step 1: Write failing test "returns null when no runs exist"**

Append at end of `morningBrief.helpers.test.ts`:

```typescript
import { getLastBriefPublishAt } from '../../handlers/morningBrief.helpers.js';

describe('getLastBriefPublishAt', () => {
  it('returns null when cognition_handler_runs is empty', () => {
    expect(getLastBriefPublishAt(getDb())).toBeNull();
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `npm -w @r2/server test -- morningBrief.helpers`
Expected: `TypeError: getLastBriefPublishAt is not a function` or export-not-found.

- [ ] **Step 3: Implement in `morningBrief.helpers.ts`**

Append:

```typescript
export function getLastBriefPublishAt(db: Database.Database): number | null {
  const row = db
    .prepare(
      "SELECT MAX(fired_at) AS ts FROM cognition_handler_runs WHERE handler_name = 'morningBrief' AND outcome = 'publish'",
    )
    .get() as { ts: number | null } | undefined;
  return row?.ts ?? null;
}
```

- [ ] **Step 4: Run test — expect PASS**

Run: `npm -w @r2/server test -- morningBrief.helpers`
Expected: 1 new test passes.

- [ ] **Step 5: Add remaining test cases**

Append to `describe('getLastBriefPublishAt', ...)`:

```typescript
it('returns null when runs exist but none with publish outcome', () => {
  getDb()
    .prepare(
      'INSERT INTO cognition_handler_runs (handler_name, fired_at, duration_ms, outcome) VALUES (?, ?, ?, ?)',
    )
    .run('morningBrief', 1000, 10, 'error');
  getDb()
    .prepare(
      'INSERT INTO cognition_handler_runs (handler_name, fired_at, duration_ms, outcome) VALUES (?, ?, ?, ?)',
    )
    .run('morningBrief', 2000, 10, 'skip');
  expect(getLastBriefPublishAt(getDb())).toBeNull();
});

it('returns the most recent publish fired_at, ignoring other handlers', () => {
  const rows: Array<[string, number, string]> = [
    ['morningBrief', 100, 'publish'],
    ['pulse', 500, 'publish'],
    ['morningBrief', 300, 'publish'],
    ['morningBrief', 200, 'error'],
  ];
  for (const [name, ts, outcome] of rows) {
    getDb()
      .prepare(
        'INSERT INTO cognition_handler_runs (handler_name, fired_at, duration_ms, outcome) VALUES (?, ?, ?, ?)',
      )
      .run(name, ts, 10, outcome);
  }
  expect(getLastBriefPublishAt(getDb())).toBe(300);
});
```

- [ ] **Step 6: Run — expect PASS for all 3 new tests**

Run: `npm -w @r2/server test -- morningBrief.helpers`

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/cognition/handlers/morningBrief.helpers.ts packages/server/src/cognition/__tests__/handlers/morningBrief.helpers.test.ts
git commit -m "feat(morning-brief): add getLastBriefPublishAt helper"
```

---

## Task 2: `computeGapDays` helper

**Files:**
- Modify: `packages/server/src/cognition/handlers/morningBrief.helpers.ts`
- Test: `packages/server/src/cognition/__tests__/handlers/morningBrief.helpers.test.ts`

- [ ] **Step 1: Write failing tests**

Append:

```typescript
import { computeGapDays } from '../../handlers/morningBrief.helpers.js';

describe('computeGapDays', () => {
  it('returns 0 when lastPublishAt is null (first run)', () => {
    const now = Date.UTC(2026, 3, 22, 9, 0, 0);
    expect(computeGapDays(null, now, TZ)).toBe(0);
  });

  it('returns 0 when lastPublishAt is on same local date as now', () => {
    const lastPublish = Date.UTC(2026, 3, 22, 3, 0, 0); // 06:00 Kyiv 22nd
    const now = Date.UTC(2026, 3, 22, 15, 0, 0); // 18:00 Kyiv same day
    expect(computeGapDays(lastPublish, now, TZ)).toBe(0);
  });

  it('returns 1 when lastPublishAt is yesterday local', () => {
    const lastPublish = Date.UTC(2026, 3, 21, 3, 0, 0); // 06:00 Kyiv 21st
    const now = Date.UTC(2026, 3, 22, 9, 0, 0); // 12:00 Kyiv 22nd
    expect(computeGapDays(lastPublish, now, TZ)).toBe(1);
  });

  it('returns 3 when last publish 3 local days ago', () => {
    const lastPublish = Date.UTC(2026, 3, 19, 3, 0, 0);
    const now = Date.UTC(2026, 3, 22, 9, 0, 0);
    expect(computeGapDays(lastPublish, now, TZ)).toBe(3);
  });

  it('is DST-aware across spring-forward', () => {
    // Kyiv spring-forward 2026-03-29: 03:00→04:00. Measure 2-day gap crossing it.
    const lastPublish = Date.UTC(2026, 2, 28, 6, 0, 0); // 08:00 Kyiv 28th (pre-DST)
    const now = Date.UTC(2026, 2, 30, 6, 0, 0); // 09:00 Kyiv 30th (post-DST UTC+3)
    expect(computeGapDays(lastPublish, now, TZ)).toBe(2);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `npm -w @r2/server test -- morningBrief.helpers`

- [ ] **Step 3: Implement**

Append to `morningBrief.helpers.ts`:

```typescript
export function computeGapDays(
  lastPublishAt: number | null,
  now: number,
  tz: string,
): number {
  if (lastPublishAt === null) return 0;
  const lastStart = getLocalCivilEpoch(lastPublishAt, tz);
  const todayStart = getLocalCivilEpoch(now, tz);
  if (todayStart <= lastStart) return 0;
  // Count civil day boundaries between lastStart and todayStart — DST-safe
  // because getLocalCivilEpoch rebuilds offset per date.
  let days = 0;
  let cursor = lastStart;
  while (cursor < todayStart && days < 365) {
    cursor = getLocalCivilEpoch(cursor + 26 * 3600_000, tz); // +26h steps to skip any DST day (23h/25h)
    days++;
  }
  return days;
}
```

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/cognition/handlers/morningBrief.helpers.ts packages/server/src/cognition/__tests__/handlers/morningBrief.helpers.test.ts
git commit -m "feat(morning-brief): add computeGapDays helper (DST-aware)"
```

---

## Task 3: `hasUserActivityInLastHour` helper

**Files:**
- Modify: `packages/server/src/cognition/handlers/morningBrief.helpers.ts`
- Test: `packages/server/src/cognition/__tests__/handlers/morningBrief.helpers.test.ts`

- [ ] **Step 1: Write failing tests**

Append:

```typescript
import { hasUserActivityInLastHour } from '../../handlers/morningBrief.helpers.js';

describe('hasUserActivityInLastHour', () => {
  it('returns false when no chat messages at all', () => {
    expect(hasUserActivityInLastHour(getDb(), Date.now())).toBe(false);
  });

  it('returns false when last user message is > 1 hour old', () => {
    const now = Date.UTC(2026, 3, 22, 12, 0, 0);
    getDb()
      .prepare(
        "INSERT INTO chat_messages (message_id, role, content, timestamp) VALUES ('a', 'user', 'hi', ?)",
      )
      .run(now - 2 * 3600_000);
    expect(hasUserActivityInLastHour(getDb(), now)).toBe(false);
  });

  it('returns true when user message within last hour', () => {
    const now = Date.UTC(2026, 3, 22, 12, 0, 0);
    getDb()
      .prepare(
        "INSERT INTO chat_messages (message_id, role, content, timestamp) VALUES ('a', 'user', 'hi', ?)",
      )
      .run(now - 30 * 60_000);
    expect(hasUserActivityInLastHour(getDb(), now)).toBe(true);
  });

  it('ignores assistant messages', () => {
    const now = Date.UTC(2026, 3, 22, 12, 0, 0);
    getDb()
      .prepare(
        "INSERT INTO chat_messages (message_id, role, content, timestamp) VALUES ('a', 'assistant', 'hi', ?)",
      )
      .run(now - 10 * 60_000);
    expect(hasUserActivityInLastHour(getDb(), now)).toBe(false);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement in `morningBrief.helpers.ts`**

Append:

```typescript
export function hasUserActivityInLastHour(
  db: Database.Database,
  now: number,
): boolean {
  const row = db
    .prepare(
      "SELECT 1 FROM chat_messages WHERE role = 'user' AND timestamp >= ? LIMIT 1",
    )
    .get(now - 3600_000);
  return row !== undefined;
}
```

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/cognition/handlers/morningBrief.helpers.ts packages/server/src/cognition/__tests__/handlers/morningBrief.helpers.test.ts
git commit -m "feat(morning-brief): add hasUserActivityInLastHour helper"
```

---

## Task 4: `gatherPreviousPeriod` — raw bundle collection

**Files:**
- Modify: `packages/server/src/cognition/handlers/morningBrief.helpers.ts`
- Test: `packages/server/src/cognition/__tests__/handlers/morningBrief.helpers.test.ts`

- [ ] **Step 1: Write failing test "collects all 7 source kinds"**

Append:

```typescript
import { gatherPreviousPeriod } from '../../handlers/morningBrief.helpers.js';

describe('gatherPreviousPeriod', () => {
  it('returns empty bundle when period is empty', () => {
    const bundle = gatherPreviousPeriod(getDb(), 1000, 2000);
    expect(bundle).toEqual({
      chat: [],
      memoryCreated: [],
      memoryUpdated: [],
      memoryForgotten: [],
      audit: [],
      cognition: [],
      remindersOverdue: [],
      remindersCreated: [],
    });
  });

  it('collects chat messages in [from, to)', () => {
    const from = 1000;
    const to = 2000;
    const db = getDb();
    db.prepare(
      "INSERT INTO chat_messages (message_id, role, content, timestamp) VALUES ('a', 'user', 'before', ?)",
    ).run(500);
    db.prepare(
      "INSERT INTO chat_messages (message_id, role, content, timestamp) VALUES ('b', 'user', 'inside', ?)",
    ).run(1500);
    db.prepare(
      "INSERT INTO chat_messages (message_id, role, content, timestamp) VALUES ('c', 'assistant', 'inside-2', ?)",
    ).run(1800);
    db.prepare(
      "INSERT INTO chat_messages (message_id, role, content, timestamp) VALUES ('d', 'user', 'after', ?)",
    ).run(2500);
    const bundle = gatherPreviousPeriod(db, from, to);
    expect(bundle.chat.map((r) => r.content)).toEqual(['inside', 'inside-2']);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement `gatherPreviousPeriod`**

Append to `morningBrief.helpers.ts`:

```typescript
export interface PreviousPeriodBundle {
  chat: ChatRow[];
  memoryCreated: Array<{ key: string; value: string; createdAt: number }>;
  memoryUpdated: Array<{ key: string; lastMentionedAt: number }>;
  memoryForgotten: Array<{ key: string; lastMentionedAt: number }>;
  audit: Array<{ toolName: string; result: string; createdAt: string; success: number }>;
  cognition: Array<{ handlerName: string; firedAt: number; outcome: string; content: string | null }>;
  remindersOverdue: Array<{ text: string; nextFireAt: number }>;
  remindersCreated: Array<{ text: string; createdAt: number }>;
}

const BUNDLE_CHAT_MAX = 80;
const BUNDLE_CHAT_CONTENT_MAX = 500;
const BUNDLE_MEMORY_MAX = 30;
const BUNDLE_MEMORY_VALUE_MAX = 300;
const BUNDLE_AUDIT_MAX = 20;
const BUNDLE_AUDIT_RESULT_MAX = 300;
const BUNDLE_COGNITION_MAX = 20;
const BUNDLE_COGNITION_CONTENT_MAX = 400;
const BUNDLE_REMINDERS_MAX = 20;
const BUNDLE_REMINDERS_OVERDUE_LOOKBACK_MS = 30 * 86400_000;
const AUDIT_HEAVY_TOOLS = ['code_task', 'code_deploy', 'eval_add', 'eval_run'];

function truncStr(s: string | null | undefined, max: number): string {
  if (!s) return '';
  return s.length > max ? s.slice(0, max) : s;
}

export function gatherPreviousPeriod(
  db: Database.Database,
  from: number,
  to: number,
): PreviousPeriodBundle {
  const chatRaw = db
    .prepare(
      'SELECT role, content, timestamp AS ts FROM chat_messages WHERE timestamp >= ? AND timestamp < ? ORDER BY timestamp ASC LIMIT ?',
    )
    .all(from, to, BUNDLE_CHAT_MAX) as Array<{ role: string; content: string; ts: number }>;
  const chat: ChatRow[] = chatRaw.map((r) => ({
    role: r.role,
    ts: r.ts,
    content: truncStr(r.content, BUNDLE_CHAT_CONTENT_MAX),
  }));

  const memoryCreated = (
    db
      .prepare(
        'SELECT key, value, created_at AS createdAt FROM memory_facts WHERE created_at >= ? AND created_at < ? ORDER BY created_at DESC LIMIT ?',
      )
      .all(from, to, BUNDLE_MEMORY_MAX) as Array<{ key: string; value: string; createdAt: number }>
  ).map((r) => ({ ...r, value: truncStr(r.value, BUNDLE_MEMORY_VALUE_MAX) }));

  const memoryUpdated = db
    .prepare(
      'SELECT key, last_mentioned_at AS lastMentionedAt FROM memory_facts WHERE last_mentioned_at >= ? AND last_mentioned_at < ? AND created_at < ? AND forgotten = 0 ORDER BY last_mentioned_at DESC LIMIT ?',
    )
    .all(from, to, from, BUNDLE_MEMORY_MAX) as Array<{ key: string; lastMentionedAt: number }>;

  const memoryForgotten = db
    .prepare(
      'SELECT key, last_mentioned_at AS lastMentionedAt FROM memory_facts WHERE forgotten = 1 AND last_mentioned_at >= ? AND last_mentioned_at < ? ORDER BY last_mentioned_at DESC LIMIT ?',
    )
    .all(from, to, BUNDLE_MEMORY_MAX) as Array<{ key: string; lastMentionedAt: number }>;

  const fromIso = new Date(from).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
  const toIso = new Date(to).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
  const placeholders = AUDIT_HEAVY_TOOLS.map(() => '?').join(',');
  const auditRaw = db
    .prepare(
      `SELECT tool_name AS toolName, result, created_at AS createdAt, success FROM audit_log WHERE tool_name IN (${placeholders}) AND created_at >= ? AND created_at < ? ORDER BY created_at DESC LIMIT ?`,
    )
    .all(...AUDIT_HEAVY_TOOLS, fromIso, toIso, BUNDLE_AUDIT_MAX) as Array<{
    toolName: string;
    result: string;
    createdAt: string;
    success: number;
  }>;
  const audit = auditRaw.map((r) => ({ ...r, result: truncStr(r.result, BUNDLE_AUDIT_RESULT_MAX) }));

  const cognitionRaw = db
    .prepare(
      "SELECT handler_name AS handlerName, fired_at AS firedAt, outcome, content FROM cognition_handler_runs WHERE handler_name != 'morningBrief' AND fired_at >= ? AND fired_at < ? ORDER BY fired_at DESC LIMIT ?",
    )
    .all(from, to, BUNDLE_COGNITION_MAX) as Array<{
    handlerName: string;
    firedAt: number;
    outcome: string;
    content: string | null;
  }>;
  const cognition = cognitionRaw.map((r) => ({
    ...r,
    content: r.content ? truncStr(r.content, BUNDLE_COGNITION_CONTENT_MAX) : null,
  }));

  const remindersOverdue = db
    .prepare(
      'SELECT text, next_fire_at_ms AS nextFireAt FROM reminders WHERE active = 1 AND next_fire_at_ms < ? AND next_fire_at_ms >= ? ORDER BY next_fire_at_ms DESC LIMIT ?',
    )
    .all(to, to - BUNDLE_REMINDERS_OVERDUE_LOOKBACK_MS, BUNDLE_REMINDERS_MAX) as Array<{ text: string; nextFireAt: number }>;

  const remindersCreated = db
    .prepare(
      'SELECT text, created_at AS createdAt FROM reminders WHERE created_at >= ? AND created_at < ? ORDER BY created_at DESC LIMIT ?',
    )
    .all(from, to, BUNDLE_REMINDERS_MAX) as Array<{ text: string; createdAt: number }>;

  return {
    chat,
    memoryCreated,
    memoryUpdated,
    memoryForgotten,
    audit,
    cognition,
    remindersOverdue,
    remindersCreated,
  };
}
```

- [ ] **Step 4: Run — expect PASS for the 2 initial tests**

- [ ] **Step 5: Add per-source tests**

Append to `describe('gatherPreviousPeriod', ...)`:

```typescript
it('classifies memory_facts as created / updated / forgotten correctly', () => {
  const db = getDb();
  const from = 1000;
  const to = 2000;
  // Created inside period
  db.prepare(
    "INSERT INTO memory_facts (key, value, created_at, last_mentioned_at, importance, forgotten) VALUES ('k.new', 'v', 1500, 1500, 5, 0)",
  ).run();
  // Created before, updated inside, not forgotten → updated
  db.prepare(
    "INSERT INTO memory_facts (key, value, created_at, last_mentioned_at, importance, forgotten) VALUES ('k.upd', 'v', 500, 1700, 5, 0)",
  ).run();
  // Forgotten inside (last_mentioned_at inside, forgotten=1)
  db.prepare(
    "INSERT INTO memory_facts (key, value, created_at, last_mentioned_at, importance, forgotten) VALUES ('k.forg', 'v', 200, 1900, 5, 1)",
  ).run();
  const bundle = gatherPreviousPeriod(db, from, to);
  expect(bundle.memoryCreated.map((r) => r.key)).toEqual(['k.new']);
  expect(bundle.memoryUpdated.map((r) => r.key)).toEqual(['k.upd']);
  expect(bundle.memoryForgotten.map((r) => r.key)).toEqual(['k.forg']);
});

it('collects audit_log only for heavy tools', () => {
  const db = getDb();
  const from = 1000;
  const to = 2000;
  const isoInside = '2026-04-22 10:00:00';
  const isoBefore = '2026-04-20 10:00:00';
  // audit_log.created_at is TEXT; we control via explicit insert
  db.prepare(
    "INSERT INTO audit_log (tool_name, input, result, success, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run('code_task', '{}', 'ok', 1, 100, isoInside);
  db.prepare(
    "INSERT INTO audit_log (tool_name, input, result, success, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run('web_search', '{}', 'ok', 1, 100, isoInside);
  // To make numeric from/to match against ISO column, re-fetch via ISO bounds
  const bundle = gatherPreviousPeriod(
    db,
    Date.parse('2026-04-21T00:00:00Z'),
    Date.parse('2026-04-23T00:00:00Z'),
  );
  const names = bundle.audit.map((r) => r.toolName);
  expect(names).toContain('code_task');
  expect(names).not.toContain('web_search');
});

it('excludes morningBrief from cognition runs', () => {
  const db = getDb();
  const from = 1000;
  const to = 2000;
  db.prepare(
    'INSERT INTO cognition_handler_runs (handler_name, fired_at, duration_ms, outcome, content) VALUES (?, ?, ?, ?, ?)',
  ).run('morningBrief', 1500, 10, 'publish', 'old brief');
  db.prepare(
    'INSERT INTO cognition_handler_runs (handler_name, fired_at, duration_ms, outcome, content) VALUES (?, ?, ?, ?, ?)',
  ).run('pulse', 1600, 10, 'publish', 'pulse');
  const bundle = gatherPreviousPeriod(db, from, to);
  expect(bundle.cognition.map((r) => r.handlerName)).toEqual(['pulse']);
});

it('collects overdue active reminders within 30d lookback, excluding inactive', () => {
  const db = getDb();
  const now = Date.UTC(2026, 3, 22, 12, 0, 0);
  const to = now;
  const from = now - 86400_000;
  // Active, overdue within window
  db.prepare(
    "INSERT INTO reminders (text, schedule_json, next_fire_at_ms, active, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run('buy milk', '{}', now - 2 * 3600_000, 1, now - 3 * 86400_000);
  // Inactive — must be excluded
  db.prepare(
    "INSERT INTO reminders (text, schedule_json, next_fire_at_ms, active, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run('old reminder', '{}', now - 2 * 3600_000, 0, now - 3 * 86400_000);
  // Active but outside 30d lookback
  db.prepare(
    "INSERT INTO reminders (text, schedule_json, next_fire_at_ms, active, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run('ancient', '{}', now - 60 * 86400_000, 1, now - 60 * 86400_000);
  const bundle = gatherPreviousPeriod(db, from, to);
  expect(bundle.remindersOverdue.map((r) => r.text)).toEqual(['buy milk']);
});

it('applies row-count caps per source', () => {
  const db = getDb();
  const from = 1000;
  const to = 2000;
  for (let i = 0; i < 120; i++) {
    db.prepare(
      "INSERT INTO chat_messages (message_id, role, content, timestamp) VALUES (?, 'user', 'msg', ?)",
    ).run(`m${i}`, 1000 + i);
  }
  const bundle = gatherPreviousPeriod(db, from, to);
  expect(bundle.chat.length).toBe(80);
});
```

- [ ] **Step 6: Run — expect PASS for all new tests**

Run: `npm -w @r2/server test -- morningBrief.helpers`

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/cognition/handlers/morningBrief.helpers.ts packages/server/src/cognition/__tests__/handlers/morningBrief.helpers.test.ts
git commit -m "feat(morning-brief): gatherPreviousPeriod collects 7-source bundle"
```

---

## Task 5: Bundle truncation

**Files:**
- Modify: `packages/server/src/cognition/handlers/morningBrief.helpers.ts`
- Test: `packages/server/src/cognition/__tests__/handlers/morningBrief.helpers.test.ts`

- [ ] **Step 1: Write failing test**

Append:

```typescript
import { renderPreviousPeriod } from '../../handlers/morningBrief.helpers.js';

describe('renderPreviousPeriod', () => {
  it('includes "tail-only" marker when rendered body exceeds MAX_BUNDLE_CHARS', () => {
    const bigChat: ChatRow[] = [];
    for (let i = 0; i < 80; i++) {
      bigChat.push({ role: 'user', ts: 1_700_000_000_000 + i * 60_000, content: 'x'.repeat(450) });
    }
    const rendered = renderPreviousPeriod(
      {
        chat: bigChat,
        memoryCreated: [],
        memoryUpdated: [],
        memoryForgotten: [],
        audit: [],
        cognition: [],
        remindersOverdue: [],
        remindersCreated: [],
      },
      'Europe/Kyiv',
    );
    expect(rendered).toContain('...и ');
    expect(rendered).toContain('событий раньше опущено');
    expect(rendered.length).toBeLessThanOrEqual(12500); // MAX_BUNDLE_CHARS + tail marker
  });

  it('renders compact markdown with all non-empty sections', () => {
    const rendered = renderPreviousPeriod(
      {
        chat: [{ role: 'user', ts: 1_700_000_000_000, content: 'hello' }],
        memoryCreated: [{ key: 'k', value: 'v', createdAt: 1_700_000_000_000 }],
        memoryUpdated: [],
        memoryForgotten: [],
        audit: [],
        cognition: [],
        remindersOverdue: [],
        remindersCreated: [],
      },
      'Europe/Kyiv',
    );
    expect(rendered).toContain('### Chat');
    expect(rendered).toContain('### Memory изменения');
    expect(rendered).not.toContain('### Tool runs');
  });

  it('returns "активности не было" when every section is empty', () => {
    const rendered = renderPreviousPeriod(
      {
        chat: [],
        memoryCreated: [],
        memoryUpdated: [],
        memoryForgotten: [],
        audit: [],
        cognition: [],
        remindersOverdue: [],
        remindersCreated: [],
      },
      'Europe/Kyiv',
    );
    expect(rendered.trim()).toBe('активности не было');
  });
});
```

Also ensure `ChatRow` is imported (it's already exported from helpers):

```typescript
import type { ChatRow } from '../../handlers/morningBrief.helpers.js';
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement `renderPreviousPeriod` + truncation**

Append to `morningBrief.helpers.ts`:

```typescript
const MAX_BUNDLE_CHARS = 12000;

function renderSection(title: string, lines: string[]): string | null {
  if (lines.length === 0) return null;
  return `### ${title}\n${lines.join('\n')}`;
}

export function renderPreviousPeriod(
  bundle: PreviousPeriodBundle,
  tz: string,
): string {
  const sections: string[] = [];

  const chatLines = bundle.chat.map(
    (c) => `- [${formatLocal(c.ts, tz)}] ${c.role}: ${c.content}`,
  );
  const chatSec = renderSection('Chat', chatLines);
  if (chatSec) sections.push(chatSec);

  const memLines: string[] = [];
  for (const r of bundle.memoryCreated) memLines.push(`- created: ${r.key} = ${r.value}`);
  for (const r of bundle.memoryUpdated) memLines.push(`- updated: ${r.key}`);
  for (const r of bundle.memoryForgotten) memLines.push(`- forgotten: ${r.key}`);
  const memSec = renderSection('Memory изменения', memLines);
  if (memSec) sections.push(memSec);

  const toolLines = bundle.audit.map(
    (a) =>
      `- [${a.createdAt}] ${a.toolName}${a.success === 0 ? ' (fail)' : ''}: ${a.result}`,
  );
  const toolSec = renderSection('Tool runs', toolLines);
  if (toolSec) sections.push(toolSec);

  const cogLines = bundle.cognition.map(
    (c) =>
      `- [${formatLocal(c.firedAt, tz)}] ${c.handlerName} (${c.outcome})${c.content ? ': ' + c.content : ''}`,
  );
  const cogSec = renderSection('Cognition runs', cogLines);
  if (cogSec) sections.push(cogSec);

  const ovdLines = bundle.remindersOverdue.map(
    (r) => `- [${formatLocal(r.nextFireAt, tz)}] ${r.text}`,
  );
  const ovdSec = renderSection('Reminders overdue', ovdLines);
  if (ovdSec) sections.push(ovdSec);

  const newRemLines = bundle.remindersCreated.map(
    (r) => `- [${formatLocal(r.createdAt, tz)}] ${r.text}`,
  );
  const newRemSec = renderSection('Reminders созданные', newRemLines);
  if (newRemSec) sections.push(newRemSec);

  if (sections.length === 0) return 'активности не было';

  const joined = sections.join('\n\n');
  if (joined.length <= MAX_BUNDLE_CHARS) return joined;
  // Tail-first trim: keep the last MAX_BUNDLE_CHARS, count dropped lines
  const trimmedTail = joined.slice(joined.length - MAX_BUNDLE_CHARS);
  const droppedChars = joined.length - trimmedTail.length;
  const approxDroppedLines = (joined.slice(0, droppedChars).match(/\n/g) ?? []).length;
  return `...и ${approxDroppedLines} событий раньше опущено\n${trimmedTail}`;
}
```

Also `formatLocal` is already in the file (unexported) — if it's currently a local `function`, promote it to `export function` so `renderPreviousPeriod` uses the same formatter as `composePrompt`.

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/cognition/handlers/morningBrief.helpers.ts packages/server/src/cognition/__tests__/handlers/morningBrief.helpers.test.ts
git commit -m "feat(morning-brief): renderPreviousPeriod with tail-first truncation"
```

---

## Task 6: Extend `gatherData` with previousPeriod + gapDays

**Files:**
- Modify: `packages/server/src/cognition/handlers/morningBrief.helpers.ts`
- Test: `packages/server/src/cognition/__tests__/handlers/morningBrief.helpers.test.ts`

- [ ] **Step 1: Write failing test**

Append:

```typescript
describe('gatherData extended', () => {
  it('includes previousPeriod bundle and gapDays=0 when last publish is today', () => {
    const db = getDb();
    const now = Date.UTC(2026, 3, 22, 9, 0, 0); // 12:00 Kyiv
    db.prepare(
      'INSERT INTO cognition_handler_runs (handler_name, fired_at, duration_ms, outcome, content) VALUES (?, ?, ?, ?, ?)',
    ).run('morningBrief', Date.UTC(2026, 3, 22, 3, 0, 0), 10, 'publish', 'brief');
    // previousPeriod spans [lastPublish, todayStart) — on a same-day republish
    // the range collapses to empty (to <= from). Handler must still return a
    // well-formed bundle (all empty arrays), not throw.
    const data = gatherData(db, now, TZ);
    expect(data.gapDays).toBe(0);
    expect(data.previousPeriod).toBeDefined();
    expect(data.previousPeriod.chat).toEqual([]);
  });

  it('sets gapDays to 2 when last publish was 2 local days ago', () => {
    const db = getDb();
    const now = Date.UTC(2026, 3, 22, 9, 0, 0);
    db.prepare(
      'INSERT INTO cognition_handler_runs (handler_name, fired_at, duration_ms, outcome, content) VALUES (?, ?, ?, ?, ?)',
    ).run('morningBrief', Date.UTC(2026, 3, 20, 3, 0, 0), 10, 'publish', 'brief');
    const data = gatherData(db, now, TZ);
    expect(data.gapDays).toBe(2);
  });

  it('falls back to last 48h window when no prior publish exists', () => {
    const db = getDb();
    const now = Date.UTC(2026, 3, 22, 9, 0, 0);
    db.prepare(
      "INSERT INTO chat_messages (message_id, role, content, timestamp) VALUES ('x', 'user', 'hi', ?)",
    ).run(now - 6 * 3600_000);
    const data = gatherData(db, now, TZ);
    expect(data.gapDays).toBe(0);
    expect(data.previousPeriod.chat.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run — expect FAIL (property does not exist)**

- [ ] **Step 3: Update `BriefData` + `gatherData`**

Modify in `morningBrief.helpers.ts`:

```typescript
export interface BriefData {
  reminders: ReminderRow[];
  notes: NoteRow[];
  recentContext: ChatRow[];
  city: string | null;
  gapDays: number;
  previousPeriod: PreviousPeriodBundle;
  previousPeriodFrom: number;
  previousPeriodTo: number;
}
```

In `gatherData`, after `cityRow` block, before `return`:

```typescript
const lastBriefPublishAt = getLastBriefPublishAt(db);
const gapDays = computeGapDays(lastBriefPublishAt, now, tz);
const previousPeriodFrom = lastBriefPublishAt ?? now - 48 * 3600_000;
const previousPeriodTo = todayStart;
const safeFrom = Math.min(previousPeriodFrom, previousPeriodTo);
const previousPeriod = gatherPreviousPeriod(db, safeFrom, previousPeriodTo);

return { reminders, notes, recentContext, city, gapDays, previousPeriod, previousPeriodFrom: safeFrom, previousPeriodTo };
```

- [ ] **Step 4: Run — expect PASS on new tests, but existing tests may break if they asserted exact `BriefData` shape**

Run: `npm -w @r2/server test -- morningBrief.helpers`
Expected: Fix any existing `gatherData` tests that did `toEqual({...})` without the new fields. Adjust to `toMatchObject` OR add the new fields.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/cognition/handlers/morningBrief.helpers.ts packages/server/src/cognition/__tests__/handlers/morningBrief.helpers.test.ts
git commit -m "feat(morning-brief): gatherData emits gapDays + previousPeriod bundle"
```

---

## Task 7: Rewrite `composePrompt` with recap + gap preamble

**Files:**
- Modify: `packages/server/src/cognition/handlers/morningBrief.helpers.ts`
- Test: `packages/server/src/cognition/__tests__/handlers/morningBrief.helpers.test.ts`

- [ ] **Step 1: Write failing tests**

Append:

```typescript
describe('composePrompt with gap and previousPeriod', () => {
  const emptyBundle: PreviousPeriodBundle = {
    chat: [],
    memoryCreated: [],
    memoryUpdated: [],
    memoryForgotten: [],
    audit: [],
    cognition: [],
    remindersOverdue: [],
    remindersCreated: [],
  };

  it('includes gap preamble when gapDays > 0', () => {
    const p = composePrompt(
      {
        reminders: [],
        notes: [],
        recentContext: [],
        city: 'Kyiv',
        gapDays: 3,
        previousPeriod: emptyBundle,
        previousPeriodFrom: 1_700_000_000_000,
        previousPeriodTo: 1_700_259_200_000,
      },
      TZ,
    );
    expect(p).toContain('Gap: 3');
    expect(p).toContain('"Пока меня не было');
  });

  it('omits gap preamble when gapDays = 0 and asks about висящее со вчера', () => {
    const p = composePrompt(
      {
        reminders: [],
        notes: [],
        recentContext: [],
        city: 'Kyiv',
        gapDays: 0,
        previousPeriod: emptyBundle,
        previousPeriodFrom: 1_700_000_000_000,
        previousPeriodTo: 1_700_086_400_000,
      },
      TZ,
    );
    expect(p).not.toContain('Gap:');
    expect(p).toContain('Что висит со вчера');
  });

  it('includes "Прошлый период" section with rendered bundle content', () => {
    const p = composePrompt(
      {
        reminders: [],
        notes: [],
        recentContext: [],
        city: 'Kyiv',
        gapDays: 1,
        previousPeriod: {
          ...emptyBundle,
          chat: [{ role: 'user', ts: 1_700_000_000_000, content: 'вопрос висит' }],
        },
        previousPeriodFrom: 1_700_000_000_000,
        previousPeriodTo: 1_700_086_400_000,
      },
      TZ,
    );
    expect(p).toContain('## Прошлый период');
    expect(p).toContain('вопрос висит');
  });

  it('instructs the LLM to analyze (висит / повторяется / упустил), not retell', () => {
    const p = composePrompt(
      {
        reminders: [],
        notes: [],
        recentContext: [],
        city: 'Kyiv',
        gapDays: 0,
        previousPeriod: emptyBundle,
        previousPeriodFrom: 1,
        previousPeriodTo: 2,
      },
      TZ,
    );
    expect(p).toContain('что висит');
    expect(p).toContain('что повторяется');
    expect(p).toContain('что упустил');
    expect(p).toContain('Не пересказывай');
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Rewrite `composePrompt`**

Replace entire body of `composePrompt` in `morningBrief.helpers.ts` with:

```typescript
export function composePrompt(data: BriefData, tz: string): string {
  const cityLine = data.city
    ? `Город пользователя: ${data.city}.`
    : 'Город пользователя: не задан — погоду искать не нужно, напиши "город не задан".';

  const gapPreamble =
    data.gapDays > 0
      ? [
          `⚠️ Gap: ${data.gapDays} дней — начни ответ с "Пока меня не было ${data.gapDays} дней, вот что было".`,
          '',
        ].join('\n')
      : '';

  const periodHeader = `## Прошлый период (${formatLocal(data.previousPeriodFrom, tz)} — ${formatLocal(data.previousPeriodTo, tz)})`;
  const periodBody = renderPreviousPeriod(data.previousPeriod, tz);

  const todaySection = [
    section(
      'Reminders на сегодня/завтра',
      data.reminders.map((r) => `- ${formatLocal(r.nextFireAt, tz)}: ${r.text}`),
    ),
    '',
    section(
      'Открытые заметки',
      data.notes.map((n) => `- ${n.key}: ${n.value}`),
    ),
    '',
    section(
      'Recent context (48h)',
      data.recentContext.map(
        (c) => `- [${formatLocal(c.ts, tz)}] ${c.role}: ${c.content}`,
      ),
    ),
  ].join('\n');

  const todayGuide =
    data.gapDays > 0
      ? '1. "Пока меня не было N дней..." — 2-4 строки выжимка периода\n2. Что висит — 1-5 пунктов, если нет — "висящего нет"\n3. Сегодня — 3-5 bullets: конкретно, не дневник'
      : '1. Что висит со вчера — 1-4 пункта, если нет — "вчера закрыто чисто"\n2. Сегодня — 3-5 bullets';

  return [
    `Собери утренний brief для dim (русский язык). Время — ${tz}. ${cityLine}`,
    '',
    gapPreamble,
    periodHeader,
    periodBody,
    '',
    '## Сегодня / завтра',
    todaySection,
    '',
    'Проанализируй прошлый период с разных углов. Найди:',
    '- что висит (вопросы без ответа, задачи без закрытия, overdue reminders)',
    '- что повторяется (одинаковые темы в чате, застрявшие решения)',
    '- что упустил (важное упомянуто мельком и пропало)',
    '',
    'Формат:',
    todayGuide,
    '',
    'Не пересказывай raw данные дословно — делай выводы. Предлагай конкретные действия где возможно.',
  ].join('\n');
}
```

- [ ] **Step 4: Run — expect PASS on new tests, existing `composePrompt` tests will likely break**

Run: `npm -w @r2/server test -- morningBrief.helpers`
Expected: existing tests asserting exact prompt wording need relaxing. Update them to check for presence of key substrings (use `toContain`, not `toBe`).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/cognition/handlers/morningBrief.helpers.ts packages/server/src/cognition/__tests__/handlers/morningBrief.helpers.test.ts
git commit -m "feat(morning-brief): rewrite composePrompt with recap + gap preamble"
```

---

## Task 8: Add gap-return trigger branch

**Files:**
- Modify: `packages/server/src/cognition/handlers/morningBrief.ts`
- Test: `packages/server/src/cognition/__tests__/handlers/morningBrief.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `morningBrief.test.ts` in the `describe('trigger', ...)` block:

```typescript
it('gap-return: fires at 15:00 when gapDays >= 2 and user active in last hour', async () => {
  const h = createMorningBriefHandler({
    piiProxy: fakeProxy(),
    anthropic: fakeAnthropic('ok') as any,
  });
  const now = Date.UTC(2026, 3, 22, 12, 0, 0); // 15:00 Kyiv 22nd
  // Simulate last brief 3 days ago
  getDb()
    .prepare(
      'INSERT INTO cognition_handler_runs (handler_name, fired_at, duration_ms, outcome) VALUES (?, ?, ?, ?)',
    )
    .run('morningBrief', Date.UTC(2026, 3, 19, 3, 0, 0), 10, 'publish');
  // Recent user activity (20 min ago)
  getDb()
    .prepare(
      "INSERT INTO chat_messages (message_id, role, content, timestamp) VALUES ('a', 'user', 'hi', ?)",
    )
    .run(now - 20 * 60_000);
  const res = await h.trigger({ now, lastFiredAt: null, lastResult: null }, { db: getDb() });
  expect(res).toBe(true);
});

it('gap-return: does not fire when user was not active in last hour', async () => {
  const h = createMorningBriefHandler({
    piiProxy: fakeProxy(),
    anthropic: fakeAnthropic('ok') as any,
  });
  const now = Date.UTC(2026, 3, 22, 12, 0, 0);
  getDb()
    .prepare(
      'INSERT INTO cognition_handler_runs (handler_name, fired_at, duration_ms, outcome) VALUES (?, ?, ?, ?)',
    )
    .run('morningBrief', Date.UTC(2026, 3, 19, 3, 0, 0), 10, 'publish');
  // Activity 3 hours ago — stale
  getDb()
    .prepare(
      "INSERT INTO chat_messages (message_id, role, content, timestamp) VALUES ('a', 'user', 'hi', ?)",
    )
    .run(now - 3 * 3600_000);
  const res = await h.trigger({ now, lastFiredAt: null, lastResult: null }, { db: getDb() });
  expect(res).toBe(false);
});

it('gap-return: publishedToday still blocks even after gap-return fires once', async () => {
  const h = createMorningBriefHandler({
    piiProxy: fakeProxy(),
    anthropic: fakeAnthropic('ok') as any,
  });
  const now = Date.UTC(2026, 3, 22, 18, 0, 0); // 21:00 Kyiv
  // Published earlier today via gap-return (15:00 same local day)
  const earlierToday = Date.UTC(2026, 3, 22, 12, 0, 0);
  getDb()
    .prepare(
      'INSERT INTO cognition_handler_runs (handler_name, fired_at, duration_ms, outcome) VALUES (?, ?, ?, ?)',
    )
    .run('morningBrief', earlierToday, 10, 'publish');
  getDb()
    .prepare(
      "INSERT INTO chat_messages (message_id, role, content, timestamp) VALUES ('a', 'user', 'hi', ?)",
    )
    .run(now - 10 * 60_000);
  const res = await h.trigger(
    { now, lastFiredAt: earlierToday, lastResult: { publish: true, content: 'already' } },
    { db: getDb() },
  );
  expect(res).toBe(false);
});

it('gap-return: does not fire when gapDays is 1 (only)', async () => {
  const h = createMorningBriefHandler({
    piiProxy: fakeProxy(),
    anthropic: fakeAnthropic('ok') as any,
  });
  const now = Date.UTC(2026, 3, 22, 12, 0, 0); // 15:00 Kyiv 22nd
  getDb()
    .prepare(
      'INSERT INTO cognition_handler_runs (handler_name, fired_at, duration_ms, outcome) VALUES (?, ?, ?, ?)',
    )
    .run('morningBrief', Date.UTC(2026, 3, 21, 3, 0, 0), 10, 'publish'); // 1 day ago
  getDb()
    .prepare(
      "INSERT INTO chat_messages (message_id, role, content, timestamp) VALUES ('a', 'user', 'hi', ?)",
    )
    .run(now - 10 * 60_000);
  const res = await h.trigger({ now, lastFiredAt: null, lastResult: null }, { db: getDb() });
  // No 06:00 window trigger either (because now is 15:00 but lastResult is null so activitySince06AM is decisive)
  // Activity is 10 min ago (>> 06:00 local). Should fire via 06:00 branch → true.
  // This test confirms that gap-return alone (gapDays=1) does NOT fire, but normal branch can.
  expect(res).toBe(true); // Fired by 06:00 branch, not gap-return
});
```

- [ ] **Step 2: Run — expect FAIL on the new tests (no gap-return logic yet)**

- [ ] **Step 3: Update `morningBrief.ts` trigger**

Replace the `trigger` function in `morningBrief.ts`:

```typescript
import {
  composePrompt,
  gatherData,
  hasUserActivitySince,
  hasUserActivityInLastHour,
  isSameLocalDate,
  getLocalCivilEpoch,
  getLastBriefPublishAt,
  computeGapDays,
} from './morningBrief.helpers.js';

// ...
    async trigger(state, ctx) {
      // Guard: already published today → never re-fire same local day.
      const publishedToday =
        state.lastResult !== null &&
        'publish' in state.lastResult &&
        state.lastResult.publish === true &&
        state.lastFiredAt !== null &&
        isSameLocalDate(state.lastFiredAt, state.now, TZ);
      if (publishedToday) return false;

      // Branch A — morning window (>= 06:00 local + activity since 06:00).
      const sixAmLocal = getLocalCivilEpoch(state.now, TZ, 0, ACTIVITY_START_HOUR);
      if (state.now >= sixAmLocal && hasUserActivitySince(ctx.db, sixAmLocal)) {
        return true;
      }

      // Branch B — gap-return (>= 2 days since last publish + activity within last hour).
      const lastPublishAt = getLastBriefPublishAt(ctx.db);
      const gapDays = computeGapDays(lastPublishAt, state.now, TZ);
      if (gapDays >= 2 && hasUserActivityInLastHour(ctx.db, state.now)) {
        return true;
      }

      return false;
    },
```

- [ ] **Step 4: Run — expect PASS on all trigger tests**

Run: `npm -w @r2/server test -- morningBrief`

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/cognition/handlers/morningBrief.ts packages/server/src/cognition/__tests__/handlers/morningBrief.test.ts
git commit -m "feat(morning-brief): add gap-return trigger branch"
```

---

## Task 9: Integration checks

**Files:** none (verification only)

- [ ] **Step 1: Full server typecheck**

Run: `npx tsc --noEmit -p packages/server/tsconfig.json`
Expected: 0 new errors. If `tool-code-deploy` / `tool-eval-run` have pre-existing test-file errors (see prior plan notes), those are not part of this change — confirm unchanged.

- [ ] **Step 2: Full server test suite**

Run: `npm -w @r2/server test`
Expected: all files green. If unrelated tests fail, investigate — your changes to `BriefData`/`composePrompt` may have broken tests that relied on exact shape. Relax assertions (`toMatchObject` / `toContain`) instead of rewriting logic.

- [ ] **Step 3: Full monorepo test**

Run: `npm test`
Expected: 100% pass.

- [ ] **Step 4: Commit if any test fixes made**

```bash
git add -A
git commit -m "test(morning-brief): relax assertions broken by BriefData extension"
```

(Skip this step if no fixes were needed.)

---

## Task 10: [Final] Documentation touch-up

**Files:**
- Modify: `AGENTS.md` (if it mentions morningBrief)

- [ ] **Step 1: Check AGENTS.md for morningBrief mentions**

Run: `grep -n 'morningBrief\|morning brief' AGENTS.md || echo "no mentions"`

- [ ] **Step 2: If mentions exist, append recap + gap note**

Add one bullet under the morningBrief section:

> - Расширен `previousPeriod` bundle и gap-return trigger: при gap ≥ 2 дней и активности в последний час brief публикуется вне утреннего окна и начинается с "Пока меня не было N дней".

Skip this step if AGENTS.md does not mention morningBrief.

- [ ] **Step 3: Commit if modified**

```bash
git add AGENTS.md
git commit -m "docs(agents): note morningBrief recap + gap-return"
```

---

## Post-Completion

**Manual verification:**

1. Run server locally (`npm -w @r2/server dev` or supervisor).
2. Simulate a gap: in dev DB delete `cognition_handler_runs` rows with `handler_name='morningBrief' AND outcome='publish'` (or set `fired_at` back 3 days).
3. Send a Discord message to R2 now.
4. Within ~60s (next heartbeat tick), R2 should reply with brief starting "Пока меня не было 3 дней...".
5. Re-send another message — brief must NOT fire again (publishedToday lock).
6. Next morning at ≥06:00, after first activity, normal brief should publish (no gap preamble).

**External system updates:** none.

**Deployment:** per standard deploy-flow: sync `dev ← master`, then `feature/morning-brief-recap → dev → master`. Supervisor auto-restart picks up the new handler wiring (no code change in `index.ts` — handler is already registered via `createMorningBriefHandler`).

## Self-Review Notes

- All spec sections covered: Gap detection (Task 1-2, 8), Trigger (Task 8), Bundle (Task 4-5), Prompt (Task 7), Edge cases (first run empty = Task 6; bundle oversize = Task 5; publishedToday lock = Task 8; gap ≥ 14 days fallback is same truncation path as Task 5).
- No placeholders — every step has exact code, command, or decision.
- Type consistency: `BriefData` extended in Task 6 with `gapDays`/`previousPeriod`/`previousPeriodFrom`/`previousPeriodTo`, used identically in Task 7 (`composePrompt`) and elsewhere.
- "reminders firing history" limitation from spec — acknowledged only, no task (out of scope).
