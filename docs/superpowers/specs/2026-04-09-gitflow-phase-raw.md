# R2 Phase: Supervisor + Worker + Git Flow Architecture

## Контекст

R2 — AI-ассистент на стеке React + Vite + Express + Claude API.
Цель этой фазы — реализовать архитектуру, при которой R2 может модифицировать сам себя через чат.
Пользователь общается с R2 (прод на master), просит фичу или исправление → Claude Code работает на dev ветке → после аппрува мержится в master → supervisor перезапускает worker → чат продолжается с обновлённым R2.

## Принципы

- Supervisor НИКОГДА не модифицируется автоматически
- Worker содержит ВСЮ бизнес-логику R2
- Прод всегда работает с master ветки
- Вся разработка на dev ветке
- Мерж в master = деплой
- История чата сохраняется между рестартами

---

## Задача 1: Supervisor процесс

- [ ] Создать `supervisor.js` в корне проекта (~50-80 строк, минимальный код)
- [ ] Supervisor поднимает WebSocket-сервер на порту 3100 (управление)
- [ ] Supervisor спавнит worker как child_process (`node worker/index.js`)
- [ ] Supervisor пробрасывает stdout/stderr worker'а в свой лог
- [ ] Supervisor слушает сигнал от worker'а `process.send({ type: 'ready' })` для подтверждения старта
- [ ] Supervisor реализует graceful restart: SIGTERM worker → ждёт 5 сек → SIGKILL если не умер → спавнит новый
- [ ] Supervisor буферизирует входящие сообщения от фронта пока worker перезапускается
- [ ] Supervisor при краше worker'а автоматически рестартует (max 3 попытки за 60 сек, потом пауза)
- [ ] Добавить в `package.json` скрипт: `"start:prod": "node supervisor.js"`

## Задача 2: Worker процесс

- [ ] Перенести текущий Express-сервер в `worker/index.js`
- [ ] Worker отправляет `process.send({ type: 'ready' })` после инициализации
- [ ] Worker слушает SIGTERM и делает graceful shutdown (закрывает коннекты, сохраняет состояние)
- [ ] Worker при старте загружает историю чата из `data/chat-history.json`
- [ ] Worker при каждом сообщении дописывает в `data/chat-history.json`
- [ ] Worker экспортирует эндпоинт `POST /api/health` для healthcheck от supervisor'а

## Задача 3: Git watcher в supervisor

- [ ] Supervisor каждые 10 сек проверяет `git log --oneline -1 origin/master`
- [ ] Перед проверкой делает `git fetch origin master --quiet`
- [ ] Хранит последний известный хеш коммита в памяти
- [ ] Если хеш изменился: `git pull origin master` → restart worker
- [ ] Логирует: `[supervisor] New commit detected: <hash> — restarting worker...`
- [ ] После рестарта логирует: `[supervisor] Worker restarted on commit <hash>`
- [ ] Интервал проверки настраивается через `R2_POLL_INTERVAL` env (default 10000ms)

## Задача 4: Git-in-the-loop эндпоинт

- [ ] Worker реализует `POST /api/task` — принимает описание задачи от чата
- [ ] Эндпоинт выполняет: `git checkout dev`, `git pull origin dev`
- [ ] Запускает Claude Code CLI: `claude -p "<task_prompt>" --allowedTools Edit,Write,Bash` через child_process
- [ ] Claude Code работает ТОЛЬКО на dev ветке (проверка через pre-exec `git branch --show-current`)
- [ ] После завершения: `git add -A && git commit -m "r2: <краткое описание>"`
- [ ] Возвращает в чат: diff изменений, статус, commit hash
- [ ] Worker переключается обратно на master после завершения задачи

## Задача 5: Merge & Deploy из чата

- [ ] Worker реализует `POST /api/merge` — мержит dev в master
- [ ] Перед мержем запускает evals (Задача 6), если они есть
- [ ] Если evals прошли — `git checkout master && git merge dev --no-ff -m "r2: deploy <описание>"`
- [ ] Если evals НЕ прошли — возвращает отчёт об ошибках, мерж не делает
- [ ] После успешного мержа — `git push origin master` (для git watcher'а)
- [ ] Supervisor подхватит изменение через git watcher и рестартует worker
- [ ] Фронт показывает статус: "Deploying..." → "R2 updated!" после переподключения

## Задача 6: Eval-driven система

- [ ] Создать `data/evals.json` — массив тест-кейсов: `[{ "id", "input", "expected", "type": "contains|exact|semantic" }]`
- [ ] Worker реализует `POST /api/eval/add` — добавляет новый тест-кейс из чата
- [ ] Когда пользователь говорит "это неправильно" + даёт правильный ответ, R2 через Claude API формирует eval-кейс
- [ ] Worker реализует `POST /api/eval/run` — прогоняет все evals
- [ ] Каждый eval: отправляет input в Claude API с текущим system prompt, сравнивает ответ с expected
- [ ] Типы проверок: `contains` (подстрока), `exact` (точное совпадение), `semantic` (Claude оценивает похожесть)
- [ ] Результат: `{ passed: N, failed: N, details: [...] }`
- [ ] Evals автоматически запускаются перед мержем (Задача 5)

## Задача 7: Чат-команды

- [ ] Worker распознаёт специальные команды в сообщениях пользователя:
- [ ] `r2 task <описание>` → вызывает POST /api/task
- [ ] `r2 diff` → показывает текущий diff на dev vs master
- [ ] `r2 deploy` → вызывает POST /api/merge
- [ ] `r2 evals` → показывает список eval-кейсов
- [ ] `r2 eval run` → прогоняет evals
- [ ] `r2 status` → показывает: текущая ветка, последний коммит, worker uptime, кол-во evals
- [ ] `r2 restart` → supervisor рестартует worker без мержа (через WebSocket на порт 3100)
- [ ] Команды обрабатываются ДО отправки в Claude API
- [ ] Если сообщение не команда — обрабатывается как обычный чат

## Задача 8: Фронт — интеграция

- [ ] Добавить статус-бар сверху: ветка, коммит, worker uptime, evals passed/total
- [ ] При рестарте worker'а показывать оверлей "R2 is upgrading..." с анимацией
- [ ] Фронт пингует `/api/health` каждые 3 сек, при потере связи показывает статус
- [ ] После восстановления — подгружает историю чата из `data/chat-history.json`
- [ ] Показывать diff в чате красиво (зелёный/красный, как в GitHub)
- [ ] Результаты evals показывать как таблицу: ✅/❌ | input | expected | got

---

## Файловая структура после выполнения

```
r2/
├── supervisor.js              # Supervisor (НЕ модифицируется автоматически)
├── worker/
│   ├── index.js               # Express-сервер (основная логика)
│   ├── routes/
│   │   ├── chat.js            # Чат с Claude API
│   │   ├── task.js            # Git-in-the-loop
│   │   ├── merge.js           # Merge & deploy
│   │   └── eval.js            # Eval система
│   ├── services/
│   │   ├── git.js             # Git-операции
│   │   ├── claude-code.js     # Claude Code CLI wrapper
│   │   ├── eval-runner.js     # Прогон evals
│   │   └── command-parser.js  # Парсинг r2-команд
│   └── middleware/
│       └── history.js         # Сохранение истории чата
├── data/
│   ├── chat-history.json      # Персистентная история чата
│   └── evals.json             # Тест-кейсы
├── src/                       # React фронт (Vite)
│   ├── App.jsx
│   ├── components/
│   │   ├── Chat.jsx
│   │   ├── StatusBar.jsx
│   │   ├── DiffView.jsx
│   │   └── EvalResults.jsx
│   └── hooks/
│       ├── useR2Connection.js
│       └── useAutoReconnect.js
├── AGENTS.md
├── .env
└── package.json
```

## Порядок выполнения

Задачи 1-2 → 3 → 4 → 5-6 → 7 → 8

Каждая задача — отдельный коммит. После каждой задачи — проверить что R2 запускается и чат работает.
