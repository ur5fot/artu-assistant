# Distraction pullback — restore button (Digital Observer iter-2)

**Date:** 2026-06-26
**Epic:** Digital Observer (iter-2) / EPIC 7 Action Engine (digital)
**Status:** approved design

## Цель

Когда `distractionPullback` пингует «вернись к работе», дать кнопку, которая
одним тапом возвращает рабочую поверхность, от которой отвлёкся пользователь:
фокус work-приложения, а если это была вкладка браузера — открыть её URL.

Это первое **реальное действие** Digital Observer. До сих пор он только наблюдал
(active-window logger) и нудил (pullback). Восстановление — это action.

### Контекст / история

Проект ушёл от пассивной модели «вернулся → restore?» (`contextSwitch`,
`CONTEXT_SWITCH_ENABLED` default off) к проактивному `distractionPullback`
(2026-06-02). Поэтому restore строим **внутри live-флоу pullback**, а не
оживляем deprecated `contextSwitch`.

Данные, которыми располагаем: `window_history` пишет **только активное окно**
(app + title + host/path URL для браузеров), один foreground за раз. Полного
набора фоновых вкладок/файлов нет — значит restore оперирует тем, что реально
было в фокусе.

## Scope

В scope:
- Эвристика «доминирующей рабочей поверхности» перед отвлечением.
- Store-метод для её вычисления.
- macOS executor (`open`-обёртка) для фокуса app + открытия URL.
- Кнопка в pullback-нудже + обработка клика в `interactions.ts`.
- Feature flag (default off), тесты.

Вне scope (YAGNI):
- Полный набор фоновых вкладок / открытых файлов / terminal cwd.
- Восстановление query/fragment части URL (храним host+path).
- Мульти-поверхность restore (несколько окон сразу).
- Оживление `contextSwitch`.

## Что считаем «рабочей поверхностью»

Доминирующая поверхность в work-периоде непосредственно перед dwell:

- Берём строки `window_history` с `started_at` в `[runStart − workLookbackMin, runStart)`.
- Исключаем app отвлечения (`excludeApp`).
- Группируем по `(app, url)` (url может быть `NULL` для не-браузеров).
- Берём группу с максимальной суммарной длительностью фокуса
  `Σ(last_seen_at − started_at)`.
- Браузерная вкладка → группа имеет `url` (host/path). Обычное приложение
  (VS Code, терминал) → `url` отсутствует.
- Если строк нет / всё исключено — возвращаем `null` (кнопки не будет).

Обоснование: то, на чём пользователь провёл больше всего времени в фокусе
перед тем как отвлечься, — лучший доступный сигнал «это была работа». Структурного
work/leisure лейбла на уровне строк `window_history` нет (его знает только LLM-judge
как прозу `work_summary`), поэтому эвристика по суммарной длительности.

## Архитектура / компоненты

### 1. Store-метод

`WindowHistoryStore.findDominantWorkSurfaceBefore(beforeTs, lookbackMs, excludeApp)`
→ `{ app: string; url?: string } | null`.

Чистый SQL-агрегат поверх `window_history`. Группировка по `(app_name, url)`,
`SUM(last_seen_at - started_at)` как вес, `ORDER BY weight DESC LIMIT 1`,
`WHERE started_at >= ? AND started_at < ? AND app_name != ?`. `url` может быть
`NULL` — в результате тогда `url` отсутствует. Тестируется изолированно.

### 2. Executor

Новый модуль `packages/server/src/observers/window-restore.ts` (сосед
`window-snapshot.ts` — оба macOS-обёртки Digital Observer).

Принципиально **без AppleScript** — только `execFile('open', args)`, аргументы
передаются массивом (не shell-строкой), чтобы исключить инъекцию имени app / URL:

- target c `url` → `execFile('open', ['-a', app, 'https://' + url])`
  (открывает/поднимает вкладку в этом браузере и фокусирует его);
- target без `url` → `execFile('open', ['-a', app])` (фокус приложения).

`exec` инъектируется (для тестов default — реальный `execFile`). Провал `open`
(ненулевой код / timeout) → возвращает структурированный результат-ошибку
(`{ ok: false, reason }`), **не throw**. Сигнатура примерно:

```
restoreWorkSurface(target: { app: string; url?: string }, opts?): Promise<{ ok: boolean; reason?: string }>
```

### 3. Сборка нуджа

В `distractionPullback.run()`, после того как принято решение пинговать
(`shouldPing`), вычисляем target через `findDominantWorkSurfaceBefore(runStart,
workLookbackMin * 60_000, candidate.app)`.

`buildDistractionNudge` получает опциональный `restoreTarget`; если он есть —
добавляет кнопку:

- `customId = distract:restore:<app>:<runStart>` — несёт **app отвлечения +
  runStart** (тот же dwell-ключ, что у `work`/`done`/`snooze`); `parseAppDwell`
  уже умеет это парсить. URL в customId **не** кладём (длина / 100-char лимит) —
  при клике поверхность пере-выводим заново.
- лейбл `↩️ Вернуть: <app>` (app здесь — имя work-приложения из target,
  усечённое под лимит лейбла).
- overflow-guard как у остальных кнопок: если customId > лимита — кнопка
  дропается, остальные и текст выживают.

Если `restoreTarget === null` — кнопки нет (старое поведение нуджа без изменений).

### 4. Обработка клика

В `interactions.ts`, ветка `action === 'restore'` внутри `handleDistractFeedback`:

1. `parseAppDwell(rawId)` → `{ app: distractionApp, runStart }`.
2. `findDominantWorkSurfaceBefore(runStart, lookbackMs, distractionApp)` —
   **defensive re-derive** (в духе текущего «re-detect at run time»; данные могли
   измениться между сборкой и кликом).
3. target есть → `restoreWorkSurface(target)` → ephemeral-ответ
   `↩️ Открыл <app>` или `↩️ Открыл <app> · <url>`.
4. target нет (гонка) → ephemeral `Не нашёл рабочий контекст для восстановления.`
5. executor вернул `ok:false` → ephemeral `Не смог открыть <app>.` + лог.

Ответ ephemeral (как `window:show`) — исходный нудж остаётся видимым в DM.

Дотянуть в `InteractionDeps`: `windowHistoryStore` (уже есть), executor-функция,
`distractionWorkLookbackMin` (с дефолтом-fallback, как `distractionSnoozeMin`).

### 5. Feature flag

`DISTRACTION_RESTORE_ENABLED` (env, default `false`, macOS-only). Шипим dark;
включается на машине, где работает `open`. Зеркалит паттерн `WINDOW_LOGGER_ENABLED`.
При выключенном флаге кнопка не рендерится и ветка `restore` не активна.

## Data flow

```
window-logger (foreground samples) → window_history
                                          │
distractionPullback.run() (shouldPing) ──┤
   findDominantWorkSurfaceBefore(runStart,…) → target?
                                          │
   buildDistractionNudge(+restoreTarget) → Discord button (distract:restore:app:runStart)
                                          │  user taps
   interactions.ts handleDistractFeedback('restore')
   → re-derive target → window-restore executor → `open -a app [url]`
   → ephemeral ack
```

## Privacy / safety (EPIC 8)

- Действие **user-initiated** (явный тап кнопки), low-risk, обратимое (просто
  фокус / открытие уже виденного пользователем URL). Отдельного confirm-шага
  не требует.
- URL — host/path без query/fragment (уже так хранится).
- Имя app и URL идут из нашей БД и передаются в `open` как exec-аргументы массивом
  → нет shell/AppleScript-инъекции.
- За feature-флагом (default off).

## Edge-кейсы

| Случай | Поведение |
|---|---|
| work-поверхность == app отвлечения | исключаем через `excludeApp` |
| в lookback нет ничего значимого | target=null → кнопки нет |
| target найден при сборке, исчез к клику | ephemeral «не нашёл», без действия |
| `open` упал / timeout | `ok:false` → ephemeral-ошибка + лог |
| не-macOS | флаг off, executor не зовётся |
| пафологически длинный app-name (customId > лимита) | кнопка дропается, текст и прочие кнопки выживают |
| work-app == текущее окно | всё равно фокусируем (no-op для юзера, безвредно) |

## Тестирование

- **store**: `findDominantWorkSurfaceBefore` — выбор доминанта по суммарной
  длительности, исключение app отвлечения, NULL-url → без url, пусто → null.
- **executor**: правильные `open`-аргументы для url / без-url; провал exec →
  `ok:false`; имя app с пробелами/спецсимволами передаётся как один аргумент.
- **нудж**: кнопка присутствует при target, отсутствует при null; форма customId;
  overflow-guard.
- **interactions**: ветка `restore` зовёт executor с re-derived target;
  ephemeral-тексты для успеха / нет-target / ошибки; гонка (target исчез).

## Acceptance criteria

1. При активном `DISTRACTION_RESTORE_ENABLED` и наличии work-поверхности нудж
   несёт кнопку `↩️ Вернуть: <app>`.
2. Тап кнопки фокусирует work-app (и открывает URL, если он браузерный) на
   macOS, отвечает ephemeral-ack, исходный нудж не трогает.
3. Нет work-поверхности → кнопки нет; нудж работает как раньше.
4. Флаг off → ни кнопки, ни ветки; поведение pullback без изменений.
5. Все ошибки (нет target, провал `open`) → ephemeral-сообщение, не throw,
   не ломают остальные кнопки.
6. Зелёный весь тестовый набор + новые тесты выше.
