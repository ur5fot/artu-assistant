# Worklog

Короткий журнал того, что делается — чтобы можно было быстро пересказать.
Новые записи сверху. Формат: дата · что сделано · результат/статус.

---

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
