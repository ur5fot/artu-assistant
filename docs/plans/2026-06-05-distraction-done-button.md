# distractionPullback — кнопка «✅ Закончил» (завершил задачу ≠ отвлёкся)

## Overview

`distractionPullback` шлёт пуш «🧲 Ты ~N мин в X… Вернёшься?», когда judge решает `distracted`. Слепая зона: judge видит только таймлайн `app·title·duration` и рассуждает «дрейфанул ли из работы» — у него **нет понятия «задача завершена»**. Поэтому «бросил дело на полпути» (отвлечение) и «доделал → пошёл дальше» (легитимно) выглядят одинаково → ложное «Вернёшься?».

**MVP (iter-1):** добавить кнопку **«✅ Закончил»** рядом с `Возвращаюсь / Это по работе / Отстань на 60м`. По клику R2 подтверждает и **пишет сигнал `feedback='done'`** в `distraction_evals`. Это снимает боль сразу (точный ответ вместо мисслейбла «это по работе») и копит данные для iter-2 (judge учится на этих сигналах и сам перестаёт дёргать). **Judge в этой итерации не трогаем.**

## Context (from discovery)

- **Кнопки строятся** в `buildDistractionNudge` ([packages/server/src/channels/discord/embeds.ts:359](../../packages/server/src/channels/discord/embeds.ts:359)): id `distract:back:${runStart}`, `distract:work:${app}:${runStart}`, `distract:snooze:${app}:${runStart}`, каждый с guard на `CUSTOM_ID_LIMIT`.
- **Роутинг** в `handleDistractFeedback` ([packages/server/src/channels/discord/interactions.ts:510](../../packages/server/src/channels/discord/interactions.ts:510)): `back` → ack; `work` → `recordFeedback(app, runStart, 'work')` + ack; `snooze` → `recordFeedback(..., 'snooze', snoozeUntil)` + ack.
- **Тип фидбека**: `DistractionFeedback = 'back' | 'work' | 'snooze'` ([packages/server/src/observers/distraction-eval-store.ts:4](../../packages/server/src/observers/distraction-eval-store.ts:4)). Колонка `distraction_evals.feedback` — **свободный TEXT** ([db.ts:475](../../packages/server/src/db.ts:475)) → **миграция не нужна**.
- **Подавление ре-нага — автоматическое**: `distraction-detector.ts:110` (`if (latest.verdict === 'distracted') return null`) уже не пере-оценивает запинганный dwell. `feedback` сейчас не читается фильтром (только пишется). → **детектор НЕ трогаем**, `'done'` ведёт себя как `'work'`.
- **Тесты есть рядом:** `channels/discord/__tests__/embeds.distraction.test.ts` (кнопки), `channels/discord/__tests__/interactions.distraction.test.ts` (роутинг), `observers/__tests__/distraction-eval-store.test.ts`.
- **Фича включена** (DISTRACTION_ENABLED — пуши приходят live).

## Development Approach

- **Testing approach:** тесты в той же задаче (ralphex enforce: зелёное перед следующей). Каждая задача — тесты на новый/изменённый код (success + edge).
- Маленькое изменение, backward-compatible: новое значение фидбека, никакой смены поведения существующих кнопок/judge/схемы.
- `npm test` после каждой задачи.

## Testing Strategy

- **Unit (vitest):** кнопка `done` строится с корректным id и переживает `CUSTOM_ID_LIMIT`-guard; роут `action==='done'` зовёт `recordFeedback('done')` ровно раз и шлёт ephemeral-ack; `recordFeedback` принимает и пишет `'done'`.
- **E2E:** нет.

## Progress Tracking

- `[x]` сразу; ➕ новые задачи; ⚠️ блокеры.

## What Goes Where

- **Implementation Steps** — код+тесты.
- **Post-Completion** — деплой (dev→master, push, supervisor auto-restart) + live-проверка кнопки в Discord.

## Implementation Steps

### Task 1: Кнопка «✅ Закончил» в нудже
- [x] в `buildDistractionNudge` ([embeds.ts:378](../../packages/server/src/channels/discord/embeds.ts:378)) добавить кнопку `distract:done:${event.app}:${event.runStart}`, label `✅ Закончил`, style `secondary`, с тем же `CUSTOM_ID_LIMIT`-guard, что у `work`/`snooze`; порядок: `Возвращаюсь · Это по работе · ✅ Закончил · Отстань на Nм` (≤5 в ряду)
- [x] write tests (`embeds.distraction.test.ts`): кнопка `done` присутствует с корректным id/label; при длинном app — дропается так же, как `work`/`snooze` (guard), а `Возвращаюсь` и текст выживают
- [x] run `npm test` — зелёное перед Task 2

### Task 2: Роутинг + запись фидбека `done`
- [ ] добавить `'done'` в тип `DistractionFeedback` ([distraction-eval-store.ts:4](../../packages/server/src/observers/distraction-eval-store.ts:4))
- [ ] в `handleDistractFeedback` ([interactions.ts:510](../../packages/server/src/channels/discord/interactions.ts:510)) добавить ветку `action === 'done'` → `deps.distractionEvalStore?.recordFeedback(app, runStart, 'done')` + ephemeral-ack «✓ Понял, задача закрыта — по этому переходу не дёргаю» (по образцу `work`)
- [ ] write tests (`interactions.distraction.test.ts`): `done` зовёт `recordFeedback(app, runStart, 'done')` один раз и отвечает ephemeral; no-op если store не подключён (ack всё равно есть); malformed rawId не падает
- [ ] write tests (`distraction-eval-store.test.ts`): `recordFeedback(..., 'done')` пишет `feedback='done'` в строку dwell
- [ ] run `npm test` — зелёное перед Task 3

### Task 3: Verify acceptance criteria
- [ ] проверить: кнопка приходит в пуше, клик пишет `feedback='done'`, ре-наг по этому dwell не повторяется (через существующий verdict-гейт, без правок детектора)
- [ ] полный `npm test` — зелёное
- [ ] `npm run build -w @r2/shared && -w @r2/server && -w @r2/supervisor` — clean
- [ ] подтвердить, что judge/схема БД/env не менялись

## Technical Details

- customId формат: `distract:done:${app}:${runStart}` — splitCustomId парсит как domain=`distract`, action=`done`, rawId=`${app}:${runStart}` → `parseAppDwell(rawId)` (как у `work`/`snooze`).
- `feedback='done'` — чисто данные для iter-2 (обучение judge). Подавление ре-нага не зависит от значения фидбека.

## Post-Completion

**Деплой (по флоу):** sync dev←master → ralphex на dev → dev→master → `git push origin master` (supervisor auto-restart).

**Live-проверка:** дождаться следующего distractionPullback в Discord → видна кнопка «✅ Закончил» → клик даёт ack и не дёргает повторно по этому залипанию; в `distraction_evals` строка с `feedback='done'`.

**iter-2 (отдельный план, когда накопятся данные):** judge читает прошлые `done`-сигналы (похожий контекст) → перестаёт пинговать в выученных паттернах завершения.
