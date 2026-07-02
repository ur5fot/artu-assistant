# English tutor module

**Date:** 2026-07-02
**Epic:** New R2 capability (proactive personal English teacher)
**Status:** approved design

## Цель

R2 ведёт пользователя по английскому как персональный учитель:

1. определяет уровень коротким placement-тестом;
2. каждый день **проактивно** присылает адаптивный урок в Discord (плюс по
   команде `/english`);
3. урок = объяснение темы + упражнения (микс MCQ-кнопок и свободных ответов);
4. проверяет ответы, объясняет ошибки на русском;
5. трекает mastery по темам и адаптивно подбирает следующую тему.

Канал — Discord (единственный вход R2). За флагом `ENGLISH_TUTOR_ENABLED`
(default off), шип dark.

### Контекст

- Проактивная доставка — паттерн cognition-хендлеров (`morningBrief`, `pulse`)
  в `packages/server/src/cognition/handlers/`.
- Тайминг — reminders scheduler/recurrence уже есть, но дневной урок делаем
  cognition-хендлером (как morningBrief по часу), не reminder.
- Память (`memory/`) — семантическая, НЕ подходит для flashcard-state; у модуля
  свои таблицы.
- Discord: slash-команды + кнопки (customId) + message-хендлер — существующие
  паттерны в `channels/discord/`.
- Готового tutor/vocab/lesson-кода нет.

## Решения (из брейншторма)

- Куррикулум: **LLM генерит адаптивно** (не фиксированный трек, не импорт курса).
- Доставка: **проактивно каждый день + команда `/english`**.
- Упражнения: **микс** MCQ (кнопки) + свободный ответ (LLM-грейдинг).
- Старт: **короткий placement** (5–10 вопросов).
- Модель: **Claude** (Sonnet по умолчанию) — качество преподавания важнее
  дешевизны Ollama.
- **≤1 активный урок** на пользователя за раз (упрощает состояние и чат-роутинг).

## Архитектура

Новый серверный модуль `packages/server/src/tutor/`:

- `store.ts` — доступ к таблицам (profile, lesson, progress).
- `lesson-generator.ts` — LLM-генерация урока (структурный JSON + фолбэк).
- `grader.ts` — проверка MCQ (детерминированно) + свободного ответа (LLM).
- `placement.ts` — генерация вопросов + оценка → CEFR.
- `session.ts` — state-machine активного урока (awaiting_mcq → awaiting_free →
  done), решает, куда роутить ответ.

Обвязка:

- `cognition/handlers/englishLesson.ts` — дневной проактивный урок (по часу,
  quiet hours, `paused`, флаг).
- Discord: slash-команда `/english [stop]` + обработка кнопок `tutor:*` в
  `interactions.ts`; хук в message-хендлер для роутинга свободного ответа, когда
  активный урок в `awaiting_free`.

### Данные (новые таблицы в r2.db, аддитивные миграции)

- **`tutor_profile`** (одна строка — single-user): `level` (CEFR: A1..C2 | null),
  `placement_state` (`none` | `in_progress` | `done`), `placement_payload` (JSON,
  промежуточные вопросы/ответы placement), `daily_hour` (int), `paused` (int 0/1),
  `created_at`, `updated_at`.
- **`tutor_lesson`**: `id`, `topic`, `payload` (JSON: объяснение + упражнения +
  ответы юзера + пер-упражнение оценки), `status` (`awaiting_mcq` |
  `awaiting_free` | `done`), `current_ex` (индекс текущего упражнения), `score`
  (nullable), `created_at`, `completed_at` (nullable). Активный урок =
  последний со `status != done`.
- **`tutor_progress`**: `topic` (PK), `attempts`, `correct`, `mastery` (REAL,
  EWMA 0..1), `last_at`.

### Формат урока (LLM JSON-контракт)

```
{
  "topic": "<slug/short title>",
  "explanation": "<краткое объяснение темы, EN + RU-заметки>",
  "exercises": [
    { "kind": "mcq",  "prompt": "...", "options": ["a","b","c","d"], "answer": <idx> },
    { "kind": "free", "prompt": "...", "answer": "<эталон>", "rubric": "<что проверять>" }
  ]
}
```

- MCQ проверяется детерминированно (индекс совпал).
- Free проверяется LLM-грейдером: `(prompt, answer/rubric, userAnswer)` →
  `{ verdict: correct|partial|wrong, feedback: "<ru>" }`.

## Потоки

### Онбординг (placement)

Нет профиля или `placement_state != done` → первый триггер (`/english` или
дневной хендлер) запускает placement: генерируем набор вопросов по возрастанию
сложности, задаём по одному (состояние в `placement_payload`), ответы в чат
роутятся в placement-грейдер. В конце — CEFR-уровень → `tutor_profile.level`,
`placement_state = done`.

### Дневной урок

`englishLesson` cognition-хендлер: `trigger` = час дня совпал, не quiet hours,
не `paused`, флаг on, placement done, нет незавершённого урока → `run` генерит
урок (`lesson-generator` с уровнем + недавними/слабыми темами), постит объяснение
+ первое упражнение, создаёт `tutor_lesson` в `awaiting_*`.

### Ответы

- **MCQ:** Discord-кнопки `tutor:mcq:<lessonId>:<exIdx>:<choice>` → детерм.
  проверка → ephemeral-фидбек, `current_ex++`, следующее упражнение или итог.
- **Free:** урок в `awaiting_free`; **следующее обычное сообщение в чат
  роутится в grader** (а не в общий ассистент). Grader выставляет verdict +
  feedback, `current_ex++`. Escape: `/english stop` (закрыть активный урок).
- Пройдены все упражнения → `status=done`, `score`, апдейт `tutor_progress`
  по теме (attempts/correct/mastery EWMA), итоговый разбор.

### On-demand

`/english` → продолжить активный урок, либо (нет активного) сгенерить новый,
либо запустить placement, если не пройден. `/english stop` → закрыть активный
урок/сессию.

## Чат-роутинг свободного ответа (ключевой trade-off)

В Discord-only R2 обычный чат — универсальный ассистент. Чтобы свободные ответы
работали естественно, вводится проверка в message-хендлере: если есть активный
`tutor_lesson` в `awaiting_free` (или активный placement `in_progress`),
входящее текстовое сообщение отдаётся tutor-grader'у, а не общему ассистенту.
Одно активное состояние на пользователя делает это однозначным. Escape —
`/english stop`. Slash-команды и кнопки всегда работают в обход.

## Ошибки / edge-кейсы

| Случай | Поведение |
|---|---|
| LLM-генерация урока упала | сообщение «не смог собрать урок, позже», состояние не создаётся/не портится |
| Невалидный JSON урока | один ретрай, затем graceful-ошибка |
| Free-grader (LLM) упал | сообщение об ошибке, `current_ex` не двигается, можно ответить снова |
| Дневной триггер в quiet hours / `paused` | не постит |
| placement прерван | `in_progress`, продолжаем при следующем `/english`/триггере |
| нет активного урока, юзер пишет обычный текст | идёт в общий ассистент (роутинг не срабатывает) |
| флаг off | хендлер не зарегистрирован, `/english` отвечает «выключено», роутинг неактивен |

## Флаги

- `ENGLISH_TUTOR_ENABLED` (default `false`).
- `ENGLISH_TUTOR_HOUR` (час дневного урока, локальная TZ; default напр. 9).
- `ENGLISH_TUTOR_MODEL` (default `claude-sonnet-4-6`).

## Вне scope (YAGNI)

- Голос/произношение, картинки.
- Мульти-юзер (single-user, как весь R2).
- Полноценный SRS по отдельным словам/карточкам (mastery по темам — лёгкая
  замена; адаптивный подбор возвращает к слабым темам).
- Сертификация уровня, ручное редактирование курса, экспорт прогресса.

## Тестирование

- **store:** CRUD profile/lesson/progress; mastery EWMA-апдейт; выбор активного
  урока; миграции добавляют таблицы.
- **lesson-generator:** парс валидного JSON; кривой JSON → ретрай/фолбэк;
  промпт включает уровень + недавние/слабые темы.
- **grader:** MCQ детерминизм (совпал/не совпал индекс); free-грейдер
  correct/partial/wrong; LLM-ошибка → не двигает `current_ex`.
- **placement:** сбор ответов по состоянию, финальная оценка → CEFR.
- **session/state-machine:** awaiting_mcq → awaiting_free → done; роутинг чата
  активен только при awaiting_free / placement in_progress.
- **englishLesson handler:** триггер по часу; блок при quiet hours/paused/флаг
  off/незавершённый урок/placement не пройден.
- **discord:** `/english` (старт/продолжение/stop), кнопки `tutor:mcq:*`.

## Acceptance criteria

1. При `ENGLISH_TUTOR_ENABLED=true` первый `/english` (или дневной триггер)
   запускает placement и выставляет CEFR-уровень.
2. Дневной хендлер в заданный час постит адаптивный урок (объяснение + упражнения),
   уважая quiet hours/paused.
3. MCQ проверяется кнопками детерминированно; свободный ответ — LLM-грейдером с
   разбором на русском.
4. Свободный ответ в чате роутится в учителя только при активном
   `awaiting_free`/placement; иначе обычный ассистент не затронут.
5. По завершении урока обновляется `tutor_progress` (mastery), следующий урок
   учитывает слабые/недавние темы.
6. Флаг off → поведение R2 без изменений; все LLM-сбои → graceful, состояние
   не ломается.
7. Полный тестовый набор зелёный + новые тесты выше.

## Post-Completion

**Активация:** `ENGLISH_TUTOR_ENABLED=true` (+ `ENGLISH_TUTOR_HOUR`) в
рантайм-`.env`, рестарт `com.r2.supervisor`.

**Manual verification:** пройти placement в Discord; дождаться/вызвать урок;
ответить на MCQ кнопкой и на свободное задание текстом; проверить, что фидбек
осмысленный и прогресс сохраняется; убедиться, что вне активного урока обычный
чат работает как раньше.
