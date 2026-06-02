# Antizalipanie — реальные заголовки браузера + guard «не знаю»

## Overview

Distraction-pullback вживую прислал ложный пинг: «🧲 Ты ~104 мин в Google Chrome.
До этого: Неопределённая активность в Chrome». Диагностика по `distraction_evals`
+ `window_history` (2026-06-02):

- На **длинных** Chrome-двеллах `window_title` приходит **пустым** (`""`): текущий
  ран — 91 мин, 173 сэмпла, title `""`. Именно на нём сработал пинг (conf 72).
- Короткие соседние строки заголовки **ловят**: `«Уроки для Пети»`, `«Teplo —
  príprava na kontrolnú»`, `«zed редактор - Поиск в Google»` — это реальное дело
  (привязано к ремайндеру про Петю). → юзер, вероятно, был при деле.
- `Claude`-сессии судья верно метит `working` (conf 85, без пинга) — основная
  логика работает; проблема именно в слепоте на пустых заголовках.

**Корень:** `window-snapshot` берёт заголовок через generic System Events
`name of front window`; для Chrome в ряде состояний (статичная страница, видео,
app-mode) это `""`. Реальный заголовок активной вкладки не запрашивается. На
длинных двеллах — там, где и живёт залипание — судья слепнет и дефолтит в
«distracted / undefined» на пограничной уверенности → ложные пинги.

**Цель (2 части):**
1. **Реальный сигнал:** для браузеров брать заголовок активной вкладки через
   родной AppleScript-словарь браузера (надёжнее System Events AX).
2. **Guard:** дать судье вердикт `unknown` — когда сигнала нет/заголовки пустые,
   он явно говорит «не знаю» → пинга НЕ будет (вместо угадывания «distracted»).

## Scope

**In:**
- `window-snapshot.ts`: browser-aware захват заголовка. Для известных браузеров
  (Google Chrome, Safari — стартовый набор, расширяемая map) — заголовок активной
  вкладки через словарь браузера; фолбэк на System Events `name of front window`,
  если браузерный запрос пуст/недоступен.
- Корректная обработка отсутствия Automation-привилегии на браузер: не падать,
  фолбэк на старый путь, **один раз** залогировать подсказку (grant в System
  Settings → Privacy → Automation), как window-logger логирует blind.
- Судья: новый вердикт `unknown` (+ в `report_verdict` enum, `isValidVerdict`,
  `JudgeVerdict`, system-prompt-инструкция). Хэндлер трактует `unknown` как
  no-nudge (наравне с `break`/`working`), пишет eval c verdict='unknown'.
- Тесты: `parseSnapshot`/новый билд скрипта (браузер vs не-браузер vs фолбэк);
  судья отдаёт `unknown` → хэндлер skip; регресс существующих.

**Out:**
- Захват **URL** вкладки (не только title) — Future (приватность; title уже
  кратно улучшает сигнал, и существующая фича — titles-only by design).
- Браузеры помимо Chrome/Safari (Edge/Arc/Firefox) — добавляются одной строкой в
  map позже; в MVP только реально используемый Chrome + дешёвый Safari.
- Браузерное расширение (богатейший сигнал) — Future.
- Тюнинг порогов (`DISTRACTION_CONFIDENCE_PCT`, `DWELL_MIN`) — отдельно, не здесь.

## Current state

- `packages/server/src/observers/window-snapshot.ts` — единый AppleScript `SCRIPT`
  (System Events: frontApp + `name of front window`), `createOsascriptProvider`
  (execFile osascript, timeout 5s, `err → null`), `parseSnapshot` (split `|||`).
- `packages/server/src/observers/window-logger.ts` — поллер + blind-detection
  (`onBlind`), образец «логируем подсказку про Automation-привилегию».
- `packages/server/src/cognition/handlers/distractionPullback.judge.ts` —
  `JudgeVerdict = 'distracted'|'break'|'working'`, `VERDICT_TOOL` enum те же три,
  `isValidVerdict`, `SYSTEM_PROMPT` (уже с «сомневаешься — не distracted», но без
  escape «не знаю»), `buildJudgePrompt`, `judgeDistraction`.
- `packages/server/src/cognition/handlers/distractionPullback.ts` — хэндлер: при
  `verdict==='distracted' && confidence>=cutoff` → publish; иначе skip + recordEval.

## Design

### 1. Browser-aware заголовок (`window-snapshot.ts`)

Поток в `getActive()`:
1. **Call 1 — System Events** (как сейчас): `frontApp` + generic `frontTitle`.
   System Events уже разрешён, всегда работает.
2. Если `frontApp` ∈ `BROWSER_TITLE_SCRIPTS` (map имя→AppleScript), **Call 2** —
   родной словарь браузера:
   - Google Chrome: `tell application "Google Chrome" to get title of active tab of front window`
   - Safari: `tell application "Safari" to get name of current tab of front window`
3. Итоговый `window_title` = непустой результат Call 2, иначе generic из Call 1
   (фолбэк). Для не-браузеров Call 2 не делается (один вызов, как сейчас).

`WindowSnapshot`/`parseSnapshot` не меняются. Map даёт расширяемость (Edge/Arc —
позже одной строкой). Call 2 — отдельный `execFile`, чтобы JS поймал ошибку
привилегии (см. §Error), а не глотать её внутри AppleScript `try`.

### 2. Вердикт `unknown` (guard)

- `JudgeVerdict` → `'distracted' | 'break' | 'working' | 'unknown'`; `VERDICT_TOOL`
  enum + описание; `isValidVerdict` принимает 'unknown'.
- `SYSTEM_PROMPT` +абзац: «Если заголовки пустые/неинформативные и ты НЕ можешь
  понять, чем занят юзер — верни `unknown`. Это лучше, чем гадать `distracted`.»
- Хэндлер `distractionPullback.ts`: `unknown` обрабатывается как `break`/`working`
  — **no publish**, `recordEval(verdict='unknown')`. Пинг только на уверенном
  `distracted` (как и было). Так пустой Chrome-двелл → `unknown` → тишина, а не
  ложный «distracted».

Связка двух частей: §1 даёт судье реальные заголовки (меньше слепоты вообще), §2
ловит остаток (когда заголовок всё же пуст — видео/недоступная вкладка) → нет
ложных пингов «Неопределённая активность».

## Error / permission handling

- **Браузерная Automation-привилегия не выдана:** Call 2 (`tell application
  "Google Chrome"…`) → osascript error (-1743 not authorized). JS ловит → НЕ
  падает, использует generic title из Call 1, и **один раз** логирует подсказку:
  `[window-snapshot] нет Automation-привилегии на Google Chrome — заголовки вкладок
  будут пустыми; grant: System Settings → Privacy & Security → Automation`.
  (Латч «логировали уже», чтобы не спамить каждый тик.)
- **Браузер без открытого окна / ошибка скрипта:** Call 2 пусто/ошибка → фолбэк на
  generic. Никогда не роняет поллер (как сейчас `err → null`).
- Существующий blind-detection поллера не трогаем.

## Testing

- `window-snapshot`: билдер скрипта/парс для (а) не-браузер → один System Events
  путь; (б) браузер с непустым tab-title → берём его; (в) браузер, Call 2 пусто →
  фолбэк на generic; (г) Call 2 error (привилегия) → фолбэк + флаг подсказки
  выставлен один раз. (execFile мокается, как в существующих window-snapshot тестах.)
- `judge`: `unknown` проходит `isValidVerdict`; `buildJudgePrompt` стабилен;
  `judgeDistraction` возвращает `unknown` при соответствующем tool-ответе.
- `distractionPullback` handler: `unknown` → skip + eval записан, НЕ publish;
  `distracted`+conf≥cutoff → по-прежнему publish.
- Регресс: существующие distraction/window-snapshot тесты зелёные.

## Decisions / defaults

- Браузеры в MVP: **Chrome + Safari** (Chrome — реально используемый; Safari —
  дёшево). Остальные — map-расширение позже.
- Захват **только title**, не URL (приватность; консистентно с titles-only).
- Permission-фейл = тихий фолбэк + одноразовый лог, не Discord-алерт (не шумим).
- Пороги уверенности/dwell не трогаем — сначала чиним сигнал.

## Future

- URL/домен вкладки как доп.сигнал (приватность-режим).
- Edge/Arc/Firefox в map.
- Браузерное расширение — самый богатый и надёжный сигнал (видит вкладки/прогресс
  напрямую), если AppleScript-пути окажется мало.
