# Morning Brief — триггер по активности окон (earliest-wins)

## Overview
- `morningBrief` сейчас стреляет только когда юзер **пишет первое сообщение** после 06:00 (ветка A) или возвращается после gap ≥2 дней и пишет (ветка B). Активность = `chat_messages (role='user')`.
- Добавляем второй сигнал активности — **начало сессии окна** из `window_history` (подсистема `observers/`), чтобы брифинг стрелял проактивно как только юзер сел за Mac, без ручного ввода. Принцип: **что раньше (сообщение ИЛИ окно) — то и триггер**, в **обеих** ветках.
- Решает: «ноль ручного ввода — наблюдать со стороны». Полный дизайн: `docs/superpowers/specs/2026-06-02-morning-brief-window-trigger-design.md`.

## Context (from discovery)
- Файлы:
  - `packages/server/src/cognition/handlers/morningBrief.helpers.ts` — новый helper `hasWindowActivitySince` + const `IDLE_APP_NAMES`.
  - `packages/server/src/cognition/handlers/morningBrief.ts` — OR в ветках A и B (`trigger`).
  - `packages/server/src/db.ts:360` — индекс `idx_window_history_started`.
  - Тесты: `packages/server/src/cognition/__tests__/handlers/morningBrief.helpers.test.ts`, `.../morningBrief.test.ts`.
- Паттерны: helpers делают raw SQL по `ctx.db` (см. `hasUserActivitySince`); индексы в db.ts через `CREATE INDEX IF NOT EXISTS`; trigger получает `ctx.db` через `TriggerContext`.
- Таблица `window_history(id, app_name, window_title, started_at, last_seen_at, sample_count)`. Новая строка-сессия создаётся `recordSample` только при смене `app_name`/`window_title` → `started_at` = момент реального переключения окна.
- Helpers `hasUserActivitySince`/`hasUserActivityInLastHour` импортит только `morningBrief.ts` (grep подтверждён) — расширять их сигнатуру безопасно, но берём отдельный helper + OR в триггере (явнее).

## Development Approach
- **Testing approach**: TDD-friendly — каждый таск содержит тесты как отдельные пункты.
- Маленькие фокусные изменения, backward-compatible (только добавляем OR-условие).
- **Каждый таск завершается тестами; все тесты зелёные перед следующим таском.**
- Test: `npm test -w @r2/server` (vitest). Typecheck: `npm run build -w @r2/server` (tsc). Eslint в проекте нет.

## Testing Strategy
- **Unit**: helper `hasWindowActivitySince` (изолированно, in-memory sqlite как в существующих helper-тестах).
- **Trigger**: `morningBrief.test.ts` — поведение веток A/B с оконной активностью.
- E2E нет (бэкенд cognition-слой).

## Progress Tracking
- `[x]` сразу по завершении пункта; ➕ — новые задачи; ⚠️ — блокеры.
- Синхронизировать план с фактической работой.

## What Goes Where
- **Implementation Steps**: код + тесты + индекс (всё в этом репо).
- **Post-Completion**: ручная проверка реального срабатывания на живой машине (вне автотестов).

## Implementation Steps

### Task 1: helper `hasWindowActivitySince` + индекс
- [x] в `morningBrief.helpers.ts` добавить экспортируемую const `IDLE_APP_NAMES = ['loginwindow', 'ScreenSaverEngine']` с комментарием (lock-screen / screensaver frontmost apps — не реальное взаимодействие)
- [x] в `morningBrief.helpers.ts` добавить `export function hasWindowActivitySince(db, since, now): boolean` — `SELECT 1 FROM window_history WHERE started_at >= ? AND started_at <= ? AND app_name NOT IN (<IDLE_APP_NAMES placeholders>) LIMIT 1`; комментарий почему `started_at` (а не `last_seen_at`) и почему верхняя граница `<= now`
- [x] в `db.ts` рядом с прочими индексами `window_history` добавить `CREATE INDEX IF NOT EXISTS idx_window_history_started ON window_history(started_at)`
- [x] тесты helper (success): новая сессия `started_at >= since`, реальный app → `true`
- [x] тесты helper (edge): сессия `started_at < since` но `last_seen_at >= since` → `false` (ключевой кейс «оставлено с ночи»); `started_at >= since` но `app_name='loginwindow'`/`'ScreenSaverEngine'` → `false`; `started_at > now` → `false`; пустая таблица → `false`
- [x] `npm test -w @r2/server` — зелёный перед Task 2

### Task 2: OR-комбинация в обеих ветках триггера
- [ ] в `morningBrief.ts` импортировать `hasWindowActivitySince`
- [ ] ветка A: `state.now >= sixAmLocal && (hasUserActivitySince(ctx.db, sixAmLocal, state.now) || hasWindowActivitySince(ctx.db, sixAmLocal, state.now))` (chat первым — короткое замыкание)
- [ ] ветка B: `gapDays >= GAP_MODE_THRESHOLD && (hasUserActivityInLastHour(ctx.db, state.now) || hasWindowActivitySince(ctx.db, state.now - 3600_000, state.now))`
- [ ] trigger-тесты: ветка A стреляет на оконной активности **без** chat-сообщения; **не** стреляет если единственная сессия после 06:00 — `loginwindow`; **не** стреляет до 06:00 при наличии оконной активности
- [ ] trigger-тесты: guard `publishedToday` блокирует повтор после оконного срабатывания; ветка B стреляет на оконной активности за последний час при `gapDays >= 2`
- [ ] `npm test -w @r2/server` — зелёный перед Task 3

### Task 3: Verify acceptance + финализация
- [ ] сверить с Overview/spec: оба сигнала работают earliest-wins в обеих ветках, idle-app отсев работает, порог 06:00 и guard не сломаны
- [ ] `npm test -w @r2/server` — полный прогон зелёный
- [ ] `npm run build -w @r2/server` — typecheck без ошибок
- [ ] (опц.) обновить README/AGENTS.md если описывают условие триггера morningBrief

## Technical Details
- `IDLE_APP_NAMES` placeholders: `IDLE_APP_NAMES.map(() => '?').join(',')`, параметры `...IDLE_APP_NAMES` после `since, now`.
- `started_at`: ловит начало новой сессии (юзер переключил/открыл окно). `last_seen_at` бампается и на статичном окне пока Mac не спит → дал бы ложное срабатывание в 06:00.
- Backward-compat: добавляется только OR-ветвь; существующее поведение (chat) сохраняется, chat проверяется первым.

## Post-Completion
*Ручная проверка (вне автотестов):*
- Понаблюдать живое срабатывание: утром сесть за Mac не написав R2 → брифинг должен прийти по оконной активности.
- При ложных/пропущенных срабатываниях — скорректировать `IDLE_APP_NAMES` (могут всплыть другие idle frontmost-приложения macOS).
- Деплой по обычному flow: dev→master + `git push origin master` (supervisor поллит origin/master, авто-рестарт).
