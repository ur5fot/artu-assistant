# Reminder Tool — Alarm-style Scheduled Notifications

## Context

У R2 нет инструмента для напоминаний. Когда пользователь просит ("напомни через 5 часов выпить воды", "каждый день в 9 утра"), qwen2.5 галлюцинирует успех ("Запланировал напоминание на 15:50") — не вызывая никакого tool'а. Claude в этой же ситуации честно отвечает "не могу", что тоже бесполезно. Фича требуется как core capability: R2 — personal assistant, напоминания — базовый use case.

Параллельно нужна защита от галлюцинаций "имитация действий": даже при отсутствии tool'а qwen должен честно отказаться, а не выдумывать успех.

## Goals

1. Пользователь может создать напоминание голосом/текстом: one-shot ("через 5 часов", "завтра в 10") и recurring (daily / weekly / monthly в конкретное время).
2. При срабатывании — будильник в UI: зацикленный звук + модалка + сообщение в чате. Если игнорируется → auto-off → повтор. До 3 циклов. Затем "пропущено".
3. Пользователь может отключить звон (`Dismiss`) или отложить (`Snooze 10 min`).
4. Активные напоминания — listable, deletable через slash-команду.
5. Scheduler идемпотентен на рестарт сервера (state в SQLite, тик восстанавливает).
6. Prompt guard: LLM (оба — qwen и claude) не имитируют действия при отсутствии tool'а.

## Non-goals

- Cron-expression синтаксис (сложный recurrence вне daily/weekly/monthly).
- Push-нотификации в браузер / native OS / email. Звук и модалка — только во вкладке R2.
- Timezone переключение. Сервер и клиент — одна зона (дом пользователя).
- Уведомления в Telegram / Slack.

## Schedule Types

Discriminated union, передаётся tool'у и сохраняется как `schedule_json`:

```ts
type Schedule =
  | { kind: 'once'; at_iso: string }                                    // ISO 8601 datetime
  | { kind: 'daily'; hour: number; minute: number }                     // каждый день
  | { kind: 'weekly'; weekdays: number[]; hour: number; minute: number } // 0=Sun..6=Sat
  | { kind: 'monthly'; day_of_month: number; hour: number; minute: number }; // 1..31, clamp to last
```

`monthly` с `day_of_month=31` в феврале → clamp к последнему дню месяца (28/29).

LLM отвечает за перевод натуральной речи в этот формат. System prompt содержит примеры:
- "через 5 часов" → `{ kind: 'once', at_iso: '<now+5h>' }`
- "каждый день в 9" → `{ kind: 'daily', hour: 9, minute: 0 }`
- "по пн и ср в 18:30" → `{ kind: 'weekly', weekdays: [1,3], hour: 18, minute: 30 }`
- "1-го числа каждый месяц в 12" → `{ kind: 'monthly', day_of_month: 1, hour: 12, minute: 0 }`

## Storage

Новая таблица в `data/r2.db`:

```sql
CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  schedule_json TEXT NOT NULL,
  next_fire_at_ms INTEGER NOT NULL,
  cycle_stage TEXT NOT NULL DEFAULT 'idle',  -- 'idle' | 'ringing' | 'paused' | 'done'
  cycle_num INTEGER NOT NULL DEFAULT 0,       -- 0..2
  cycle_stage_ends_at_ms INTEGER,             -- NULL when idle
  active INTEGER NOT NULL DEFAULT 1,          -- 0 = deleted, 1 = active
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reminders_next_fire
  ON reminders(next_fire_at_ms)
  WHERE active = 1;
```

Всё DDL в `packages/server/src/db.ts` — рядом с существующими таблицами.

## Scheduler State Machine

Фоновый цикл в `packages/server/src/reminders/scheduler.ts`:

```
setInterval tick каждые 15 секунд (SCHEDULER_TICK_MS, override в тестах fake timers)
```

На каждом тике для всех `active=1` записей:

1. **idle → ringing** (начало срабатывания)
   - Условие: `cycle_stage='idle' AND next_fire_at_ms <= now`
   - Action: `cycle_stage='ringing', cycle_num=0, cycle_stage_ends_at_ms=now+60000`
   - Side effects:
     - Broadcast SSE `{type:'reminder_ring', id, text}` всем клиентам
     - Вставить assistant message в `chat_messages` с `content="⏰ " + text`

2. **ringing → paused** (auto-off звона)
   - Условие: `cycle_stage='ringing' AND cycle_stage_ends_at_ms <= now`
   - Action: `cycle_stage='paused', cycle_stage_ends_at_ms=now+120000`
   - Side effects: SSE `{type:'reminder_stop_ring', id}`

3. **paused → ringing** (повтор) / **paused → done** (финиш)
   - Условие: `cycle_stage='paused' AND cycle_stage_ends_at_ms <= now`
   - Если `cycle_num < 2`:
     - Action: `cycle_stage='ringing', cycle_num=cycle_num+1, cycle_stage_ends_at_ms=now+60000`
     - SSE `{type:'reminder_ring', id, text}`
   - Иначе (все 3 цикла прошли):
     - Action: `cycle_stage='done'`, вычислить `next_fire_at_ms` через `recurrence.ts` (для `once` → `active=0`), вернуться в `idle` если recurring
     - SSE `{type:'reminder_done', id}`
     - Вставить assistant message `"⏰ пропущено: <text>"`

**Dismiss** (через POST `/api/reminder/dismiss`):
- Server: `cycle_stage='done'`, пересчитать `next_fire_at_ms` по schedule, вернуться в `idle` (или `active=0` для `once`)
- Side effects: SSE `{type:'reminder_stop_ring', id}` если был `ringing`

**Snooze** (через POST `/api/reminder/snooze`):
- Server: **создать новый** once-shot reminder с `text=<оригинал>`, `schedule={kind:'once', at_iso:<now+10min>}`. Оригинал не трогается (если recurring → продолжит по расписанию).
- Side effects: SSE `{type:'reminder_stop_ring', id}` для текущего звона (который юзер snooze'нул)

**Идемпотентность на рестарт:** при старте сервера `scheduler.ts` запускает `setInterval` — и на первом тике продолжает со state в БД. Никакой логики "restore missed" не нужно: если сервер был оффлайн когда reminder должен был сработать, `next_fire_at_ms <= now` → запустится сразу на первом тике после старта. Для recurring: если пропустили несколько окон (напр. сервер не работал сутки при daily) — пользователь увидит одно срабатывание, и `next_fire_at_ms` перескочит вперёд. Это осознанный trade-off против спама "пропущенных".

## Recurrence Calculator

`packages/server/src/reminders/recurrence.ts`:

```ts
export function computeNextFire(schedule: Schedule, now: number): number | null;
```

- `once` → `Date.parse(at_iso)`, но только если `> now`; иначе `null` (already passed).
- `daily` → сегодня в H:M если `> now`, иначе завтра.
- `weekly` → ближайший будущий weekday из списка в H:M. Если `weekdays=[]` → invalid (schema rejects).
- `monthly` → этот месяц в `day_of_month` H:M если будущее, иначе следующий месяц. Clamp `day_of_month` к `lastDayOfMonth(target)`.

**DST (Europe/Kiev):** используем JS `Date` без кастомной timezone-библиотеки. `Date` локален к системному TZ сервера. При переходе DST может быть "пропущенный час" или "повторённый час" — принимаем как edge case, тестом фиксируем поведение (не гарантируем идеал).

## Tool Package

**`packages/tool-reminder/`** — новый workspace package, стиль как у `tool-memory` / `tool-web-search`.

```
packages/tool-reminder/
├── package.json           # "name": "@r2/tool-reminder"
├── tsconfig.json
└── src/
    ├── index.ts           # export tool definitions
    └── schedule-types.ts  # Schedule union (re-exported to @r2/shared if needed)
```

Tool definitions (`index.ts`):

```ts
import type { ToolDefinition } from '@r2/shared';
import type { ReminderStore } from '@r2/shared'; // injected by server

export function createReminderTools(store: ReminderStore): ToolDefinition[] {
  return [
    {
      name: 'reminder_create',
      description: 'Создать напоминание с будильником. schedule — один из: once/daily/weekly/monthly.',
      provider: 'all',
      parameters: { /* JSON schema with schedule discriminated union */ },
      permissionLevel: 'auto',
      command: { name: 'нагадай', description: '...', params: [{ name: 'text', required: true }] },
      execute: async (input) => {
        const id = await store.create(input.text, input.schedule);
        return { success: true, data: { id, message: `Напоминание #${id} создано` } };
      },
    },
    {
      name: 'reminder_list',
      description: 'Показать активные напоминания',
      provider: 'all',
      parameters: { type: 'object', properties: {} },
      permissionLevel: 'auto',
      command: { name: 'нагадування', description: '...', params: [] },
      execute: async () => ({ success: true, data: await store.list() }),
    },
    {
      name: 'reminder_delete',
      description: 'Удалить напоминание по id',
      provider: 'all',
      parameters: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
      permissionLevel: 'auto',
      execute: async (input) => {
        const ok = await store.delete(input.id as number);
        return ok ? { success: true, data: { id: input.id } } : { success: false, error: 'not found' };
      },
    },
  ];
}
```

`ReminderStore` — интерфейс реализованный в server'е (`packages/server/src/reminders/store.ts`), даёт CRUD над таблицей + computes `next_fire_at_ms` при create через `computeNextFire`.

## SSE Events (server → client)

**Новый endpoint:** `GET /api/events` — Server-Sent Events stream, одно подключение на вкладку. Держится открытым, сервер push'ит события.

Реализация в `packages/server/src/routes/events.ts` — аналогично `/api/chat` (SSE уже используется), но без per-request логики: клиент подключается один раз на mount, сервер broadcasts через shared event bus (`EventEmitter` singleton в `packages/server/src/reminders/bus.ts`).

Event types (добавить в `packages/shared/src/types.ts`):

```ts
export type ServerPushEvent =
  | { type: 'reminder_ring'; id: number; text: string }
  | { type: 'reminder_stop_ring'; id: number }
  | { type: 'reminder_done'; id: number };
```

Client connects на `/api/events` через `EventSource` (проще чем `WebSocket`, одно направление), парсит JSON из `data:` frames.

**Почему не supervisor WS?** Supervisor — отдельный процесс (`packages/supervisor`), его WS узко специализирован под worker lifecycle. Добавлять в него app-level events разрушит изоляцию. Делать новый WS на основном сервере требует `ws` dep и ручного protocol. SSE даёт то же (server push) через стандартный HTTP + `EventSource` без доп. зависимостей.

## Dismiss / Snooze Endpoints

**`packages/server/src/routes/reminder.ts`:**

- `POST /api/reminder/dismiss` body `{id: number}` → вызывает `store.dismiss(id)`, которая выполняет state-machine action "dismiss" (см. Scheduler).
- `POST /api/reminder/snooze` body `{id: number}` → `store.snooze(id)` → создаёт новый once-shot reminder `now+10min` с тем же текстом.

Оба возвращают `{ok: true}` или `{error: string}`.

## Client UI

**`packages/client/src/components/ReminderAlarm.tsx`:**

Singleton компонент, монтируется в `App.tsx`. Подписан на `EventSource('/api/events')`.

State: `activeAlarms: Map<id, {text, ringing}>`.

- На `reminder_ring`: устанавливает `activeAlarms.set(id, {text, ringing: true})`, запускает `alarmAudio.startLoop()` (если ещё не играет для этого id).
- На `reminder_stop_ring`: `ringing=false` для этого id, останавливает audio если это был единственный ringing. Отображает "пропущено, повторится через 2 мин".
- На `reminder_done`: удаляет из map, показывает final banner 5 сек, потом убирает.

Рендер: если `activeAlarms.size > 0` — модалка (fixed overlay, z-index поверх чата) со списком активных alarm'ов. Для каждого:
- Иконка + текст напоминания
- Индикатор "звонит" / "пауза"
- Две кнопки: `✓ Выключить` → POST `/api/reminder/dismiss`, `😴 Через 10 мин` → POST `/api/reminder/snooze`

**`packages/client/src/lib/alarm-audio.ts`** — тонкая обёртка над Web Audio API:

```ts
export function createAlarmAudio() {
  let ctx: AudioContext | null = null;
  let osc: OscillatorNode | null = null;
  let gain: GainNode | null = null;
  let pulseTimer: number | null = null;

  return {
    startLoop() {
      if (osc) return;
      ctx = ctx ?? new AudioContext();
      osc = ctx.createOscillator();
      gain = ctx.createGain();
      osc.frequency.value = 880;
      osc.type = 'sine';
      gain.gain.value = 0;
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      // Pulse: 500ms on, 500ms off
      let on = false;
      pulseTimer = window.setInterval(() => {
        on = !on;
        gain!.gain.value = on ? 0.2 : 0;
      }, 500);
    },
    stopLoop() {
      if (pulseTimer) { clearInterval(pulseTimer); pulseTimer = null; }
      osc?.stop(); osc?.disconnect(); osc = null;
      gain?.disconnect(); gain = null;
    },
  };
}
```

**Autoplay policy:** `AudioContext` требует user gesture. Ожидание: пользователь уже успел кликнуть/печатать в чате до того как прилетит reminder. Если `ctx.state === 'suspended'`, вызываем `ctx.resume()`. Edge case — новая вкладка без gestures → звук не заиграет, модалка всё равно покажется. Приемлемо.

## Prompt Guard

В `packages/server/src/ai/prompts.ts`, в `getLocalSystemPrompt`, расширить секцию ОБМЕЖЕННЯ:

```
ОБМЕЖЕННЯ:
У тебе НЕМАЄ доступу до bash, баз даних, API чи програмування.
Якщо потрібна задача програмування або інша складна дія — поверни РІВНО один рядок:

  [need tool: <що саме потрібно зробити>]

**КРИТИЧНО: НЕ ІМІТУЙ ДІЇ ЯКИХ ТИ НЕ ЗРОБИВ.**
Якщо у списку ДОСТУПНІ TOOLS немає потрібного інструменту — НІКОЛИ не пиши
що "запланував/зробив/надіслав/створив". Скажи чесно: "в мене немає такого
інструменту" або поверни `[need tool: ...]`. Брехня про виконання — заборонена.
```

Аналогичный параграф в `getSystemPrompt` (Claude) — Claude уже более-менее чест, но явно не мешает.

## Tests

### `packages/server/src/reminders/__tests__/recurrence.test.ts`
- `once` в будущем → parsed timestamp; в прошлом → `null`.
- `daily` — сейчас до H:M → сегодня; сейчас после → завтра; сейчас ровно H:M → завтра.
- `weekly [1,3,5]` в воскресенье → понедельник H:M; в понедельник до H:M → сегодня; в понедельник после → среда.
- `monthly day=1` — 15 апреля → 1 мая; 1 апреля до H:M → сегодня; 1 апреля после → 1 мая.
- `monthly day=31` в январе → 31 янв; в феврале → 28/29 фев (clamp).
- DST regression: `daily hour=2` на день перехода Europe/Kiev (документируем текущее поведение, не обязательно идеал).

### `packages/server/src/reminders/__tests__/scheduler.test.ts`
- `vi.useFakeTimers()`, in-memory SQLite, ручное перелистывание времени.
- **Happy path:** create once, advance time to `at_ms`, tick → `ringing`, SSE broadcast, chat message inserted. Advance +60s, tick → `paused`, SSE stop_ring. Advance +120s, tick → `ringing` cycle 1. Advance +60s+120s+60s → `done`, SSE done.
- **Dismiss mid-ring:** create once, tick → `ringing`, call `store.dismiss(id)` → `active=0`, SSE stop_ring, no further state changes on subsequent ticks.
- **Snooze:** tick → `ringing`, `store.snooze(id)` → оригинал `active=0` (if once) или continues (if recurring), новый once-reminder создан с `next_fire_at_ms=now+10min`.
- **Recurring daily continuation:** after `done`, `next_fire_at_ms` = завтра в тот же час, state вернулся в `idle`.
- **Idempotency на рестарт:** создать запись вручную в `ringing` state с `cycle_stage_ends_at_ms=now-1000` (stale), запустить scheduler с нуля, тик → переход в `paused` без потери состояния.
- **Multiple reminders в одном тике:** 2 one-shot'а одновременно → оба переходят в `ringing`, оба broadcasts.

### `packages/tool-reminder/__tests__/tools.test.ts`
- `reminder_create` с валидным schedule → store.create вызван, успех.
- `reminder_create` с невалидным schedule (`kind:'weekly'` без weekdays) → ошибка schema validation.
- `reminder_list` → возвращает активные.
- `reminder_delete` существующего → success; несуществующего → error.

### `packages/server/src/routes/__tests__/reminder.test.ts`
- POST `/api/reminder/dismiss` с валидным id → 200, store.dismiss вызван.
- POST `/api/reminder/snooze` с валидным id → 200, создан новый reminder.
- POST с невалидным body → 400.

### `packages/server/src/routes/__tests__/events.test.ts`
- EventSource client receives broadcasted events (через mock EventEmitter + in-process client).

### `packages/client/src/components/__tests__/ReminderAlarm.test.tsx`
- Mock EventSource + mock alarm-audio. Fire `reminder_ring` → модалка появляется, audio.startLoop вызван. Click `Dismiss` → POST вызван, audio.stopLoop. Fire `reminder_done` → модалка убирается через timeout.

### Prompt regression
Ручной smoke test документируем в плане, автоматизировать не будем (требует реальной LLM).

## Verification

1. `cd packages/server && npx tsc --noEmit && npx vitest run` — все тесты зелёные.
2. `cd packages/client && npx vitest run` — клиентские тесты зелёные.
3. Manual e2e:
   - Перезапустить dev server.
   - В чате: "напомни через 1 минуту выпить воды".
   - Через ~1 мин: появляется модалка, играет звук, в чате появляется `⏰ выпить воды`.
   - Click `Dismiss` → звук стоп, модалка убирается.
   - "напомни каждый день в 9:00 зарядка" → tool вызван с `daily, hour:9, minute:0`.
   - `/нагадування` → показывает оба.
   - `/нагадування видалити 1` → первое удалено.
4. Smoke prompt guard (ручной): попросить qwen "забронируй столик в ресторане" → qwen должен ответить "нет такого инструмента" или `[need tool: ...]`, не имитировать.

## Rollout

Фичу катим через стандартный flow: feat branch → dev → master. Scheduler запускается на старте сервера безусловно (если таблица пустая — no-op).

## Размер

Средний. Разбивается на 5 задач в плане:
1. Recurrence calculator + unit tests
2. Scheduler state machine + store + tests
3. Tool package + dismiss/snooze routes
4. SSE events endpoint + client EventSource + ReminderAlarm component + alarm-audio
5. Prompt guard + manual smoke tests + docs update
