# Presence/idle tracking — не считать «отошёл» активностью + отчитываться о присутствии

## Overview

Тулза `activity` (shipped 2026-06-06) показала за день `total_active_min ≈ 1178`
(~19.6 ч) — потому что Digital Observer трекает **сфокусированное окно**, а не
активность ввода. Ночной прогон «Chrome · YouTube — 566 мин» (юзер спал с видео в
фокусе) посчитан активным. Усугубляет `recordSample`: он продлевает сессию по
совпадению `(app, title)` **игнорируя временной разрыв**
([window-history-store.ts:113](../../../packages/server/src/observers/window-history-store.ts#L113)),
так что возврат к тому же видео «сшивает» разрыв.

**Цель:** научить наблюдателя различать присутствие. При системном idle ≥ порога
юзер «отошёл»: это время НЕ идёт в активность, а пишется как away-период, чтобы R2
отвечал «активно X, отошёл Y (N отлучек)».

Под vision (наблюдать **человека** — присутствие). Решения юзера: трекать away
(не просто исключать) + хранить в **отдельном** presence-логе.

## Scope

**In:**

- `idle-source` — модуль системного idle (macOS `ioreg HIDIdleTime`), инжектируемый.
- Логгер: idle-проверка каждый тик; AWAY (idle ≥ порога) → не писать window-сэмпл +
  открыть/вести away; ACTIVE → `recordSample` + закрыть away-спан.
- `recordSample` gap-aware split: не продлевать сессию через разрыв > `maxGap`.
- `presence-store` + таблица `presence_log` (away-спаны).
- `buildActivityDigest` / тулза `activity`: `away_min`, `away_spans`, summary с «отошёл».
- Проводка в `index.ts` + конфиг (env), гейт `WINDOW_LOGGER_ENABLED`.

**Out (осознанно):**

- Ретроактивная правка истории — существующую 566-мин строку НЕ переписываем; фикс
  forward-looking (новые данные + presence_log со дня деплоя).
- Тримминг ~5-мин «хвоста» сессии до ухода (между последним вводом и пересечением
  порога) — Future-уточнение (см. Future), в v1 принимаем мелкий перекос.
- Не-macOS idle — `getIdleSeconds` вернёт `null` → активным (наблюдатель и так
  macOS-only через osascript).
- detector/distraction idle-aware — побочно выигрывают от gap-split, отдельно не
  трогаем.

## Current state

- Логгер ([window-logger.ts](../../../packages/server/src/observers/window-logger.ts)):
  self-scheduling loop, тик = `provider.getActive()` → `store.recordSample({...snap,
  sampled_at})`. Есть blind-detection (null/throw N тиков). Idle-сигнала НЕТ.
- `recordSample` ([window-history-store.ts:113](../../../packages/server/src/observers/window-history-store.ts#L113)):
  если latest-строка совпадает по `(app_name, window_title)` — UPDATE `last_seen_at`
  **независимо от разрыва** (отсюда бридж). Иначе INSERT.
- Стор: `findRowsInWindow(from,to,limit)`, `recordSample`, `purgeOlderThan` и т.д.
- macOS idle: `ioreg -c IOHIDSystem` → `HIDIdleTime` (наносекунды) — проверено,
  дёшево, без доп. прав.
- Тулза `activity` / `buildActivityDigest` ([packages/tool-activity](../../../packages/tool-activity/src/digest.ts)):
  суммирует сессии в окне; `ActivityDigest` уже отдаётся агенту.
- `context_pings` (context-switch-detector) — про app-отсутствие, НЕ про input-idle;
  не переиспользуем.

## Design

### 1. `idle-source` (`observers/idle-source.ts`)

`IdleSource = { getIdleSeconds(): Promise<number | null> }`. Реализация:
`ioreg -c IOHIDSystem`, regex `HIDIdleTime` → ns → `Math.round(ns/1e9)`. Любой сбой
(не-macOS, throw, не распарсилось) → `null`. Инжектируется в логгер (мок в тестах),
как `WindowSnapshotProvider`.

### 2. Логгер — presence state machine

В `startWindowLogger` добавить dep `idleSource` + `presence` (стор) + порог. Состояние
тика (после получения снапшота):
- `idleSec = await idleSource.getIdleSeconds()` (null → трактуем как active).
- **AWAY** (`idleSec != null && idleSec ≥ thresholdSec`):
  - НЕ `recordSample` (window_history не растёт).
  - Если `awayStartedAt == null` → `awayStartedAt = now − idleSec*1000` (бэкдейт к
    последнему вводу; не раньше последнего активного сэмпла).
- **ACTIVE** (иначе):
  - Если `awayStartedAt != null` → `presence.recordAway(awayStartedAt, now)`;
    `awayStartedAt = null`.
  - `recordSample` как сейчас.

Idle-проверка не влияет на blind-detection (blind = снапшот null/throw — отдельная
ось). Away — это «видим экран, но юзера нет».

### 3. `recordSample` gap-aware split

Параметр `maxGapMs` (из конфига). В `recordSample`: продлевать latest-строку только
если `(app,title)` совпали **И** `sample.sampled_at − latest.last_seen_at ≤ maxGapMs`;
иначе INSERT новой строки. Возврат к тому же окну после away/сна/blind → новая
сессия, не бридж. Это устраняет корень 566-мин для новых данных.

### 4. `presence-store` + `presence_log`

Таблица `presence_log (id, away_started_at INTEGER, away_ended_at INTEGER)`,
индекс по `away_ended_at`. Стор:
- `recordAway(from, to)` — INSERT закрытого спана (`to > from`).
- `listAwayInWindow(from, to)` — спаны, пересекающие окно (для дайджеста).
- `purgeOlderThan(cutoff)` — как у window-history.

v1 пишет только **закрытые** спаны (на возврате). Текущий незакрытый away (юзер ещё
не вернулся) в таблицу не идёт — для «что я делал» это «сейчас», не история.

### 5. Дайджест / тулза `activity`

`buildActivityDigest(rows, evals, awaySpans, range)`:
- `away_min` — сумма пересечений away-спанов с `range`.
- `away_spans` — `[{from, to, min}]` (клампленные к range).
- `summary` — добавляет «активно ~X, отошёл ~Y (N отлучек)».
- `total_active_min` — без изменений в формуле, но реалистичен (логгер не тянет idle
  + gap-split).

Хэндлер тулзы инжектит `presenceStore`, читает `listAwayInWindow(range)`.

### 6. Проводка / конфиг

`index.ts`: построить `idleSource` (реальный ioreg) + `presenceStore`
(`createPresenceStore({db})`); передать в `startWindowLogger` и в deps
`discoverTools` (`presence` для тулзы). Всё под `WINDOW_LOGGER_ENABLED`.
Env (`envInt`): `IDLE_THRESHOLD_SEC` (дефолт 300, 60..3600),
`WINDOW_SESSION_MAX_GAP_MS` (дефолт 90000, 35000..600000).

## Decisions / defaults

- **Трекать away, не просто исключать** (выбор юзера) → presence_log + отчёт.
- **Отдельная таблица** (выбор юзера) — чистое разделение «что» (window_history) vs
  «присутствие» (presence_log).
- **Порог idle 300с / maxGap 90с** — дефолты, env-настраиваемые.
- **Forward-looking** — историю не переписываем (риск + YAGNI).
- **Бэкдейт awayStart по `idleSec`** — точная граница ухода без доп. данных.

## Testing

- **idle-source**: парс `HIDIdleTime` ns→сек; мусор/не-macOS → `null` (мок exec).
- **Логгер** (мок `idleSource`/`presence`/`store`): active→away (нет recordSample,
  awayStart бэкдейт), away→active (recordAway вызван с [awayStart, now], recordSample),
  непрерывный active (recordSample каждый тик), idle=null → active.
- **recordSample**: продлевает в пределах maxGap; INSERT за пределом даже при том же
  `(app,title)`; обычная смена title — как раньше.
- **presence-store**: recordAway/listAwayInWindow (пересечение окна)/purge.
- **digest**: `away_min`/`away_spans` (клампинг к range), summary с «отошёл», пустые
  away.
- **Acceptance (честно)**: now = unit + симуляция тиков (idle-данных в БД ещё нет).
  Живая проверка «отошёл Y» — после деплоя + день реального сбора presence_log. НЕ
  выдаю unit за живую проверку away.

## Future (осознанно отложено)

- Тримминг активной сессии до `now − idleSec` при детекте away (убрать ~5-мин хвост
  до пересечения порога) — точность, отложено.
- «Сейчас отошёл N мин» (открытый away) в ответах. Презентация присутствия в
  morningBrief. Idle-aware detector/distraction (не дёргать сразу после возврата).
