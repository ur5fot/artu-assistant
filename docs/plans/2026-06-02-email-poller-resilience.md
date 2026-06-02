# Email poller — устойчивость к обрывам IMAP

## Overview

Фикс: транзиентный сокет-`error` ImapFlow (ETIMEOUT/ECONNRESET) роняет воркер
(uncaught 'error'), тик не финишит, аккаунт застревает с ошибкой → R2 видит
только один ящик. Чиним root cause + делаем падения видимыми и алертим о застрявшем
аккаунте.

**Источник истины — спека:**
[docs/superpowers/specs/2026-06-02-email-poller-resilience-design.md](../superpowers/specs/2026-06-02-email-poller-resilience-design.md).
При расхождении — права спека; план обновляем.

## Context (from discovery)

- `packages/server/src/emails/imap-client.ts` — `withClient` (70-86): `new Ctor` → connect/open/fn → finally logout, **нет** `client.on('error')`. Стаб-хук `__setImapFlowCtor` (8-10) для тестов. `SOCKET_TIMEOUT_MS=60000`.
- `packages/server/src/emails/multi-account-poller.ts` — `runPollTick` (186-329), per-account catch (323-326) = только `setAccountError`, без `console`. `startEmailPoller` (335) + `StartParams`.
- `packages/server/src/emails/store.ts` — `setAccountError` (93, пишет last_error+last_poll_at), `updateLastSeenUid` (66) и `setLastSeenAndValidity` (82) пишут `last_error=NULL`. Интерфейс `EmailStore` (~5-16).
- `packages/server/src/db.ts` — таблица `email_account_state` (~209); паттерн миграции `ALTER TABLE email_account_state ADD COLUMN …` (уже есть для `uid_validity`, ~226).
- `packages/server/src/index.ts` — блок emails: `startEmailPoller({...})`; window-logger `onBlind` (~838) — образец Discord-алерта (`reminderBus.emit('push',{type:'cognition_publish',runId:-1,handler,content})`).
- `packages/server/src/env-utils.ts` — `envInt(raw, fallback, min, max?)`.
- Тесты email: `packages/server/src/emails/__tests__/` (стабят через `__setImapFlowCtor`).

## Development Approach

- **Testing approach: Regular** — код, затем тесты в той же задаче (как в репо).
- Каждую задачу до конца перед следующей; маленькие фокусные изменения.
- **CRITICAL: каждая задача включает новые/обновлённые тесты** (success + error), отдельными чекбоксами.
- **CRITICAL: все тесты зелёные перед следующей задачей.**
- **CRITICAL: при изменении скоупа — обновить план.**
- Команда тестов: `npm test --workspace packages/server`.
- Backward-compat: не ломать существующие 964+ email-тестов.

## Testing Strategy

- **Unit-тесты** — в каждой задаче. Ключевое: симуляция ImapFlow `'error'` через `__setImapFlowCtor`.
- Поллер — со стаб-store и стаб-fetcher (как в существующих poller-тестах).
- **E2E:** вход R2 — Discord; алерт тестируется на уровне колбэка `onAccountBlind` (вызван/не вызван), не через живой Discord.

## Progress Tracking

- `[x]` сразу по завершении; ➕ новые задачи; ⚠️ блокеры. Держать в синхроне.

## What Goes Where

- **Implementation Steps** (`[ ]`) — код/тесты/доки в репо.
- **Post-Completion** — самовосстановление imap2 после деплоя, ручная проверка, выставление env.

## Implementation Steps

### Task 1: `'error'`-листенер в `withClient` (root fix краша)

- [x] в `imap-client.ts` `withClient`: сразу после `new Ctor({...})` повесить `client.on('error', …)` — захват сокет-ошибки, чтобы unhandled `'error'` не ронял процесс; операция реджектит сама и идёт в per-account catch (гард `typeof client.on === 'function'` для стаб-клиентов)
- [x] убедиться, что `finally { logout() }` и ранний `'error'` не приводят к uncaught (листенер покрывает teardown)
- [x] тест (`__setImapFlowCtor`): стаб, чей `connect()` реджектит **и** emit-ит `'error'` (ETIMEOUT) → `withClient` бросает, **нет uncaught**
- [x] тест: стаб emit-ит `'error'` **после** успешной операции (idle/после logout) → процесс жив, результат возвращён
- [x] прогнать тесты — зелёные перед Task 2

### Task 2: Видимый stdout-лог per-account падения

- [x] в `multi-account-poller.ts` catch (323-326): добавить `console.error(\`[emails] poll failed for ${acc.id}:\`, msg)` рядом с `setAccountError`
- [x] тест: per-account throw → `setAccountError` вызван **и** `console.error` (spy) с id аккаунта; второй аккаунт продолжает (Promise.all-изоляция)
- [x] прогнать тесты — зелёные перед Task 3

### Task 3: Счётчик `consecutive_errors` в store + миграция

- [x] `db.ts`: `ALTER TABLE email_account_state ADD COLUMN consecutive_errors INTEGER NOT NULL DEFAULT 0` и `ADD COLUMN blind_alerted INTEGER NOT NULL DEFAULT 0` (идемпотентно, как `uid_validity`)
- [x] `store.ts`: `setAccountError` → `consecutive_errors = consecutive_errors + 1`; `updateLastSeenUid` и `setLastSeenAndValidity` → `consecutive_errors = 0, blind_alerted = 0`
- [x] `store.ts`: добавить `getAccountErrorState(accountId): { consecutive_errors, blind_alerted, last_error } | null` и `markBlindAlerted(accountId)` (ставит `blind_alerted = 1`)
- [x] тесты store: инкремент при error; обнуление обоими success-методами; getter возвращает актуальное; `markBlindAlerted` выставляет флаг
- [x] прогнать тесты — зелёные перед Task 4

### Task 4: Колбэк `onAccountBlind` в поллере

- [x] `multi-account-poller.ts`: в `TickParams`/`StartParams` добавить `blindAlertAfter: number` и опц. `onAccountBlind?: (info:{account,consecutive,lastError}) => void`
- [x] в per-account catch после `setAccountError`: прочитать `getAccountErrorState(acc.id)`; если `consecutive_errors === blindAlertAfter` и `blind_alerted === 0` → вызвать `onAccountBlind(...)` и `markBlindAlerted(acc.id)`
- [x] тесты: алерт вызван **ровно раз** при достижении порога; не вызван до порога; не повторяется после; после success-сброса может сработать снова
- [x] прогнать тесты — зелёные перед Task 5

### Task 5: Проводка в `index.ts` (конфиг + алерт в Discord)

- [ ] `index.ts` (emails-блок): `const blindAlertAfter = envInt(process.env.EMAIL_ACCOUNT_BLIND_ALERT_AFTER, 3, 1, 100)`; передать в `startEmailPoller`
- [ ] передать `onAccountBlind`, который (по образцу window-logger `onBlind`) эмитит `reminderBus.emit('push',{type:'cognition_publish',runId:-1,handler:'emails',content:\`⚠️ Почта …: не поллится ${N} тиков подряд — ${lastError}\`})`; гейт на живой Discord (иначе только лог)
- [ ] `.env.example`: добавить `EMAIL_ACCOUNT_BLIND_ALERT_AFTER=3` с комментарием
- [ ] тест/проверка проводки, если есть инфраструктура; иначе — ручная проверка в Post-Completion
- [ ] прогнать тесты — зелёные перед Task 6

### Task 6: Verify acceptance criteria

- [ ] проверить: `'error'` больше не роняет воркер; per-account падение в логах; счётчик + единичный алерт; imap2-сценарий самовосстановления (success чистит last_error+счётчик)
- [ ] прогнать полный unit-набор (`packages/server`)
- [ ] линтер — все вопросы исправить
- [ ] покрытие новых/изменённых модулей по стандарту проекта

### Task 7: Документация

- [ ] обновить секцию email-watcher в `README.md` (устойчивость к обрывам, `EMAIL_ACCOUNT_BLIND_ALERT_AFTER`)
- [ ] `AGENTS.md`, если появились новые паттерны

## Technical Details

- Root fix — наличие `'error'`-листенера на ImapFlow: unhandled `'error'` в Node = краш процесса; листенер переводит сокет-ошибку в штатный reject → `setAccountError` → ретрай следующего тика.
- `consecutive_errors`/`blind_alerted` живут в `email_account_state`; success-пути уже чистят `last_error` — туда же сброс счётчика.
- Алерт — один раз на «ослепший» аккаунт (как window-logger blind), сброс после первого успешного поллинга.
- Конкурентность коннектов и retry-backoff — НЕ в этом плане (Future в спеке).

## Post-Completion

*Ручные шаги — без чекбоксов.*

**Самовосстановление imap2:** после деплоя фикса воркер перестаёт падать, доводит
тик; первый успех по `wagvpered@gmail.com` обнулит `last_error`/`consecutive_errors`
→ ящик снова виден. Ручная починка не нужна.

**Проверка на живой машине:** после деплоя — `email_account_state` обоих аккаунтов
без `last_error`, `last_poll_at` свежие (≤ интервал); оба ящика отдают письма.

**Деплой:** по flow — `dev→master` + `git push origin master` (supervisor авто-рестарт).
`EMAIL_ACCOUNT_BLIND_ALERT_AFTER` опционален (дефолт 3), в живой `.env` можно не добавлять.
