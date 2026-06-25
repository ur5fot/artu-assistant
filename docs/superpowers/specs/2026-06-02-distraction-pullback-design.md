# Антизалипание — проактивный pullback из отвлечений

## Overview

Digital Observer уже непрерывно пишет активное приложение + заголовок окна в
`window_history` (через `window-logger` + osascript, каждые ~30с). Сейчас этот
сигнал кормит только `contextSwitch` — обработчик, который пингует **постфактум,
когда юзер вернулся** в приложение после долгой отлучки («🔁 Restore context?»).
Юзер сказал прямо: это ему не помогает.

**Цель:** заменить пассивный «restore при возврате» на **проактивный pullback в
моменте** — поймать, когда юзер **залип** (ушёл из рабочего ритма в явное
отвлечение и завис там), и дёрнуть его *пока он ещё там*, а не после.

Ключевое ограничение, которого боится юзер, — **ложные срабатывания**. «Залип»
нельзя определить в вакууме (40 минут YouTube — прокрастинация или законный
отдых?). Поэтому нужен **якорь из активности** (R2 видит, что юзер был в работе и
дрейфанул из неё) + **ИИ-судья** как точностный гейт поверх дешёвого фильтра.

Источник — **только заголовки окон** (то, что уже пишется). Расширение восприятия
(браузерное расширение, скриншоты+vision) — осознанно отложено, см. Future.

## Scope

**In:**

- Новый cognition-обработчик `distractionPullback` (`trigger` = дешёвый фильтр,
  `run` = ИИ-судья + публикация). Ложится на существующую модель `Handler`.
- Чистая функция-фильтр `shouldEvaluateDistraction(...)` (по образцу
  `detectContextSwitch`) — крутится каждый тик, без ИИ.
- ИИ-судья: один вызов `client.anthropic.messages.create` со структурированным
  ответом через forced-tool (по образцу `morningBrief.ai.ts`).
- Новая таблица `distraction_evals` + store (дедуп, повторная оценка, снуз,
  фидбэк от кнопок).
- Пинг в Discord (существующий `cognition_publish` → DM путь) + 3 кнопки и их
  обработчики в боте (по образцу кнопки `window:show:`).
- Конфиг через `envInt` (по образцу `WINDOW_LOGGER_*` / `CONTEXT_SWITCH_*`).
- Старый `contextSwitch` уводим за отдельный флаг `CONTEXT_SWITCH_ENABLED`
  (default false) — код и тесты остаются, но по дефолту он молчит.
- Тесты: unit на фильтр + на сборку промпта; handler-тесты с замоканным судьёй;
  тесты обработчиков кнопок.

**Out:**

- Сам поллер окон (`window-logger`, `window-snapshot`, `window-history-store`) —
  **не трогаем**, он остаётся источником данных под флагом `WINDOW_LOGGER_ENABLED`.
- Расширение восприятия за пределы заголовков (браузер/скриншоты) — Future.
- Сценарий «вернуть к брошенному открытому циклу» (заливка/билд) — отдельная
  фича, не здесь (юзер выбрал «оттащить от залипания», не «открытый цикл»).
- Персистентное обучение «этот заголовок = работа» из фидбэка — Future (в MVP
  фидбэк только глушит текущий залипон).
- Edge «запарковался в одном приложении с самого начала, до него ничего не было»
  — Future (фильтр требует предшествующей другой активности, см. Design §2).

## Current state

- `packages/server/src/observers/window-history-store.ts` — store с методами:
  `findCurrentSession(): WindowSession | null`, `findRecentRows(since, limit?):
  WindowSession[]` (most-recent-first), `listTitlesInSession(app, from, to)`,
  `purgeOlderThan(cutoff)`. `WindowSession = { id, app_name, window_title,
  started_at, last_seen_at, sample_count }`. Длительность сессии выводится из
  `last_seen_at - started_at`, текущий dwell = `now - findCurrentSession().started_at`.
- `packages/server/src/cognition/types.ts` — `Handler = { name, trigger(state,
  ctx), run(ctx) }`. `trigger` получает `HandlerState { now, lastFiredAt,
  lastResult }` + `TriggerContext { db }`, может быть async. `run` получает
  `HandlerContext { db, signal, firedAt }`. `HandlerResult` = `{ publish: true,
  content, embed?, components?, onPublished? } | { skip: true, reason } |
  { error: true, message }`.
- Тик: `cognition/heartbeat.ts`, `HEARTBEAT_TICK_MS = 60_000` → `trigger`
  оценивается **каждые 60с**; при `true` job ставится в очередь и `run`
  исполняется серийно с таймаутом (по дефолту 60с).
- LLM: `packages/server/src/ai/claude.ts` → `createClaudeClient()` →
  `client.anthropic` (raw `@anthropic-ai/sdk`). Структурный ответ — как в
  `cognition/handlers/morningBrief.ai.ts` (`anthropic.messages.create({ model,
  max_tokens, system, messages }, { signal })`).
- Env: `packages/server/src/env-utils.ts` → `envInt(raw, fallback, min, max?)` —
  парсит, флорит, клампит, не бросает.
- `IDLE_APP_NAMES = ['loginwindow', 'ScreenSaverEngine']` уже введён в
  `morningBrief.helpers.ts` — переиспользуем для отсева lock/idle.
- Регистрация старого обработчика: `index.ts:803-867`, тройной гейт (флаг +
  darwin + живой Discord), переиспользует hoisted `windowStore`.

## Design

### 1. Где живёт

Новый файл `packages/server/src/cognition/handlers/distractionPullback.ts`
экспортит `createDistractionHandler(deps): Handler`. Маппинг на модель тика:

- **`trigger` = дешёвый фильтр** (только SQL по `window_history` +
  `distraction_evals`, без ИИ). Его задача — recall: «стоит ли вообще будить
  судью». Нарочно туповат и щедр.
- **`run` = ИИ-судья + публикация**. Точностный гейт: дорогой шаг только когда
  фильтр сказал «кандидат».

Чистая логика фильтра выносится в
`packages/server/src/observers/distraction-detector.ts` как
`shouldEvaluateDistraction(params): DistractionCandidate | null` (по образцу
`context-switch-detector.ts`) — чтобы тестировать детерминированно.

### 2. Фильтр (`trigger`, каждые 60с, без ИИ)

`shouldEvaluateDistraction` возвращает кандидата только если **все** условия:

1. `current = store.findCurrentSession()` существует и `current.app_name` не в
   `IDLE_APP_NAMES`. `current.window_title` = текущий заголовок.
2. **Dwell достаточно долгий.** Dwell считаем на уровне **приложения**, не
   заголовка: из `findRecentRows(now - WORK_LOOKBACK_MIN)` строим непрерывный run
   строк с `app_name === current.app_name` (как `detectContextSwitch` строит свой
   `run`), `runStart` = его самая ранняя `started_at`, `dwell = now - runStart`.
   Условие: `dwell >= DWELL_MIN` (default 25 мин). App-level коалесинг критичен:
   YouTube меняет заголовок на каждом ролике → на уровне (app,title) dwell
   сбрасывался бы каждые пару минут и порог не достигался бы никогда.
3. **Был переход в этот контекст (anti-degenerate):** в lookback перед `runStart`
   есть хотя бы одна non-idle сессия с **другим `app_name`**. Т.е. юзер пришёл
   сюда *из чего-то*, а не сидит в одном приложении с начала lookback (напр. Mac
   простоял ночь). Заметь: это **не** различение «работа vs досуг» — его делает
   только ИИ-судья (§3). Фильтр нарочно app-грубый. (Edge «весь день в одном
   приложении, дрейф localhost→YouTube внутри Chrome без других приложений» —
   осознанно в Out/Future; для мульти-app рабочего ритма юзера он не возникает.)
4. **Снуз не активен:** `evalStore.activeSnoozeUntil(now)` пуст (кнопка «Отстань»
   не нажата недавно).
5. **Не дедуп по приложению:** нет пинга по этому `app_name` за последние
   `DEDUPE_H` часов (кросс-dwell anti-spam).
6. **Этот dwell ещё не «отработан»:** ключ dwell = `(app_name, runStart)`. Либо
   оценки не было, либо прошлая дала verdict ≠ `distracted` **и** выполнено одно
   из: `dwell` вырос с тех пор ещё на ≥ `REEVAL_MIN` (короткий «перерыв» мог
   перерасти в залип), **или** `current.window_title` изменился относительно
   заголовка на момент прошлой оценки. Title-условие ловит флип *внутри* одного
   app-run (Chrome: localhost → YouTube) сразу, не дожидаясь `REEVAL_MIN`. Уже
   пинганутый dwell не переоцениваем.
7. **Дневной потолок ИИ не достигнут:** `evalStore.countEvalsSince(startOfDay) <
   DAILY_LLM_CAP`. Иначе — `false` + одна строка лога (не молчим silently).

Все запросы дешёвые: `findCurrentSession` (1 строка), `findRecentRows` (≤ lookback),
пара индексных лукапов в `distraction_evals`.

### 3. ИИ-судья (`run`, только при кандидате)

1. **Защитно перечитать** `findCurrentSession` (trigger и run исполняются в разные
   моменты — dwell мог закончиться). Если juzер уже ушёл / dwell < DWELL_MIN →
   `{ skip }`.
2. **Собрать поток заголовков:** `findRecentRows(firedAt - JUDGE_LOOKBACK_MIN)` →
   список `{ app, title, durationMin }` (most-recent-first, по строкам (app,title)
   — т.е. с разбивкой заголовков **внутри** app-run) + текущий залипон
   `{ app, title, dwellMin }`. Именно здесь решается «работа vs досуг внутри
   одного приложения»: судья видит, что Chrome-run — это `localhost`, `GitHub`, а
   потом `YouTube`, и судит по заголовкам, а не по имени `Chrome`. Сборка
   промпта — чистая функция `buildJudgePrompt(timeline, current)` (тестируется).
3. **Один вызов** `client.anthropic.messages.create` с forced-tool для структуры.
   System-prompt: «Ты — наблюдатель внимания R2. По таймлайну активных окон
   (приложения + заголовки + длительности) и тому, на чём юзер залип сейчас,
   реши: дрейфанул ли он в отвлечение от работы, законный перерыв, или это на
   самом деле работа. Заголовки могут обманывать (YouTube-туториал по его стеку =
   работа). Отвечай только инструментом.» Модель — `DISTRACTION_JUDGE_MODEL`
   (default `claude-haiku-4-5` — быстро и дёшево для короткого суждения).

   Tool `report_verdict` →
   ```ts
   {
     verdict: 'distracted' | 'break' | 'working';
     confidence: number;        // 0..100
     reason: string;            // короткая фраза, RU
     work_summary: string;      // на чём работал до дрейфа, коротко RU
   }
   ```
4. **Решение:**
   - `verdict === 'distracted' && confidence >= CONFIDENCE_PCT` → publish (см. §5),
     записать eval c `pinged = true`.
   - иначе → записать eval с verdict (чтобы фильтр §2.6 не дёргал судью снова) →
     `{ skip, reason }`.
5. `onPublished` пишет финальный eval-ping (по образцу `contextSwitch.onPublished`
   → `recordPing`).

### 4. Данные: `distraction_evals` + store

Миграция в `packages/server/src/db.ts`:

```sql
CREATE TABLE IF NOT EXISTS distraction_evals (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  app_name         TEXT    NOT NULL,
  dwell_started_at INTEGER NOT NULL,   -- = runStart, идентифицирует dwell (§2.2)
  window_title     TEXT,               -- заголовок на момент оценки (для §2.6 title-флипа)
  evaluated_at     INTEGER NOT NULL,
  eval_dwell_ms    INTEGER NOT NULL,   -- длина dwell на момент оценки (для §2.6)
  verdict          TEXT    NOT NULL,   -- distracted|break|working|error
  confidence       INTEGER,
  pinged           INTEGER NOT NULL DEFAULT 0,
  feedback         TEXT,               -- back|work|snooze|null (из кнопок)
  snooze_until     INTEGER             -- выставляется кнопкой «Отстань»
);
CREATE INDEX IF NOT EXISTS idx_distraction_dwell
  ON distraction_evals (app_name, dwell_started_at);
CREATE INDEX IF NOT EXISTS idx_distraction_evaluated_at
  ON distraction_evals (evaluated_at DESC);
```

`createDistractionEvalStore({ db })` →
`findLatestEvalForDwell(app, dwellStart)`, `findRecentPing(app, since)`,
`countEvalsSince(since)`, `activeSnoozeUntil(now)`, `recordEval(input)`,
`recordFeedback(app, dwellStart, feedback, snoozeUntil?)`. (Снуз — глобальный:
`activeSnoozeUntil` = max `snooze_until` среди свежих строк.)

### 5. Пинг + кнопки (Discord)

`run` возвращает `{ publish: true, content, components, onPublished }`:

- **content:** `🧲 Ты ~{dwellMin} мин в {app}{": "+title?}. До этого: {work_summary}. Вернёшься?`
- **components** — 3 кнопки, customId по образцу `window:show:...`:
  - `distract:back:{dwellStart}` → «Возвращаюсь» (ack)
  - `distract:work:{app}:{dwellStart}` → «Это по работе» → `recordFeedback(...,
    'work')`, глушит переоценку этого dwell.
  - `distract:snooze:{dwellStart}` → «Отстань на {SNOOZE_MIN}м» →
    `recordFeedback(..., 'snooze', now + SNOOZE_MIN)`.

Обработчики кнопок — в `channels/discord/bot.ts`, рядом с существующим хэндлером
`window:show:` (тот же `interactionCreate` блок), пишут в `distractionEvalStore`.
Ответ — эфемерный (как у `window:show`).

### 6. Конфиг (env, через `envInt`)

| Var | default | min | max |
|---|---|---|---|
| `DISTRACTION_ENABLED` | `false` | — | — |
| `DISTRACTION_DWELL_MIN` | 25 | 5 | 240 |
| `DISTRACTION_WORK_LOOKBACK_MIN` | 120 | 10 | 480 |
| `DISTRACTION_JUDGE_LOOKBACK_MIN` | 60 | 10 | 480 |
| `DISTRACTION_DEDUPE_H` | 3 | 1 | 168 |
| `DISTRACTION_REEVAL_MIN` | 30 | 5 | 240 |
| `DISTRACTION_CONFIDENCE_PCT` | 70 | 0 | 100 |
| `DISTRACTION_SNOOZE_MIN` | 60 | 5 | 480 |
| `DISTRACTION_DAILY_LLM_CAP` | 40 | 1 | 1000 |
| `DISTRACTION_JUDGE_MODEL` | `claude-haiku-4-5` | — | — |

### 7. Регистрация + судьба старого `contextSwitch`

В `index.ts` (блок 803-867):

- Поллер окон остаётся под `WINDOW_LOGGER_ENABLED` — без изменений (источник данных).
- Старую регистрацию `createContextSwitchHandler` обернуть в новый флаг
  `CONTEXT_SWITCH_ENABLED` (default false) → «restore при возврате» по дефолту молчит.
- Добавить регистрацию `createDistractionHandler({ store: windowStore, evalStore,
  anthropic: client.anthropic, ...cfg })` под тройным гейтом
  `DISTRACTION_ENABLED && isDarwin && discordReady` (тот же паттерн, тот же
  shared `windowStore`).

## Error handling

- **ИИ упал / таймаут / невалидный tool-ответ:** `run` ловит, пишет
  `verdict='error'` (с `eval_dwell_ms`, чтобы §2.6 отложил повтор на `REEVAL_MIN`,
  а не дёргал каждый тик), возвращает `{ skip }`. **Никогда не публикуем на ошибке.**
- **Пустая история / blind:** `findCurrentSession` → null → фильтр `false`.
  Существующий blind-alert поллера не трогаем.
- **Дневной потолок:** фильтр `false` + лог (видимый, не silent).

## Testing

- `distraction-detector.test.ts` — чистый фильтр: not-long-enough, нет
  предшествующей активности другого приложения, снуз активен, dedup по
  приложению, dwell уже отработан, re-eval после роста dwell, **re-eval при смене
  заголовка внутри app-run** (localhost→YouTube), **app-run коалесит смену
  заголовка** (череда YouTube-роликов = один dwell, порог достигается), дневной
  потолок, happy path. (Зеркало `context-switch-detector.test.ts`.)
- `buildJudgePrompt` — таймлайн → промпт (стабильный снапшот).
- `distractionPullback.test.ts` — handler с **замоканным судьёй** (инъекция `judge`
  fn): verdict distracted+высокая уверенность → publish + pinged; distracted+низкая
  → skip; break/working → skip + eval записан; error → skip, не publish.
- Обработчики кнопок — запись в store (snooze глушит фильтр; work глушит переоценку).

## Decisions / defaults

- Порог dwell **25 мин**, дедуп **3ч** на приложение, уверенность **70%**, снуз
  **60 мин**, дневной потолок ИИ **40**, модель судьи **haiku** — всё через env.
- Фильтр recall-oriented (щедрый, может over-fire) — точность держит ИИ-гейт.
- Старый contextSwitch не удаляем, а гасим флагом (обратимо).

## Future (осознанно отложено)

- Расширение восприятия для спорных заголовков: браузерное расширение (реальный
  URL/страница) или скриншоты+vision.
- ✅ (iter-2) Персистентное обучение из фидбэка «Это по работе» → судья теперь
  видит прошлый `work`/`done` фидбэк по сигнатуре заголовка
  (`<app>:<token>`) и смещается к `working`. См.
  `docs/superpowers/specs/2026-06-25-distraction-feedback-loop-design.md`.
- Вариант «вернуть к брошенному открытому циклу» (заливка/билд/начатая форма).
- Edge «весь день в одном приложении с самого начала».
