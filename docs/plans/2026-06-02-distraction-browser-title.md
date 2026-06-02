# Antizalipanie — реальные заголовки браузера + guard 'unknown'

## Overview

Чиним ложный distraction-пинг («~104 мин в Chrome, Неопределённая активность»):
на длинных Chrome-двеллах `window_title` пустой (System Events отдаёт `""`), судья
слепнет и гадает `distracted`. Две части: (1) брать реальный заголовок активной
вкладки через родной AppleScript браузера (Chrome/Safari), (2) дать судье вердикт
`unknown` — при пустом сигнале молчать, а не гадать.

**Источник истины — спека:**
[docs/superpowers/specs/2026-06-02-distraction-browser-title-design.md](../superpowers/specs/2026-06-02-distraction-browser-title-design.md).
При расхождении — права спека; план обновляем.

## Context (from discovery)

- `packages/server/src/observers/window-snapshot.ts` — `SCRIPT` (System Events: frontApp + `name of front window`), `createOsascriptProvider().getActive()` (execFile osascript, timeout 5s, `err → null`), `parseSnapshot` (split `|||`), `WindowSnapshot`.
- `packages/server/src/observers/__tests__/window-snapshot.test.ts` — существующие тесты, мокают execFile/parse.
- `packages/server/src/cognition/handlers/distractionPullback.judge.ts` — `JudgeVerdict = 'distracted'|'break'|'working'`, `VERDICT_TOOL` (enum те же три), `isValidVerdict`, `SYSTEM_PROMPT`, `JudgeResult`, `judgeDistraction`, `buildJudgePrompt`.
- `packages/server/src/cognition/handlers/distractionPullback.ts` — publish-гейт `verdict==='distracted' && confidence>=cutoff`; иначе skip + `recordEval`.
- Тесты судьи/хэндлера: `cognition/__tests__/handlers/distractionPullback.judge.test.ts`, `distractionPullback.test.ts`.
- `window-logger.ts` — образец «логировать подсказку про Automation-привилегию» (onBlind).

## Development Approach

- **Testing approach: Regular** — код, затем тесты в той же задаче (как в репо).
- Каждую задачу до конца перед следующей; маленькие фокусные изменения.
- **CRITICAL: каждая задача включает новые/обновлённые тесты** (success + error), отдельными чекбоксами.
- **CRITICAL: все тесты зелёные перед следующей задачей.**
- **CRITICAL: при изменении скоупа — обновить план.**
- Команда тестов: `npm test --workspace packages/server`; typecheck: `npm run build --workspace packages/server -- --noEmit`.
- Backward-compat: не ломать существующие window-snapshot / distraction тесты.

## Testing Strategy

- **Unit-тесты** — в каждой задаче. window-snapshot: мок `execFile` (как в существующих тестах) под разные ветки. judge/handler: мок tool-ответа anthropic / injected judge.
- **E2E:** вход R2 — Discord; реальная проверка пинга — ручная (Post-Completion), требует macOS + Chrome Automation-привилегии.

## Progress Tracking

- `[x]` сразу; ➕ новые задачи; ⚠️ блокеры. Держать в синхроне.

## What Goes Where

- **Implementation Steps** (`[ ]`) — код/тесты/доки в репо.
- **Post-Completion** — выдача Chrome/Safari Automation-привилегии, ручная проверка на живом Mac, деплой.

## Implementation Steps

### Task 1: Browser-aware захват заголовка вкладки (`window-snapshot.ts`)

- [x] добавить `BROWSER_TITLE_SCRIPTS: Record<string,string>` — имя приложения → AppleScript активной вкладки: `Google Chrome` (`tell application "Google Chrome" to get title of active tab of front window`), `Safari` (`tell application "Safari" to get name of current tab of front window`)
- [x] в `getActive()`: Call 1 — System Events (frontApp + generic title, как сейчас); если `frontApp` ∈ map → Call 2 (отдельный `execFile` с браузерным скриптом); итоговый `window_title` = непустой Call 2, иначе generic из Call 1 (фолбэк); для не-браузеров Call 2 не делать
- [x] обработка Call 2 error (нет Automation-привилегии / нет окна): не падать, фолбэк на generic; **один раз** залогировать подсказку (латч), формат как у window-logger blind (`System Settings → Privacy & Security → Automation`)
- [x] не менять `WindowSnapshot`/`parseSnapshot`; сохранить timeout/`err→null` семантику
- [x] тесты (мок execFile): не-браузер → один System Events путь; браузер с непустым tab-title → берём его; браузер, Call 2 пусто → фолбэк на generic; Call 2 error → фолбэк + подсказка залогирована ровно один раз
- [x] прогнать тесты — зелёные перед Task 2

### Task 2: Вердикт `unknown` у судьи + no-nudge в хэндлере

- [x] `distractionPullback.judge.ts`: `JudgeVerdict` += `'unknown'`; `VERDICT_TOOL` enum += `'unknown'` (+ описание); `isValidVerdict` принимает `'unknown'`
- [x] `SYSTEM_PROMPT`: +инструкция «если заголовки пустые/неинформативные и не можешь понять, чем занят юзер — верни `unknown` (лучше, чем гадать `distracted`)»
- [x] `distractionPullback.ts`: убедиться, что `unknown` идёт в no-publish ветку (только `distracted && conf>=cutoff` публикует), `recordEval(verdict='unknown')`; правка только если где-то есть явный switch/проверка по вердикту — логика не требовала правок (гейт уже `distracted && conf>=cutoff`); добавлен `'unknown'` в `DistractionVerdict` (eval-store) для типизации
- [x] тесты judge: `unknown` проходит `isValidVerdict`; `judgeDistraction` возвращает `unknown` при таком tool-ответе; `buildJudgePrompt` содержит инструкцию про unknown
- [x] тесты handler: `unknown` → skip + eval записан, НЕ publish; `distracted`+conf≥cutoff → по-прежнему publish (регресс)
- [x] прогнать тесты — зелёные перед Task 3

### Task 3: Verify acceptance criteria

- [ ] проверить: браузерный заголовок берётся (Chrome/Safari), фолбэк работает, permission-fail не роняет; `unknown` → нет пинга
- [ ] прогнать полный unit-набор (`packages/server`)
- [ ] typecheck (`tsc --noEmit`) — чисто
- [ ] линтер — все вопросы исправить
- [ ] покрытие новых/изменённых модулей по стандарту проекта

### Task 4: Документация

- [ ] обновить секцию Digital Observer / distraction в `README.md` и `AGENTS.md`: window-snapshot теперь берёт заголовок вкладки браузера (Chrome/Safari), и для этого нужна **отдельная Automation-привилегия** на браузер (помимо System Events); без неё — тихий фолбэк на пустой заголовок
- [ ] зафиксировать в доках вердикт `unknown` (судья молчит при отсутствии сигнала)

## Technical Details

- Два `execFile` для браузеров (System Events для frontApp + браузерный словарь для tab-title) — намеренно раздельно, чтобы JS поймал ошибку Automation-привилегии (а не глотать в AppleScript `try`) и залогировал подсказку.
- Заголовок — только title, без URL (приватность, см. спеку Future).
- `unknown` не публикует по той же ветке, что `break`/`working`; пинг — только уверенный `distracted`.
- Map браузеров расширяема (Edge/Arc/Firefox — позже одной строкой).

## Post-Completion

*Ручные шаги — без чекбоксов.*

**Automation-привилегия (обязательно для реальных заголовков):** на живом Mac выдать
R2/node право управлять **Google Chrome** (и Safari, если нужен) — System Settings →
Privacy & Security → Automation → node/R2 → отметить браузер. Без неё заголовки
вкладок останутся пустыми (фолбэк), и судья будет чаще возвращать `unknown`.

**Ручная проверка:** залипнуть в Chrome на статичной странице/видео ≥25 мин →
заголовок вкладки попадает в `window_history` (не пусто), судья видит контент;
на пустом/недоступном заголовке — `unknown`, пинга нет.

**Деплой:** по flow — `dev→master` + `git push origin master` (supervisor авто-рестарт).
