# Morning Brief — Recap прошлого периода и gap detection

## Overview

Текущий `morningBrief` handler выдаёт brief на сегодня: reminders, notes, recent 48h chat. Не видит "что вчера висело незакрытым" и не реагирует если R2 не запускался несколько дней (gap).

**Цель:** один раз в день R2 анализирует **прошлый период** (вчера или gap) и выделяет открытые темы — вопросы без ответа, незавершённые задачи, повторяющиеся паттерны. Анализ — через LLM на сыром срезе данных, без жёстких корзин.

## Scope

**In:**
- Recap прошлого периода как LLM-анализ raw данных
- Gap detection по `cognition_handler_runs` (last successful publish)
- Изменение trigger: fires на первом возвращении юзера после gap ≥ 2 дней (не только в 06:00)
- Новый промпт: свободный анализ "что висит / повторяется / упущено"

**Out:**
- macOS Reminders integration (отдельный канал, нужен thin agent на Mac)
- Google Calendar (юзер не пользуется)
- Детерминированная классификация "открытых тем" по типам
- История firing reminders (нет в БД, см. Known limitations)

## Current state

`packages/server/src/cognition/handlers/morningBrief.ts` — handler регистрируется в `index.ts`, запускается cognition dispatcher'ом.

- `trigger(state, ctx)`: fires если `now >= 06:00 local` и `lastResult.publish !== true за сегодня` и `hasUserActivitySince(06:00)`.
- `run(ctx)`: `gatherData` → `composePrompt` → `callMorningBriefAI` → publish.
- `gatherData` собирает: reminders (сегодня+завтра), `memory_facts` (14 дней), `chat_messages` (48h × 30 rows), `user.city`.
- `composePrompt` формирует markdown со секциями "Reminders", "Открытые заметки", "Recent context" + инструкция "5-8 bullets: (1) на сегодня, (2) что висит, (3) предложения".

## Design

### 1. Gap detection

Новая helper-функция `getLastBriefPublishAt(db)`:
```sql
SELECT MAX(fired_at) FROM cognition_handler_runs
WHERE handler_name = 'morningBrief' AND outcome = 'publish'
```

`computeGapDays(lastPublishAt, now, tz)`:
- Если `lastPublishAt === null` — gap = 0 (первый запуск, не драматизировать).
- Иначе — разница в local civil days между `lastPublishAt` и `now` (DST-aware, аналог `getLocalCivilEpoch`).
- Результат: `gapDays: number` (0 = вчера уже был brief, 1 = пропущен 1 день, 2+ = пропущено 2+ дней).

### 2. Trigger изменения

Текущий guard (`publishedToday` + `hasUserActivitySince(06:00)`) остаётся. **Добавляется второй trigger:**

```
returnAfterGap = gapDays >= 2 AND userActiveInLastHour
```

Fires если `(now >= 06:00 AND publishedToday === false AND activitySince06AM) OR returnAfterGap`.

Дополнительный lock `publishedToday` всё равно обрезает повторы — если gap-trigger сработал в 15:00 и опубликовал, 06:00 завтра уже не задвоит.

### 3. Previous-period bundle

В `gatherData` добавляется секция `previousPeriod`:
- **Период:** `[lastBriefPublishAt, todayStart)` (начало сегодняшнего local дня — 00:00).
- Если `lastBriefPublishAt === null` — берём последние 48h как fallback (первый запуск).

**Данные bundle:**

| Источник | Query | Truncation |
|----------|-------|------------|
| `chat_messages` | `WHERE timestamp >= ? AND timestamp < ?` ORDER BY ts | max 80 rows, content truncate 500 chars |
| `memory_facts` created | `WHERE created_at >= ? AND created_at < ?` | max 30 |
| `memory_facts` updated | `WHERE last_mentioned_at >= ? AND last_mentioned_at < ? AND created_at < ?` | max 30 |
| `memory_facts` forgotten | `WHERE forgotten = 1 AND last_mentioned_at >= ? AND last_mentioned_at < ?` | max 20 |
| `audit_log` heavy tools | `WHERE tool_name IN ('code_task','code_deploy','eval_add','eval_run') AND created_at >= ? AND created_at < ?` | max 20, result truncate 300 chars |
| `cognition_handler_runs` (кроме morningBrief самого) | `WHERE handler_name != 'morningBrief' AND fired_at >= ? AND fired_at < ?` | max 20 |
| `reminders` overdue now | `WHERE active = 1 AND next_fire_at_ms < now` | max 20 |
| `reminders` created в период | `WHERE created_at >= ? AND created_at < ?` | max 10 |

**Верхний лимит total:** если bundle > `MAX_BUNDLE_CHARS` (~12000 символов) — усечение по времени: оставляем свежие события, добавляем хвост `...и N событий раньше опущено`.

### 4. Prompt изменения

`composePrompt` получает новый аргумент `{ gapDays, previousPeriod }`. Новая структура:

```
Собери утренний brief для dim (русский). Время — {tz}. Город: {city}.

{if gapDays > 0}
⚠️ Gap: ты не присылал brief {gapDays} дней — проанализируй весь этот период как "прошлый период".
{endif}

## Прошлый период ({start} — {end})
### Chat
- [ts] role: content
...
### Memory изменения
- created: key = value
- updated: key
- forgotten: key
### Tool runs (code_task, code_deploy, ...)
- [ts] tool_name: summary
### Reminders overdue
- [fire_at] text
### Reminders созданные
- [created_at] text

## Сегодня / завтра
### Reminders
...
### Открытые заметки
...

Инструкция:
Проанализируй прошлый период с разных углов. Найди:
- что висит (вопросы без ответа, задачи без закрытия, overdue reminders)
- что повторяется (одинаковые темы в чате, застрявшие решения)
- что упустил (важное упомянуто мельком и пропало)

Формат:
{if gapDays > 0}
1. "Пока меня не было {gapDays} дней..." — 2-4 строки выжимка периода
2. Что висит — 1-5 пунктов, если нет — "висящего нет"
3. Сегодня — 3-5 bullets: конкретно, не дневник
{else}
1. Что висит со вчера — 1-4 пункта, если нет — "вчера закрыто чисто"
2. Сегодня — 3-5 bullets
{endif}

Не пересказывай raw данные дословно — делай выводы. Предлагай конкретные действия где возможно.
```

### 5. Output

Один Discord message (тот же path что сейчас — `cognition_publish` event → Discord bot). Формат: простой markdown текст, Discord-safe (правила из `prompt` — без таблиц, single-line items). Длина: если > 2000 chars — bot сам разрезает на chunks (уже есть логика в разделении cognition messages).

## Data flow

```
heartbeat tick (60s)
  → dispatcher.runTick
  → morningBrief.trigger
      → getLastBriefPublishAt(db)
      → computeGapDays
      → check (today-trigger || gap-return-trigger)
  → [if fires] morningBrief.run
      → gatherData(db, now, tz)
          → existing: reminders, notes, recentContext, city
          → new: previousPeriod bundle (chat / memory / audit_log / cognition_runs / reminders)
      → composePrompt(data, tz, { gapDays, previousPeriod })
      → callMorningBriefAI (Claude via PII proxy, with web_search for weather)
      → publish event → Discord
```

## Edge cases

- **Первый запуск** (`lastBriefPublishAt === null`): gap = 0, previousPeriod fallback — последние 48h chat. Prompt использует текущую ветку (не "пока меня не было").
- **Повтор в тот же день после gap**: `publishedToday` guard блокирует. Gap-trigger использует тот же guard — безопасно.
- **Bundle пустой** (юзер не общался в gap): секция "Прошлый период" содержит только "тихо было, активности нет". LLM должен упомянуть это кратко и перейти к "сегодня".
- **Overdue reminders > 30 дней**: не включаем в bundle как "только что просрочен" — это скорее забытые. Фильтр `next_fire_at_ms >= now - 30d`.
- **LLM выдумывает "висящее"**: инструкция "если нечего — скажи 'висящего нет'" + temperature в `callMorningBriefAI` остаётся как сейчас.
- **Очень большой gap (> 14 дней)**: bundle усечётся по `MAX_BUNDLE_CHARS`, LLM получит только хвост + счётчик. Пометить в промпте явно "gap > 14 дней, показан только хвост".

## Known limitations

1. **Reminders firing history отсутствует.** Таблица `reminders` хранит только текущее состояние (`active`, `cycle_stage`, `next_fire_at_ms`). Нельзя сказать "reminder сработал вчера в 15:00, юзер не отреагировал". Может быть добавлено отдельным epic'ом (таблица `reminder_events`), вне скоупа этого дизайна.
2. **macOS Reminders недоступны.** Требуют thin agent на Mac (EPIC 1 Digital Observer). Скоуп: только R2 server data.
3. **Chat-интенты не классифицируются.** LLM сам решает что "висящее" — риск false positive. Митигируется инструкцией и форматом "висящего нет".

## Testing strategy

Существующие тесты `morningBrief.helpers.test.ts` и `morningBrief.test.ts` покрывают gatherData + trigger. Новые тесты:

- `getLastBriefPublishAt` — 3 кейса: нет runs, есть только error/skip, есть publish.
- `computeGapDays` — DST boundary, same day, 1-2-7 days gap, null input.
- `gatherData` → `previousPeriod`: проверить что все 7 источников собираются для данного периода.
- Bundle truncation: синтетический >12k chars → проверить наличие "...и N событий раньше".
- Trigger matrix: same-day vs gap-return vs both.
- Prompt composition: gap=0 vs gap=3 — разные preamble.

## Deployment

Меняется только `packages/server/src/cognition/handlers/morningBrief*.ts` + тесты. Никаких миграций БД — все source таблицы уже есть. Supervisor подхватит новую версию автоматом.

По deploy-flow: `feature/morning-brief-recap` → dev → master. Sync `dev ← master` перед веткой.

## Post-completion verification

После деплоя в dev: `/heartbeat status` → убедиться что handler зарегистрирован. Manual: удалить последний publish в `cognition_handler_runs` (симулируя gap) → дождаться user-активности → проверить что brief содержит "Пока меня не было".
