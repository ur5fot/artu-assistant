# Антизалипание — проактивный distraction-pullback

## Overview

Заменить пассивный `contextSwitch` («restore при возврате») на проактивный
обработчик `distractionPullback`, который ловит залипание **в моменте** и дёргает
юзера. Дешёвый фильтр на уровне приложения (`trigger`) + ИИ-судья по заголовкам
(`run`); пинг только на уверенном «distracted». Источник восприятия — только
заголовки окон (уже пишутся в `window_history`).

**Источник истины — спека:**
[docs/superpowers/specs/2026-06-02-distraction-pullback-design.md](../superpowers/specs/2026-06-02-distraction-pullback-design.md).
При расхождении плана и спеки — права спека; план обновляем.

## Context (from discovery)

Файлы/точки интеграции (проверено):
- `packages/server/src/db.ts` — миграции = последовательные `db.exec(\`CREATE TABLE IF NOT EXISTS ...\`)`. Сюда добавляем `distraction_evals`.
- `packages/server/src/observers/window-history-store.ts` — `findCurrentSession()`, `findRecentRows(since, limit?)`, `listTitlesInSession(...)`. Источник для фильтра и судьи.
- `packages/server/src/observers/context-switch-detector.ts` + `__tests__/context-switch-detector.test.ts` — **образец** чистого детектора и его тестов (строит contiguous `run` по `app_name`).
- `packages/server/src/cognition/types.ts` — `Handler { name, trigger(state,ctx), run(ctx) }`; `HandlerState { now }`, `HandlerContext { db, signal, firedAt }`, `HandlerResult`.
- `packages/server/src/cognition/handlers/contextSwitch.ts` — образец обработчика (trigger→run, defensive re-detect, `onPublished`).
- `packages/server/src/cognition/handlers/morningBrief.ai.ts` — образец вызова `anthropic.messages.create({ model, max_tokens, system, messages }, { signal })`.
- `packages/server/src/ai/claude.ts` — `createClaudeClient()` → `client.anthropic`. Инстанс `client` уже создан в `index.ts:184`.
- `packages/server/src/env-utils.ts` — `envInt(raw, fallback, min, max?)`.
- `packages/server/src/index.ts:803-867` — блок регистрации Digital Observer (тройной гейт: флаг + darwin + discord, hoisted `windowStore`).
- `packages/server/src/channels/discord/bot.ts` — `interactionCreate` (`:299`), чтение `window:show` (`:118`), `setCustomId` (`:193`). Сюда — обработчики кнопок.
- `packages/server/src/channels/discord/embeds.ts:296-327` — `buildWindowRestoreEmbed`, образец билдера embed+components.
- `.env.example` — документируем новые переменные.

## Development Approach

- **Testing approach: Regular** — реализация, затем тесты в **той же** задаче (как
  в репо: детектор + его `__tests__`). Под ralphex.
- Каждую задачу доводим до конца перед следующей; маленькие фокусные изменения.
- **CRITICAL: каждая задача обязана включать новые/обновлённые тесты** (success +
  error/edge), отдельными чекбоксами.
- **CRITICAL: все тесты зелёные перед началом следующей задачи.**
- **CRITICAL: при изменении скоупа обновляем этот план.**
- Команда тестов: `npm test --workspace packages/server` (или как в `package.json`).
- Backward-compat: старый `contextSwitch` не удаляем — гасим флагом.

## Testing Strategy

- **Unit-тесты** — обязательны в каждой задаче (см. выше).
- Чистые функции (`shouldEvaluateDistraction`, `buildJudgePrompt`) — детерминированные
  тесты, зеркало `context-switch-detector.test.ts`.
- Обработчик — с **замоканным судьёй** (инъекция `judge` fn) + замоканным store.
- **E2E:** UI-вход проекта (Discord) тестируется на уровне обработчиков кнопок
  (запись в store), не через реальный Discord.

## Progress Tracking

- `[x]` сразу по завершении пункта.
- ➕ — новые задачи, найденные в процессе.
- ⚠️ — блокеры.
- Держать план в синхроне с фактом.

## What Goes Where

- **Implementation Steps** (`[ ]`) — код, тесты, доки внутри репо.
- **Post-Completion** (без чекбоксов) — ручная проверка на живом Mac+Discord,
  выставление env-флагов, деплой.

## Implementation Steps

### Task 1: Таблица `distraction_evals` + store

- [x] в `db.ts` добавить `db.exec` с `CREATE TABLE IF NOT EXISTS distraction_evals` (поля по спеке §4: `id, app_name, dwell_started_at, window_title, evaluated_at, eval_dwell_ms, verdict, confidence, pinged, feedback, snooze_until`) + индексы `idx_distraction_dwell (app_name, dwell_started_at)`, `idx_distraction_evaluated_at (evaluated_at DESC)`
- [x] создать `packages/server/src/observers/distraction-eval-store.ts` с `createDistractionEvalStore({ db })`: `findLatestEvalForDwell(app, dwellStart)`, `findRecentPing(app, since)`, `countEvalsSince(since)`, `activeSnoozeUntil(now)`, `recordEval(input)`, `recordFeedback(app, dwellStart, feedback, snoozeUntil?)`
- [x] написать тесты store: record+findLatest, dedup (`findRecentPing`), `countEvalsSince`, `activeSnoozeUntil` (active/expired), `recordFeedback` (work + snooze)
- [x] написать тесты edge: пустая таблица → null/0; снуз в прошлом → не активен
- [x] прогнать тесты — зелёные перед Task 2

### Task 2: Чистый фильтр `shouldEvaluateDistraction`

- [x] создать `packages/server/src/observers/distraction-detector.ts` с `shouldEvaluateDistraction(params): DistractionCandidate | null` (по образцу `detectContextSwitch`): app-level `run` по `current.app_name`, `runStart`, `dwell = now - runStart`; условия §2.1–2.7 спеки (idle-отсев, `dwell >= DWELL_MIN`, предшествующая non-idle сессия другого `app_name` перед `runStart`, снуз, dedup по app, ключ dwell `(app, runStart)` + re-eval по росту dwell или смене title, дневной потолок)
- [x] параметры: пороги из вызывающего кода (`dwellMin, workLookbackMin, dedupeH, reevalMin, dailyCap`), `store` (window history) + `evalStore`
- [x] написать тесты (зеркало `context-switch-detector.test.ts`): happy path; not-long-enough; нет предшествующего другого приложения; снуз активен; dedup по app; dwell уже отработан (verdict=working); re-eval после роста dwell; **re-eval при смене title внутри app-run**; **app-run коалесит смену title (череда YouTube-роликов = один dwell)**; дневной потолок
- [x] прогнать тесты — зелёные перед Task 3

### Task 3: Судья — `buildJudgePrompt` + вызов LLM

- [x] в новом `packages/server/src/cognition/handlers/distractionPullback.judge.ts`: чистая `buildJudgePrompt(timeline, current)` — таймлайн `{app,title,durationMin}[]` (most-recent-first, по строкам (app,title)) + текущий залипон → system+user строки (по спеке §3: «работа vs досуг внутри одного приложения решается по заголовкам»)
- [x] `judgeDistraction({ anthropic, model, signal }, timeline, current)` — один `anthropic.messages.create` с forced-tool `report_verdict` (`verdict: distracted|break|working`, `confidence: 0..100`, `reason`, `work_summary`); распарсить tool_use, вернуть структуру
- [x] написать тесты `buildJudgePrompt` (стабильный снапшот промпта)
- [x] написать тесты `judgeDistraction` с замоканным `anthropic.messages.create`: валидный tool-ответ → структура; невалидный/нет tool_use → бросок/`error` (для обработки в Task 4)
- [x] прогнать тесты — зелёные перед Task 4

### Task 4: Обработчик `distractionPullback`

- [x] создать `packages/server/src/cognition/handlers/distractionPullback.ts` → `createDistractionHandler(deps): Handler`; `deps` = `{ store, evalStore, anthropic, model, dwellMin, workLookbackMin, judgeLookbackMin, dedupeH, reevalMin, confidencePct, dailyCap }` (+ инъектируемый `judge` для тестов)
- [x] `trigger(state)` = `shouldEvaluateDistraction(...) !== null`
- [x] `run(ctx)`: defensive re-check; собрать timeline через `store.findRecentRows(firedAt - judgeLookbackMin)` + current; вызвать judge; `distracted && confidence >= confidencePct` → `{ publish, content, components, onPublished: recordEval(pinged=true) }`; иначе `recordEval(verdict)` + `{ skip }`; ошибка judge → `recordEval('error')` + `{ skip }` (никогда не publish на ошибке)
- [x] написать тесты обработчика (замоканные `judge` + store): distracted+высокая → publish + pinged записан; distracted+низкая → skip; break/working → skip + eval записан; judge кинул → skip, eval='error', не publish; trigger дергает фильтр
- [x] прогнать тесты — зелёные перед Task 5

### Task 5: Пинг — embed/components + обработчики кнопок

- [x] в `channels/discord/embeds.ts` рядом с `buildWindowRestoreEmbed` добавить `buildDistractionNudge(event)` → `{ content, components }` с 3 кнопками: `distract:back:{runStart}`, `distract:work:{app}:{runStart}`, `distract:snooze:{app}:{runStart}` (лейблы по спеке §5). **Скоуп-правка:** snooze-кнопка теперь несёт `{app}` (как work), т.к. `recordFeedback(app, dwellStart, …)` адресует строку по ключу dwell `(app, runStart)`; без app снуз не смог бы записать `snooze_until`. customId-overflow (>100) роняет work+snooze, ack «Возвращаюсь» и текст остаются.
- [x] в `channels/discord/bot.ts` (`interactionCreate`, рядом с `window:show`) добавить обработку `distract:*` customId → запись в `distractionEvalStore` (`back`=ack; `work`=`recordFeedback(...,'work')`; `snooze`=`recordFeedback(...,'snooze', now+SNOOZE_MIN)`); эфемерный ответ (обработчик в `interactions.ts:handleDistractFeedback`, вызывается из `routeButton`)
- [x] прокинуть `distractionEvalStore` и `snoozeMin` в бота (как `windowStore` прокинут сейчас) — `DiscordBotDeps.distractionEvalStore` + `distractionSnoozeMin` → `routeInteraction` deps
- [x] написать тесты `buildDistractionNudge` (кнопки/customId/лейблы) — `embeds.distraction.test.ts`
- [x] написать тесты обработчиков кнопок: `work` пишет feedback и глушит переоценку; `snooze` ставит `snooze_until`; `back` — ack — `interactions.distraction.test.ts`
- [x] прогнать тесты — зелёные перед Task 6

### Task 6: Конфиг + регистрация + гашение старого contextSwitch

- [ ] в `index.ts` (блок 803-867) прочитать новые env через `envInt` (по спеке §6: `DISTRACTION_DWELL_MIN`, `_WORK_LOOKBACK_MIN`, `_JUDGE_LOOKBACK_MIN`, `_DEDUPE_H`, `_REEVAL_MIN`, `_CONFIDENCE_PCT`, `_SNOOZE_MIN`, `_DAILY_LLM_CAP`) + `DISTRACTION_JUDGE_MODEL` (string, default `claude-haiku-4-5`)
- [ ] зарегистрировать `createDistractionHandler({ store: windowStore, evalStore, anthropic: client.anthropic, ... })` под гейтом `DISTRACTION_ENABLED === 'true' && isDarwin && discordReady`; создать `distractionEvalStore` и передать в бота
- [ ] обернуть существующую регистрацию `createContextSwitchHandler` в новый флаг `CONTEXT_SWITCH_ENABLED === 'true'` (default false); поллер `window-logger` остаётся под `WINDOW_LOGGER_ENABLED` без изменений
- [ ] обновить `.env.example`: новые `DISTRACTION_*` + `CONTEXT_SWITCH_ENABLED` с дефолтами и комментариями
- [ ] написать/обновить тесты на гейтинг регистрации, если есть инфраструктура; иначе зафиксировать ручную проверку в Post-Completion
- [ ] прогнать тесты — зелёные перед Task 7

### Task 7: Verify acceptance criteria

- [ ] проверить, что все требования Overview/спеки реализованы (фильтр, судья, кнопки, дедуп/снуз/потолок, гашение старого)
- [ ] проверить edge: title-флип внутри Chrome, коалесинг YouTube, ошибка LLM = молчание, потолок = лог
- [ ] прогнать полный unit-набор
- [ ] прогнать линтер — все вопросы исправить
- [ ] проверить покрытие новых модулей (стандарт проекта)

### Task 8: Документация

- [ ] обновить секцию Digital Observer в `README.md` (новое поведение pullback, env-флаги, что старый restore выключен по дефолту)
- [ ] обновить `AGENTS.md`, если появились новые паттерны/команды

## Technical Details

- **Гранулярность dwell:** app-level (коалесит смену title) — иначе YouTube
  сбрасывал бы dwell на каждом ролике. Различение работа/досуг внутри одного
  приложения — на ИИ-судье по заголовкам (закрывает фронтенд-кейс Chrome).
- **Дедуп/переоценка:** ключ `(app_name, runStart)`; повтор только при росте dwell
  ≥ `REEVAL_MIN` или смене `window_title` (ловит флип localhost→YouTube быстро).
- **Стоимость:** LLM зовётся только когда фильтр сказал «кандидат» + дневной
  потолок; модель — haiku.
- **Ошибки:** judge упал → `verdict='error'`, `{ skip }`, никогда не publish.

## Post-Completion

*Ручные шаги — без чекбоксов, информационно.*

**Ручная проверка (живой Mac + Discord):**
- Выставить `WINDOW_LOGGER_ENABLED=true` + `DISTRACTION_ENABLED=true`, проверить
  реальный залип (≥25 мин в YouTube после работы) → приходит пинг; кнопки
  «Возвращаюсь / Это по работе / Отстань» работают.
- Проверить, что YouTube-туториал по рабочему стеку судья помечает `working` (нет
  пинга), а localhost/IDE никогда не триггерят.
- Проверить отсутствие спама при дрейфе туда-сюда (дедуп/снуз).

**Деплой:**
- По твоему flow: sync dev←master → ralphex → dev→master + `git push origin master`
  (supervisor поллит origin/master, auto-restart).
- Старый contextSwitch остаётся в коде, но молчит (`CONTEXT_SWITCH_ENABLED` unset).
