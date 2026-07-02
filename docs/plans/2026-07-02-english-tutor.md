# English tutor module

## Overview

Проактивный персональный учитель английского в R2: placement на старте →
LLM-адаптивные уроки (объяснение + микс MCQ/свободных упражнений) → проверка с
разбором на русском → трекинг mastery по темам → адаптивный подбор следующей
темы. Доставка: дневной cognition-хендлер (по часу) + команда `/english`. За
флагом `ENGLISH_TUTOR_ENABLED` (default off).

Design spec: `docs/superpowers/specs/2026-07-02-english-tutor-design.md`.

## Context (from discovery)

- Новый модуль `packages/server/src/tutor/`: `store.ts`, `lesson-generator.ts`,
  `grader.ts`, `placement.ts`, `session.ts`.
- Обвязка:
  - `packages/server/src/db.ts` — новые таблицы (паттерн `CREATE TABLE IF NOT EXISTS`).
  - `packages/server/src/cognition/handlers/englishLesson.ts` — дневной хендлер
    (эталон `morningBrief.ts`; регистрация `cognitionService.register`,
    index.ts:376/559 — условно после Discord).
  - `packages/server/src/channels/discord/slash-commands.ts` — команда `/english`.
  - `packages/server/src/channels/discord/interactions.ts` — домен кнопок `tutor:*`
    (паттерн `routeButton`/`splitCustomId`).
  - `packages/server/src/channels/discord/bot.ts` `handleMessage` (bot.ts:441) —
    хук роутинга свободного ответа в учителя до общего ассистента.
  - `packages/server/src/index.ts` — флаги + wiring (anthropic-клиент уже собран).
- Related patterns: cognition Handler (`trigger`/`run`, quiet hours как в
  `emailDigest.helpers`), `extractJson` (emails/scorer) для парса LLM-JSON,
  Claude-вызов (`anthropic.messages.create`) как в scorer.
- Dependencies: `anthropic` клиент, `cognitionService`, Discord bot/interactions,
  r2.db `Database`.

## Development Approach

- **Testing approach**: Regular (код, затем тесты в той же задаче) — vitest,
  colocated `*.test.ts`, как весь server-набор.
- Каждую задачу до конца перед следующей; мелкие фокусные изменения.
- **CRITICAL: каждая задача включает новые/обновлённые тесты** (success + error).
- **CRITICAL: все тесты зелёные до следующей задачи.**
- Backward-compat: флаг off → R2 без изменений (хендлер не зарегистрирован,
  `/english` отвечает «выключено», message-хук неактивен).
- LLM-вызовы инъектируемы (стаб в тестах), никогда не бьём в сеть в юнитах.
- Обновлять этот файл при сдвиге scope.

## Testing Strategy

- **Unit tests** (vitest) на каждую задачу; LLM/Discord — через инъекцию стабов.
  E2E-харнесса нет.

## Progress Tracking

- `[x]` сразу; `➕` новые; `⚠️` блокеры.

## What Goes Where

- Implementation Steps: код, тесты, доки в репо.
- Post-Completion: активация флага, ручная проверка в Discord.

## Implementation Steps

### Task 1: Схема БД + `tutor/store.ts`
- [x] `db.ts`: `CREATE TABLE IF NOT EXISTS` для `tutor_profile`, `tutor_lesson`,
      `tutor_progress` (поля по спеке)
- [x] `tutor/store.ts`: CRUD профиля (get/upsert, level, placement_state,
      placement_payload, daily_hour, paused); урок (create, getActive
      (`status!=done`), update payload/status/current_ex/score/complete); progress
      (get, upsert с mastery EWMA)
- [x] write tests: профиль upsert/read; активный урок = последний не-done;
      mastery EWMA-апдейт; пустое состояние (нет профиля/урока)
- [x] write tests: миграции создают таблицы идемпотентно
- [x] run tests — must pass before Task 2

### Task 2: `tutor/lesson-generator.ts`
- [x] `generateLesson(input, deps) → Lesson` где `input = { level, recentTopics,
      weakTopics }`, `deps = { anthropic, model, signal }`; промпт просит JSON
      `{topic, explanation, exercises:[{kind,prompt,options?,answer,rubric?}]}`
- [x] парс через `extractJson`-подобный хелпер; валидация формы (≥1 упражнение,
      корректные kind); кривой/невалидный JSON → один ретрай, затем throw
      `LessonGenError`
- [x] write tests: валидный JSON → Lesson; промпт включает level/recent/weak;
      кривой JSON → ретрай; повторный провал → throw
- [x] run tests — must pass before Task 3

### Task 3: `tutor/grader.ts`
- [x] `gradeMcq(exercise, choiceIdx) → { correct }` — детерминированно
- [x] `gradeFree(exercise, userAnswer, deps) → { verdict: correct|partial|wrong,
      feedback }` — LLM (Claude), feedback на русском; ошибка LLM → throw
      `GradeError` (не выдумывать verdict)
- [x] write tests: MCQ совпал/не совпал/вне диапазона; free correct/partial/wrong
      (стаб LLM); LLM-ошибка → throw
- [x] run tests — must pass before Task 4

### Task 4: `tutor/placement.ts`
- [x] `startPlacement(deps) → questions[]` (5–10, по возрастанию сложности);
      `assessPlacement(qa, deps) → { level: CEFR }`
- [x] хранит промежуточное состояние в `placement_payload` (через store)
- [x] write tests: генерация вопросов; сбор ответов пошагово; финальная оценка →
      CEFR; LLM-ошибка → graceful
- [x] run tests — must pass before Task 5

### Task 5: `tutor/session.ts` (state-machine)
- [x] `advance(lesson, answer) ` — применяет ответ к `current_ex`, двигает
      `awaiting_mcq`/`awaiting_free`, на последнем → `done` + score + агрегат в
      `tutor_progress`
- [x] `routingState()` — есть ли активный `awaiting_free` урок / placement
      `in_progress` (для message-хука); helper «что показать дальше»
- [x] write tests: awaiting_mcq→awaiting_free→done; апдейт progress на done;
      routingState активен только при awaiting_free/placement in_progress
- [x] run tests — must pass before Task 6

### Task 6: Discord `/english` + кнопки `tutor:mcq:*`
- [x] `slash-commands.ts`: команда `/english` (опц. подкоманда/арг `stop`)
- [x] `interactions.ts`: домен `tutor`, кнопки `tutor:mcq:<lessonId>:<exIdx>:<choice>`
      → `gradeMcq` → session.advance → ephemeral-фидбек + следующее упражнение/итог
- [x] `/english`: нет профиля/placement не done → запуск placement; активный урок
      → продолжить; иначе → сгенерить урок; `stop` → закрыть активный урок/сессию
- [x] флаг off → `/english` отвечает «учитель выключен»
- [x] write tests: `/english` старт placement/новый урок/продолжение/stop; кнопка
      MCQ грейдит и продвигает; флаг off
- [x] run tests — must pass before Task 7

### Task 7: Message-хук для свободного ответа
- [x] `bot.ts` `handleMessage`: перед общим ассистентом — если
      `session.routingState()` активен (awaiting_free / placement in_progress) →
      отдать текст `gradeFree`/`assessPlacement`-пути, не общему ассистенту
- [x] escape и slash/кнопки всегда в обход; нет активного состояния → обычный чат
- [x] write tests: awaiting_free → сообщение идёт в грейдер; нет активного →
      общий ассистент не затронут; placement in_progress → в placement
- [x] run tests — must pass before Task 8

### Task 8: Дневной хендлер `cognition/handlers/englishLesson.ts`
- [x] Handler `trigger` = флаг on + placement done + нужный час + не quiet hours +
      не `paused` + нет незавершённого урока; `run` = generateLesson → пост
      объяснения + первого упражнения → create `tutor_lesson`
- [x] генерация упала → skip с reason, состояние не создаётся
- [x] write tests: триггер по часу; блок при quiet hours/paused/незавершённый
      урок/placement не done/флаг off; run создаёт урок; генерация упала → skip
- [x] run tests — must pass before Task 9

### Task 9: Флаги + wiring в index.ts
- [x] `ENGLISH_TUTOR_ENABLED` (default false), `ENGLISH_TUTOR_HOUR` (envInt),
      `ENGLISH_TUTOR_MODEL` (default `claude-sonnet-4-6`)
- [x] собрать tutor store/deps, зарегистрировать `englishLesson` (условно, после
      Discord, как morningBrief), прокинуть session/store в bot+interactions
      (bot.ts: `tutor` теперь форвардится в routeInteraction)
- [x] лог состояния флага
- [x] write/extend wiring-тесты, если есть startup-тест; иначе покрыто юнитами
      (startup-теста нет → покрыто tutor/discord юнитами; tsc --noEmit чистый)
- [x] run tests — must pass before Task 10 (422 server-теста зелёные)

### Task 10: Verify acceptance criteria
- [x] placement выставляет CEFR; дневной урок постится по часу с гейтами
      (placement.test.ts + cognition/handlers/__tests__/englishLesson.test.ts)
- [x] MCQ кнопкой детерминированно; свободный ответ LLM-грейдером с ru-разбором
      (grader.test.ts + discord/__tests__/tutor-handlers.test.ts)
- [x] чат-роутинг активен только при awaiting_free/placement; иначе ассистент цел
      (session.test.ts routingState + discord/__tests__/bot.test.ts hook)
- [x] на done обновляется mastery; следующий урок учитывает слабые/недавние темы
      (session.test.ts progress-on-done + lesson-generator.test.ts weak/recent)
- [x] флаг off → R2 без изменений; LLM-сбои → graceful
      (tutor-handlers.test.ts flag-off + *GenError/GradeError throw tests)
- [x] полный server-набор + линтер зелёные; coverage на новых модулях
      (vitest run: 2399 passed / 168 files; tsc --noEmit exit 0)

### Task 11: Документация
- [x] `ENGLISH_TUTOR_ENABLED`/`_HOUR`/`_MODEL` в `AGENTS.md` + `.env.example`
- [x] описать модуль-учитель в `README.md`

## Technical Details

- Lesson JSON-контракт и grader-verdict — см. спеку §«Формат урока».
- Один активный урок на юзера (single-user) → однозначный чат-роутинг.
- Claude через существующий `anthropic`-клиент; модель из `ENGLISH_TUTOR_MODEL`.
- Все LLM-вызовы инъектируемы (deps) для детерминированных тестов.
- Миграции аддитивные (`CREATE TABLE IF NOT EXISTS`), не трогают существующие
  таблицы.

## Post-Completion

**Активация:** `ENGLISH_TUTOR_ENABLED=true` (+ `ENGLISH_TUTOR_HOUR`) в
рантайм-`.env`, рестарт `com.r2.supervisor`.

**Manual verification (Discord):** пройти placement; вызвать/дождаться урока;
ответить MCQ кнопкой и свободным текстом; проверить осмысленность фидбека и
сохранение прогресса; убедиться, что вне активного урока обычный чат работает
как раньше.
