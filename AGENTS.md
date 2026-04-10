# R2 — Personal AI Assistant

## Проект
Персональный AI-ассистент с кодовым именем **R2**.
Localhost-first. Один чат — один собеседник. Он делает рутину, ты думаешь о великом.

## Стек
- **Runtime:** Node.js >= 20 LTS
- **Frontend:** React 19 + Vite + TypeScript
- **Backend:** Express 4 + TypeScript
- **AI:** Anthropic Claude API (claude-sonnet-4-6-20250514) с tool_use
- **DB:** SQLite (better-sqlite3) — история, память, аудит
- **Search:** SearXNG (self-hosted, Docker)
- **PII:** Microsoft Presidio (Python microservice) — Phase 2
- **TTS/STT:** Web Speech API (браузер) — Phase 3
- **Tools:** модульные, каждый tool — отдельный npm package с единым интерфейсом
- **Тесты:** Vitest (unit + integration)

## Архитектура

```
r2/
├── AGENTS.md
├── package.json              # npm workspaces root
├── packages/
│   ├── shared/               # Общие типы между client и server
│   │   ├── src/
│   │   │   ├── types.ts      # Message, ToolCall, ToolResult, SSEEvent
│   │   │   └── index.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── client/               # React + Vite
│   │   ├── src/
│   │   │   ├── App.tsx
│   │   │   ├── components/
│   │   │   │   ├── Chat.tsx           # Основной чат-контейнер
│   │   │   │   ├── MessageBubble.tsx  # Одно сообщение (user/assistant)
│   │   │   │   ├── ToolCallCard.tsx   # Отображение tool call + результат
│   │   │   │   └── ChatInput.tsx      # Поле ввода + кнопка отправки
│   │   │   ├── hooks/
│   │   │   │   ├── useChat.ts         # SSE подключение, state сообщений
│   │   │   │   └── useSupervisor.ts   # WebSocket: worker status от supervisor
│   │   │   └── utils/
│   │   │       └── sse.ts             # SSE клиент с reconnect
│   │   ├── package.json
│   │   ├── vite.config.ts
│   │   └── tsconfig.json
│   │
│   ├── server/               # Express API
│   │   ├── src/
│   │   │   ├── index.ts              # Express entry, middleware, CORS
│   │   │   ├── db.ts                 # SQLite connection, initDb, logToolCall, cleanup
│   │   │   ├── db.test.ts            # Tests for db module
│   │   │   ├── routes/
│   │   │   │   └── chat.ts           # POST /api/chat → SSE stream
│   │   │   ├── ai/
│   │   │   │   ├── claude.ts         # Claude API client wrapper
│   │   │   │   ├── prompts.ts        # System prompt
│   │   │   │   └── tool-loop.ts      # Agentic loop с tool execution
│   │   │   ├── tools/
│   │   │   │   ├── registry.ts       # Авто-загрузка и регистрация tools
│   │   │   │   └── base.ts           # ToolDefinition interface
│   │   │   └── errors.ts             # Централизованная обработка ошибок
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── supervisor/            # Process manager (Phase 3A, prod-only)
│   │   ├── src/
│   │   │   ├── index.ts              # Entry point: wires WorkerManager + WS server
│   │   │   ├── worker-manager.ts     # Spawns/restarts worker via child_process.fork
│   │   │   └── ws-server.ts          # WebSocket status broadcast (port 3100)
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── tool-web-search/      # Каждый tool — отдельный npm package (tool-*)
│       ├── src/
│       │   └── index.ts
│       ├── __tests__/
│       │   └── web-search.test.ts
│       └── package.json
│
│   # Будущие tools добавляются как packages/tool-{name}/
│
├── data/                     # Локальные данные (gitignore)
│   └── r2.db                 # SQLite database (audit log)
│
└── .env.example              # Шаблон переменных окружения
```

## Shared Types (packages/shared)

```typescript
// Сообщение в чате
interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: ToolCall[];
  timestamp: number;
}

// Tool call от Claude
interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  result?: ToolResult;
  status: 'pending' | 'running' | 'done' | 'error';
}

// Результат выполнения tool
interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
  display?: {
    type: 'text' | 'table' | 'link' | 'code' | 'file';
    content: string;
  };
}

// SSE события от сервера к клиенту
type SSEEvent =
  | { type: 'text_delta'; content: string }
  | { type: 'tool_call_start'; toolCall: ToolCall }
  | { type: 'tool_call_result'; id: string; result: ToolResult }
  | { type: 'done' }
  | { type: 'error'; message: string };
```

## Tool Interface

```typescript
interface ToolDefinition {
  name: string;
  description: string;                              // для Claude
  permissionLevel: 'auto' | 'confirm' | 'forbidden';
  parameters: {                                     // JSON Schema
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  handler: (params: Record<string, unknown>) => Promise<ToolResult>;
}

// Конвертация в формат Claude API
function toClaudeTool(tool: ToolDefinition): ClaudeToolParam {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  };
}
```

### Permission Levels
- **auto** — безопасные read-only операции (поиск, чтение). Выполняются без вопросов.
- **confirm** — изменения требуют подтверждения юзера через UI (Phase 2).
- **forbidden** — никогда не выполняются автоматически (удаление, финансы).

В MVP все tools — `auto`. Permission dialog добавляется в Phase 2.

## API Contract

### POST /api/chat

**Request:**
```json
{
  "messages": [
    { "role": "user", "content": "string" },
    { "role": "assistant", "content": "string" }
  ]
}
```

**Response:** SSE stream (`text/event-stream`)
```
data: { "type": "text_delta", "content": "..." }
data: { "type": "tool_call_start", "toolCall": { "id": "...", "name": "...", "input": {...}, "status": "pending" } }
data: { "type": "tool_call_result", "id": "...", "result": { "success": true, "data": ... } }
data: { "type": "error", "message": "..." }
data: { "type": "done" }
```

### GET /api/health

**Response:** `{ "status": "R2 online", "timestamp": "ISO8601" }`

## Agentic Loop (ядро системы)

```
User message
    ↓
POST /api/chat { messages[] }
    ↓
Claude API stream (с tools в параметрах)
    ↓
Читаем stream:
    ├── text_delta → SSE: { type: "text_delta", content } → клиент
    ├── tool_use → SSE: { type: "tool_call_start", toolCall }
    │     ↓
    │   Execute tool (из registry по name)
    │     ↓
    │   SSE: { type: "tool_call_result", id, result }
    │     ↓
    │   Отправить tool_result обратно в Claude → продолжить stream
    │     (повторить до max 10 итераций или пока Claude не остановится)
    │
    └── end → SSE: { type: "done" }

Ошибки:
    ├── Tool упал → ToolResult { success: false, error } → Claude получает ошибку и решает что делать
    ├── Claude API timeout (30s) → SSE: { type: "error", message } → клиент показывает ошибку
    └── Max iterations (10) → Claude получает "max tool iterations reached" → должен дать финальный ответ
```

## System Prompt (R2 personality)

```
Ти — R2, персональний AI-асистент. Ти працюєш для свого власника.
Твоя задача — робити рутину, щоб власник міг думати про важливе.

Правила:
1. Якщо можеш зробити сам — роби. Не питай зайвих питань.
2. Якщо потрібен дозвіл — коротко поясни що хочеш зробити і чому.
3. Відповідай тією мовою, якою до тебе звертаються.
4. Будь лаконічним. Факти > вода.
5. Якщо чогось не знаєш — скажи. Не вигадуй.
6. Веди список зроблених дій щоб власник бачив що було зроблено.
```

## Конвенции кода

### TypeScript
- Strict mode всегда
- Интерфейсы для объектов, type для unions/утилит
- Async/await, никаких callback hell
- Именование: camelCase для переменных, PascalCase для компонентов/интерфейсов
- Все пути — через path.join/resolve, не хардкод
- **Порты и URL — НИКОГДА не хардкодить.** Всегда читать из env (process.env.PORT, etc.) с дефолтами. Это касается vite.config.ts, серверных URL, WebSocket адресов.

### Error Handling
- Tools: всегда возвращают `ToolResult`, никогда не throw наружу
- API routes: централизованный error middleware в Express
- Claude API: retry 1 раз при 5xx, abort при 4xx
- SSE: клиент автоматически reconnect при обрыве

### Тестирование
- Vitest для unit тестов
- Каждый tool — обязательные тесты (success + error cases)
- Server routes — integration тесты с supertest
- Минимальное покрытие: каждая публичная функция

---

## Phase 1 — MVP: Чат + web_search + streaming

### Цель: end-to-end работающий чат с одним tool

1. **Monorepo setup** — npm workspaces, shared types, TypeScript configs
2. **Express server** — POST /api/chat, SSE streaming, CORS
3. **Claude integration** — claude client, system prompt, streaming
4. **Tool loop** — agentic loop с max iterations и error handling
5. **web_search tool** — SearXNG (self-hosted), permission: auto
6. **React UI** — чат с SSE, отображение tool calls, responsive

### Запуск
```bash
# Dev (без supervisor)
docker compose up -d
npm run dev

# Production (через supervisor)
npm run start:build   # Build all + start supervisor
npm start             # Start supervisor (requires prior build)
```

## Phase 2 — Tools + PII

- Новые tools: files (чтение/запись), documents (PDF/DOCX), reminder
- PII gateway (Presidio Python microservice + Docker)
  - Anonymize перед Claude API, de-anonymize перед юзером
  - Encrypted vault (AES-256) для маппинга токенов
- Permission dialog в UI (confirm level tools)
- ~~Audit log (SQLite таблица: who, what, when, result)~~ ✓ Phase 2A
- ~~Tool registry: авто-обнаружение tools из packages/tool-*/~~ ✓ Phase 2A

## Phase 3 — Self-modifying R2

- **3A) Supervisor + Worker split** ✓ — process manager, auto-restart, WS status
- **3B) Chat persistence** ✓ — SQLite conversation history, GET /api/messages
- **3C) Git-in-the-loop** ✓ — code_task tool, ralphex on dev worktree
- **3D) Git watcher + auto-deploy** ✓ — supervisor polls master, code_deploy tool, POST /api/merge
- 3E) Eval система — test cases, pre-merge checks
- 3F) Chat commands + UI — r2 task/deploy, status bar, diff view

## Phase 4 — CRM Integration

- Справки, рапорти
- RAG по юридической базе
- Генерация документов .docx
- Напоминания и дедлайны

## Env Variables

```bash
# .env.example
ANTHROPIC_API_KEY=sk-ant-...
PORT=3001
CLIENT_PORT=5173
SEARXNG_URL=http://localhost:8888
# Active (Phase 2A)
DB_PATH=./data/r2.db
PII_SERVICE_URL=http://localhost:8080
# Supervisor (Phase 3A)
R2_SUPERVISOR_PORT=3100
R2_SHUTDOWN_TIMEOUT=5000
VITE_SUPERVISOR_WS_URL=ws://localhost:3100  # Client-side, set only for prod
# Code task (Phase 3C)
R2_DEV_WORKTREE_PREFIX=/tmp/r2-dev-
R2_DEV_BRANCH=dev
R2_DEV_BASE_BRANCH=master
R2_RALPHEX_MAX_ITERATIONS=20
# Git watcher + auto-deploy (Phase 3D)
R2_GIT_POLL_INTERVAL=60000        # ms; 0 disables the watcher
R2_GIT_WATCH_BRANCH=master
R2_GIT_REPO_PATH=                 # optional, defaults to repo root
```

## Self-deploy flow (Phase 3C+3D)

1. `code_task` spawns ralphex in a dev worktree, commits to `dev`.
2. User reviews; `code_deploy` (confirm-gated) calls `POST /api/merge`.
3. Merge endpoint: `fetch` → checkout master → `pull --ff-only` → `merge --no-ff dev` → `push`. On conflicts returns 409 with file list and aborts.
4. Supervisor git watcher polls `origin/master` every `R2_GIT_POLL_INTERVAL`, sees the new commit, fast-forwards the primary worktree (only if HEAD is on the watched branch), and restarts the worker.

`POST /api/merge` responses:
- `200 { ok, commit, filesChanged, message }`
- `409 { error: "merge conflicts", conflicts: string[] }`
- `500 { error: string }`

## Git

```gitignore
node_modules/
data/
.env
dist/
pii-service/__pycache__/
*.db
*.enc
```

## Языки

- **Документация / код:** английский (переменные, комменты, коммиты)
- **System prompt R2:** украинский
- **UI:** английский (лейблы, placeholder'ы)
- **R2 отвечает** на языке пользователя (правило 3 system prompt)

## Принципы

- **Localhost-first.** Никаких облаков без явного решения.
- **Модульность.** Каждый tool — отдельный пакет. Подключил — R2 умеет.
- **Безопасность.** Permission levels + аудит. R2 спрашивает перед опасным действием.
- **PII.** Никогда не уходит в API без анонимизации (с Phase 2).
- **Простота.** YAGNI. Делаем минимум который работает, расширяем по потребности.

## Уроки из ревью (обновлять при каждом Phase)

### SSE и стриминг
- **SSE буфер:** Последняя строка в чанке может быть неполной. Всегда сохранять остаток буфера после split по `\n` и приклеивать к следующему чанку.
- **Abort signal:** Пробрасывать AbortSignal через весь стек: chat route → tool loop → Claude API client → каждый tool handler. Проверять `signal?.aborted` перед каждой итерацией цикла И после каждого await.
- **Запись в закрытый response:** SSE response может закрыться пока сервер обрабатывает. Слушать `res.on('close')` и проверять `res.writableEnded` перед `res.write()`.

### Claude API
- **tool_result content:** `JSON.stringify(undefined)` возвращает `undefined`, не строку. Всегда иметь fallback: `JSON.stringify(result.data ?? '')`.
- **Max iterations boundary:** Отслеживать `stop_reason` последнего ответа. Не отправлять "дай финальный ответ" если Claude уже завершил текстом на последней итерации.
- **Retry:** 1 раз при 5xx, abort при 4xx. Не добавлять backoff для single retry — усложнение без пользы для MVP.

### Безопасность
- **Санитизация ошибок:** Никогда не отправлять клиенту raw error messages от внешних API. Фильтровать: API ключи (sk-ant-*), URL внутренних сервисов (SearXNG), названия провайдеров. Использовать case-insensitive matching.
- **Input validation:** Валидировать `messages[]` в chat route — проверять что каждое сообщение имеет `role` и `content`.

### React / клиент
- **StrictMode double-render:** Не вызывать side effects (fetch, SSE connect) внутри setState updater. Использовать ref (`sendingRef`) чтобы предотвратить двойное подключение.
- **Cleanup при unmount:** SSE соединение должно abort'иться при размонтировании компонента. `useEffect` cleanup обязателен.

### Контекст времени
- **System prompt:** `getSystemPrompt()` вызывается при каждом запросе (не один раз при старте) — R2 всегда знает текущую дату и время.
- **Timestamps в сообщениях:** Клиент отправляет `timestamp` с каждым сообщением. Сервер форматирует как `[08.04.2026, 16:30]` префикс в content перед отправкой Claude. R2 видит когда каждое сообщение было написано и может учитывать паузы между сообщениями.

### Пути и файловая система
- **`process.cwd()` ненадёжен:** В monorepo `cwd()` зависит от того откуда запущен процесс. Для определения путей относительно модуля использовать `import.meta.url` + `fileURLToPath()` + `path.dirname()`.
- **Создание директорий:** Всегда `fs.mkdirSync(dir, { recursive: true })` перед записью файла. Не предполагать что директория существует.
- **DB path:** SQLite файл должен resolve'иться от `import.meta.url`, не от `cwd()`. Хранить в `data/r2.db` относительно корня проекта.

### Тестирование
- **Temp directories для тестов с файлами:** `fs.mkdtempSync()` в `beforeEach`, `fs.rmSync(tmpDir, { recursive: true })` в `afterEach`. Не использовать фиксированные пути.
- **Mock vs integration:** Tool loop тесты без DB — `logToolCall` в try/catch, падает тихо. Отдельный describe с `initDb()` для тестов аудит-лога. Оба подхода нужны.
- **Проверять что тест реально тестирует:** Тест должен упасть если убрать тестируемый код. Если тест проходит с пустой реализацией — тест бесполезен.
