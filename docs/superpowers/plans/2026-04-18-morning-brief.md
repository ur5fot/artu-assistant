# Morning Brief Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Реализовать `morningBrief` — первый «настоящий» cognition handler: утренняя сводка, фаерится при первом сообщении юзера за день (>06:00 Europe/Kyiv), LLM собирает brief из reminders + memory + recent chat, отправляет в Discord DM.

**Architecture:** Handler factory `createMorningBriefHandler({ piiProxy, anthropic })` — DI через замыкание. Trigger сигнатура расширяется до `(state, ctx)` (ctx = `{ db }`), чтобы триггер мог читать БД. Внутри `run`: pure `gatherData(db)` → pure `composePrompt(data)` → Anthropic one-shot через PII-proxy → `{ publish: true, content }`. Фича встраивается в существующий pipeline (queue → `cognition_publish` → `bot.ts` DM) без изменений нижележащих компонент.

**Tech Stack:** TypeScript, better-sqlite3, @anthropic-ai/sdk, vitest, existing `packages/server/src/cognition/*` и `packages/server/src/pii/proxy.ts`.

---

## File Structure

**New files:**
- `packages/server/src/cognition/handlers/morningBrief.helpers.ts` — чистые функции: `getTodayBoundaryLocal`, `isSameLocalDate`, `hasUserActivityToday`, `gatherData`, `composePrompt`.
- `packages/server/src/cognition/handlers/morningBrief.ai.ts` — `callMorningBriefAI({ piiProxy, anthropic, prompt, signal })` — Anthropic one-shot + PII anonymize/deanonymize.
- `packages/server/src/cognition/handlers/morningBrief.ts` — фабрика `createMorningBriefHandler(deps)` возвращает `Handler`.
- `packages/server/src/cognition/__tests__/handlers/morningBrief.helpers.test.ts`
- `packages/server/src/cognition/__tests__/handlers/morningBrief.ai.test.ts`
- `packages/server/src/cognition/__tests__/handlers/morningBrief.test.ts`

**Modified files:**
- `packages/server/src/cognition/types.ts` — расширяем `Handler.trigger` до `(state, ctx) => boolean | Promise<boolean>`; добавляем тип `TriggerContext = { db: Database.Database }`.
- `packages/server/src/cognition/dispatcher.ts` — принимает `db` в deps, создаёт `ctx` и `await`-ит триггер.
- `packages/server/src/cognition/service.ts` — пробрасывает `db` в dispatcher.
- `packages/server/src/cognition/__tests__/dispatcher.test.ts` — fixture-ы передают `db`, ожидают await на trigger.
- `packages/server/src/cognition/handlers/pulse.ts` — trigger принимает второй аргумент (игнорирует).
- `packages/server/src/cognition/__tests__/handlers/pulse.test.ts` — если тесты напрямую вызывают trigger — обновить вызов.
- `packages/server/src/index.ts` — регистрация `createMorningBriefHandler({ piiProxy, anthropic })` рядом с `pulseHandler`.

---

## Task 1: Расширить `Handler.trigger` — принимать ctx, async-aware

**Files:**
- Modify: `packages/server/src/cognition/types.ts`
- Modify: `packages/server/src/cognition/dispatcher.ts`
- Modify: `packages/server/src/cognition/handlers/pulse.ts`
- Modify: `packages/server/src/cognition/service.ts`
- Modify: `packages/server/src/cognition/__tests__/dispatcher.test.ts`

**Why:** `morningBrief.trigger` должен читать `chat_messages` чтобы определить «было ли сообщение сегодня». Текущая сигнатура `trigger(state: HandlerState) => boolean` не даёт доступа к БД. Минимальное расширение: добавить второй аргумент `ctx: TriggerContext` и разрешить `Promise<boolean>`.

- [x] **Step 1: Обновить тест диспетчера — ожидать await на триггер и ctx.db**

В `packages/server/src/cognition/__tests__/dispatcher.test.ts` добавь новый тест сразу после существующих (не удаляя их):

```typescript
it('awaits async triggers and passes db in ctx', async () => {
  const store = createCognitionStore({ db: getDb() });
  const registry = createHandlerRegistry();
  const seen: Array<{ hasState: boolean; hasDb: boolean }> = [];
  registry.register({
    name: 'async-one',
    trigger: async (state, ctx) => {
      seen.push({ hasState: typeof state.now === 'number', hasDb: ctx.db === getDb() });
      return true;
    },
    run: async () => ({ skip: true, reason: '' }),
  });
  const { queue, enqueued } = fakeQueue();
  const d = createDispatcher({ registry, queue, store, db: getDb() });

  await d.runTick(Date.now());

  expect(seen).toEqual([{ hasState: true, hasDb: true }]);
  expect(enqueued).toEqual(['async-one']);
});
```

- [x] **Step 2: Запустить тесты — ожидать FAIL (сигнатура не позволяет, db не в deps)**

```bash
npx vitest run --root packages/server packages/server/src/cognition/__tests__/dispatcher.test.ts
```

Ожидается ошибка TypeScript (`trigger` принимает 1 аргумент; `db` не в Deps) или runtime fail.

- [x] **Step 3: Расширить тип `Handler` и добавить `TriggerContext`**

В `packages/server/src/cognition/types.ts` замени `Handler`:

```typescript
export interface TriggerContext {
  db: Database.Database;
}

export interface Handler {
  name: string;
  trigger: (state: HandlerState, ctx: TriggerContext) => boolean | Promise<boolean>;
  run: (ctx: HandlerContext) => Promise<HandlerResult>;
}
```

(оставь остальные экспорты без изменений; импорт `Database` уже есть).

- [x] **Step 4: Обновить dispatcher — добавить `db` в Deps, передавать ctx, await триггер**

Замени содержимое `packages/server/src/cognition/dispatcher.ts`:

```typescript
import type Database from 'better-sqlite3';
import type { CognitionStore } from './store.js';
import type { HandlerRegistry } from './registry.js';
import type { JobQueue } from './queue.js';
import type { HandlerState, TriggerContext } from './types.js';

export interface Dispatcher {
  runTick(now: number): Promise<void>;
}

interface Deps {
  registry: HandlerRegistry;
  queue: JobQueue;
  store: CognitionStore;
  db: Database.Database;
}

export function createDispatcher(deps: Deps): Dispatcher {
  const { registry, queue, store, db } = deps;
  const ctx: TriggerContext = { db };
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
          triggered = await handler.trigger(state, ctx);
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

- [x] **Step 5: Пробросить `db` в dispatcher из service.ts**

В `packages/server/src/cognition/service.ts` найди строку `const dispatcher = createDispatcher({ registry, queue, store });` и замени:

```typescript
const dispatcher = createDispatcher({ registry, queue, store, db: deps.db });
```

- [x] **Step 6: Обновить pulse handler — принимать второй аргумент**

В `packages/server/src/cognition/handlers/pulse.ts` замени объявление trigger:

```typescript
trigger: (state, _ctx) => {
  if (state.lastFiredAt === null) return true;
  return state.now - state.lastFiredAt >= FIVE_MINUTES;
},
```

(TypeScript требует соответствия сигнатуре. `_ctx` с underscore — unused arg).

- [x] **Step 7: Обновить существующие тесты dispatcher — fixtures передают `db`**

В `packages/server/src/cognition/__tests__/dispatcher.test.ts` найди ВСЕ вхождения `createDispatcher({ registry, queue, store })` и замени на `createDispatcher({ registry, queue, store, db: getDb() })`. Обычно это происходит в 2-3 местах внутри `describe('Dispatcher')`.

Если какой-то тест вызывает `handler.trigger(state)` напрямую — обнови до `handler.trigger(state, { db: getDb() })`.

- [x] **Step 8: Проверить — нет ли прямых вызовов trigger в других тестах**

```bash
grep -rn "\.trigger(" packages/server/src --include="*.ts"
```

Если найдёшь вызовы вне dispatcher — обнови с двумя аргументами.

- [x] **Step 9: Запустить тесты — ожидать PASS**

```bash
npx vitest run --root packages/server packages/server/src/cognition
```

Все cognition-тесты должны пройти (pulse, dispatcher, store, queue, heartbeat, registry, service, handlers/pulse).

- [x] **Step 10: Typecheck**

```bash
npx tsc --noEmit -p packages/server
```

Ожидается: exit 0.

- [x] **Step 11: Commit**

```bash
git add packages/server/src/cognition/types.ts packages/server/src/cognition/dispatcher.ts packages/server/src/cognition/service.ts packages/server/src/cognition/handlers/pulse.ts packages/server/src/cognition/__tests__/dispatcher.test.ts
git commit -m "refactor(cognition): trigger receives ctx and may be async"
```

---

## Task 2: Date/timezone helpers + `hasUserActivityToday`

**Files:**
- Create: `packages/server/src/cognition/handlers/morningBrief.helpers.ts`
- Create: `packages/server/src/cognition/__tests__/handlers/morningBrief.helpers.test.ts`

**Why:** Триггер Morning brief завязан на local date (Europe/Kyiv) и наличие сообщения юзера с начала дня. Чистые функции, хорошо покрываемые тестами, без зависимости от LLM.

- [ ] **Step 1: Создать файл с failing тестами для helpers**

В `packages/server/src/cognition/__tests__/handlers/morningBrief.helpers.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, getDb } from '../../../db.js';
import {
  getTodayStartLocal,
  isSameLocalDate,
  hasUserActivityToday,
} from '../../handlers/morningBrief.helpers.js';

const TZ = 'Europe/Kyiv';

beforeEach(() => initDb(':memory:'));

describe('getTodayStartLocal', () => {
  it('returns midnight of same local date as `now`', () => {
    // 2026-04-18 14:30:00 UTC = 17:30 Kyiv (UTC+3 summer)
    const now = Date.UTC(2026, 3, 18, 14, 30, 0);
    const startLocal = getTodayStartLocal(now, TZ);
    // 2026-04-18 00:00 Kyiv = 2026-04-17 21:00 UTC
    expect(new Date(startLocal).toISOString()).toBe('2026-04-17T21:00:00.000Z');
  });

  it('handles pre-midnight UTC correctly (Kyiv ahead of UTC)', () => {
    // 2026-04-18 23:30 UTC = 2026-04-19 02:30 Kyiv
    const now = Date.UTC(2026, 3, 18, 23, 30, 0);
    const startLocal = getTodayStartLocal(now, TZ);
    // start of 2026-04-19 in Kyiv = 2026-04-18 21:00 UTC
    expect(new Date(startLocal).toISOString()).toBe('2026-04-18T21:00:00.000Z');
  });
});

describe('isSameLocalDate', () => {
  it('returns true for two timestamps on same local date', () => {
    const a = Date.UTC(2026, 3, 18, 4, 0, 0); // 07:00 Kyiv 18th
    const b = Date.UTC(2026, 3, 18, 20, 0, 0); // 23:00 Kyiv 18th
    expect(isSameLocalDate(a, b, TZ)).toBe(true);
  });

  it('returns false across local midnight even if within 24h', () => {
    const a = Date.UTC(2026, 3, 18, 20, 0, 0); // 23:00 Kyiv 18th
    const b = Date.UTC(2026, 3, 18, 22, 30, 0); // 01:30 Kyiv 19th
    expect(isSameLocalDate(a, b, TZ)).toBe(false);
  });
});

describe('hasUserActivityToday', () => {
  it('returns false when chat_messages has no rows since today_start', () => {
    const now = Date.UTC(2026, 3, 18, 6, 0, 0); // 09:00 Kyiv 18th
    expect(hasUserActivityToday(getDb(), now, TZ)).toBe(false);
  });

  it('returns true when at least one user message exists after today_start', () => {
    const now = Date.UTC(2026, 3, 18, 6, 0, 0);
    // insert a message at 07:00 Kyiv 18th = 04:00 UTC 18th
    const ts = Date.UTC(2026, 3, 18, 4, 0, 0);
    getDb()
      .prepare(
        "INSERT INTO chat_messages (message_id, role, content, timestamp) VALUES (?, 'user', 'hi', ?)",
      )
      .run(`m-${ts}`, ts);
    expect(hasUserActivityToday(getDb(), now, TZ)).toBe(true);
  });

  it('ignores messages from previous local day', () => {
    const now = Date.UTC(2026, 3, 18, 6, 0, 0);
    // insert message at 23:00 Kyiv 17th = 20:00 UTC 17th
    const ts = Date.UTC(2026, 3, 17, 20, 0, 0);
    getDb()
      .prepare(
        "INSERT INTO chat_messages (message_id, role, content, timestamp) VALUES (?, 'user', 'hi', ?)",
      )
      .run(`m-${ts}`, ts);
    expect(hasUserActivityToday(getDb(), now, TZ)).toBe(false);
  });

  it('ignores assistant messages (only user role counts)', () => {
    const now = Date.UTC(2026, 3, 18, 6, 0, 0);
    const ts = Date.UTC(2026, 3, 18, 4, 0, 0);
    getDb()
      .prepare(
        "INSERT INTO chat_messages (message_id, role, content, timestamp) VALUES (?, 'assistant', 'hi', ?)",
      )
      .run(`m-${ts}`, ts);
    expect(hasUserActivityToday(getDb(), now, TZ)).toBe(false);
  });
});
```

- [ ] **Step 2: Подтвердить схему `chat_messages`**

```bash
grep -A 12 "CREATE TABLE IF NOT EXISTS chat_messages" packages/server/src/db.ts
```

Ожидаемые колонки (2026-04-18): `message_id TEXT UNIQUE`, `role TEXT`, `content TEXT`, `timestamp INTEGER NOT NULL` (это ms-время сообщения, используем его — **не** `created_at`, который TEXT/datetime). Если схема уже ушла вперёд — адаптируй тесты и helper. Не выдумывай поля.

- [ ] **Step 3: Запустить тесты — ожидать FAIL (файла helpers нет)**

```bash
npx vitest run --root packages/server packages/server/src/cognition/__tests__/handlers/morningBrief.helpers.test.ts
```

Ожидается: ошибка импорта `Cannot find module`.

- [ ] **Step 4: Реализовать helpers (минимальный набор для Task 2)**

В `packages/server/src/cognition/handlers/morningBrief.helpers.ts`:

```typescript
import type Database from 'better-sqlite3';

export function getTodayStartLocal(now: number, tz: string): number {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date(now));
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  const y = Number(get('year'));
  const m = Number(get('month'));
  const d = Number(get('day'));
  // Midnight-local expressed as epoch ms:
  // take the current `now`, subtract (hh:mm:ss) seen in tz.
  const hh = Number(get('hour'));
  const mm = Number(get('minute'));
  const ss = Number(get('second'));
  return now - hh * 3600_000 - mm * 60_000 - ss * 1000 - ((now % 1000));
}

export function isSameLocalDate(a: number, b: number, tz: string): boolean {
  return localDateKey(a, tz) === localDateKey(b, tz);
}

function localDateKey(ts: number, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ts)); // en-CA → "YYYY-MM-DD"
}

export function hasUserActivityToday(db: Database.Database, now: number, tz: string): boolean {
  const todayStart = getTodayStartLocal(now, tz);
  const row = db
    .prepare(
      "SELECT 1 FROM chat_messages WHERE role = 'user' AND timestamp >= ? LIMIT 1",
    )
    .get(todayStart);
  return row !== undefined;
}
```

Внимание: если при step 2 проверил что имя роли в `chat_messages` отличается (напр., нет `role` колонки) — адаптируй запрос. Не выдумывай поля.

- [ ] **Step 5: Запустить тесты — ожидать PASS**

```bash
npx vitest run --root packages/server packages/server/src/cognition/__tests__/handlers/morningBrief.helpers.test.ts
```

Все 6+ assertions должны пройти. Если `getTodayStartLocal` первый тест зелёный но второй (pre-midnight UTC) красный — вероятно нужно перестроить логику:
- Альтернатива: вычислить Y-M-D в tz, затем `Date.UTC(Y,M-1,D)` — это не точно (игнорирует DST offset). Способ через "now - local hh/mm/ss" корректнее.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/cognition/handlers/morningBrief.helpers.ts packages/server/src/cognition/__tests__/handlers/morningBrief.helpers.test.ts
git commit -m "feat(cognition): morning brief helpers — date/tz + hasUserActivityToday"
```

---

## Task 3: `gatherData` — собирает reminders + notes + recent chat

**Files:**
- Modify: `packages/server/src/cognition/handlers/morningBrief.helpers.ts` (добавить `gatherData` + types)
- Modify: `packages/server/src/cognition/__tests__/handlers/morningBrief.helpers.test.ts` (добавить тесты)

**Why:** Handler нужно readonly-собрать данные из трёх таблиц — на основе существующих схем (`reminders.next_fire_at_ms`, `memory_facts.last_mentioned_at`, `chat_messages.created_at`). Чистая функция, легко покрывается snapshot-тестом.

- [ ] **Step 1: Добавить failing тесты для `gatherData`**

В `packages/server/src/cognition/__tests__/handlers/morningBrief.helpers.test.ts` добавь `gatherData` в существующий import из `../../handlers/morningBrief.helpers.js` (рядом с `getTodayStartLocal`, `isSameLocalDate`, `hasUserActivityToday`). Затем в конец файла дописать новый describe:

```typescript
describe('gatherData', () => {
  const TZ = 'Europe/Kyiv';
  const now = Date.UTC(2026, 3, 18, 6, 0, 0); // 09:00 Kyiv 18th

  it('returns reminders active=1 with next_fire_at_ms in today+tomorrow window', () => {
    const todayStart = Date.UTC(2026, 3, 17, 21, 0, 0); // 00:00 Kyiv 18th
    const tomorrowEnd = Date.UTC(2026, 3, 19, 21, 0, 0); // 00:00 Kyiv 20th

    const db = getDb();
    const insert = db.prepare(
      "INSERT INTO reminders (text, schedule_json, next_fire_at_ms, active) VALUES (?, '{}', ?, ?)",
    );
    insert.run('in-window today', todayStart + 5 * 3600_000, 1); // 05:00 Kyiv today
    insert.run('in-window tomorrow', tomorrowEnd - 2 * 3600_000, 1); // 22:00 Kyiv tomorrow
    insert.run('past', todayStart - 3600_000, 1); // yesterday 23:00
    insert.run('too far', tomorrowEnd + 3600_000, 1); // day after
    insert.run('disabled in-window', todayStart + 4 * 3600_000, 0);

    const data = gatherData(db, now, TZ);
    expect(data.reminders.map((r) => r.text).sort()).toEqual(['in-window today', 'in-window tomorrow']);
  });

  it('returns active memory_facts with last_mentioned_at within 14d', () => {
    const db = getDb();
    const insert = db.prepare(
      'INSERT INTO memory_facts (key, value, created_at, last_mentioned_at, superseded_by) VALUES (?, ?, ?, ?, ?)',
    );
    insert.run('user.activity', 'велосипед', now - 10 * 86400_000, now - 2 * 86400_000, null);
    insert.run('user.age', '42', now - 30 * 86400_000, now - 30 * 86400_000, null); // stale
    insert.run('user.note.x', 'нужно на работу', now, now, null);
    // superseded fact should be excluded
    const oldRes = insert.run('user.old', 'old', now, now, null);
    const newerRes = insert.run('user.newer', 'newer', now, now, null);
    db.prepare('UPDATE memory_facts SET superseded_by = ? WHERE id = ?')
      .run(newerRes.lastInsertRowid, oldRes.lastInsertRowid);

    const data = gatherData(db, now, TZ);
    const keys = data.notes.map((n) => n.key).sort();
    expect(keys).toContain('user.activity');
    expect(keys).toContain('user.note.x');
    expect(keys).toContain('user.newer'); // the newer one stays (not superseded)
    expect(keys).not.toContain('user.age');
    expect(keys).not.toContain('user.old');
  });

  it('returns recent chat messages last 48h, max 30, content truncated to 500', () => {
    const db = getDb();
    const insert = db.prepare(
      "INSERT INTO chat_messages (message_id, role, content, timestamp) VALUES (?, 'user', ?, ?)",
    );
    for (let i = 0; i < 40; i += 1) {
      insert.run(`m-${i}`, `msg ${i}`, now - i * 3600_000);
    }
    const longTs = now - 3600_000;
    insert.run('long-msg', 'x'.repeat(1000), longTs);

    const data = gatherData(db, now, TZ);
    expect(data.recentContext.length).toBeLessThanOrEqual(30);
    // All within 48h window
    for (const m of data.recentContext) {
      expect(m.ts).toBeGreaterThanOrEqual(now - 48 * 3600_000);
    }
    const longM = data.recentContext.find((m) => m.content.startsWith('xxxx'));
    expect(longM?.content.length).toBe(500);
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL (`gatherData` not exported)**

```bash
npx vitest run --root packages/server packages/server/src/cognition/__tests__/handlers/morningBrief.helpers.test.ts
```

- [ ] **Step 3: Реализовать `gatherData` и types**

В `packages/server/src/cognition/handlers/morningBrief.helpers.ts` добавить:

```typescript
export interface ReminderRow { text: string; nextFireAt: number; }
export interface NoteRow { key: string; value: string; lastMentionedAt: number; }
export interface ChatRow { role: string; content: string; ts: number; }

export interface BriefData {
  reminders: ReminderRow[];
  notes: NoteRow[];
  recentContext: ChatRow[];
}

const NOTE_FRESHNESS_MS = 14 * 86400_000;
const RECENT_CONTEXT_HOURS = 48;
const RECENT_CONTEXT_MAX_ROWS = 30;
const CONTENT_TRUNCATE_CHARS = 500;

export function gatherData(db: Database.Database, now: number, tz: string): BriefData {
  const todayStart = getTodayStartLocal(now, tz);
  const tomorrowEnd = todayStart + 2 * 86400_000; // end of tomorrow = start of day-after

  const reminders = db
    .prepare(
      'SELECT text, next_fire_at_ms AS nextFireAt FROM reminders WHERE active = 1 AND next_fire_at_ms >= ? AND next_fire_at_ms <= ? ORDER BY next_fire_at_ms',
    )
    .all(todayStart, tomorrowEnd) as ReminderRow[];

  const notes = db
    .prepare(
      'SELECT key, value, last_mentioned_at AS lastMentionedAt FROM memory_facts WHERE superseded_by IS NULL AND last_mentioned_at >= ? ORDER BY last_mentioned_at DESC',
    )
    .all(now - NOTE_FRESHNESS_MS) as NoteRow[];

  const rawChat = db
    .prepare(
      'SELECT role, content, timestamp AS ts FROM chat_messages WHERE timestamp >= ? ORDER BY timestamp DESC LIMIT ?',
    )
    .all(now - RECENT_CONTEXT_HOURS * 3600_000, RECENT_CONTEXT_MAX_ROWS) as Array<{
    role: string;
    content: string;
    ts: number;
  }>;

  const recentContext: ChatRow[] = rawChat.map((r) => ({
    role: r.role,
    ts: r.ts,
    content: r.content.length > CONTENT_TRUNCATE_CHARS ? r.content.slice(0, CONTENT_TRUNCATE_CHARS) : r.content,
  }));

  return { reminders, notes, recentContext };
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
npx vitest run --root packages/server packages/server/src/cognition/__tests__/handlers/morningBrief.helpers.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/cognition/handlers/morningBrief.helpers.ts packages/server/src/cognition/__tests__/handlers/morningBrief.helpers.test.ts
git commit -m "feat(cognition): morning brief gatherData — reminders+notes+recent"
```

---

## Task 4: `composePrompt` — чистый шаблон

**Files:**
- Modify: `packages/server/src/cognition/handlers/morningBrief.helpers.ts` (добавить `composePrompt`)
- Modify: `packages/server/src/cognition/__tests__/handlers/morningBrief.helpers.test.ts` (snapshot-тест + empty sections)

**Why:** Prompt должен быть стабильным и отдельно тестируемым, чтобы правки не ломали тон.

- [ ] **Step 1: Failing snapshot-тест для `composePrompt`**

Добавь `composePrompt` в существующий import из `../../handlers/morningBrief.helpers.js` в начале файла. Затем допиши новый describe:

```typescript
describe('composePrompt', () => {
  it('formats all sections when data present', () => {
    const prompt = composePrompt({
      reminders: [
        { text: 'позвонить Иванову', nextFireAt: Date.UTC(2026, 3, 18, 11, 0, 0) },
      ],
      notes: [
        { key: 'user.note.x', value: 'нужно на работу 8:00', lastMentionedAt: Date.UTC(2026, 3, 17) },
      ],
      recentContext: [
        { role: 'user', content: 'сегодня дождь?', ts: Date.UTC(2026, 3, 18, 4, 0, 0) },
      ],
    });
    expect(prompt).toContain('## Reminders на сегодня/завтра');
    expect(prompt).toContain('позвонить Иванову');
    expect(prompt).toContain('## Открытые заметки');
    expect(prompt).toContain('user.note.x');
    expect(prompt).toContain('## Recent context');
    expect(prompt).toContain('сегодня дождь?');
    expect(prompt).toContain('5-8 bullet points');
  });

  it('shows "нет" for empty sections', () => {
    const prompt = composePrompt({ reminders: [], notes: [], recentContext: [] });
    expect(prompt).toMatch(/## Reminders на сегодня\/завтра\s+нет/);
    expect(prompt).toMatch(/## Открытые заметки\s+нет/);
    expect(prompt).toMatch(/## Recent context\s+нет/);
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
npx vitest run --root packages/server packages/server/src/cognition/__tests__/handlers/morningBrief.helpers.test.ts
```

- [ ] **Step 3: Реализовать `composePrompt`**

Добавь в конец `morningBrief.helpers.ts`:

```typescript
function formatReminder(r: ReminderRow): string {
  const t = new Date(r.nextFireAt).toISOString();
  return `- ${t}: ${r.text}`;
}

function formatNote(n: NoteRow): string {
  return `- ${n.key}: ${n.value}`;
}

function formatChat(c: ChatRow): string {
  const t = new Date(c.ts).toISOString();
  return `- [${t}] ${c.role}: ${c.content}`;
}

function section(title: string, rows: string[]): string {
  const body = rows.length > 0 ? rows.join('\n') : 'нет';
  return `## ${title}\n${body}`;
}

export function composePrompt(data: BriefData): string {
  return [
    'Собери утренний brief для dim (русский язык).',
    '',
    section('Reminders на сегодня/завтра', data.reminders.map(formatReminder)),
    '',
    section('Открытые заметки', data.notes.map(formatNote)),
    '',
    section('Recent context', data.recentContext.map(formatChat)),
    '',
    'Формат: 5-8 bullet points. Включи: (1) что конкретно на сегодня, (2) открытые темы которые висят, (3) конкретные предложения действий. Коротко. Не повторяй данные дословно — анализируй.',
  ].join('\n');
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
npx vitest run --root packages/server packages/server/src/cognition/__tests__/handlers/morningBrief.helpers.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/cognition/handlers/morningBrief.helpers.ts packages/server/src/cognition/__tests__/handlers/morningBrief.helpers.test.ts
git commit -m "feat(cognition): morning brief composePrompt"
```

---

## Task 5: AI call wrapper — Anthropic one-shot через PII proxy

**Files:**
- Create: `packages/server/src/cognition/handlers/morningBrief.ai.ts`
- Create: `packages/server/src/cognition/__tests__/handlers/morningBrief.ai.test.ts`

**Why:** Явная обёртка над Anthropic SDK + PII proxy. Прямой `anthropic.messages.create` без tool-loop'а и thinking mode — морфологически проще и дешевле. Изолирован в отдельный файл для моков в handler-тесте.

- [ ] **Step 1: Failing tests для `callMorningBriefAI`**

В `morningBrief.ai.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { callMorningBriefAI } from '../../handlers/morningBrief.ai.js';
import type { PiiProxy } from '../../../pii/proxy.js';

function fakeProxy(): PiiProxy {
  return {
    async anonymize(text) {
      return { text: text.replace('dim', '[TOKEN_USER]'), entities: [] };
    },
    async deanonymize(text) {
      return text.replace('[TOKEN_USER]', 'dim');
    },
  };
}

function fakeAnthropic(responseText: string) {
  return {
    messages: {
      create: vi.fn(async () => ({
        id: 'msg_test',
        content: [{ type: 'text', text: responseText }],
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        stop_reason: 'end_turn',
        stop_sequence: null,
        type: 'message',
        usage: { input_tokens: 10, output_tokens: 5 },
      })),
    },
  };
}

describe('callMorningBriefAI', () => {
  it('anonymizes prompt, calls anthropic, deanonymizes response', async () => {
    const anthropic = fakeAnthropic('Доброе утро, [TOKEN_USER]!');
    const piiProxy = fakeProxy();
    const result = await callMorningBriefAI({
      piiProxy,
      anthropic: anthropic as any,
      prompt: 'Привет dim',
      signal: new AbortController().signal,
    });
    expect(result).toBe('Доброе утро, dim!');
    expect(anthropic.messages.create).toHaveBeenCalledOnce();
    const call = anthropic.messages.create.mock.calls[0][0];
    expect(call.messages[0].content).toContain('[TOKEN_USER]');
    expect(call.messages[0].content).not.toContain('dim');
    expect(call.model).toBe(process.env.CLAUDE_MODEL || 'claude-sonnet-4-6');
  });

  it('returns empty string when response has no text block', async () => {
    const anthropic = {
      messages: {
        create: vi.fn(async () => ({ content: [], role: 'assistant' })),
      },
    };
    const result = await callMorningBriefAI({
      piiProxy: fakeProxy(),
      anthropic: anthropic as any,
      prompt: 'x',
      signal: new AbortController().signal,
    });
    expect(result).toBe('');
  });

  it('passes signal to anthropic.messages.create', async () => {
    const anthropic = fakeAnthropic('ok');
    const controller = new AbortController();
    await callMorningBriefAI({
      piiProxy: fakeProxy(),
      anthropic: anthropic as any,
      prompt: 'x',
      signal: controller.signal,
    });
    const opts = anthropic.messages.create.mock.calls[0][1];
    expect(opts?.signal).toBe(controller.signal);
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
npx vitest run --root packages/server packages/server/src/cognition/__tests__/handlers/morningBrief.ai.test.ts
```

- [ ] **Step 3: Реализовать `callMorningBriefAI`**

В `packages/server/src/cognition/handlers/morningBrief.ai.ts`:

```typescript
import type Anthropic from '@anthropic-ai/sdk';
import type { PiiProxy } from '../../pii/proxy.js';

const SYSTEM_PROMPT = 'Ты — R2, персональный ассистент dim. Язык — русский.';
const MAX_TOKENS = 1024;

interface CallParams {
  piiProxy: PiiProxy;
  anthropic: Anthropic;
  prompt: string;
  signal: AbortSignal;
}

export async function callMorningBriefAI(params: CallParams): Promise<string> {
  const { piiProxy, anthropic, prompt, signal } = params;
  const anonymized = await piiProxy.anonymize(prompt);
  const model = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
  const msg = await anthropic.messages.create(
    {
      model,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: anonymized.text }],
    },
    { signal },
  );
  const textBlock = msg.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') return '';
  return piiProxy.deanonymize(textBlock.text);
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
npx vitest run --root packages/server packages/server/src/cognition/__tests__/handlers/morningBrief.ai.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/cognition/handlers/morningBrief.ai.ts packages/server/src/cognition/__tests__/handlers/morningBrief.ai.test.ts
git commit -m "feat(cognition): morning brief AI wrapper — anthropic+pii"
```

---

## Task 6: Handler factory — `createMorningBriefHandler`

**Files:**
- Create: `packages/server/src/cognition/handlers/morningBrief.ts`
- Create: `packages/server/src/cognition/__tests__/handlers/morningBrief.test.ts`

**Why:** Собираем trigger + run, вкладываем зависимости (piiProxy, anthropic) через замыкание.

- [ ] **Step 1: Failing tests для фабрики**

В `morningBrief.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { initDb, getDb } from '../../../db.js';
import { createMorningBriefHandler } from '../../handlers/morningBrief.js';
import type { PiiProxy } from '../../../pii/proxy.js';

beforeEach(() => initDb(':memory:'));

function fakeProxy(): PiiProxy {
  return {
    async anonymize(text) { return { text, entities: [] }; },
    async deanonymize(text) { return text; },
  };
}

function fakeAnthropic(text: string) {
  return {
    messages: {
      create: vi.fn(async () => ({
        content: [{ type: 'text', text }],
        role: 'assistant',
      })),
    },
  };
}

const TZ = 'Europe/Kyiv';

describe('createMorningBriefHandler', () => {
  it('has name "morningBrief"', () => {
    const h = createMorningBriefHandler({ piiProxy: fakeProxy(), anthropic: fakeAnthropic('ok') as any });
    expect(h.name).toBe('morningBrief');
  });

  describe('trigger', () => {
    it('returns false before 06:00 local', async () => {
      const h = createMorningBriefHandler({ piiProxy: fakeProxy(), anthropic: fakeAnthropic('ok') as any });
      // 2026-04-18 02:00 Kyiv = 2026-04-17 23:00 UTC
      const now = Date.UTC(2026, 3, 17, 23, 0, 0);
      const res = await h.trigger({ now, lastFiredAt: null, lastResult: null }, { db: getDb() });
      expect(res).toBe(false);
    });

    it('returns false when lastFiredAt is on same local date', async () => {
      const h = createMorningBriefHandler({ piiProxy: fakeProxy(), anthropic: fakeAnthropic('ok') as any });
      const now = Date.UTC(2026, 3, 18, 6, 0, 0); // 09:00 Kyiv
      const lastFiredAt = Date.UTC(2026, 3, 18, 4, 0, 0); // 07:00 same day Kyiv
      // seed activity so that the only reason for false is "same local date"
      getDb().prepare(
        "INSERT INTO chat_messages (message_id, role, content, timestamp) VALUES ('a', 'user', 'hi', ?)",
      ).run(now - 3600_000);
      const res = await h.trigger({ now, lastFiredAt, lastResult: null }, { db: getDb() });
      expect(res).toBe(false);
    });

    it('returns false when no user activity today', async () => {
      const h = createMorningBriefHandler({ piiProxy: fakeProxy(), anthropic: fakeAnthropic('ok') as any });
      const now = Date.UTC(2026, 3, 18, 6, 0, 0);
      const res = await h.trigger({ now, lastFiredAt: null, lastResult: null }, { db: getDb() });
      expect(res).toBe(false);
    });

    it('returns true after 06:00 local, new local day, and activity present', async () => {
      const h = createMorningBriefHandler({ piiProxy: fakeProxy(), anthropic: fakeAnthropic('ok') as any });
      const now = Date.UTC(2026, 3, 18, 6, 0, 0); // 09:00 Kyiv 18th
      getDb().prepare(
        "INSERT INTO chat_messages (message_id, role, content, timestamp) VALUES ('a', 'user', 'hi', ?)",
      ).run(Date.UTC(2026, 3, 18, 4, 0, 0)); // 07:00 Kyiv
      const res = await h.trigger({ now, lastFiredAt: null, lastResult: null }, { db: getDb() });
      expect(res).toBe(true);
    });
  });

  describe('run', () => {
    it('returns publish:true with AI response', async () => {
      const anthropic = fakeAnthropic('Доброе утро! ...');
      const h = createMorningBriefHandler({ piiProxy: fakeProxy(), anthropic: anthropic as any });
      const result = await h.run({ db: getDb(), signal: new AbortController().signal });
      expect(result).toEqual({ publish: true, content: 'Доброе утро! ...' });
      expect(anthropic.messages.create).toHaveBeenCalledOnce();
    });

    it('returns skip when AI returns empty text', async () => {
      const anthropic = fakeAnthropic('');
      const h = createMorningBriefHandler({ piiProxy: fakeProxy(), anthropic: anthropic as any });
      const result = await h.run({ db: getDb(), signal: new AbortController().signal });
      expect(result).toEqual({ skip: true, reason: 'empty AI response' });
    });

    it('returns error when anthropic throws', async () => {
      const anthropic = {
        messages: { create: vi.fn(async () => { throw new Error('boom'); }) },
      };
      const h = createMorningBriefHandler({ piiProxy: fakeProxy(), anthropic: anthropic as any });
      const result = await h.run({ db: getDb(), signal: new AbortController().signal });
      expect(result).toEqual({ error: true, message: 'boom' });
    });
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
npx vitest run --root packages/server packages/server/src/cognition/__tests__/handlers/morningBrief.test.ts
```

- [ ] **Step 3: Реализовать фабрику**

В `packages/server/src/cognition/handlers/morningBrief.ts`:

```typescript
import type Anthropic from '@anthropic-ai/sdk';
import type { Handler } from '../types.js';
import type { PiiProxy } from '../../pii/proxy.js';
import {
  composePrompt,
  gatherData,
  hasUserActivityToday,
  isSameLocalDate,
  getTodayStartLocal,
} from './morningBrief.helpers.js';
import { callMorningBriefAI } from './morningBrief.ai.js';

const TZ = 'Europe/Kyiv';
const ACTIVITY_START_HOUR = 6;

interface Deps {
  piiProxy: PiiProxy;
  anthropic: Anthropic;
}

export function createMorningBriefHandler(deps: Deps): Handler {
  const { piiProxy, anthropic } = deps;
  return {
    name: 'morningBrief',
    async trigger(state, ctx) {
      const todayStart = getTodayStartLocal(state.now, TZ);
      const sixAmLocal = todayStart + ACTIVITY_START_HOUR * 3600_000;
      if (state.now < sixAmLocal) return false;
      if (state.lastFiredAt !== null && isSameLocalDate(state.lastFiredAt, state.now, TZ)) {
        return false;
      }
      return hasUserActivityToday(ctx.db, state.now, TZ);
    },
    async run(ctx) {
      try {
        const data = gatherData(ctx.db, Date.now(), TZ);
        const prompt = composePrompt(data);
        const text = await callMorningBriefAI({ piiProxy, anthropic, prompt, signal: ctx.signal });
        if (!text.trim()) return { skip: true, reason: 'empty AI response' };
        return { publish: true, content: text };
      } catch (err) {
        return { error: true, message: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
npx vitest run --root packages/server packages/server/src/cognition/__tests__/handlers/morningBrief.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/cognition/handlers/morningBrief.ts packages/server/src/cognition/__tests__/handlers/morningBrief.test.ts
git commit -m "feat(cognition): morningBrief handler factory"
```

---

## Task 7: Регистрация handler'а в `index.ts`

**Files:**
- Modify: `packages/server/src/index.ts`

**Why:** Handler должен быть зарегистрирован в cognitionService при старте приложения. Требует инстанс Anthropic.

- [ ] **Step 1: Найти существующее создание Anthropic клиента**

```bash
grep -n "new Anthropic\|createClaudeClient" packages/server/src/index.ts
```

Если уже есть — переиспользовать `.anthropic`. Если нет — создаём новый инстанс рядом.

- [ ] **Step 2: Добавить импорт и регистрацию**

Найди в `packages/server/src/index.ts` блок:

```typescript
cognitionService.register(pulseHandler);
cognitionService.start();
```

Добавь импорт Anthropic и morning brief factory вверху файла:

```typescript
import Anthropic from '@anthropic-ai/sdk';
import { createMorningBriefHandler } from './cognition/handlers/morningBrief.js';
```

(pulseHandler import уже существует рядом — добавь новый импорт возле него).

Замени блок регистрации:

```typescript
cognitionService.register(pulseHandler);
cognitionService.register(
  createMorningBriefHandler({
    piiProxy,
    anthropic: new Anthropic(),
  }),
);
cognitionService.start();
```

**Важно:** если в Step 1 увидел `createClaudeClient()` уже создающий Anthropic — переиспользуй его `.anthropic` инстанс вместо создания нового:

```typescript
cognitionService.register(
  createMorningBriefHandler({ piiProxy, anthropic: claudeClient.anthropic }),
);
```

- [ ] **Step 3: Typecheck и full suite**

```bash
npx tsc --noEmit -p packages/server && npx vitest run --root packages/server
```

Все тесты должны пройти (включая новые handler'а).

- [ ] **Step 4: Проверить что dev-сервер стартует**

```bash
timeout 5 npm --prefix packages/server run dev 2>&1 | head -50 || true
```

Ожидается что в логах не будет ошибок от cognition. Сервер должен дойти до `[discord] bot started` (или дальше). Timeout 5с — нормально, просто проверка что startup не падает.

Если есть ошибка — смотри на trace и исправляй. Чаще всего: забыл импорт, опечатка в имени handler'а.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/index.ts
git commit -m "feat(cognition): register morningBrief handler"
```

---

## Task 8: Full suite + typecheck pass

**Files:** none (verification only)

**Why:** Подстраховка перед ручным E2E — всё зелёное, никаких регрессий.

- [ ] **Step 1: Full vitest**

```bash
npx vitest run --root packages/server
```

Ожидается: все тесты зелёные, включая:
- `cognition/__tests__/handlers/morningBrief.{helpers,ai,}.test.ts`
- `cognition/__tests__/dispatcher.test.ts` (обновлённый)
- `cognition/__tests__/handlers/pulse.test.ts`

Зафиксируй итоговое количество (`N passed`) — для PR-summary.

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit -p packages/server
```

Ожидается: exit 0.

- [ ] **Step 3: Commit (если нужны исправления от Step 1-2)**

Если что-то пришлось править — коммить. Если всё зелёное — skip step.

---

## Task 9: Manual E2E verification

**Files:** none (manual check by user)

**Why:** Последний шаг — юзер в живом Discord проверяет что brief действительно приходит. Автоматически это сделать нельзя (нужен живой Anthropic API + Discord bot + реальный chat message).

- [ ] **Step 1: Start dev server**

```bash
cd /Users/dim/code/R2-D2 && npm run dev
```

Убедись что `[discord] bot started` и `[discord] slash commands registered` в логе.

- [ ] **Step 2: Проверка что handler зарегистрирован**

В Discord DM: `/heartbeat status`. В ephemeral reply должно быть: `Registered handlers: pulse, morningBrief` (порядок может отличаться).

- [ ] **Step 3: Симуляция «первого сообщения дня»**

Если сегодня уже были сообщения — handler fired или fire'нется при первом тике после 06:00. Если сегодня ещё не писал — напиши любое сообщение в DM: "привет".

В течение **до 60 секунд** (один тик heartbeat) — должен прийти DM с утренним brief'ом от R2. Параллельно обычный chat pipeline ответит на "привет" как раньше — это ожидаемо.

- [ ] **Step 4: Verify через `/heartbeat status`**

После срабатывания `/heartbeat status` должен показать в Recent runs:

```
HH:MM:SS morningBrief — publish (Доброе утро...)
```

- [ ] **Step 5: Проверка once-per-day**

Напиши ещё одно сообщение в DM. Подожди 2 минуты. Второй brief НЕ должен прийти (lastFiredAt сегодня → trigger=false). `/heartbeat status` не покажет новый `morningBrief` run.

- [ ] **Step 6: Verify через рестарт**

Останови сервер (Ctrl-C). Запусти снова. `/heartbeat status` должен всё ещё показывать last morningBrief run от сегодня; новый НЕ должен выпасть (lastFiredAt persist'ится в `cognition_handler_runs`).

- [ ] **Step 7: Document findings**

Дописать в `docs/superpowers/specs/2026-04-18-morning-brief-design.md` блок:

```markdown
## Execution Status (YYYY-MM-DD)

**Automated verification — PASSED.** N/N vitest tests green, typecheck clean.

**Manual Discord E2E — PASSED.**
- `/heartbeat status` показывает `morningBrief` в handlers.
- Первое сообщение дня → brief приходит в DM в течение одного тика.
- Второе сообщение в тот же день → brief не повторяется.
- После рестарта lastFiredAt сохранён, повтор не шлётся.
```

Commit:

```bash
git add docs/superpowers/specs/2026-04-18-morning-brief-design.md
git commit -m "docs(spec): mark morning brief E2E verified"
```

---

## Self-Review Notes

Проверено против `docs/superpowers/specs/2026-04-18-morning-brief-design.md`:

- **Goal 1** новый handler → Task 6.
- **Goal 2** fires once per local day on first activity → Task 6 trigger tests (4 случая).
- **Goal 3** data из reminders/memory/chat → Task 3 `gatherData`.
- **Goal 4** existing AI слой через env → Task 5 `callMorningBriefAI` читает `CLAUDE_MODEL`; PII proxy передаётся через фабрику.
- **Goal 5** publish через cognition_publish → уже существует в queue.ts + bot.ts; Task 6 возвращает `{publish:true}`, Task 7 регистрирует handler — и pipeline работает без изменений.
- **Trigger signature change** → Task 1 (первый таск, изолирован).
- **Timezone** — `Europe/Kyiv` хардкод в `morningBrief.ts` + helpers (спецификация §"Configuration").
- **Error handling** — Task 6 `run()` try/catch → `{error:true}`; пустой ответ → `{skip:true}`; Claude down — handler не залипает, next day попробует.

**Known gaps (intentional):**
- Backoff после повторных errors — отложено (см. spec open points).
- Target-per-user targeting — уезжает во все whitelist'ы по решению юзера.
- Router integration для LOCAL_LLM_MODE — v1 использует direct Anthropic; переключение на router — отдельный трек когда local станет мощнее.
