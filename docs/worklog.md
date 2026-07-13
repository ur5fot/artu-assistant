# Worklog

Короткий журнал того, что делается — чтобы можно было быстро пересказать.
Новые записи сверху. Формат: дата · что сделано · результат/статус.

---

## 2026-07-13

- **Постоянная отметка источника ответа в Discord.** Основной текстовый чат
  теперь показывает `🟢 local` для Ollama/Qwen и `🔵 claude` для Claude API;
  переключение после локальной попытки отдельно помечается
  `🟢 local → 🔵 claude (fallback)`. Метка добавляется только при отправке в
  Discord и не загрязняет историю/память. Focused Discord suite:
  73/73, полный server suite: 2158/2158 (141 файл), TypeScript build чистый.
  Изменение опубликовано через `dev -> master`, R2 перезапущен.
- **Внедрён safe-local harness для `qwen3:1.7b`.** Чат теперь до inference
  детерминированно делится: простой разговор/один read-only домен → Qwen с
  0–3 tools; actions, code/math, strict JSON, multi-domain и длинные запросы →
  Claude. Добавлены фазовый tool-loop без same-model self-check, отдельный
  `OLLAMA_NUM_CTX` budget, bounded memory/topic context и privacy-safe
  `[local-route]` telemetry. Исправлен нативный Ollama tool-result контракт
  (`tool_name`). Email scorer/gist/action-match используют JSON Schema через
  `format` + temperature 0 и проверку semantics кодом. Незавершённые tutor-
  изменения сведены с новым `topicSteering`: остановка нетронутого урока больше
  не портит mastery, а частичный ответ сохраняется и покрыт тестом. Итоговая
  проверка: server build чистый, 2157/2157 тестов зелёные (141 файл),
  `git diff --check` чистый. LaunchAgent перезапущен, `/api/health` отвечает.
  Runtime smoke на реальной Qwen: простой чат → Ollama (~1,3 с), weather →
  только read-only `weather` (~2,2 с), strict JSON и запись файла → Claude до
  локального inference; synthetic email scorer вернул полный schema-valid
  результат без Claude fallback. Дизайн/план:
  `docs/superpowers/specs/2026-07-13-safe-local-llm-router-design.md`,
  `docs/plans/2026-07-13-safe-local-llm-router.md`.
- **Аудит качества локальной `qwen3:1.7b`.** Проведён обезличенный benchmark
  текущего Ollama-режима и сравнение с thinking / рекомендованным sampling /
  `qwen2.5:7b`. Текущий Qwen3 прошёл 21/44 seeded-проверок (47,7%): быстрый и
  уверенно выбирает два простых tool, но стабильно проваливает арифметику,
  сортировку, строгий формат и недоверенный текст. Найден системный блокер:
  полный статический prompt с 23 tool-схемами занимает 9681 токен и уже
  обрезается при `num_ctx=8192` без истории/памяти. Выводы и порядок исправлений:
  `docs/2026-07-13-qwen3-1.7b-quality.md`. Код и runtime-конфиг не менялись.

## 2026-07-02

- **English tutor Task 1 (схема БД + store).** Добавил аддитивные таблицы
  `tutor_profile`/`tutor_lesson`/`tutor_progress` в `db.ts` и модуль
  `tutor/store.ts` (CRUD профиля, урок с getActive=последний не-done, progress
  с mastery EWMA). 13 юнит-тестов зелёные, tsc чистый. Флаг ещё не заведён —
  R2 без изменений.
- **Старт журнала.** С этого момента веду лог (юзер работает без просмотра стрима).
- **Точка отсчёта:** Digital Observer iter-2 restore-button уже в проде
  (`origin/master` @ `7d9f42c`) — кнопка `↩️ Вернуть` в pullback-нудже,
  за флагом `DISTRACTION_RESTORE_ENABLED` (default off). 1934 теста зелёные.
- **Включил restore в рантайме.** Добавил `DISTRACTION_RESTORE_ENABLED=true` в
  `.env`, рестарт launchd-сервиса `com.r2.supervisor`. Воркер поднялся, лог:
  `[distraction] pullback handler registered (restore=true)`. Фича активна.
- **Новая боль: суть письма на русском.** Забрейнштормили + написали спеку
  `docs/superpowers/specs/2026-07-02-email-gist-native-language-design.md`:
  двухстадийно (importance-скорер как есть + отдельный gist-шаг для писем
  ≥cutoff), суть 2–3 предложения на русском, PII deanon, показ в пинге/дайджесте/
  туле, флаг `EMAIL_GIST_ENABLED` (default off). Дальше — план + ralphex.
- **План + запуск ralphex (email gist).** План
  `docs/plans/2026-07-02-email-gist-native-language.md` (8 задач). Запустил
  ralphex Full/50 на dev (task `bsigwy3tv`). Ждём выполнение + review.
- **email gist: код готов, review через codex-only.** Все 8 задач в коде на dev
  (коммиты `102ce97`→`1e834e7`, 39/39). Full-прогон review упал на Claude
  session-limit (4-й раз, не код). Откатил случайный мусор в `.env.example`
  («ку» прилипло). Лимит отпустило (21:14 Kiev > сброс 18:50) → запустил
  `--codex-only` (task `bkygwcbuv`). После завершения — деплой dev→master.
- **email gist задеплоено.** Codex-review чисто (REVIEW_DONE, 0 critical/major,
  фикс `249103a`), 1964 теста зелёные. Merge dev→master + push
  (`7d9f42c..249103a`). Фича в проде за флагом `EMAIL_GIST_ENABLED` (default off).
- **Включил gist в рантайме.** `EMAIL_GIST_ENABLED=true` в `.env`, рестарт
  `com.r2.supervisor`. Лог нового воркера: `native-language gist enabled`.
  Обе фичи сессии живые: restore-кнопка + email gist.
- **Новая фича: модуль «Учитель английского».** Забрейнштормили (структурные
  уроки, LLM-адаптивный куррикулум, проактивно+команда, микс MCQ/свободный ответ,
  placement на старте) → спека `docs/superpowers/specs/2026-07-02-english-tutor-design.md`.
  Модуль `tutor/` + cognition-хендлер + `/english`, флаг `ENGLISH_TUTOR_ENABLED`.
  Дальше — план + ralphex (с `--serve`).
- **План + запуск ralphex (english tutor).** План
  `docs/plans/2026-07-02-english-tutor.md` (11 задач). Запустил ralphex Full/50
  с `--serve` (дашборд http://localhost:8080) + `--wait=1h` (переживёт
  session-limit) на dev (task `bc76b945a`). Ждём выполнение + review.
- **Task 9 (english tutor) — флаги + wiring.** `ENGLISH_TUTOR_ENABLED`/`_HOUR`/
  `_MODEL` в index.ts, собран `tutorStore` + `tutorDeps`, `englishLesson`-хендлер
  зарегистрирован в Discord-gated блоке (как morningBrief), `tutor` прокинут в bot
  и форвардится в routeInteraction. 422 server-теста зелёные, tsc чистый.
- **Task 10 (english tutor) — проверка acceptance criteria.** Все критерии
  приёмки (placement→CEFR, MCQ/free грейдинг, чат-роутинг только на
  awaiting_free/placement, mastery-апдейт на done, флаг off = R2 не меняется,
  graceful LLM-фейлы) подтверждены существующими юнит-тестами. Полный
  server-набор (2399 тестов/168 файлов) + `tsc --noEmit` зелёные.
- **Task 11 (english tutor) — документация.** `ENGLISH_TUTOR_ENABLED`/`_HOUR`/
  `_MODEL` задокументированы в `AGENTS.md` + `.env.example`, добавлена секция
  «English tutor» в `README.md`. Только доки, код/тесты не тронуты.
- **English tutor: code review, 3 итерации фиксов.** (1) Ответы учителя
  писались в `chat_messages` — роутинг тутора перенесён на приём DM, до
  save/coalesce, чтобы ответы на упражнения не засоряли историю ассистента.
  (2) Дедлок placement-ретрая (LLM падал на последнем вопросе не давая
  завершить тест) и гонка с молчаливым дропом сообщения в `bot.ts` — оба пути
  теперь ретраят `finishPlacement`/падают в обычный чат вместо no-op/дропа.
  (3) Два TOCTOU: stale-lesson-write при `/english stop` во время грейдинга и
  двойное создание урока (daily-хендлер vs `/english`) — закрыты re-check
  перед записью/инсертом. Все три коммита `fix: address code review findings`.
