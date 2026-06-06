# @r2/tool-activity — агент видит цифровую активность юзера

## Overview
Юзер спросил R2 «что я делал сегодня» — R2 перечислил **свои** действия и заявил
«я не имею доступа» к работе за компом. Корень: Digital Observer пишет
`window_history`, но у разговорного агента **нет тулзы** его прочитать.

Фикс: новый пакет `@r2/tool-activity` с тулзой `activity` — отдаёт агенту дайджест
активности (приложения/время/сайты/сессии/смены + слой отвлечений из
`distraction_evals`) за период; плюс `ACTIVITY_RULES` блок в промпт, чтобы агент
маршрутизировал такие вопросы на тулзу и перестал отрицать доступ.

Спек: `docs/superpowers/specs/2026-06-06-activity-tool-design.md`.
**Заменяет** прежний невыполненный план `2026-06-04-activity-analysis-tool.md`
(слиты промпт-правило + `context_switches`).

## Context (from discovery)
- Паттерн тулзы: `packages/tool-weather/src/index.ts` — `createTool(deps):
  ToolDefinition[]`; handler → `{ success, data }` (структура + готовый RU
  `summary`) или `{ success:false, error }`; read-only → `permissionLevel:'auto'`.
- Стор: `packages/server/src/observers/window-history-store.ts` —
  `findRecentRows(since, limit=200)` (most-recent-first), `recentUrlsSince`.
  Строка = (app, title) run с `started_at`/`last_seen_at`/`sample_count`/`url`.
  Idle-приложения: `loginwindow`, `ScreenSaverEngine`.
- Эвалы: `packages/server/src/observers/distraction-eval-store.ts` —
  `DistractionEvalStore` (`app_name, window_title, evaluated_at, eval_dwell_ms,
  verdict, confidence`).
- Реестр: `discoverTools(registry, deps)` (`packages/server/src/tools/registry.ts:71`),
  вызов `index.ts:709`; стор+evalStore уже сконструированы для distraction-хендлера.
- Промпт: `getSystemPrompt`/`getLocalSystemPrompt` (`packages/server/src/ai/prompts.ts`),
  `EMAIL_RULES` — образец routing-блока. Локальный сам печатает список тулз.
- Воркспейсы: `packages/*` (root `package.json`).

## Development Approach
- **Testing approach**: TDD — для каждой задачи тесты пишем первыми (red), затем
  реализация (green). Чистая `buildActivityDigest` идеальна под tests-first.
- Аддитивно: новый пакет + один промпт-блок + регистрация. Без изменений схемы БД,
  без записи новых данных (только чтение).
- Read-only тулза. Время оценочное (sampling 30s) — заявляем честно.
- Каждая задача завершается тестами (success + edge) и зелёным прогоном.

## Testing Strategy
- **Unit `buildActivityDigest`** (фикстуры, детерминированно): склейка app-run'ов,
  idle-исключение, `by_app`/`share`, `top_sites` по хостам, `timeline` (≥3 мин),
  `context_switches`, клампинг к `range`, слой эпизодов + `coverage_note`, пустое окно.
- **Handler `activity`**: `today`/`yesterday`/`last_24h` → корректный range;
  observer-off → `success:false`; пустой день → `success:true` пустой дайджест.
- **Промпт**: оба промпта содержат `ACTIVITY_RULES` (упоминание `activity` + запрет
  «нет доступа»/«физически недоступно»).
- **Acceptance (реальная БД, сегодня 2026-06-06)**: прогон тулзы → показать дайджест,
  сверить что отражает реальный день.

## Progress Tracking
- Отмечать `[x]` сразу по завершении. ➕ новые задачи, ⚠️ блокеры.
- Держать план в синхроне с фактической работой.

## What Goes Where
- **Implementation Steps** (`[ ]`): код, тесты, регистрация — в этом репо.
- **Post-Completion** (без чекбоксов): деплой-флоу, ручная проверка в Discord.

## Implementation Steps

### Task 1: Пакет `@r2/tool-activity` + `buildActivityDigest` (факты активности)
- [ ] scaffold `packages/tool-activity/` (`package.json` `@r2/tool-activity`,
      `tsconfig.json`, `src/index.ts`, `src/types.ts`, `src/digest.ts`) по образцу
      `tool-weather`; добавить в workspace build
- [ ] `src/types.ts`: `ActivityRange`, `ActivityDigest`, `ActivityDeps`
      (`{ store, evalStore }`), `WindowRowLike`, `EvalLike` (структурные)
- [ ] `src/digest.ts`: `buildActivityDigest(rows, evals, range)` — idle-исключение
      (`loginwindow`/`ScreenSaverEngine`), `total_active_min`, `by_app`+`share`,
      `top_sites` (по хосту из `url`), `timeline` (склейка соседних same-app в
      app-run, только ≥3 мин), `context_switches` (число смен app в timeline),
      клампинг длительностей к `[range.from, range.to]`
- [ ] write tests: склейка/idle/by_app/share/top_sites/timeline/context_switches/
      клампинг/пустое окно (success + edge)
- [ ] run `npm test` (в `packages/server` или корне) — must pass before next task

### Task 2: Слой отвлечений + `summary` в дайджесте
- [ ] расширить `buildActivityDigest`: `observer.episodes` (из evals в окне:
      `{at, app, title, dwell_min, verdict, confidence}`), `observer.counts`
      (distracted/break/working/unknown), `observer.coverage_note` (всегда —
      «наблюдатель оценивает выборочно… отсутствие отметок ≠ отсутствие отвлечений»)
- [ ] собрать готовый RU `summary`: топ-приложения по времени, заметные сессии,
      смены; слой отвлечений **эпизодически** («отмечено N эпизодов: X залипаний,
      Y отдых»), без «всего за день»
- [ ] write tests: маппинг эпизодов, counts, `coverage_note` присутствует всегда,
      фразинг summary эпизодический, пустой слой
- [ ] run `npm test` — must pass before next task

### Task 3: Тулза `activity` + handler
- [ ] `src/index.ts`: `createTool({ store, evalStore }): ToolDefinition[]` — тулза
      `activity`, `permissionLevel:'auto'`, `provider:'all'`, param `period` enum
      `today`(default)/`yesterday`/`last_24h`, `command` `активність [period]`
- [ ] description (RU): «Сводка активности за компом (приложения/сайты/время/смены/
      отвлечения) за период. Зови на: проанализируй работу, чем занимался, что
      делал сегодня/вчера, экранное время, сколько сидел в X.»
- [ ] handler: `period→range` (локальная полночь для today/yesterday, now-24h для
      last_24h), читает `store.findRecentRows(range.from, 2000)` + эвалы за окно,
      зовёт `buildActivityDigest`, → `{success:true, data}`; стор null/observer-off
      → `{success:false, error:'digital observer выключен (WINDOW_LOGGER_ENABLED)'}`
- [ ] write tests: period→range (3 значения), success, пустой день, disabled
      (инжект fake `store`/`evalStore`)
- [ ] run `npm test` — must pass before next task

### Task 4: Регистрация в `discoverTools` + гейт
- [ ] добавить `@r2/tool-activity` в реестр (`packages/server/src/tools/registry.ts`
      запись пакета) и в deps `discoverTools` на `index.ts:709` пробросить
      `{ store, evalStore }` (уже созданы для distraction)
- [ ] гейт `WINDOW_LOGGER_ENABLED`: если выключен — инжектить `null` стор, тулза
      отвечает понятным `success:false`
- [ ] write/extend tests для проводки реестра (если тестируемо) либо подтвердить
      сборкой
- [ ] run `npm test` + `npx tsc --noEmit` (packages/server) — must pass before next task

### Task 5: `ACTIVITY_RULES` блок в промпт (стоп ложного «нет доступа»)
- [ ] в `packages/server/src/ai/prompts.ts` добавить общий `ACTIVITY_RULES` (UA, по
      образцу `EMAIL_RULES`), инжектить в `getSystemPrompt` и `getLocalSystemPrompt`:
      «проаналізуй роботу / чим займався / екранний час / скільки сидів у X → виклич
      activity. У тебе Є дані Digital Observer (активність/застосунки/час) — НЕ кажи
      'немає доступу'/'фізично недоступно'. Якщо за період порожньо — 'спостереження
      порожнє за цей період'.»
- [ ] write tests: оба промпта содержат `activity` + запрет «немає доступу»/
      «фізично недоступно»
- [ ] run `npm test` — must pass before next task

### Task 6: Verify acceptance & build
- [ ] verify: дайджест из `buildActivityDigest` на реальной БД за сегодня
      (2026-06-06) отражает реальный день (приложения/время/сессии)
- [ ] verify: оба промпта маршрутизируют активность на `activity`, без отрицания
- [ ] run full suite (`npm test`) — all green
- [ ] `npx tsc --noEmit` (packages/server) + build нового пакета — без type-ошибок
- [ ] подтвердить: аддитивно, read-only, без изменений схемы/наблюдателя

## Technical Details
- `ActivityDigest` = `{ range:{from,to,label}, total_active_min, context_switches,
  by_app:[{app,minutes,share}], top_sites:[{host,minutes}],
  timeline:[{from,to,app,title,min}], observer:{episodes,counts,coverage_note},
  summary }`.
- Время app = Σ(`last_seen_at`−`started_at`) по строкам app в окне, клампленное к
  range; оценочно (sampling 30s) — заявить в summary/описании.
- `context_switches` = число смен `app_name` в хронологическом timeline.
- `period→range` в локальном времени: today `[midnight(now), now]`, yesterday
  `[midnight−24h, midnight]`, last_24h `[now−24h, now]`.
- Тулза read-only; агент превращает дайджест в нарратив.

## Post-Completion
*Informational only*

**Deploy** (per flow): sync `dev`←`master`; ralphex на `dev`; затем `dev`→`master`
+ `git push origin master`; **остаться на `master`**; supervisor авто-рестарт.

**Manual verification (Discord):** «что я делал сегодня» / «проанализируй работу за
компом» → ожидаем реальный разбор (топ-приложения, время, сайты, смены, отвлечения
с честной рамкой), НЕ «нет доступа». Данные sampling-based (30s), глубина = история
наблюдателя.
