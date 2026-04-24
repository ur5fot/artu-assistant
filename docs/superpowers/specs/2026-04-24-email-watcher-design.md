# Email Watcher + tool-emails — анализ и digest важной почты

## Overview

R2 подключается к нескольким IMAP-ящикам (Gmail × 2+, iCloud), опрашивает их по интервалу, оценивает важность каждого нового письма через LLM, копит "важные" в очереди. Доступ к этой инфре даётся двумя путями:

1. **Background digest (proactive)** — cognition handler сам толкает digest в Discord при наборе threshold (с правилами тишины и cooldown).
2. **Tool `@r2/tool-emails` (on-demand)** — R2 может запросить почту из чата ("что в почте?", "покажи важные письма"). Возвращает ранжированный список с краткими смыслами.

Это первая реализация Phase 4F ("proactive scheduler") — watcher как отдельный handler поверх cognition layer + первый канал-интеграционный tool (фундамент для будущих Gmail-send, Calendar и т.д.).

## Scope

**In:**
- Multi-account IMAP polling (Gmail app-password + iCloud app-password + generic IMAP)
- LLM-based importance scoring (1-5), cutoff ≥4 = "важное"
- Очередь `email_pending` в SQLite
- `emailDigest` cognition handler: threshold + quiet hours + cooldown + post-morning-brief hold
- Discord digest-сообщение с ранжированным списком + кратким смыслом каждого письма
- Tool `@r2/tool-emails` с операциями `emails_list` (ранжированный список) и `emails_get` (полное тело письма по id) — R2 зовёт их из чата
- Kill switch `EMAIL_ENABLED=false`

**Out (следующие итерации):**
- Отправка писем (reply/compose) — только чтение
- Пометки в IMAP (read/archive/delete) — R2 ничего не трогает в ящике
- Threading / conversation tracking
- Вложения (attachments игнорируются, metadata "есть attachment" может передаваться в снипете)
- Search (по отправителю/ключевому слову) — v2
- Google Calendar, chat-extracted events, pre-warn над reminders — отдельные watchers в будущем
- Rule-based filter (headers/sender whitelist) — возможно добавим позже если LLM дорого

## Current state

Cognition layer готов:
- `packages/server/src/cognition/` — dispatcher + handlers registry + queue + store
- Pattern: handler = `{ name, trigger(state,ctx), run(ctx) → HandlerResult }`
- `morningBrief` — reference handler с AI-композицией через `ollama→claude` router и PII proxy
- Результат `{ publish: true, content }` доставляется в Discord через `cognition_publish` event (подписан в `bot.ts`)

Почтовой интеграции нет — этот spec её вводит.

## Design

### 1. Data flow

```
┌─ IMAP accounts (ENV JSON) ─┐
│ gmail-main, gmail-work,    │
│ icloud, ...                │
└────────────┬───────────────┘
             │ imapflow poll (5 min)
             ▼
   multi-account-poller.ts
             │ new UIDs > last_seen_uid
             ▼
      scorer.ts (batched LLM)
             │ score 1-5
             ▼
      email_pending table (only score ≥ 4)
             │
      ┌──────┴──────────────────────────────┐
      │                                     │
      ▼ (cognition tick)                    ▼ (on-demand from chat)
 emailDigest.trigger()                 tool-emails: emails_list
  - count pending (undelivered) ≥ 3?    - R2 читает тем же store
  - не quiet hours?                     - не трогает delivered_at
  - cooldown >= 2h?                     - читает undelivered + последние 72ч
  - morning-brief published today?      - возвращает top-N ранжированных
      │ yes                                 │
      ▼                                     ▼
 emailDigest.run() → formatDigest()   R2 сам формирует ответ в чат
      │                               (из JSON в разговорный текст)
      ▼  (publish)
 Discord channel
      │
      ▼
 mark pending rows as delivered
```

`emails_get` (второй tool) — отдельный путь: берёт id из `email_pending` + догружает полное тело через IMAP по UID.

### 2. Config

ENV variable `IMAP_ACCOUNTS` — JSON array:

```json
[
  {"id":"gmail-main","host":"imap.gmail.com","port":993,"user":"ur5fot@gmail.com","password":"APP_PASS","tls":true},
  {"id":"gmail-work","host":"imap.gmail.com","port":993,"user":"work@gmail.com","password":"APP_PASS2","tls":true},
  {"id":"icloud","host":"imap.mail.me.com","port":993,"user":"user@icloud.com","password":"APP_PASS3","tls":true}
]
```

- `id` уникальный, не меняется (используется как PK в `email_account_state`).
- Пароли — IMAP app-passwords, хранить в `.env` / secret manager, никогда в БД.
- Parsing: при старте `JSON.parse(process.env.IMAP_ACCOUNTS || '[]')`; пустой массив = фича выключена.

Дополнительные env:
- `EMAIL_ENABLED` — kill switch, `false` выключает poller и handler (default `true`; если `IMAP_ACCOUNTS=[]` — poller не стартует независимо от флага)
- `EMAIL_POLL_INTERVAL_MS` — default `300000` (5 мин)
- `EMAIL_DIGEST_THRESHOLD` — default `3`
- `EMAIL_DIGEST_COOLDOWN_MS` — default `7200000` (2 часа)
- `EMAIL_QUIET_HOUR_START` — default `22` (локальное время). Morning-release определяется фактом публикации morning-brief; fallback на 09:00 локально если morning-brief не публиковался ≥ 7 дней (чтобы digest не завис навсегда).
- Scorer model: используется shared `OLLAMA_MODEL` (Ollama) с fallback на `CLAUDE_MODEL` — отдельного `EMAIL_SCORE_MODEL` нет.

### 3. DB schema

Две новые таблицы в `packages/server/src/db.ts` (следуя паттерну `CREATE TABLE IF NOT EXISTS`):

```sql
CREATE TABLE IF NOT EXISTS email_account_state (
  account_id TEXT PRIMARY KEY,
  last_seen_uid INTEGER NOT NULL DEFAULT 0,
  last_poll_at INTEGER,
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS email_pending (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  message_uid INTEGER NOT NULL,
  from_addr TEXT NOT NULL,
  subject TEXT NOT NULL,
  snippet TEXT NOT NULL,
  importance INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  added_at INTEGER NOT NULL,
  delivered_at INTEGER,
  UNIQUE(account_id, message_uid)
);

CREATE INDEX IF NOT EXISTS idx_email_pending_undelivered
  ON email_pending(delivered_at, importance DESC, received_at DESC);
```

- `last_seen_uid` обновляется после успешного scoring (не до), чтобы падение scorer'а не "съедало" письма.
- `UNIQUE(account_id, message_uid)` — защита от двойной записи на retry.
- Unscored/low-importance письма не пишем в таблицу вообще (экономит место, snippet'ы могут быть длинными).

### 4. Components

Директория `packages/server/src/emails/`:

- **`imap-client.ts`** — тонкая обёртка над `imapflow`. Функция `fetchNewMessages(account, sinceUid, limit) → NewMessage[]`. Закрывает connection в finally. Тип `NewMessage = { uid, from, subject, snippet (до 500 chars из text body), receivedAt }`.
- **`scorer.ts`** — `scoreBatch(messages: NewMessage[], deps) → Array<{ uid, importance: 1..5 }>`. Один LLM call на батч (до 10 писем). Промпт: "Оцени важность 1-5. 1 — рассылка/промо. 2 — инфо без действий. 3 — требует внимания. 4 — требует действий/ответа. 5 — срочное/деньги/юридическое/здоровье". Возвращает JSON. Ollama → Claude fallback через existing router.
- **`store.ts`** — CRUD для обеих таблиц. `getLastSeenUid(accountId)`, `insertPending(...)`, `updateLastSeenUid(...)`, `countPendingUndelivered()`, `fetchPendingUndelivered(limit)`, `markDelivered(ids[])`.
- **`multi-account-poller.ts`** — `startEmailPoller({ accounts, db, scorer, piiProxy, interval, signal }) → stop()`. Tick:
  1. Для каждого account параллельно: `fetchNewMessages` → `scoreBatch` → `insertPending` (только importance ≥ 4) → `updateLastSeenUid`.
  2. Ошибки per-account логируются в `last_error`, не роняют poller.
  3. Запись в `email_pending` — транзакционная per-message (чтобы частичный сбой не ломал весь батч).

Handler:
- **`packages/server/src/cognition/handlers/emailDigest.ts`** — `trigger()` + `run()`.
- **`packages/server/src/cognition/handlers/emailDigest.helpers.ts`** — quiet-hours check, cooldown check, digest formatter.

Бутстрап в `packages/server/src/index.ts` — рядом с `morningBrief` registration (после старта Discord bot, чтобы publish был услышан).

Tool package `packages/tool-emails/`:
- **`src/index.ts`** — экспортирует `createTool({ emailStore, imapClient, piiProxy })` → `ToolDefinition[]`.
- Две tool definition:
  - **`emails_list`** — `{ limit?: number (default 10, max 50), since_hours?: number (default 72) }`. Читает `email_pending` где `received_at >= now - since_hours*3600*1000` (включая и undelivered, и delivered — юзер мог пропустить digest и переспросить). Возвращает JSON массив `{ id, from, subject, snippet, importance, received_at, account_id, delivered: boolean }`. Sorted by importance desc, received_at desc. R2 сам формирует ответ юзеру.
  - **`emails_get`** — `{ id: number }`. Читает запись из `email_pending`, через IMAP на лету скачивает полное тело (`fetchFullBody(account, uid)`). Кеш body не храним (большой, редкий запрос). Возвращает `{ from, subject, body_text, received_at }`. Если письмо удалено с сервера — error.
- Triggers в ru/uk/en (как в других tools): "почта", "листи", "письма", "inbox", "emails".
- Tool-emails НЕ имеет прямого доступа к IMAP-паролям — получает готовый `imapClient` (фабрика per-account по id) из server bootstrap. Изоляция secrets.

### 5. Trigger rules

```
trigger(state, ctx):
  if EMAIL_ENABLED=false: return false

  pendingCount = store.countPendingUndelivered()
  if pendingCount < THRESHOLD: return false

  if inQuietHours(state.now): return false
  if !morningBriefPublishedToday(ctx.db, state.now): return false  // hold until morning-brief fired
  if state.lastFiredAt && (state.now - state.lastFiredAt) < COOLDOWN: return false

  return true
```

Helpers:
- `inQuietHours(now)` — локальный час `>= QUIET_START` (default 22) → true. Утренний release полностью делегирован `morningBriefPublishedToday` — никакого отдельного `hour < X` в `inQuietHours` нет.
- `morningBriefPublishedToday(db, now)` — `SELECT MAX(fired_at) FROM cognition_handler_runs WHERE handler_name='morningBrief' AND outcome='publish'`, сравнить локальный день с today. Если morning-brief handler вообще не публиковался за 7+ дней (либо нет записей, либо последняя старше 7 дней) — fallback: считаем что release происходит в 09:00 локально, чтобы digest не зависал навсегда.
- cooldown по `state.lastFiredAt` (cognition уже это трекает).

### 6. `run()`: formatDigest

```
run(ctx):
  try:
    pending = store.fetchPendingUndelivered(50)  // hard cap, чтобы не раздувать сообщение
    if pending.length === 0: return { skip: true, reason: 'no pending' }

    sorted = pending.sort by (importance desc, received_at desc)
    content = formatDigest(sorted)

    store.markDelivered(pending.map(p => p.id))  // ВАЖНО: до return, чтобы retry не дублировал
    return { publish: true, content }
  catch err: return { error: true, message: ... }
```

Формат сообщения (Discord — plain markdown без таблиц, согласно `feat(prompt): forbid markdown tables`):

```
📬 N важных писем

🔴 [5] Bank X — Списание 12 500 ₴ на имя Y
🟠 [4] Court — Напоминание о заседании 28.04
🟠 [4] Startup Z — Приглашение на собеседование, ждут ответа до пятницы
```

- Emoji по score: 5 = 🔴, 4 = 🟠.
- `[score]` — числовой приоритет для transparency.
- `from_addr` → чистое имя отправителя (drop "<email>" если есть).
- `subject` + один абзац summary в 1 линию (из snippet, cut на 140 символов).
- Hard limit Discord message — 2000 chars; если контент длиннее, режем хвост + "...еще N писем".

### 7. LLM scoring — prompt

Батчевый запрос (до 10 писем сразу), возвращает JSON.

```
System: Ты фильтр входящей почты. Для каждого письма оцени importance 1-5 строго по шкале:
1 — newsletter, promo, автоматический bulk. Удаляется не читая.
2 — инфо-уведомление без действий (order confirmation, system notice).
3 — стоит заметить, но не срочно (report, summary, FYI).
4 — требует ответа/действия (человек пишет лично, приглашение, счёт, документ).
5 — срочное/критичное (банковский alert, юридика, здоровье, deadline сегодня).

Отвечай только JSON массивом: [{"uid": 123, "importance": 4}, ...].

User: messages = [{uid, from, subject, snippet (первые 300 chars)}, ...]
```

PII proxy: subject + snippet проходят через `piiProxy.anonymize()` перед отправкой в LLM, как в `morningBrief.ai.ts`.

### 8. Error handling

- **IMAP auth fail** per-account — пишем в `last_error`, остальные accounts продолжают. Discord получает сообщение только при первом падении (cooldown 24ч на error notifications, чтобы не спамить).
- **Scorer error** — UID не обновляем, при следующем tick retry на тех же письмах. Idempotency: `UNIQUE(account_id, message_uid)` + `INSERT OR IGNORE`.
- **Poller crash** — `startEmailPoller` ловит top-level error в tick, логирует, следующий tick по интервалу. Supervisor auto-restart не нужен (embedded в server).
- **IMAP connect timeout** — 10 сек hard timeout per-account.

### 9. Kill switch + rollout

- `EMAIL_ENABLED=false` (или `IMAP_ACCOUNTS=[]`) — poller не стартует, handler не регистрируется. Миграции БД всё равно применяются (таблицы пустые — fine).
- First deploy: включить на 1 аккаунт, проверить scoring quality на 24-48 часовом окне, расширить до всех.

### 10. Testing

Vitest, следуя паттерну `morningBrief.test.ts`:

- **`scorer.test.ts`** — mock LLM response, проверить парсинг JSON, обработка невалидного ответа, fallback на importance=3 если LLM сломался.
- **`multi-account-poller.test.ts`** — mock imapflow, проверить: параллельный fetch, per-account error isolation, корректный update `last_seen_uid` только после успешного scoring.
- **`emailDigest.test.ts`** — trigger logic: threshold, quiet hours, cooldown, morning-brief-hold. Run: format correctness, markDelivered idempotency.
- **`emailDigest.helpers.test.ts`** — `inQuietHours` (DST edge cases), `morningBriefPublishedToday`, digest formatter truncation.

Integration тест IMAP против реального сервера — НЕ добавляем, нет stable test inbox.

## Open questions

1. **Quiet hours start** — 22:00 ок или хочется позже/раньше? (env-настраиваемо, default 22 для стартa)
2. **Importance cutoff** — сейчас ≥4 попадает в pending, ≥4 также попадает в digest. Может стоит: ≥3 в pending (для analytics / future), но digest только ≥4? → Пока просто ≥4 в pending, меньше сложности.
3. **Re-scoring** — если LLM ошибочно поставил 5 на промо, нет способа корректировки. Первая итерация без feedback loop, следующая может добавить "❌ not important" кнопку в Discord digest для обучения whitelist.

## Out of scope (явно)

- Отправка / ответ / архивация — R2 только читает.
- Attachments.
- Thread grouping (несколько писем в одной переписке показываются отдельно).
- Calendar invites (`.ics`) — пока как обычное письмо.
- Rule-based pre-filter (headers like `Precedence: bulk`) — добавим если LLM token budget станет проблемой.

## Follow-up после этого spec

- `emails_search` — по отправителю / ключевому слову (IMAP SEARCH или SQL fallback)
- Кнопки в Discord digest: "не важно" (feedback loop для scorer), "открыть полное"
- Pre-warn над существующими reminders (Phase 4F подзадача)
- Events-from-chat extractor (watcher 2)
- Google Calendar (OAuth) — если iCloud/Gmail IMAP окажется недостаточно
- Gmail/iCloud send (reply/compose) — новый tool `tool-emails-send`
- Archive/label — если IMAP read уже работает стабильно

## Smoke test checklist (after deploy)

- [ ] `IMAP_ACCOUNTS=[{...one gmail...}]` — server boots, log `[emails] poller started for 1 account(s)`
- [ ] After 5 min tick, no errors in console, `SELECT * FROM email_account_state` shows `last_poll_at`
- [ ] Send a test email to yourself → next tick picks it up, LLM scores it, if ≥4 lands in `email_pending`
- [ ] `/почта` slash command in Discord → R2 returns a list via `emails_list`
- [ ] Force threshold: set `EMAIL_DIGEST_THRESHOLD=1`, wait for morning-brief publish, next cognition tick → digest lands in Discord
- [ ] Verify `delivered_at` populated after digest publish
- [ ] Add second account, restart → both poll in parallel
- [ ] Intentionally break one account's password → `last_error` logged, other accounts unaffected
