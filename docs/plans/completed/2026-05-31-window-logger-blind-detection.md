# Window-Logger Blind-Detection — Pain #2 / Digital Observer iter 1.5

## Overview

**Проблема.** 2026-05-30 ~08:21 poller Digital Observer'а (`window-logger.ts`)
тихо перестал писать в `window_history` на ~26 часов, при этом сам процесс R2
был жив (uptime с 05-29 21:41). Ни одной строки в логах, ни алерта. Сэмплинг
сначала разрядился (08:05:23 → 08:05:53 → 08:21:43), потом полностью встал —
типичная картина, когда `osascript` после sleep/wake теряет Automation-доступ к
System Events и начинает возвращать `null`/timeout.

**Корень.** Poller вызывает provider каждые 30 с; по дизайну любой
error/timeout/null от `osascript` проглатывается (errors → `null`, цикл
продолжается). Observer может полностью ослепнуть **без единого лог-сообщения**.
Поскольку реальный режим отказа — это `null` (не throw), существующий
`onError`-путь даже не срабатывает.

**Фикс (self-diagnostics).** Poller считает подряд идущие «слепые» тики
(`null` ИЛИ throw). По достижении порога **один раз** эмитит понятный
`[window-logger]`-warning + **однократный** Discord-DM через существующий
cognition-publish путь (Discord — единственный канал, который пользователь
реально читает; процесс был жив → пинг бы дошёл). Счётчик сбрасывается на
первом успешном снимке; при восстановлении после алерта — лог-строка recovery.
Без спама. Поведение по умолчанию (`WINDOW_LOGGER_ENABLED=false`) не меняется.

**Решения пользователя (зафиксированы до плана):**
- Alert path: **Log + однократный Discord** (не log-only).
- Порог по умолчанию: **10 тиков ≈ 5 мин** при интервале 30 с.
- Новый env: **`WINDOW_LOGGER_BLIND_ALERT_AFTER`** (default 10, диапазон 1–2880).

## Context (from discovery)

**Файлы:**
- `packages/server/src/observers/window-logger.ts` — poller; вся новая логика
  счётчика здесь.
- `packages/server/src/observers/__tests__/window-logger.test.ts` — unit-тесты
  (fake timers, mocked provider).
- `packages/server/src/__tests__/window-logger.integration.test.ts` — реальный
  bus + poller; сюда добавляем кейс на однократный `cognition_publish`.
- `packages/server/src/index.ts` — wiring (env parse + `onBlind`/`onRecover`),
  блок `{ ... }` на строках ~782–819.
- `.env.example` — новый env-var (после `WINDOW_LOGGER_INTERVAL_MS`, стр. 153).
- `README.md` §347 «Digital Observer» + `AGENTS.md` стр. 617 (абзац
  `contextSwitch`).

**Паттерны для переиспользования:**
- `envInt(env, default, min, max)` — `index.ts` (парсинг с fallback к default
  при выходе за диапазон).
- Discord publish path — `reminderBus.emit('push', { type:'cognition_publish',
  runId, handler, content, embed?, components? })`; bot слушает в
  `channels/discord/bot.ts` (`cognitionListener`), DM'ит
  `💭 _from <handler>_\n<content>`, затем `markPublished(runId)`.
- `window-logger.integration.test.ts` — `scriptedProvider`, fake timers, реальный
  `EventEmitter` bus с `events.push`.

**Discord-механизм (решено на этапе планирования).** Poller — не cognition
handler, своего `runId` у него нет. Переиспользуем cognition-publish путь
напрямую с **sentinel `runId: -1`**: `markPublished(-1)` делает
`UPDATE ... WHERE id=-1` → 0 строк (безвредно), `firePublished(-1)` → нет
callback'а (no-op). Это самый лёгкий честный reuse существующего DM-рендеринга.
Sentinel помечаем комментарием в коде.

**Без новых внешних зависимостей.**

## Development Approach

- **Testing approach: TDD** (тесты до реализации).
- Каждая задача завершается полностью (все её тесты зелёные) до перехода к
  следующей.
- Малые сфокусированные изменения; запуск тестов после каждого.
- Обратная совместимость: при `WINDOW_LOGGER_ENABLED=false` poller не стартует
  вовсе — ноль нового поведения.
- Scoped прогон: `npm -w @r2/server test -- <pattern>`.

## Testing Strategy

- **Unit** (`window-logger.test.ts`): fake timers + mocked provider + реальный
  in-memory store. Покрывают всю логику счётчика/порога/сброса (это место с
  реальной логикой).
- **Integration** (`window-logger.integration.test.ts`): реальный bus + poller;
  подтверждает, что слепой стрик даёт ровно один `cognition_publish`
  `handler='window-logger'` и не пишет строк в `window_history`.
- index.ts-замыкание (точная строка warning/DM) — тонкий glue, проверяется
  чтением + integration-кейсом на форму события; отдельный brittle-тест на текст
  не пишем.
- Live-macOS тестов нет (osascript замокан/абстрагирован за провайдером).

## Progress Tracking

- Отмечать `[x]` сразу по завершении пункта.
- ➕ — новые подзадачи, ⚠️ — блокеры.

## What Goes Where

- **Implementation Steps** (`[ ]`): код, тесты, docs.
- **Post-Completion** (без чекбоксов): ручная проверка на живом macOS.

## Implementation Steps

### Task 1: Poller blind-detection — счётчик + callbacks (TDD)

- [x] в `window-logger.test.ts` написать падающие тесты (см. ниже), импортируя
  новые опции `startWindowLogger`:
  - **fires once at threshold (null streak):** provider всегда `null`,
    `blindAlertAfter: 3`, `onBlind = vi.fn()`. Прогнать 3 тика
    (`advanceTimersByTimeAsync(0)` + `30_000`×2) → `onBlind` вызван 1 раз с
    `{ consecutive: 3 }`. Ещё 2 тика → всё ещё 1 вызов (нет спама). Строк в
    store нет.
  - **throw counts as blind:** provider всегда reject, `blindAlertAfter: 3`,
    `onError`+`onBlind` заданы. После 3 тиков → `onError` вызван 3 раза,
    `onBlind` — 1 раз.
  - **mixed null+throw:** последовательность null, reject, null при пороге 3 →
    `onBlind` срабатывает на 3-м тике 1 раз.
  - **reset + re-arm:** 2 null (порог 3), затем валидный снимок (recover), затем
    3 null → `onBlind` срабатывает один раз (только для второго стрика); строка
    из валидного снимка записана.
  - **onRecover once after alert:** null×3 (`onBlind` сработал), затем снимок →
    `onRecover` вызван 1 раз с `{ blindFor: 3 }`; следующий снимок `onRecover`
    повторно НЕ вызывает.
  - **backward-compat (no params):** provider всегда `null`, без
    `blindAlertAfter`/`onBlind`/`onRecover` → не бросает, никаких побочных
    эффектов, строк нет (текущее поведение сохранено).
- [x] расширить `StartWindowLoggerParams` в `window-logger.ts`:
  - `blindAlertAfter?: number` — порог подряд идущих слепых тиков.
  - `onBlind?: (info: { consecutive: number }) => void` — вызывается **ровно
    один раз**, когда `consecutiveBlind === blindAlertAfter`.
  - `onRecover?: (info: { blindFor: number }) => void` — вызывается один раз на
    первом успешном снимке **после** сработавшего алерта.
- [x] реализовать в `runOnce` (минимальная правка, не ломая структуру
  self-scheduling loop):
  - состояние модуля: `let consecutiveBlind = 0; let alerted = false;`
  - в каждом тике вычислить `blind: boolean` — `false` если снимок не-null
    (и записан в store), `true` если снимок `null` ИЛИ provider бросил
    (throw по-прежнему вызывает `onError?.(err)`).
  - если `blind`: `consecutiveBlind += 1`; если
    `blindAlertAfter != null && blindAlertAfter > 0 && consecutiveBlind === blindAlertAfter`
    → `alerted = true; onBlind?.({ consecutive: consecutiveBlind });`
  - иначе (recover): если `alerted` → `onRecover?.({ blindFor: consecutiveBlind }); alerted = false;`
    затем `consecutiveBlind = 0;`
  - планирование следующего тика — без изменений.
- [x] прогнать `npm -w @r2/server test -- window-logger.test` — должно пройти до
  Task 2.

### Task 2: Wiring в index.ts + integration-тест + .env.example

- [x] в `index.ts` (блок window-logger): распарсить
  `const blindAlertAfter = envInt(process.env.WINDOW_LOGGER_BLIND_ALERT_AFTER, 10, 1, 2880);`
- [x] передать `blindAlertAfter`, `onBlind`, `onRecover` в `startWindowLogger`
  (использован `console.warn`/`console.error` — конвенция этого блока в index.ts):
  - `onBlind: ({ consecutive }) => { ... }`:
    - `const mins = Math.round((consecutive * windowIntervalMs) / 60000);`
    - `console.warn('[window-logger] BLIND: no snapshot for ' + consecutive + ' consecutive ticks (~' + mins + 'm). Likely lost macOS Automation permission for System Events. Re-grant: System Settings → Privacy & Security → Automation → R2/node → System Events.');`
    - `reminderBus.emit('push', { type: 'cognition_publish', runId: -1, handler: 'window-logger', content: '⚠️ Digital Observer ослеп: нет снимков окна ~' + mins + ' мин (' + consecutive + ' тиков подряд). Похоже, потеряна Automation-привилегия (System Events). Re-grant: System Settings → Privacy & Security → Automation.' });`
      — с комментарием про sentinel `runId: -1` (нет строки в
      `cognition_handler_runs`; `markPublished` обновит 0 строк — безвредно).
  - `onRecover: ({ blindFor }) => console.warn('[window-logger] recovered after ' + blindFor + ' blind ticks; sampling resumed.');`
    (recovery — только лог, без Discord: «don't spam».)
- [x] (опц.) дополнить boot-лог: добавить `blind-alert=${blindAlertAfter}` в
  строку `[window-logger] started (...)`.
- [x] в `.env.example` после строки `WINDOW_LOGGER_INTERVAL_MS=...` (стр. 153),
  до блока `# Context-switch detection thresholds`, добавить:
  ```
  # Consecutive blind ticks (null/timeout/throw from osascript) before a
  # one-time "observer blind" warning + Discord ping. Resets on next good
  # sample. At 30s interval, 10 ≈ 5 min. Range 1–2880, else default 10.
  WINDOW_LOGGER_BLIND_ALERT_AFTER=10
  ```
- [x] в `window-logger.integration.test.ts` добавить кейс:
  - `scriptedProvider` возвращает `null` на длинном стрике (напр. 6 тиков),
    затем валидный снимок; реальный `EventEmitter` bus с `events.push`.
  - `startWindowLogger({ store, provider, intervalMs: 30_000, blindAlertAfter: 3,
    onBlind: ({ consecutive }) => bus.emit('push', { type:'cognition_publish',
    runId: -1, handler:'window-logger', content:'blind ~' + consecutive }) })`.
  - прогнать таймеры за порог и дальше; assert: ровно один event
    `type==='cognition_publish' && handler==='window-logger'` (нет спама);
    `content` — непустая строка; в `window_history` нет строк за время стрика.
  - (опц.) дописать в скрипт валидный снимок после стрика, прогнать тик → строка
    появляется (recover-путь), второго publish нет.
- [x] прогнать `npm -w @r2/server test -- window-logger` (unit + integration) —
  проходит (11 unit + 2 integration). Прогон выполнен через gated `&&`-цепочку
  (grep-проверка наличия wiring во всех трёх файлах → vitest → commit), т.к. в
  среде была проблема с отрисовкой stdout инструментов.

### Task 3: Документация + приёмка

- [x] `README.md` §347 «Digital Observer»: добавить короткий блок
  **Self-diagnostics (iter 1.5)** — observer считает подряд идущие слепые тики
  и по `WINDOW_LOGGER_BLIND_ALERT_AFTER` (default 10 ≈ 5 мин) один раз шлёт
  warning + Discord-DM «observer ослеп / потеряна Automation-привилегия»;
  сбрасывается на первом удачном снимке. Добавить env-var в список тюнинга
  (шаг 3).
- [x] `AGENTS.md` стр. 617 (абзац `contextSwitch`): дописать предложение про
  blind self-diagnostic + `WINDOW_LOGGER_BLIND_ALERT_AFTER`.
- [x] приёмка:
  - `npm -w @r2/server test` — весь сервер-сьют зелёный (1329 tests passed).
  - `tsc -b` (build-команда `npm run build -w @r2/server`) — exit 0.
  - backward-compat: при `WINDOW_LOGGER_ENABLED=false` poller не стартует →
    ноль нового поведения (подтверждается gate в index.ts:793).
  - линтер по затронутым файлам — чисто (ESLint в репо не настроен; tsc-сборка
    выступает type/lint-гейтом, прошла без ошибок).

## Technical Details

### Семантика «fire once»

`onBlind` вызывается строго при `consecutiveBlind === blindAlertAfter`. Так как
счётчик монотонно растёт (threshold, threshold+1, …), равенство достигается
ровно один раз за стрик → один алерт. Длинный отказ (как 26 ч в инциденте) даёт
**один** алерт, не спам. На первом удачном снимке `consecutiveBlind = 0` и
`alerted = false` → следующий стрик снова может сработать.

### Почему считаем и null, и throw

Реальный режим отказа — `osascript` после sleep/wake возвращает `null`/timeout
(provider их проглатывает → `null`). Поэтому `onError` (только на throw) не
ловит инцидент. Слепота = «нет данных в тике» независимо от причины → инкремент
и на `null`, и на throw.

### Sentinel runId: -1

`cognition_publish` ожидает `runId` от строки `cognition_handler_runs`. У
poller'а её нет. `-1` безопасен: `markPublished(-1)` → `UPDATE ... WHERE id=-1`
(0 строк), `firePublished(-1)` → нет callback'а. DM рендерится как
`💭 _from window-logger_\n<content>`. Минус: алерт не попадёт в
`cognition status/recentRuns` — приемлемо, warning-лог даёт observability.

### Диапазон env

`envInt(..., 10, 1, 2880)`: min 1 (можно алертить с первого слепого тика),
max 2880 (2880×30 с = 24 ч — здравый потолок). Вне диапазона → fallback к 10
(как и прочие WINDOW_LOGGER-переменные).

## Post-Completion

*Без чекбоксов — нужен живой macOS.*

- На рабочей машине с `WINDOW_LOGGER_ENABLED=true`: убрать Automation-доступ для
  System Events (System Settings → Privacy & Security → Automation), подождать
  ~5 мин (10 тиков) → убедиться, что приходит **один** Discord-DM «observer
  ослеп» и в логах есть `[window-logger] BLIND: ...`.
- Вернуть доступ → на следующем удачном снимке в логах
  `[window-logger] recovered after N blind ticks`, новые строки в
  `window_history` снова появляются, повторных DM нет.
- Подтвердить отсутствие спама при длительной слепоте (один DM на стрик).
