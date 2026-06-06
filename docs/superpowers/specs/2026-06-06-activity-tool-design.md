# `@r2/tool-activity` — агент видит цифровую активность юзера

## Overview

Юзер спросил R2 «сегодня что я делал». R2 ответил списком **своих** действий
(«проверял почту», «проверял погоду», «тестировал систему») и заявил «**я не
имею доступа**» к анализу работы за компом — пересказав вместо этого топики чата
за день.

При этом R2 **собирает** цифровую активность: `window_history` (app/title/url,
каждые ~30с через window-logger). Но эти данные читают только cognition-хендлеры
(`distractionPullback`) и детектор — **у разговорного агента нет тулзы их
прочитать**. Отсюда честное (со своей колокольни) «нет доступа» и подмена дня
юзера собственной телеметрией R2.

**Цель:** новый tool `activity`, который отдаёт агенту дайджест реальной активности
из `window_history` (+ слой отвлечений из `distraction_evals`), чтобы на «что я
делал сегодня» R2 отвечал фактами: приложения, время, сайты, заметные сессии.

Прямо под vision: наблюдать «цифру» → отдавать её юзеру по запросу.

## Scope

**In:**

- Новый пакет `@r2/tool-activity` (`createTool({ store, evalStore })`) — один tool
  `activity`, по образцу `@r2/tool-weather`/`@r2/tool-emails`.
- Чистая функция `buildActivityDigest(rows, evals, range)` — агрегация без I/O,
  включая `context_switches` (число смен приложения в окне).
- Регистрация в `discoverTools` (`packages/server/src/index.ts:709`), гейт
  `WINDOW_LOGGER_ENABLED` (флаг наблюдателя).
- **`ACTIVITY_RULES` блок в оба промпта** (`getSystemPrompt`/`getLocalSystemPrompt`):
  маршрут «проанализируй работу / чем занимался / экранное время → `activity`» +
  запрет отрицать доступ. Слито из прежнего плана `2026-06-04-activity-analysis-tool`
  (см. Decisions): тулзы одной мало — агент эмпирически дважды отрицал доступ.

**Out (осознанно не трогаем):**

- Полнота слоя отвлечений — `distraction_evals` разрежены (по дизайну), даём их
  как **эпизоды с явной рамкой**, не как полную карту фокуса (см. §3 Design).
- PII-скрабинг заголовков — данные DM-only, whitelisted; пробрасываем как есть
  (Future, если понадобится).
- Запись/хранение — ничего нового не пишем, только читаем существующее.

## Current state

1. **Паттерн tool-* пакета** (`packages/tool-weather/src/index.ts`):
   `createTool(deps): ToolDefinition[]`; `ToolDefinition` = `{ name, description
   (RU, когда звать), permissionLevel, provider, parameters (JSON-schema),
   command, handler(params): Promise<ToolResult> }`. Handler возвращает
   `{ success: true, data }` (структура + готовый RU `summary`) или
   `{ success: false, error }`. Read-only тулзы — `permissionLevel: 'auto'`.
2. **Стор активности** (`packages/server/src/observers/window-history-store.ts`):
   `findRecentRows(since, limit=200)` (most-recent-first), `listTitlesInSession`,
   `recentUrlsSince(sinceMs, limit)`. Строка = один contiguous (app, title) run
   с `started_at`/`last_seen_at`/`sample_count`/`url`. Idle-приложения —
   `loginwindow`, `ScreenSaverEngine` (как в детекторе).
3. **Реестр тулз**: `discoverTools(registry, deps)` (`packages/server/src/tools/
   registry.ts:71`), вызов на `index.ts:709`; deps инжектятся туда (стор уже
   сконструирован для distraction-хендлера — переиспользуем). Системный промпт:
   Claude (`getSystemPrompt`, `prompts.ts:73`) тулзы НЕ перечисляет (Claude
   получает их нативно, тулза ведёт по `description`) и доступ НЕ отрицает;
   локальный (`getLocalSystemPrompt`, `prompts.ts:96`) сам печатает список
   зарегистрированных тулз → `activity` попадёт автоматически. Значит правок
   промпта не нужно.
4. **`distraction_evals`** (`app_name`, `window_title`, `evaluated_at`,
   `eval_dwell_ms`, `verdict`, `confidence`, `pinged`, `feedback`): записывается
   только когда детектор разбудил судью (≥~25 мин dwell, daily cap, dedup) →
   **разреженный, не полный** журнал внимания.

## Design

### 1. Tool `activity`

- `name: 'activity'`, `permissionLevel: 'auto'`, `provider: 'all'`.
- `description` (RU): звать на «что я делал», «чем занимался сегодня/вчера»,
  «сколько сидел в X», «на что ушло время», «какие сайты смотрел».
- `parameters`: `period` — enum `today` (default) / `yesterday` / `last_24h`.
- `command`: `{ name: 'активність', params: [period?] }`.
- `handler`: резолвит `range` из `period`, читает `store.findRecentRows(range.from,
  2000)` + эвалы за окно, зовёт `buildActivityDigest`, возвращает
  `{ success: true, data: digest }`. Если стор не инжектён (наблюдатель off) →
  `{ success: false, error: 'digital observer выключен (WINDOW_LOGGER_ENABLED)' }`.

`period → range` (локальное время):
- `today`: `[midnight(now), now]`, label «сегодня (D месяца)»
- `yesterday`: `[midnight(now)-24h, midnight(now)]`, label «вчера»
- `last_24h`: `[now-24h, now]`, label «за последние 24 часа»

### 2. `buildActivityDigest(rows, evals, range)` — чистая функция

Возвращает `ActivityDigest`:
```
{
  range:   { from, to, label },
  total_active_min,                      // сумма склеенных app-run'ов, без idle
  context_switches,                      // число смен приложения в окне (timeline)
  by_app:  [{ app, minutes, share }],    // share 0..1, сорт по убыванию
  top_sites: [{ host, minutes }],        // из row.url, группировка по хосту
  timeline: [{ from, to, app, title, min }], // заметные run'ы (min >= 3), хронологически
  observer: { episodes, counts, coverage_note },  // см. §3
  summary,                               // готовый RU-абзац
}
```
- **Idle-исключение**: строки `loginwindow`/`ScreenSaverEngine` не считаются.
- **Склейка**: для `timeline` — соседние строки одного `app_name` сливаются в
  app-run (как в детекторе); `by_app` суммирует минуты по `app_name` по всем
  строкам; длительность строки = `last_seen_at - started_at`, клампленная в `range`.
- Пустое окно → нули/пустые массивы + `summary` «активность за <label> не записана».

### 3. Слой отвлечений (`observer`) — с рамкой честности

- `episodes`: `distraction_evals` с `evaluated_at` в окне →
  `[{ at, app, title, dwell_min, verdict, confidence }]`.
- `counts`: сколько `distracted` / `break` / `working` / `unknown` среди эпизодов.
- `coverage_note` (всегда): «наблюдатель оценивает внимание **выборочно** — только
  длинные залипания (≥~25 мин) и с дневным лимитом; отсутствие отметок ≠ отсутствие
  отвлечений».
- В `summary` слой подаётся **эпизодически**: «наблюдатель отметил N эпизодов: X
  залипаний, Y отдых» — НЕ «всего за день N отвлечений».

### 4. Wiring

- Новый пакет `packages/tool-activity/` (`package.json` `@r2/tool-activity`,
  `tsconfig`, `src/index.ts`, `src/types.ts`) — структура как у `tool-weather`.
- В `discoverTools` (`index.ts`) добавить запись пакета и в deps пробросить
  `{ store, evalStore }` (оба уже созданы для distraction-хендлера).
- Гейт: если `WINDOW_LOGGER_ENABLED !== 'true'` — стор не инжектится (или
  инжектится `null`), tool отвечает `success:false` с понятным текстом.

### 5. Системный промпт — `ACTIVITY_RULES` блок

В промпте нет зашитого «нет доступа», но агент **эмпирически** дважды отрицал
доступ при отсутствии тулзы (06-04 «физически недоступно», 06-06 «я не имею
доступа»). Тулзы одной может не хватить — добавляем общий `ACTIVITY_RULES` блок
(по образцу `EMAIL_RULES`), инжектируется в `getSystemPrompt` и
`getLocalSystemPrompt` (`prompts.ts`):
- маршрут: «проанализируй работу / чем занимался / экранное время / сколько сидел
  в X» → зови `activity`;
- запрет: у тебя ЕСТЬ данные Digital Observer — НЕ говори «нет доступа» /
  «физически недоступно»; если за период пусто — «наблюдение пустое за период»,
  а не «нет доступа».

Проверяется на acceptance (§Testing).

## Decisions / defaults

- **Дайджест, не сырой таймлайн** — тулза агрегирует, агент пересказывает (как
  weather). Токеново-дёшево, прямо отвечает на вопрос.
- **Слой отвлечений включён, но эпизодами с `coverage_note`** — юзер выбрал
  наложение; разреженность `distraction_evals` рамкуется явно, чтобы «0
  отвлечений» не врало.
- **Период `today` по умолчанию** + `yesterday`/`last_24h`. Произвольные диапазоны
  — Future.
- **Новый пакет, не inline** — консистентность с 12 существующими `tool-*`.
- **Слито с прежним планом `2026-06-04-activity-analysis-tool`** (не был выполнен,
  баг повторился). Из него взяты `ACTIVITY_RULES` (промпт-правило против ложного
  «нет доступа» — мой первый спек это упускал) и `context_switches`. Старый план
  заменяется этим спеком + новым планом.

## Testing

1. **Unit `buildActivityDigest`** (фикстуры, детерминированно): склейка app-run'ов,
   idle-исключение, `by_app`/`share`, `top_sites` по хостам, клампинг к `range`,
   слой эпизодов + наличие `coverage_note`, пустое окно.
2. **Handler**: `today`/`yesterday`/`last_24h` → корректный range; observer-off →
   `success:false`; пустой день → `success:true` пустой дайджест.
3. **Acceptance (реальная БД, сегодня 2026-06-06)**: прогон тулзы → показать
   дайджест, сверить что он отражает реальный день (приложения/время/сессии,
   которые видели в этой сессии). Доказательство — реальный вывод, не assert.

## Future (осознанно отложено)

- Полный слой фокуса (не только разреженные эвалы) — отдельная v2 с аккуратной
  семантикой «покрытия».
- PII-скрабинг заголовков/URL, если появятся чувствительные.
- Произвольные диапазоны (`since`/`until`), «за неделю», сравнение дней.
