# Network Resilience — стабильная работа R2 при нестабильном интернете

## Overview

R2 падает и «немеет» при нестабильной сети (флапающий VPN/DNS). Live-диагностика 2026-06-05 нашла три корня:

1. **Краш воркера.** Сырой `ws` (gateway discord.js, `@discordjs/ws`) кидает `'error'` (`Opening handshake has timed out`) при флапе — слушателя на этом уровне нет → Node роняет весь процесс (`throw er; // Unhandled 'error' event`). `client.on('error')` в [bot.ts:276](../../packages/server/src/channels/discord/bot.ts:276) **есть**, но краш летит ниже уровня Client, поэтому не перехватывается.
2. **Discord не ретраит первичный коннект.** Логин-фейл бросает ([bot.ts:1320](../../packages/server/src/channels/discord/bot.ts:1320)) → ловится в [index.ts:959](../../packages/server/src/index.ts:959) (`bot failed to start`, `discordBot=null`), **ретрая нет**. Все Discord-gated хендлеры (morningBrief/emailDigest/emailActionMatch/emailUrgent) регистрируются только при успехе → R2 висит без канала до ручного рестарта.
3. **Гейт брифа по факту генерации, а не доставки.** `morningBriefPublishedToday` ([emailDigest.helpers.ts:55](../../packages/server/src/cognition/handlers/emailDigest.helpers.ts:55)) считает `outcome='publish'` — сгенерённый, но недоставленный бриф (`published_at` NULL) помечается «вышел сегодня», что неверно для morning-hold дайджеста.

**Цель:** флап сети больше не роняет R2; Discord сам переподключается без ручного рестарта; недоставленный бриф не учитывается как доставленный.

**Решает сценарий 2026-06-05 целиком:** #1 держит процесс живым, #2 даёт авто-реконнект → существующий redelivery (`flushUndeliveredPushes` на `shardReady/shardResume`, [bot.ts:1296](../../packages/server/src/channels/discord/bot.ts:1296)) сам догоняет бриф. #3 — мелкое уточнение корректности.

## Context (from discovery)

- **Файлы:**
  - [packages/server/src/index.ts](../../packages/server/src/index.ts) — worker entry (top-level await), блок старта Discord 828-963, Discord-gated регистрации (morningBrief 911, emailDigest 929, emailActionMatch 948, emailUrgent 969+, contextSwitch/distraction ~990-1140 по `discordBot!==null`). Сигнал-хендлеры: SIGTERM 1220, disconnect 1229. **Нет** `uncaughtException`/`unhandledRejection`.
  - [packages/server/src/channels/discord/bot.ts](../../packages/server/src/channels/discord/bot.ts) — `startDiscordBot` (235), `isRetryableError` (134), login через `Promise.race([login, 30s timeout])` с throw (1300-1321), redelivery на shardReady/shardResume (1296), `deps._client` инъекция для тестов (239).
  - [packages/server/src/cognition/handlers/emailDigest.helpers.ts](../../packages/server/src/cognition/handlers/emailDigest.helpers.ts) — `morningBriefPublishedToday` (55).
  - [packages/server/src/cognition/handlers/morningBrief.ts](../../packages/server/src/cognition/handlers/morningBrief.ts) — self-gate (52-58), in-memory по `state.lastResult.publish`. **Оставляем как есть** (redelivery+#2 закрывают доставку; смена на published_at рискует дубль-генерацией против redelivery).
- **Тест-стек:** `vitest run` (`npm test`). Discord-тестов пока нет (`deps._client` позволяет инжектить фейк Client). Helper-тесты — рядом с cognition handlers.
- **Redelivery уже есть:** `findUndeliveredPublishes` (cognition/store.ts) + `redeliverMaxAgeMs` 6ч ([index.ts:865](../../packages/server/src/index.ts:865)).

## Development Approach

- **Testing approach:** тесты пишутся в той же задаче, что и код (ralphex enforce: все тесты зелёные перед следующей задачей). Не строгий TDD, но каждая задача обязана содержать тесты на новый/изменённый код (success + error).
- Маленькие сфокусированные изменения, backward-compatible (флапы конфигом не ломаем; новые env — с дефолтами).
- Запускать `npm test` после каждой задачи.

## Testing Strategy

- **Unit (vitest):** классификатор транзиентных ошибок; обработчик process-исключений (вынесен в чистую функцию, не дёргает реальный `process.exit`); retry-петля Discord через инъекцию `_client` (фейл N раз → коннект); идемпотентность регистрации; гейт `morningBriefPublishedToday` при `published_at` NULL/NOT NULL.
- **E2E:** нет (Discord-only, web заморожен) — не применимо.

## Progress Tracking

- `[x]` сразу по завершении пункта; ➕ — новые задачи; ⚠️ — блокеры. План держать в синхроне с фактом.

## What Goes Where

- **Implementation Steps** — код+тесты в этом репозитории.
- **Post-Completion** — деплой (dev→master, git push, supervisor auto-restart) и live-проверка под реальным флапом.

## Implementation Steps

### Task 1: Транзиентный классификатор + process-сетка от краша (корень #1)
- [x] вынести/расширить общий классификатор `isTransientNetworkError(err)` (на базе `isRetryableError`, [bot.ts:134](../../packages/server/src/channels/discord/bot.ts:134)) в shared-модуль (напр. `packages/server/src/net/transient-error.ts`), покрыв: `ENOTFOUND`, `EAI_AGAIN`, `ETIMEDOUT`, `ECONNRESET`, `ECONNREFUSED`, `EPIPE`, и сообщения `Opening handshake has timed out` / `WebSocket` / `Connect Timeout`
- [x] вынести чистую функцию-обработчик `handleFatalSignal(kind, err, { onExit, log })` → транзиент: лог + НЕ выходить; иначе: лог + `onExit(1)` (supervisor рестартнёт)
- [x] зарегистрировать `process.on('uncaughtException')` и `process.on('unhandledRejection')` в начале worker entry ([index.ts](../../packages/server/src/index.ts), после импортов), прокинув реальный `process.exit`
- [x] обновить `isRetryableError` использовать общий классификатор (без дублирования логики)
- [x] write tests: классификатор — транзиентные кейсы (вкл. реальный текст краша из err.log) + фатальные (TypeError и т.п.)
- [x] write tests: `handleFatalSignal` — транзиент не зовёт onExit; фатал зовёт onExit(1)
- [x] run `npm test` — зелёное перед Task 2

### Task 2: Discord background connect-retry + идемпотентная регистрация хендлеров (корень #2)
- [x] вынести регистрацию Discord-gated хендлеров (morningBrief, emailDigest, emailActionMatch, emailUrgent, contextSwitch/distraction-зависимые от `discordBot`) в `registerDiscordGatedHandlers(deps)` с once-guard (`guardOnce`, чтобы при реконнекте не дублировать)
- [x] заменить «фейл → `discordBot=null`, тишина» на: первый attempt по-старому (fast path), при фейле — запуск **фоновой** retry-петли (`startReconnectLoop`, exp-backoff + full jitter, cap ~5 мин, env `DISCORD_RECONNECT_BASE_MS`/`DISCORD_RECONNECT_CAP_MS` с дефолтами 5s/300s, не сдаётся до shutdown), которая ретраит `connectDiscord`; при успехе → `registerDiscordGatedHandlers()` один раз + лог
- [x] не блокировать bootstrap: `startReconnectLoop` возвращается синхронно, остальной R2 (HTTP, поллеры) стартует degraded без Discord; Discord цепляется в фоне
- [x] остановка петли в shutdown (`stopDiscordReconnect?.()` в `gracefulShutdown`, SIGTERM/disconnect)
- [x] write tests: retry-петля через инъекцию `connect`-мока — фейл N раз затем коннект; `onConnect`/`guardOnce` ровно один раз; `computeBackoff` растёт и кэпится; full jitter в [0, capped]
- [x] write tests: degraded-старт — `startReconnectLoop` возвращает stop() синхронно (не блокирует); stop() гасит петлю; shutdown mid-connect не регистрирует
- [x] run `npm test` — зелёное перед Task 3 (1986 passed, build green)

### Task 3: Delivery-aware гейт morning-hold (корень #3, low-risk)
- [x] в `morningBriefPublishedToday` ([emailDigest.helpers.ts:55](../../packages/server/src/cognition/handlers/emailDigest.helpers.ts:55)) сменить условие основного запроса с `outcome='publish'` на `published_at IS NOT NULL` (учитывать только реально доставленный бриф); fallback по `MORNING_FALLBACK_HOUR` сохранить
- [x] комментарий: morningBrief self-gate ([morningBrief.ts:52](../../packages/server/src/cognition/handlers/morningBrief.ts:52)) намеренно оставлен на publish-исходе — недоставленное добивает redelivery, не регенерация
- [x] write tests: `morningBriefPublishedToday` → false при строке с `published_at` NULL за сегодня; true при доставленной; fallback-ветка не сломана
- [x] run `npm test` — зелёное (1989 passed)

### Task 4: Verify acceptance criteria
- [ ] проверить, что все 3 корня закрыты (краш-сетка ловит handshake-timeout; Discord-петля сама поднимает канал; гейт по доставке)
- [ ] полный `npm test` — зелёное
- [ ] `npm run build` (если есть) + линтер — без ошибок
- [ ] проверить отсутствие дубль-регистрации хендлеров при реконнекте

## Technical Details

- **Backoff:** `min(cap, base * 2^attempt)` + jitter; defaults base 5s, cap 300s; env `DISCORD_RECONNECT_BASE_MS`/`DISCORD_RECONNECT_CAP_MS` с валидацией диапазона (как `redeliverMaxAgeMs`).
- **process-сетка:** только воркер (server), не supervisor. Транзиент → лог уровня warn + продолжаем; фатал → error + exit(1).
- **Идемпотентность:** once-guard на регистрацию; established-сессию реконнектит сам discord.js (shardResume), петля — только для первичного коннекта.

## Post-Completion

**Деплой (по флоу):** sync dev←master → ralphex на dev → dev→master → `git push origin master` (supervisor поллит origin/master, auto-restart).

**Live-проверка под флапом:**
- Отключить/переключить Mullvad relay при живом R2 → процесс НЕ падает (`ps` тот же PID), в логах транзиент-варны вместо краша.
- Вернуть сеть → Discord сам коннектится без ручного рестарта (`[discord] ready` в out.log, ESTABLISHED на `162.159.x:443`).
- Недоставленный бриф догоняется redelivery после авто-реконнекта.
