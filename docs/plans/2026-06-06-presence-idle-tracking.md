# Presence/idle tracking — не считать «отошёл» активностью + отчитываться о присутствии

## Overview
Тулза `activity` показала ~19.6ч «активности» за день — наблюдатель трекает
сфокусированное окно, а не активность ввода (ночной YouTube в фокусе посчитан
активным; `recordSample` сшивает разрыв по совпадению app/title).

Фикс: при системном idle ≥ порога юзер «отошёл» — время не идёт в активность, а
пишется в отдельный `presence_log`, чтобы R2 отвечал «активно X, отошёл Y (N отлучек)».
`recordSample` становится gap-aware (не сшивает сессию через разрыв).

Спек: `docs/superpowers/specs/2026-06-06-presence-idle-tracking-design.md`.

## Context (from discovery)
- Логгер `packages/server/src/observers/window-logger.ts` — self-scheduling loop,
  тик = `provider.getActive()` → `store.recordSample({...snap, sampled_at})`;
  blind-detection (null/throw). Idle-сигнала нет.
- `recordSample` `packages/server/src/observers/window-history-store.ts:113` —
  продлевает latest-строку по совпадению `(app_name, window_title)` независимо от
  разрыва (корень бриджа). API: `findRowsInWindow`, `purgeOlderThan` и т.д.
- macOS idle: `ioreg -c IOHIDSystem` → `HIDIdleTime` (ns) — проверено, дёшево.
- Тулза `packages/tool-activity/src/digest.ts` — `buildActivityDigest(rows, evals,
  range)`; инжект сторов в `index.ts` через `discoverTools` (gate `WINDOW_LOGGER_ENABLED`).
- БД-миграции: `packages/server/src/db.ts` (CREATE TABLE IF NOT EXISTS паттерн).
- Конфиг: `envInt` в `index.ts`.

## Development Approach
- **Testing approach**: TDD — тесты первыми (red), потом реализация (green).
- Аддитивно где можно; изменение `recordSample` — поведенческое (gap-split),
  прикрыто существующими сьютами detector/distraction (должны остаться зелёными).
- Каждая задача завершается тестами (success + edge) и зелёным прогоном.
- **Backward-compat**: `recordSample`/`buildActivityDigest` меняют сигнатуру —
  обновить всех вызывающих и их тесты в той же задаче.

## Testing Strategy
- **Unit** на каждую задачу: idle-source (парс/ошибки), gap-split, presence-store,
  логгер (моки idle/presence/store, переходы), digest (away_min/spans/summary).
- **Регресс**: detector (16) / distraction-eval-store (18) / distractionPullback (9)
  / весь server-сьют (1714) — зелёные после изменения `recordSample`.
- **Acceptance (честно)**: unit + симуляция тиков. Живых idle-данных в БД ещё нет —
  «отошёл Y» проверяется после деплоя + день сбора `presence_log`. НЕ выдаём unit за
  живую проверку away.

## Progress Tracking
- `[x]` сразу по завершении. ➕ новые задачи, ⚠️ блокеры. План в синхроне с работой.

## What Goes Where
- **Implementation Steps** (`[ ]`): код, тесты, миграция, проводка, доки.
- **Post-Completion** (без чекбоксов): деплой-флоу, живая проверка away через день.

## Implementation Steps

### Task 1: idle-source (macOS HIDIdleTime)
- [x] `observers/idle-source.ts`: `IdleSource = { getIdleSeconds(): Promise<number|null> }`
      + реализация через `ioreg -c IOHIDSystem` (regex `HIDIdleTime` → ns → сек,
      инжектируемый exec-runner для тестов)
- [x] любой сбой/не-macOS/непарс → `null`
- [x] write tests: корректный парс ns→сек; мусор/пустой вывод/throw → null (мок exec)
- [x] run `npm test` (packages/server) — must pass before next task

### Task 2: recordSample gap-aware split
- [x] `window-history-store.ts`: `recordSample` принимает `maxGapMs` (через фабрику
      `createWindowHistoryStore({db, maxGapMs})` или параметр) — продлевать latest
      только если `(app,title)` совпали И `sampled_at − last_seen_at ≤ maxGapMs`,
      иначе INSERT
- [x] обновить вызывающих (логгер) и существующие тесты стора под новую семантику
      (фабрика взяла дефолт maxGap 90с — логгер/index.ts вызывают как раньше; env-проводка в Task 6)
- [x] write tests: продление в пределах maxGap; INSERT за пределом при том же
      (app,title); обычная смена title — как раньше; дефолт maxGap
- [x] run `npm test` — detector/distraction сьюты зелёные — must pass before next task

### Task 3: presence-store + таблица presence_log
- [ ] `db.ts`: `CREATE TABLE IF NOT EXISTS presence_log (id, away_started_at INTEGER,
      away_ended_at INTEGER)` + индекс по `away_ended_at`
- [ ] `observers/presence-store.ts`: `createPresenceStore({db})` → `recordAway(from,to)`,
      `listAwayInWindow(from,to)` (спаны, пересекающие окно), `purgeOlderThan(cutoff)`
- [ ] write tests: recordAway (to>from); listAwayInWindow (пересечение/границы); purge
- [ ] run `npm test` — must pass before next task

### Task 4: логгер — presence state machine
- [ ] `window-logger.ts`: добавить deps `idleSource`, `presence`, `idleThresholdSec`;
      каждый тик: `idleSec = getIdleSeconds()`; AWAY (idleSec≥порог): не recordSample,
      если awayStart==null → `awayStart = now − idleSec*1000` (не раньше last active);
      ACTIVE (иначе/null): если awayStart!=null → `presence.recordAway(awayStart, now)`
      + reset; recordSample
- [ ] idle-проверка не трогает blind-detection
- [ ] write tests (моки idle/presence/store): active→away (нет recordSample, awayStart
      бэкдейт), away→active (recordAway с [awayStart,now] + recordSample), непрерывный
      active (recordSample каждый тик), idleSec=null → active
- [ ] run `npm test` — must pass before next task

### Task 5: away в дайджесте/тулзе activity
- [ ] `digest.ts`: `buildActivityDigest(rows, evals, awaySpans, range)` — `away_min`
      (Σ пересечений с range), `away_spans:[{from,to,min}]` (клампинг), summary +
      «активно ~X, отошёл ~Y (N отлучек)»; типы в `types.ts`
- [ ] `index.ts` тулзы: handler инжектит `presence`, читает `listAwayInWindow(range)`,
      передаёт в digest; обновить deps-тип `ActivityDeps`
- [ ] write tests: away_min/spans (клампинг к range, пересечения); summary с away;
      пустые away → без «отошёл»
- [ ] run `npm test` — must pass before next task

### Task 6: проводка index.ts + конфиг
- [ ] `index.ts`: построить `idleSource` (реальный ioreg) + `presenceStore`; передать
      в `startWindowLogger` (idleSource/presence/порог) и в deps `discoverTools`
      (`presence` для тулзы); всё под `WINDOW_LOGGER_ENABLED`
- [ ] env: `IDLE_THRESHOLD_SEC` (300, 60..3600), `WINDOW_SESSION_MAX_GAP_MS`
      (90000, 35000..600000) через `envInt`; пробросить maxGap в стор
- [ ] write/extend тесты проводки если тестируемо; иначе подтвердить сборкой
- [ ] run `npm test` + `npx tsc --noEmit` (packages/server) — must pass before next task

### Task 7: Verify acceptance & build
- [ ] verify: симуляция тиков active↔away → presence_log + digest away_min корректны
- [ ] verify: gap-split — новая сессия после разрыва (unit на реальных таймстампах)
- [ ] run full suite (`npm test`) — all green (вкл. detector/distraction регресс)
- [ ] `npx tsc --noEmit` (packages/server) — без type-ошибок
- [ ] update README/AGENTS если описывают наблюдатель/тулзу activity

## Technical Details
- `getIdleSeconds`: `ioreg -c IOHIDSystem`, `HIDIdleTime` ns → `Math.round(ns/1e9)`.
- Away state machine в логгере: одно поле `awayStartedAt: number|null`.
- `presence_log`: только закрытые спаны (на возврате); открытый away в таблицу не идёт.
- `away_min` в дайджесте = Σ `max(0, min(to,range.to) − max(from,range.from))` / 60000.
- Дефолты: idle 300с, maxGap 90с (3× интервал 30с).
- Forward-looking: история (566-мин строка) не переписывается.

## Post-Completion
*Informational only*

**Deploy** (per flow): sync `dev`←`master`; ralphex на `dev`; `dev`→`master` +
`git push origin master`; **остаться на `master`**; supervisor авто-рестарт.

**Живая проверка (через день сбора):** спросить R2 «что я делал сегодня» — ожидать
реалистичное активное время + «отошёл Y (N отлучек)», ночной фон больше не раздувает.
Idle-данные `presence_log` копятся только со дня деплоя.
