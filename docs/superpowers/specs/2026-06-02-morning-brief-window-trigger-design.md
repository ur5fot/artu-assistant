# Morning Brief — триггер по активности окон

## Overview

Сейчас `morningBrief` стреляет, когда юзер **пишет первое сообщение** после 06:00 (или возвращается после gap ≥ 2 дней и пишет). Активность отслеживается только по `chat_messages (role='user')`. Это требует ручного ввода — противоречит видению «ноль ручного ввода, наблюдать со стороны».

Подсистема `observers/` уже непрерывно пишет активность окон в `window_history` (через `window-logger` + osascript). Этот сигнал пока кормит только `contextSwitch`, но не брифинг.

**Цель:** брифинг должен триггериться по **началу активности окон** утром — т.е. как только юзер сел за Mac, без необходимости писать R2 первым. Сообщение и окна работают по принципу **«что раньше — то и триггер»**.

## Scope

**In:**
- Новый helper `hasWindowActivitySince(db, since, now)` — есть ли **новая сессия окна** в `[since, now]`, исключая lock/idle apps.
- OR-комбинация чат-активности и оконной активности в **обеих** ветках триггера (A — утро, B — возврат после gap).
- Индекс `window_history(started_at)` под новый запрос (триггер крутится каждый тик).
- Тесты: unit на helper + trigger-тесты.

**Out:**
- Показывать активность окон **внутри** контента брифинга (`gatherData`/`composePrompt`) — отдельная идея, не трогаем.
- Изменение порога 06:00 (`ACTIVITY_START_HOUR`), TZ, guard «опубликовано сегодня», `GAP_MODE_THRESHOLD`.
- Любые изменения в самих observers (`window-logger`, `window-snapshot`, store).

## Current state

`packages/server/src/cognition/handlers/morningBrief.ts`:
- **Ветка A** (утро): `now >= 06:00 local && hasUserActivitySince(06:00, now)`.
- **Ветка B** (возврат после gap): `gapDays >= 2 && hasUserActivityInLastHour(now)`.
- Guard `publishedToday` блокирует повторную публикацию в тот же день — без изменений.

`packages/server/src/cognition/handlers/morningBrief.helpers.ts`:
- `hasUserActivitySince(db, since, now)` — `SELECT 1 FROM chat_messages WHERE role='user' AND timestamp >= ? AND timestamp <= ?`.
- `hasUserActivityInLastHour(db, now)` — то же с `since = now - 1h`.
- Эти helpers импортит только `morningBrief.ts` (подтверждено grep).

`packages/server/src/db.ts:360` — таблица `window_history(id, app_name, window_title, started_at, last_seen_at, sample_count)`. Индексы: `last_seen_at`, `(app_name, last_seen_at)`. Индекса по `started_at` нет.

`recordSample` (window-history-store.ts) создаёт **новую строку** только когда меняется `app_name` ИЛИ `window_title`; иначе бампает `last_seen_at` + `sample_count` у последней строки. → `started_at` новой строки = момент реального переключения окна.

## Design

### 1. Helper `hasWindowActivitySince`

В `morningBrief.helpers.ts`, рядом с `hasUserActivitySince`:

```ts
// Lock-screen / screensaver foreground apps. A session whose app_name is one of
// these is NOT real user interaction — exclude so the brief does not fire on a
// Mac that merely woke to the lock screen overnight.
export const IDLE_APP_NAMES = ['loginwindow', 'ScreenSaverEngine'];

// True if a NEW window session started within [since, now] under a real app.
// Uses started_at (not last_seen_at): a window left static overnight keeps its
// started_at < since, so re-sampling it past 06:00 does NOT count as "activity
// started this morning". `started_at <= now` mirrors hasUserActivitySince's
// upper-bound guard for symmetry.
export function hasWindowActivitySince(
  db: Database.Database,
  since: number,
  now: number,
): boolean {
  const placeholders = IDLE_APP_NAMES.map(() => '?').join(',');
  const row = db
    .prepare(
      `SELECT 1 FROM window_history
       WHERE started_at >= ? AND started_at <= ?
         AND app_name NOT IN (${placeholders})
       LIMIT 1`,
    )
    .get(since, now, ...IDLE_APP_NAMES);
  return row !== undefined;
}
```

**Почему `started_at`, а не `last_seen_at`:** logger бампает `last_seen_at` даже на статичном окне, пока Mac не спит. Если ловить по `last_seen_at >= 06:00`, брифинг стрельнёт в ~06:00 на вчерашнем оставленном окне. `started_at` ловит именно момент **новой** сессии (юзер переключил/открыл окно) — признак реального взаимодействия.

**Почему денилист apps:** при заблокированном экране frontmost-процесс = `loginwindow`, при скринсейвере = `ScreenSaverEngine`. Их сессии не означают, что юзер за машиной. Отсев убирает ложное срабатывание «Mac проснулся на lock-экран ночью».

### 2. Триггер — OR в обеих ветках

`morningBrief.ts`, импорт + две ветки:

```ts
// Ветка A
if (
  state.now >= sixAmLocal &&
  (hasUserActivitySince(ctx.db, sixAmLocal, state.now) ||
    hasWindowActivitySince(ctx.db, sixAmLocal, state.now))
) {
  return true;
}

// Ветка B
if (
  gapDays >= GAP_MODE_THRESHOLD &&
  (hasUserActivityInLastHour(ctx.db, state.now) ||
    hasWindowActivitySince(ctx.db, state.now - 3600_000, state.now))
) {
  return true;
}
```

Чат-активность проверяется первой (короткое замыкание) — самый дешёвый и частый сигнал.

### 3. Индекс

`db.ts`, рядом с прочими индексами `window_history`:

```sql
CREATE INDEX IF NOT EXISTS idx_window_history_started
  ON window_history(started_at);
```

Идемпотентно (`IF NOT EXISTS`), как остальные миграции в db.ts. Без него запрос — full scan на каждом тике диспетчера.

## Data flow

```
window-logger (каждые N сек)
  → osascript frontmost app/title
  → store.recordSample → INSERT новая строка при смене окна (started_at = now)
                          либо UPDATE last_seen_at

dispatcher.runTick(now)  (каждый тик)
  → morningBrief.trigger(state, ctx)
      ветка A/B: hasUserActivitySince(...) || hasWindowActivitySince(...)
  → true → queue.enqueue → run() → publish брифинга (Discord DM)
  → guard publishedToday блокирует повтор за день
```

## Testing

`morningBrief.helpers.test.ts` — добавить `describe('hasWindowActivitySince')`:
- Новая сессия с `started_at >= since` (реальный app) → `true`.
- Сессия с `started_at < since` (оставлена с ночи), `last_seen_at >= since` → `false` (ключевой кейс).
- Сессия `started_at >= since`, но `app_name='loginwindow'` / `'ScreenSaverEngine'` → `false`.
- `started_at > now` (верхняя граница) → `false`.
- Пустая таблица → `false`.

`morningBrief.test.ts` — trigger:
- Ветка A стреляет на оконной активности **без** chat-сообщения.
- Ветка A **не** стреляет, если единственная сессия после 06:00 — `loginwindow`.
- Ветка A **не** стреляет до 06:00, даже при оконной активности.
- Guard `publishedToday` по-прежнему блокирует повтор после оконного срабатывания.
- Ветка B стреляет на оконной активности за последний час при `gapDays >= 2`.

## Known limitations

- Если юзер оставил **ровно одно** окно в фокусе на ночь и утром продолжает в нём работать, **не переключаясь** и не меняя заголовок, новая сессия не создаётся → оконный сигнал не сработает. Покрывается chat-веткой (earliest-wins) и тем, что на практике заголовок окна почти всегда меняется (правка файла, вкладка). Приемлемо.
- `IDLE_APP_NAMES` — эвристика под macOS; при появлении других «idle» frontmost-приложений список расширяется точечно.
