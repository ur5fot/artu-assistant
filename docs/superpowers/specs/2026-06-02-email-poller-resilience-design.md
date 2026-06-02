# Email poller — устойчивость к обрывам IMAP (no silent single-account)

## Overview

R2 настроен на 2 IMAP-аккаунта (`ur5fot@gmail.com`, `wagvpered@gmail.com`), но
видит только первый. Диагностика (2026-06-02):

- `email_account_state`: imap1 — `last_error=null`, imap2 — `last_error="Failed to
  establish connection in required time"`, оба `last_poll_at` устаревшие (57м/73м
  при интервале 5 мин).
- Живой тест коннекта к обоим ящикам в изоляции: **оба ОК** (imap2 — 1.6с, 17446
  писем). Т.е. аккаунт/пароль/доступ в порядке — причина не в нём.
- `withClient` ([imap-client.ts:70-86](../../packages/server/src/emails/imap-client.ts)) **не вешает `'error'`-листенер** на ImapFlow. Транзиентный сокет-`error` (`ETIMEOUT`/`ECONNRESET`, нередкие у Gmail, особенно при пачке одновременных коннектов через `Promise.all`) становится **uncaught 'error' → краш воркера** (`code=1`; в `err.log` — формат «Emitted 'error' event … ImapFlow», в `out.log` — `Worker crashed code=1`).
- Краш случается **посреди тика** → состояние аккаунтов не финишит, imap2 застревает с ошибкой. Ошибка аккаунта пишется **молча** (`setAccountError`, без stdout) → проблема невидима.

**Цель:** сделать поллер устойчивым — обрыв одного IMAP-коннекта не должен ронять
воркер и не должен молча выводить аккаунт из строя. После фикса imap2
самовосстанавливается на первом чистом тике (success-пути чистят `last_error`).

## Scope

**In:**
- `withClient` вешает `'error'`-листенер на ImapFlow → сокет-ошибка идёт нормальным
  reject (→ `runPollTick` catch → `setAccountError` → ретрай), **не** uncaught-краш.
- Per-account падение логируется в stdout (`multi-account-poller.ts` catch) — не только молча в БД.
- Счётчик `consecutive_errors` в `email_account_state`: инкремент в `setAccountError`, сброс в success-путях (`updateLastSeenUid`, `setLastSeenAndValidity`). Discord-алерт «аккаунт X не поллится N тиков подряд» — один раз при переходе порога (по образцу window-logger `onBlind`), флаг `EMAIL_ACCOUNT_BLIND_ALERT_AFTER`.
- Тесты: симуляция `'error'` через `__setImapFlowCtor`; логирование; счётчик + единичный алерт.

**Out:**
- Снижение конкурентности коннектов / connection-pooling / retry-with-backoff внутри тика — Future (root-fix = `'error'`-листенер; конкурентность не трогаем, YAGNI).
- Изменение интервала/логики скоринга/фидбэка — не трогаем.
- Миграция/ручная починка imap2 — не нужна: самовосстановится после деплоя фикса.

## Current state

- `imap-client.ts:70-86` — `withClient(account, fn)`: `new Ctor({...})` → `connect()` → `mailboxOpen('INBOX')` → `fn` → `finally logout()`. **Нет** `client.on('error', …)`. `socketTimeout=60_000`. Стаб-хук `__setImapFlowCtor` уже есть (для тестов).
- `multi-account-poller.ts:186-329` — `runPollTick`: `Promise.all(accounts.map(...))`, per-account `try/catch`; catch (323-326) делает **только** `setAccountError(acc.id, msg, now)` — без `console`.
- `store.ts` — `setAccountError` (93) пишет `last_error` + `last_poll_at`; `updateLastSeenUid` (66) и `setLastSeenAndValidity` (82) пишут watermark + **`last_error = NULL`** (success чистит ошибку). Таблица `email_account_state(account_id, last_seen_uid, last_poll_at, last_error, uid_validity)`.
- Window-logger blind-alert (index.ts ~838) — образец: `reminderBus.emit('push', { type: 'cognition_publish', runId: -1, handler, content })` → Discord DM. Переиспользуем шаблон для account-blind алерта.
- `env-utils.envInt(raw, fallback, min, max?)` — для порога.

## Design

### 1. `'error'`-листенер в `withClient` (root fix)

В `withClient`, сразу после `new Ctor({...})`:
```ts
const client = new Ctor({...});
// ImapFlow extends EventEmitter; a socket 'error' (ETIMEOUT/ECONNRESET) emitted
// outside the awaited op (idle/teardown) becomes an UNHANDLED 'error' → process
// crash. Capture it so it never crashes the worker; the awaited op rejects on
// its own and routes through runPollTick's per-account catch → setAccountError.
let socketError: Error | null = null;
client.on('error', (e: unknown) => { socketError = e instanceof Error ? e : new Error(String(e)); });
```
Дальше `try { connect/open/fn } finally { logout }` как сейчас. Если операция
сама не бросила, но `socketError` выставлен после — не критично (следующий тик
переустановит коннект). Главное: **процесс не падает**. (Тесты проверяют именно
«emit 'error' → нет uncaught, withClient бросает/реджектит штатно».)

### 2. Видимый лог per-account падения

`multi-account-poller.ts` catch (323-326): рядом с `setAccountError` добавить
```ts
console.error(`[emails] poll failed for ${acc.id}:`, msg);
```
Чтобы залипший аккаунт было видно в `out.log`/`err.log`, а не только в БД.

### 3. Счётчик ошибок + Discord-алерт «аккаунт ослеп»

- Миграция: `ALTER TABLE email_account_state ADD COLUMN consecutive_errors INTEGER NOT NULL DEFAULT 0` (+ опц. `blind_alerted INTEGER DEFAULT 0`, чтобы алертить один раз).
- `setAccountError`: `consecutive_errors = consecutive_errors + 1`.
- `updateLastSeenUid` / `setLastSeenAndValidity` (success): `consecutive_errors = 0`, `blind_alerted = 0`.
- Поллер получает опциональный колбэк `onAccountBlind({ account, consecutive, lastError })` (по образцу window-logger `onBlind` — инъекция из `index.ts`, поллер остаётся чистым/тестируемым). Вызывается **один раз**, когда `consecutive_errors` достигает `EMAIL_ACCOUNT_BLIND_ALERT_AFTER` при `blind_alerted = 0`, затем `blind_alerted = 1`.
- В `index.ts` колбэк эмитит `cognition_publish` → Discord DM: `⚠️ Почта {acc.user}: не поллится {N} тиков подряд — {last_error}`. Гейт на живой Discord (иначе просто лог). Сброс `blind_alerted` на success.

### 4. Самовосстановление imap2

Миграции/ручных шагов не нужно. После деплоя фикса воркер перестаёт падать,
доводит тик до конца; первый успешный fetch по imap2 вызовет `updateLastSeenUid`
→ `last_error = NULL`, `consecutive_errors = 0`. imap2 снова «виден».

## Error handling

- Сокет-`error` ImapFlow → пойман листенером, не роняет процесс; операция
  реджектит → `setAccountError` → ретрай следующего тика.
- Падение одного аккаунта **не** влияет на другой (`Promise.all` + изолированный
  per-account catch — уже так).
- Discord недоступен → account-blind алерт деградирует в лог (не падаем).

## Testing

- `imap-client` (через `__setImapFlowCtor`): стаб, чья `connect()`/операция emit-ит
  `'error'` (ETIMEOUT) → **нет uncaught**, `withClient` реджектит; стаб с поздним
  `'error'` после success → процесс жив.
- `multi-account-poller`: при per-account throw — `setAccountError` вызван **и**
  `console.error` залогирован; `consecutive_errors` растёт; success обнуляет его;
  алерт эмитится **ровно один раз** при пороге, не повторяется, сбрасывается после
  success.
- `store`: `consecutive_errors` инкремент/сброс по соответствующим методам.
- Регресс: существующие email-тесты (964+) зелёные.

## Decisions / defaults

- `EMAIL_ACCOUNT_BLIND_ALERT_AFTER` = **3** (≈15 мин при интервале 5 мин), min 1, max 100.
- Конкурентность коннектов **не трогаем** — root-fix именно в необработанном `'error'`, а не в количестве соединений.
- imap2 чиним не вручную, а самовосстановлением после фикса.

## Future (осознанно отложено)

- Retry-with-backoff на connect внутри тика (сгладить разовые блипы до того, как они станут `setAccountError`).
- Снижение конкурентности / переиспользование одного коннекта на тик-аккаунт (сейчас каждая операция withClient открывает новый коннект — несколько на тик).
