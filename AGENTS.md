# R2 — Personal AI Assistant

## Проект
Персональный AI-ассистент с кодовым именем **R2**.
Localhost-first. Один чат — один собеседник. Он делает рутину, ты думаешь о великом.

## Стек
- **Runtime:** Node.js >= 20 LTS
- **Frontend:** React 19 + Vite + TypeScript + diff2html (colored diffs)
- **Backend:** Express 4 + TypeScript
- **AI:** Anthropic Claude API (claude-sonnet-4-6-20250514) с tool_use
- **DB:** SQLite (better-sqlite3) — история, память, аудит
- **Search:** SearXNG (self-hosted, Docker)
- **PII:** Microsoft Presidio (Python microservice) — Phase 2; *frozen* (opt-in via the `pii` compose profile)
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
│   │   │   │   ├── ChatInput.tsx      # Поле ввода + кнопка отправки
│   │   │   │   ├── CommandPalette.tsx  # Command palette (Cmd+K / slash trigger)
│   │   │   │   ├── DiffView.tsx       # Colored unified diff (diff2html)
│   │   │   │   └── StatusBar.tsx      # Bottom bar: LLM source, msg count, response time
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
│   │   │   │   ├── chat.ts           # POST /api/chat → SSE stream (+ slash command interception)
│   │   │   │   └── commands.ts       # GET /api/commands → tool command list
│   │   │   ├── ai/
│   │   │   │   ├── claude.ts         # Claude API client wrapper
│   │   │   │   ├── prompts.ts        # System prompts (Claude + Ollama)
│   │   │   │   ├── tool-loop.ts      # Claude agentic loop с tool execution
│   │   │   │   ├── tool-helpers.ts   # Shared tool-execution helpers (permissions, audit, PII)
│   │   │   │   ├── ollama.ts         # Ollama REST API client with native tool calling
│   │   │   │   ├── ollama-tool-loop.ts # Ollama tool-loop (search, files natively)
│   │   │   │   ├── router.ts         # Ollama-first router with Claude fallback
│   │   │   │   └── escalation-check.ts # Regex heuristics for Ollama→Claude escalation
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
│   ├── tool-web-search/      # Каждый tool — отдельный npm package (tool-*)
│   │   ├── src/
│   │   │   └── index.ts
│   │   ├── __tests__/
│   │   │   └── web-search.test.ts
│   │   └── package.json
│   │
│   └── tool-prompt-overlay/  # /клод-промпт, /лама-промпт — overlay над system prompt
│       ├── src/
│       │   └── index.ts
│       ├── __tests__/
│       │   └── index.test.ts
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
  | { type: 'memory_recalled'; facts: Array<{ key: string; value: string; importance: number }> }
  | { type: 'done' }
  | { type: 'error'; message: string };
```

## Tool Interface

```typescript
interface ToolDefinition {
  name: string;
  description: string;                              // для Claude
  permissionLevel: 'auto' | 'confirm' | 'forbidden';
  provider: 'ollama' | 'claude' | 'all';            // which AI engine can use this tool
  parameters: {                                     // JSON Schema
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  handler: (params: Record<string, unknown>, ctx?: ToolContext) => Promise<ToolResult>;
  command?: {
    name: string;        // Ukrainian slash command name
    description: string;
    params?: Array<{ name: string; required: boolean; description?: string }>;
  };
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

### GET /api/commands

**Response:**
```json
[
  {
    "name": "пошук",
    "tool": "web_search",
    "description": "Пошук в інтернеті",
    "params": [{ "name": "query", "required": true, "description": "Пошуковий запит" }]
  }
]
```

**Available Commands:**

| Command | Tool | Description |
|---------|------|-------------|
| /пошук | web_search | Пошук в інтернеті |
| /читати | file_read | Прочитати файл |
| /записати | file_write | Записати у файл |
| /файли | file_list | Список файлів |
| /видалити | file_delete | Видалити файл |
| /перемістити | file_move | Перемістити файл |
| /задача | code_task | Запустити задачу програмування |
| /деплой | code_deploy | Задеплоїти зміни в продакшн |
| /евал | eval_add | Додати поведінковий тест |
| /тести | eval_run | Запустити всі поведінкові тести |
| /память | memory_search | Пошук у пам'яті R2 |
| /запам'ятай | memory_remember | Зберегти факт з importance=10 |
| /забудь | memory_forget | Позначити факт як забутий (через confirm-dialog) |
| — | memory_update | Оновити значення існуючого факту (через confirm-dialog з Edit) |
| — | memory_forget_last | Забути факти, витягнуті з попереднього повідомлення (через confirm-dialog) |
| /клод-промпт | prompt_overlay_claude | Надстройка системного промпту Claude |
| /лама-промпт | prompt_overlay_ollama | Надстройка системного промпту Ollama |
| /нагадай | reminder_create | Створити нагадування (once / daily / weekly / monthly) |
| /нагадування | reminder_list | Список активних нагадувань |
| /почта | emails_list | Список важливих листів з підключених IMAP-ящиків |
| — | emails_get | Повне тіло листа за id з emails_list (без slash-форми) |
| — | emails_status | Зведення черги: скільки листів очікують (awaiting) та скільки оброблено за 7 днів |
| — | emails_dismiss | Прибрати лист з черги awaiting за id (mark delivered); лист не видаляється, лишається в emails_list. Черга також авто-очищається `\Seen` sync-ом (лист, прочитаний/заархівований у Gmail, зникає з awaiting сам, без ручного dismiss) |
| /активність | activity | Зведення активності за компом (застосунки/сайти/час/зміни/відволікання + присутність «активно X / відійшов Y») за період today/yesterday/last_24h — read-only over `window_history` + `distraction_evals` + `presence_log`, gated `WINDOW_LOGGER_ENABLED` |

**Prompt overlays** (`/клод-промпт`, `/лама-промпт`): додають блок «Додаткові інструкції» поверх базового системного промпту для Claude або Ollama без рестарту сервера. Зберігаються у таблиці `prompt_overlays` (SQLite), застосовуються у наступному запиті.

Usage:
- `/клод-промпт будь лаконічним` — зберегти надстройку
- `/клод-промпт --показати` — вивести поточний текст (або `порожньо`)
- `/клод-промпт --скинути` — видалити надстройку
- Ліміт 10 000 символів. Прапорці не можна поєднувати з текстом або між собою.

### Keyboard Shortcuts (UI)

- **Cmd+K** (macOS) / **Ctrl+K** (Linux/Windows) — open command palette
- **/** (in empty input) — open command palette
- **Arrow Up/Down** — navigate commands in palette
- **Enter** — execute selected command
- **Escape** — close palette

### GET /api/events (Server-Sent Events)

Постійний SSE-потік server→client push-подій. `EventSource('/api/events')` з клієнта. Heartbeat `:heartbeat` кожні 20s. Події: `reminder_ring`, `reminder_stop_ring`, `reminder_done`, `reminder_dismissed`, `reminder_snoozed` (див. `ServerPushEvent` у `@r2/shared`). SSE listener whitelists this set by type — server-internal events on the same bus (e.g. `cognition_publish`) never leak to clients.

### POST /api/reminder/dismiss

**Request:** `{ "id": number }`
**Response:** `{ ok: true }` — зупиняє поточний цикл дзвінка, перераховує `next_fire_at_ms` для періодичних нагадувань, деактивує `once`.

### POST /api/reminder/snooze

**Request:** `{ "id": number }`
**Response:** `{ ok: true, snoozedId: number }` — створює 10-хвилинний one-shot клон; оригінал `once` деактивується, періодичний переводиться на наступне заплановане спрацювання.

### GET /api/health

**Response:** `{ "status": "R2 online", "timestamp": "ISO8601" }`

## Agentic Loop (ядро системы)

```
User message (or /command args)
    ↓
POST /api/chat { messages[] }
    ↓
Slash command check:
    ├── /commandName args → rewrite message to instruct LLM to call specific tool
    │   (permissions, audit, PII all work as normal through the tool loop)
    └── No match → proceed as normal message
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

# Always-on (launchd) — survives logout/reboot/sleep
bash scripts/install-r2-service.sh   # LaunchAgent keeps the supervisor alive
```

Supervisor-as-service: the LaunchAgent (`scripts/install-r2-service.sh` →
`com.r2.supervisor.plist`) runs the supervisor through `node --import tsx` (like the worker,
not from `dist`), so a `git pull master` deploy is picked up by the git watcher
with no build step. Two levels of supervision — `launchd` (RunAtLoad/KeepAlive)
restarts the supervisor; the supervisor restarts the worker. See README
"Always-on (launchd)". Don't run it with `npm run dev` (port 3004 conflict).

## Phase 2 — Tools + PII

- Новые tools: files (чтение/запись), documents (PDF/DOCX), reminder
- PII gateway (Presidio Python microservice + Docker)
  - Anonymize перед Claude API, de-anonymize перед юзером
  - Encrypted vault (AES-256) для маппинга токенов

### Multilingual PII Detection

Presidio analyzer is built from a custom Docker image in `presidio/` with spaCy models for en, ru, and uk. Controlled via:
- `PII_LANGUAGES=en,ru,uk` — which languages to query (each is one parallel HTTP call)
- `presidio/Dockerfile` — base image version and spaCy model versions
- `presidio/multilang.yaml` — NLP engine configuration loaded by Presidio at startup

Presidio is **frozen** behind the `pii` compose profile (PII disabled by default), so a plain `docker compose up -d` starts only SearXNG. Enable it with `docker compose --profile pii up -d` — that first run builds the analyzer image locally (~3-5 min). To use it, also set `PII_MODE` to `optional`/`required`.

### Memory System

R2 remembers past conversations via a local vector database. Every chat turn is embedded with `mxbai-embed-large` (via Ollama, 1024-dim) and stored in sqlite-vec tables inside `data/r2.db`. A `TextProvider` (Ollama `qwen2.5:7b` or Claude Haiku — see below) extracts structured facts about the user (`user.location`, `user.phone`, etc.) with versioning — when a fact changes, the old one is marked superseded and history is preserved.

Setup requires an extra Ollama model pull: `ollama pull mxbai-embed-large`. Memory is implemented in `packages/server/src/memory/` and exposed via the `@r2/tool-memory` workspace package. Slash-command invocations and tool results are intentionally NOT indexed: the former is a dispatcher, not user content; the latter bypasses the PII proxy and could leak secrets.

To run without Ollama, set `EMBEDDING_PROVIDER=voyage` + `VOYAGE_API_KEY` and `MEMORY_TEXT_PROVIDER=claude` — embeddings switch to Voyage AI (`voyage-3`, 1024-dim), fact extraction to Claude Haiku. On provider switch, R2 auto-wipes and re-embeds existing memory. See README "Running R2 without Ollama" for details.

Slash commands:
- `/память <query>` — semantic search across stored memories (`memory_search` tool).
- `/запам'ятай <text>` — store a fact with `importance=10` (protected from decay). Supports `key: value` syntax; otherwise stored as `user.note.<id>`.
- `/забудь <key or text>` — marks a fact as `forgotten=1` (raw history preserved). Works by exact key or via search fallback. Gated by a confirm-dialog with edit.

Memory editing tools (confirm-gated, no slash form — invoked by the LLM):
- `memory_forget` — mark a fact as forgotten. Confirm dialog shows preview; Edit button lets the user tweak the query before apply.
- `memory_update` — replace the value of an existing fact (new row supersedes old). Confirm dialog shows `key → newValue`; Edit button lets the user edit `newValue`.
- `memory_forget_last` — forget all facts extracted from the user's previous message. Dry-run preview shown in the confirm dialog; no editable field. Uses `memory_facts.source_message_id` (populated by `indexTurn`) to find the previous turn's facts.

All three emit a `tool_memory_confirm` SSE event; Discord renders an ephemeral embed with Approve / Edit & approve / Deny buttons. Pending confirms are held in `pendingMemoryConfirms` (`routes/memory-confirm.ts`) and resolved via `memoryConfirmService` (`services/memory-confirm-service.ts`).

Importance + decay:
- Facts have `importance` (1 = auto-extractor default, 10 = explicit `/запам'ятай` or keyword-triggered). Keywords: `важливо`, `запам'ятай`, `запомни`, `не забудь`, `don't forget`, `important`.
- Ranking uses `importance * exp(-age / halflife)` with a 30-day half-life. `importance=10` facts survive decay indefinitely; low-importance stale facts sink out of the context prefix (but stay in DB).
- Duplicate keys are deduped on save: new fact supersedes the old via `superseded_by`, inheriting `MAX(new.importance, old.importance)`.
- Recalled facts are emitted as an SSE `memory_recalled` event and rendered in the UI as a "🧠 Згадав: …" card with inline 🗑 per fact (click → `/забудь`).

Read path has two channels:
- **Auto-retrieval**: before every LLM call, router injects ranked memories into the system prompt (decay-weighted facts + top entries, ≤2000 tokens).
- **Tool**: `memory_search` lets the model dig deeper on demand. Available to both Ollama and Claude.

Chat history sent to the LLM is truncated to `CHAT_CONTEXT_BUDGET_CHARS` (default 60000 ≈ 15k tokens), keeping SYSTEM + latest user turn and walking back from the end. Raw messages remain in DB.

Configuration via env vars:
- `MEMORY_ENABLED=true` — kill switch
- `EMBEDDING_PROVIDER=auto|ollama|voyage` — embedding provider. Selection is env-based (no runtime ping): `auto` resolves to Ollama whenever the Ollama client is constructed for memory (i.e., not pinned to Voyage); set `voyage` explicitly to use Voyage.
- `MEMORY_EMBED_MODEL=mxbai-embed-large` — Ollama embedding model (1024-dim)
- `VOYAGE_API_KEY=<key>` — required when `EMBEDDING_PROVIDER=voyage`
- `VOYAGE_MODEL=voyage-3` — Voyage embedding model (1024-dim; also `voyage-3-large`)
- `MEMORY_TEXT_PROVIDER=auto|ollama|claude` — fact-extraction text provider. `auto` resolves to Ollama unless `LOCAL_LLM_MODE=disabled` or the memory-Ollama client is not constructed, in which case it falls back to Claude.
- `MEMORY_EXTRACT_MODEL=qwen2.5:7b` — Ollama extractor model
- `MEMORY_EXTRACT_MODEL_CLAUDE=claude-haiku-4-5-20251001` — Claude extractor model
- `MEMORY_ALLOW_REMOTE_PII=1` — required acknowledgement when memory uses Voyage and/or Claude; raw chat content plus extracted facts (including any PII like emails, phone numbers, addresses) leave the machine unanonymized, since the memory pipeline does not route through the PII proxy. Startup refuses remote-memory configs without this.
- `MEMORY_MAX_CONTEXT_TOKENS=2000` — budget for auto-retrieval prefix
- `CHAT_CONTEXT_BUDGET_CHARS=60000` — messages[] char budget for LLM calls

Memory starts empty on first deploy — pre-existing `chat_messages` are NOT re-indexed.

- Permission dialog в UI (confirm level tools)
- ~~Audit log (SQLite таблица: who, what, when, result)~~ ✓ Phase 2A
- ~~Tool registry: авто-обнаружение tools из packages/tool-*/~~ ✓ Phase 2A

## Phase 3 — Self-modifying R2

- **3A) Supervisor + Worker split** ✓ — process manager, auto-restart, WS status
- **3B) Chat persistence** ✓ — SQLite conversation history, GET /api/messages
- **3C) Git-in-the-loop** ✓ — code_task tool, ralphex on dev worktree
- **3D) Git watcher + auto-deploy** ✓ — supervisor polls master, code_deploy tool, POST /api/merge
- **3E) Eval система** ✓ — LLM-judge evaluator (Haiku), parallel runner, pre-merge gate in `code_deploy`, `eval_add`/`eval_run` tools, store at `data/evals.json`
- **3F) Chat commands + UI** ✓ — command palette (Cmd+K / slash), status bar (LLM source + response time), colored diff view (diff2html)

## Phase 4 — CRM Integration

- **4G) Local LLM router** ✓ — Ollama as first attempt for chat, Claude as fallback
  - `packages/server/src/ai/ollama.ts` — native /api/chat client with tool calling support
  - `packages/server/src/ai/ollama-tool-loop.ts` — tool-loop for Ollama (max 10 iterations)
  - `packages/server/src/ai/tool-helpers.ts` — shared tool-execution helpers (permissions, audit, PII)
  - `packages/server/src/ai/router.ts` — runChatRequest orchestrator
  - `packages/server/src/ai/escalation-check.ts` — regex heuristics for escalation
  - `packages/server/src/ai/timestamp-strip.ts` — shared helper for stripping the `[DD.MM.YYYY, HH:MM]` prefix that `chat.ts` adds to user turns. Used both for memory-query extraction and for cleaning Ollama output (qwen2.5 tends to mirror the prefix in its reply; Claude does not)
  - ToolDefinition has `provider: 'ollama' | 'claude' | 'all'` — controls which engine sees which tools
  - Ollama handles `web_search` and file tools natively; escalates only for `code_task` (claude-only)
  - LOCAL_LLM_MODE=disabled gates the chat router only (all chat → Claude); memory/embeddings stay active when MEMORY_ENABLED=true; ollama unreachable → silent fallback
  - Default model: qwen2.5:7b (~5 GB RAM). Run `ollama serve` + `ollama pull qwen2.5:7b` before use.
  - Cold start with full system prompt + ~11 tool schemas can take 10-20s on first call — keep `OLLAMA_TIMEOUT_MS` ≥ 30000 or expect silent fallbacks to Claude while the model loads.
- **5A) Reminder tool** ✓ — alarm-style one-shot and recurring (daily/weekly/monthly) reminders
  - `packages/tool-reminder` — tool definitions (create claude-only; list/delete provider='all')
  - `packages/server/src/reminders/` — `recurrence.ts` (next-fire calculator), `store.ts` (SQLite CRUD + state machine), `scheduler.ts` (idempotent background tick), `bus.ts` (EventEmitter singleton)
  - `packages/server/src/routes/events.ts` — Server-Sent Events endpoint `/api/events` (20s heartbeat, EventSource-compatible)
  - `packages/server/src/routes/reminder.ts` — POST `/api/reminder/dismiss`, POST `/api/reminder/snooze`
  - `packages/client/src/components/ReminderCard.tsx` — inline reminder card rendered in MessageBubble (dismiss/snooze buttons, status-colored border)
  - `packages/client/src/lib/alarm-audio.ts` — Web Audio API pulsed tone (880 Hz, no binary asset), managed by useChat hook
  - Alarm cycle: 60s ring → 2 min pause → 60s ring → 2 min pause → 60s ring → done (3 rings total before "пропущено")
  - Schedule discriminated union: `once` / `daily` / `weekly` / `monthly`, LLM translates natural language → structured params (qwen escalates `reminder_create` to Claude via `provider: 'claude'` because qwen2.5 is unreliable at datetime arithmetic / weekday numbering)
  - State machine is idempotent across server restarts: state lives in SQLite, scheduler tick resumes from whatever row state it finds on next tick after reboot
  - Runtime override of `provider` (to force reminder_create onto Ollama after upgrading models) is a backlog item ("Tool provider overrides")
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
# Eval system (Phase 3E)
EVAL_CONCURRENCY=3                # parallel eval runs
EVALS_PATH=./data/evals.json      # behavior evals store
CLAUDE_HAIKU_MODEL=claude-haiku-4-5-20251001  # evaluator model
# Discord bot (DM-only, whitelist-gated)
DISCORD_BOT_TOKEN=                 # bot token; if unset the bot does not start
DISCORD_ALLOWED_USER_IDS=          # comma-separated Discord user IDs; required when token is set
DISCORD_REQUEST_TIMEOUT_MS=300000  # per-message request timeout; on expiry unresolved permission/plan-review embeds are edited to "⚠️ expired"
DISCORD_COALESCE_MS=1500           # debounce window for burst coalescing; each new DM resets the timer, LLM runs once after idle
# Local LLM router (Phase 4G)
LOCAL_LLM_MODE=enabled            # enabled | disabled (gates chat router + the Ollama memory text-provider)
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=qwen2.5:7b
OLLAMA_TIMEOUT_MS=15000
OLLAMA_ALLOW_REMOTE=               # =1 to permit non-loopback OLLAMA_URL (otherwise startup refuses — Ollama path bypasses PII anonymization)
# Memory system (Phase 2 — Memory)
MEMORY_ENABLED=true                # kill switch; false skips sqlite-vec load
EMBEDDING_PROVIDER=auto            # auto | ollama | voyage. Env-based, no runtime ping; auto resolves to ollama when the memory-ollama client is constructed
MEMORY_TEXT_PROVIDER=auto          # auto | ollama | claude. auto resolves to ollama unless LOCAL_LLM_MODE=disabled or the memory-ollama client is unset
MEMORY_EMBED_MODEL=mxbai-embed-large            # Ollama embedding model (1024-dim)
MEMORY_EXTRACT_MODEL=qwen2.5:7b                 # Ollama extractor model
MEMORY_EXTRACT_MODEL_CLAUDE=claude-haiku-4-5-20251001  # Claude extractor model (when text provider = claude)
VOYAGE_API_KEY=                    # required when EMBEDDING_PROVIDER=voyage
VOYAGE_MODEL=voyage-3              # voyage-3 | voyage-3-large (both 1024-dim)
MEMORY_ALLOW_REMOTE_PII=           # =1 required when memory uses Voyage and/or Claude (raw chat + extracted PII flow out unanonymized); startup refuses otherwise
MEMORY_MAX_CONTEXT_TOKENS=2000     # budget for auto-retrieval prefix
# Email watcher (Phase 4F)
IMAP_ACCOUNTS=[]                   # JSON array of {id,host,port,user,password,tls}; empty disables the feature
EMAIL_ENABLED=true                 # kill switch; false disables poller + handler regardless of accounts
EMAIL_POLL_INTERVAL_MS=300000      # IMAP poll interval per account, ms (min 1 s)
EMAIL_DIGEST_THRESHOLD=3           # pending undelivered count required to fire digest
EMAIL_DIGEST_COOLDOWN_MS=7200000   # min gap between digest publishes (applies only after a successful publish)
EMAIL_QUIET_HOUR_START=22          # local hour when evening quiet starts (0-23); morning release is tied to morning-brief publish, 09:00 fallback after 7d silence
EMAIL_URGENT_ENABLED=false         # opt-in: immediate Discord ping for importance=5 emails (also requires Discord bot live; suppressed during quiet hours)
EMAIL_SEND_HOLD_SECONDS=30         # hold zone before SMTP send for draft replies (0-300, default 30); 0 bypasses the hold (kill switch, restores pre-iter-3 instant send)
EMAIL_ACCOUNT_BLIND_ALERT_AFTER=3  # consecutive failed poll ticks before an account is flagged "blind" and a one-shot Discord alert fires; reset by the next successful poll (1-100, default 3 ≈15 min at the 5-min interval)
# Implicit feedback (Pain #1 iter 4) — learn from how the user reacts to urgent pings
EMAIL_FEEDBACK_ENABLED=false       # opt-in: collect IMAP-flag outcomes per urgent ping and auto-demote ignored senders; default off = zero behaviour change (no feedback rows, no auto-rules)
EMAIL_FEEDBACK_IGNORE_HOURS=24     # hours after a ping before an unanswered email is finalized as read (\Seen) or ignored (never \Seen) (1-168)
EMAIL_FEEDBACK_SUPPRESS_AFTER=3    # negative outcomes (ignored + read-without-reply) per sender in the lookback before auto-suppression fires (1-20)
EMAIL_FEEDBACK_SUPPRESS_TTL_DAYS=7 # TTL of an auto suppression rule, also the scorer lookback window (1-90)
EMAIL_FEEDBACK_MAX_REPOLL=50       # cap on unresolved UIDs re-polled for flags per account per tick (1-500)
# Weather (Open-Meteo) — key-less forecast by coordinates
WEATHER_ENABLED=false              # master switch: 3-day outlook in the morning brief + the on-demand `weather` tool (off ⇒ brief shows "погода недоступна", tool reports "not enabled")
WEATHER_TZ=Europe/Kyiv             # forecast timezone (string)
WEATHER_LAT=                       # optional manual coordinate override (both required); wins over geocoding — use when Open-Meteo doesn't know a small village
WEATHER_LON=
WEATHER_ALERT_ENABLED=false        # proactive `weatherAlert` handler; needs WEATHER_ENABLED=true + resolvable coordinates + a live Discord bot
WEATHER_TEMP_SWING_C=8             # day-over-day Δ°C that counts as a swing (1-30, else default)
WEATHER_PRECIP_PROB_PCT=60         # precip probability % that reads as "rain coming" (0-100, else default)
WEATHER_LEAD_HOURS=6               # intraday look-ahead window, hours (1-48, else default)
WEATHER_CHECK_INTERVAL_H=3         # min hours between forecast checks (1-24, else default)
WEATHER_ALERT_DEDUPE_H=12          # don't re-ping the same event for N hours (1-168, else default)
WEATHER_QUIET_START=22             # no pings at/after this local hour (0-23, else default)
WEATHER_QUIET_END=8                # no pings before this local hour (0-23, else default)
REDELIVER_MAX_AGE_MS=21600000     # max age (ms) of an undelivered cognition publish run still re-delivered on Discord (re)connect/restart; valid range 5m..48h, else default 6h
```

## Discord Bot (DM channel)

R2 can receive messages via Discord DMs in addition to the web UI. The bot is whitelist-gated: only configured user IDs can interact with it; all other DMs are silently ignored.

### Setup

1. Go to https://discord.com/developers/applications and create a new Application.
2. Under **Bot**, click "Reset Token" and copy the token into `DISCORD_BOT_TOKEN` in `.env`.
3. Enable **Message Content Intent** on the Bot page (required for reading DM text).
4. Create a private Discord server for yourself if you don't already have one (sidebar `+` → Create My Own → For me and my friends). Discord does not allow inviting bots directly to DMs — you and the bot must share at least one server before DMs are possible.
5. Under **OAuth2 → URL Generator**, select scope `bot` and permission `Send Messages`. Open the generated URL and authorize the bot into your private server from step 4.
6. In Discord client, enable **Developer Mode** (Settings → Advanced → Developer Mode). Right-click your profile → **Copy User ID**. Add the ID to `DISCORD_ALLOWED_USER_IDS` in `.env` (comma-separated for multiple users).
7. Restart the server. Open your private server, find the bot in the member list, click it → **Message**, and send a DM to verify. The bot will only appear in your Direct Messages sidebar after you send it the first message.

### Env vars

- `DISCORD_BOT_TOKEN` — bot token; if unset the bot does not start
- `DISCORD_ALLOWED_USER_IDS` — comma-separated Discord user IDs; required when token is set
- `DISCORD_REQUEST_TIMEOUT_MS` — per-message request timeout in ms (default 300000); on expiry unresolved permission/plan-review embeds are edited to `⚠️ expired`
- `DISCORD_COALESCE_MS` — burst coalescing debounce window in ms (default 1500); incoming DMs are saved immediately but `handleMessage` (history read + LLM call) only fires after this much idle time, so a series of short multi-turn messages triggers the LLM once
- `DISCORD_RECONNECT_BASE_MS` — background connect-retry backoff floor in ms (default 5000, clamped 1000–60000); the first retry after a failed initial connect waits ~this long
- `DISCORD_RECONNECT_CAP_MS` — background connect-retry backoff ceiling in ms (default 300000, clamped 5000–1800000); capped exponential backoff with full jitter never waits longer than this. If the initial connect fails (flapping VPN/DNS), R2 boots degraded — HTTP/pollers up — and a detached loop retries the connection, registering Discord-gated handlers exactly once on the first success; no manual restart needed

### Slash commands

Available in DM with the bot:

- `/clear` — Clear all chat history (confirms Yes/No)
- `/status` — Show model, uptime, active reminders, pending permissions
- `/reminders` — List active reminders
- `/memory [query]` — List recent memory entries, or search when query provided
- `/permissions` — List saved "Allow always" rules; each rule gets a Revoke button (up to 5 at a time; re-open `/permissions` to paginate)
- `/heartbeat status|pause|resume` — Cognition layer control. `status` shows paused state, last tick, ticks in last 24h, queue depth, registered handlers and last 10 runs. `pause`/`resume` toggle the heartbeat (persists across restarts via `cognition_state` in SQLite).
- `/why [id:<n>]` — Explain why an `emailUrgent` ping fired. No arg → most recent successfully-pinged urgent row; `id:<n>` → that specific `email_pending` row. Embed shows from / subject / importance / received & ping timestamps, 7-day history with the same sender (pings, sent, cancelled, errors via `email_sent_log` + `email_pending`), and any active suppression rule that would match the row. Rows with `urgent_pinged_at = -1` (sentinel for "suppressed by rule") get a dedicated message explaining which rule blocked the ping. When `EMAIL_FEEDBACK_ENABLED`, the embed also shows the sender's implicit-feedback signals — replied/read/ignored counts over the suppress lookback and any active `auto_feedback` auto-suppression with its expiry. Read-only; ephemeral.

### Interactive embeds

- `reminder_ring` → embed with "Dismiss" / "Snooze 10m" buttons
- `tool_confirm_request` → embed with "Allow once" / "Allow always" / "Deny" buttons
- `tool_plan_review` → multi-chunk plan + "Approve" / "Reject" buttons
- `tool_memory_confirm` → ephemeral message with "✅ Approve" / "✏️ Edit & approve" / "❌ Deny" buttons; Edit opens a modal (`memconfirm_modal:<callId>:<field>`) prefilled with the current query/newValue. `memory_forget_last` has no editable field — approve/deny only.
- `tool_call_start` → 🔧 + tool name in "running" state (gray). Edited in place as the call progresses: `tool_progress` → debounced "progress" edit (800 ms), `tool_call_result` → ✅ "done" (green) or ❌ "error" (red). `SILENT_TOOLS` (`memory_search`, `memory_save`, `router`) skip the embed to avoid DM noise.
- `code_task` result → structured embed (Task / Commit / Files / duration) plus a `code_task_<shortSha|callId>.diff` file attachment. Attachments > 24 MB are replaced by a `⚠️ diff too large to attach` notice.
- `emailUrgent` ping → rich embed with from / subject / snippet plus three buttons: `Draft reply` (`email_draft:start:<rowId>`), `🙈 Sender` (`email_suppress:sender_start:<rowId>`), `🙈 Subject` (`email_suppress:subject_start:<rowId>`). Draft path: ephemeral `✏️ Черновик: …` with `Send` / `Edit` / `Cancel`; `Edit` opens a modal (`email_draft_modal:<pendingId>`) prefilled with the current body. State is held in-memory by `draftReplyService` (lost on restart by design). Send hold flow: clicking `Send` arms a `setTimeout` for `EMAIL_SEND_HOLD_SECONDS` (default 30, range 0-300) and edits the ephemeral to `"✉️ Will send at HH:MM:SS"` + a single `Cancel send` button (`email_draft:cancelSend:<pendingId>`); on timer fire SMTP runs and the ephemeral edits to `"✅ Sent"`, on Cancel within the window the timer is cleared and the ephemeral edits to `"🚫 Cancelled"`. `EMAIL_SEND_HOLD_SECONDS=0` bypasses the hold and sends synchronously (one-env-edit kill switch). A pre-check refuses Send when the remaining 15-min ephemeral webhook window can't cover hold+60s buffer. Every terminal outcome is logged to the `email_sent_log` table (`action ∈ sent|cancelled|error`). SIGTERM during hold is an explicit known edge case — pending timers are lost on restart and the stale `"Will send at …"` ephemeral has no resolution path. Suppression path: `🙈 Sender` → ephemeral with four TTL buttons `1d / 7d / 30d / forever` (`email_suppress:sender_set_ttl:<rowId>:<days>`, `0` = forever) → click stores a rule on the row's `from_addr`. `🙈 Subject` → modal (`email_suppress:subject_submit:<rowId>`) with the current subject pre-filled (editable substring) + a days field (default 7, range 0-365; 0 = forever) → submit stores a rule on the substring. Active rules live in `email_suppression_rules` (`rule_type ∈ sender|subject`, `expires_at` NULL = forever, `created_via ∈ discord_button|auto_feedback` — provenance tag; the 🙈 buttons write `discord_button`, the feedback scorer writes/clears only `auto_feedback` rules and never touches manual ones). On the next tick, `emailUrgent.trigger()` calls `suppressionStore.findActiveMatch(from, subject, now)` before `findUnpingedUrgent`; if a candidate row matches an active rule, the row is marked `urgent_pinged_at = -1` (sentinel for "suppressed by rule") and the trigger returns false. Suppressed rows stay out of subsequent urgent attempts but remain available to the digest path. `/why` detects the sentinel and shows which rule blocked the ping. Known limitation: a row marked `-1` stays excluded from `findUnpingedUrgent` even after its rule expires, since the query filters on `urgent_pinged_at IS NULL` rather than NULL-or-`-1`; deferred to iter 5.5.
- Ollama → Claude escalation → the next assistant message is prefixed with `🔵 claude\n\n` on the first flush after the `assistant_source` switch.

Embeds are edited in place on resolution (success/denial) or request timeout (→ `⚠️ expired`). Tool-call embeds that remain in non-terminal state when the request ends are edited to an error embed so no DM is left in a perpetual "running" state. Button interactions land on `interactionCreate` and are routed through `channels/discord/interactions.ts` to services (`reminder-service`, `permission-service`, `plan-review-service`, `command-service`, `memory-confirm-service`, `draft-reply-service`). Button domains in use: `reminder`, `tool_confirm`, `tool_plan_review`, `memory_confirm`, `email_draft`, `email_suppress`.

### Architecture

The adapter lives in `packages/server/src/channels/discord/bot.ts`. It plugs directly into `runChatRequest` with `source='discord:<userId>'`, reusing the full pipeline (tool loop, memory, PII). Messages are isolated from web chat via the `source` column in `chat_messages`.

Multi-turn burst coalescing: each incoming DM is saved to `chat_messages` immediately, then a per-user debounce timer (`DISCORD_COALESCE_MS`, default 1500 ms) is armed. Additional DMs reset the timer; when idle elapses, `handleMessage` runs once with `{ alreadySaved: true }` and reads the full burst from DB as a single user turn (the history builder collapses consecutive same-role messages). This lets the LLM see the full intent after a chain of short clarifying replies and respond once instead of on every fragment. `userQueues` still serializes processing so a new burst cannot overlap with an in-flight LLM call. Extracted memory facts anchor to the last message of the burst — see comment in `packages/server/src/memory/service.ts` `runIndexTurn`.

The Discord bot also subscribes to `reminderBus` and forwards `reminder_ring` events as interactive embeds to all whitelisted users; on `reminder_done`/`reminder_dismissed`/`reminder_snoozed` the corresponding embed is edited in place for the owning user. No additional configuration beyond the standard Discord bot setup is required.

The same bus also carries a server-internal `cognition_publish` event emitted by the cognition layer when a handler returns `{ publish: true, content }`. The Discord bot DMs `💭 _from <handler>_\n<content>` to the whitelist and marks the run as published exactly once on the first successful delivery. The SSE route in `routes/events.ts` filters `cognition_publish` out, so web clients never see it.

## Cognition layer (Phase 5B)

Background "thinking" loop that can act proactively, distinct from the reactive Discord request path.

- Module: `packages/server/src/cognition/` — `types.ts` (Handler/HandlerState/HandlerResult), `store.ts` (SQLite pause/ticks/runs), `registry.ts` (handler map), `queue.ts` (single-worker FIFO with per-job `AbortController` — handlers race against abort so `workerTimeoutMs` actually terminates stuck work), `dispatcher.ts` (per-tick trigger loop), `heartbeat.ts` (60 s `setInterval` with re-entrancy guard), `service.ts` (composed API).
- Tables: `cognition_state` (singleton `id=1` row; `paused`, `paused_at`), `cognition_ticks` (pruned >7 d), `cognition_handler_runs` (`outcome ∈ publish|skip|error`, optional `published_at`).
- Wiring: `createCognitionService({ db, bus: reminderBus })` in `index.ts` registers `pulseHandler` (demo, always returns `skip`) and `morningBrief` (Europe/Kyiv summary via Claude through `PiiProxy`; trigger has two branches — **A — morning window** at/after 06:00 local with any activity since 06:00 today; **B — gap-return** when the previous successful publish was ≥ `GAP_MODE_THRESHOLD` (=2) local days ago AND there was activity in the last hour. In both branches "activity" is **earliest-wins**: a chat message (`hasUserActivitySince`/`hasUserActivityInLastHour`, checked first) **OR** a window session starting (`hasWindowActivitySince` over `window_history.started_at`, idle frontmost apps in `IDLE_APP_NAMES` excluded) — so the brief fires proactively the moment the user sits down at the Mac, even with zero manual input. A successful publish today blocks both branches via a `publishedToday` lock. Constants live at the top of `cognition/handlers/morningBrief.ts` and `morningBrief.helpers.ts`). The Claude path runs a lightweight tool-loop (max 5 iterations) with `web_search` injected for general lookups; Ollama fallback stays tool-less. Weather is **no longer** fetched via `web_search` — when `WEATHER_ENABLED=true`, `gatherData` deterministically fetches a 3-day Open-Meteo forecast (`weather/open-meteo.ts`) for the resolved coordinates and `composePrompt` injects a "## Погода (3 дня)" section (or "погода недоступна" on a null/failed fetch); see the Weather section below. When Discord bot starts and email-watcher is enabled, `emailDigest` is also registered (see Phase 4F below). When `EMAIL_URGENT_ENABLED=true` AND Discord is configured, `emailUrgent` is also registered — it pings the user immediately for `importance=5` emails (suppressed during quiet hours, one row per tick, marks `urgent_pinged_at` on publish so each row pings at most once). The urgent embed carries a `Draft reply` button: click → `interactions.ts` walks the IMAP thread via `emails/thread-fetcher.ts` (References/In-Reply-To header chain, max 20 messages), asks Claude for a one-shot draft, shows the result ephemerally with `Send`/`Edit`/`Cancel`. Send goes through `emails/smtp-client.ts` (nodemailer, port 465, secure: true) using the **same Gmail/iCloud app password as IMAP** — `smtpHostFor()` just swaps the `imap.*` → `smtp.*` host prefix. Pending draft state lives in `draftReplyService` (in-memory `Map`, lost on restart by design). `cognitionService.start()` on boot, `await cognitionService.stop()` on `SIGTERM` so in-flight work drains.
- `morningBrief.helpers.ts` exposes `gatherPreviousPeriod` (7-source bundle: chat, memory created/updated/forgotten, heavy-tool audit log, non-self cognition runs, overdue & created reminders) and `renderPreviousPeriod` (tail-first, char-budgeted at `MAX_BUNDLE_CHARS`). `gatherData` returns `{ …, gapDays, previousPeriod, previousPeriodFrom, previousPeriodTo }`; `composePrompt` injects a "Прошлый период" section and, when `gapDays >= GAP_MODE_THRESHOLD`, a "Пока меня не было N дней" preamble (with Russian plural agreement via `pluralizeDays`). For gap-return the recap window ends at `now` (today's first-return message lands in the bundle); for normal mornings it ends at local midnight.
- Publish flow: `run()` returning `{ publish: true, content, embed?, components? }` → `queue.ts` emits `cognition_publish` on `reminderBus` (carries `embed` + `components` through) → bot DMs whitelist (rich embed when present, plain text otherwise; both paths set `allowedMentions: { parse: [] }` so LLM-emitted `@everyone` cannot ping) → `markPublished` called once on first success.
- Push re-delivery on Discord (re)connect (resilience) — a DM-send failure (transient network/DNS outage) left the run `published_at NULL` with no retry, so once-per-day/cooldown-gated pushes were lost forever. Fix: `store.recordHandlerRun` now persists `publish_payload` (`{content, embed, components}`, only for `outcome='publish'`) via an idempotent `PRAGMA`-guarded `ALTER TABLE … ADD COLUMN publish_payload TEXT` migration in `db.ts` (nullable; NULL = pre-migration row ⇒ `findUndeliveredPublishes` falls back to `{content}`; corrupt JSON ⇒ same fallback). `store.findUndeliveredPublishes(sinceMs)` returns `outcome='publish' AND published_at IS NULL AND fired_at >= sinceMs` (exposed on `CognitionService`). `bot.ts` extracts the DM send into a shared `deliverCognitionPush(event)` helper (live `cognition_publish` listener + flush both use it; `marked` flips only on the first *successful* recipient send so a partial failure leaves the run eligible) and adds `flushUndeliveredPushes()` hooked on `client.on('shardReady'|'shardResume')` (in-process reconnect) and once after the `clientReady` DM pre-cache (restart-after-outage — note `shardReady` fires *before* `isReady()` on a cold start, so its flush no-ops and `clientReady` is the path that actually re-delivers on restart). Idempotent via `markPublished` (single gate, at-most-once); an in-flight `flushing` boolean stops overlapping shard events from double-flushing; freshness bounded by `REDELIVER_MAX_AGE_MS` (valid range 5m..48h, else default 6h, wired via `redeliverMaxAgeMs`). **Known limitation:** re-delivery calls `markPublished` → `queue.firePublished(runId)`, which only fires the *in-memory* `onPublished` callback. On the in-process reconnect path the callback survives; on a **restart** (the `clientReady` path) the map is empty, so a handler's `onPublished` side-effect is **skipped**. Only `morningBrief` is truly benign (no `onPublished` callback). Every handler that carries an `onPublished` side-effect is affected the same way: `weatherAlert` (`recordAlert` dedup marker), `emailUrgent` (`markUrgentPinged`), `emailDigest` (`markDelivered` — skipping it leaves the digest's email rows pending, so the digest re-fires once the cooldown lapses), `contextSwitch` (`recordPing` away-app dedup), and `distractionPullback` (`recordEval` dwell dedup). In each case the skipped marker/ack lets the run fire **once more** on the next tick (duplicate, not lost; the re-fired run runs in-process so its `onPublished` lands and bounds it to a single repeat). Note that `markDelivered`/`recordAlert` being *idempotent* does **not** help here — on a restart they run zero times, not twice. Persisting `onPublished` across restarts is deliberately out of scope (YAGNI).
- Adding a handler: copy `handlers/pulse.ts`, give it a unique `name`, implement `trigger(state, ctx)` (sync or async — may return `boolean | Promise<boolean>`; `ctx.db` is available for DB-dependent gating) and async `run(ctx)`; `run()` should honor `ctx.signal` to cooperate with the queue timeout. Handlers may also return `embed?: EmbedData` and `components?: ComponentData[]` (plain-data shapes from `cognition/types.ts` — `ButtonStyle`, `ButtonData`, `ComponentData`, `EmbedFieldData`, `EmbedData`) when they want rich Discord output; `bot.ts` converts these to `EmbedBuilder` / `ActionRowBuilder<ButtonBuilder>` at the channel boundary so the cognition layer stays free of discord.js.
- `contextSwitch` (Digital Observer, Pain #2 iter 1 — **off by default; superseded by `distractionPullback`**) — now gated behind `CONTEXT_SWITCH_ENABLED=true` (default false) AND `process.platform === 'darwin'` AND Discord is live; the `window-logger` poller itself still runs under `WINDOW_LOGGER_ENABLED` and feeds both handlers. A 30 s `osascript` poller (`observers/window-logger.ts` + `window-snapshot.ts`) records the foreground app+title into `window_history` (coalescing identical consecutive samples). `window-snapshot.ts:getActive()` makes up to three `execFile` calls: Call 1 = System Events (frontApp + generic `name of front window`); when `frontApp` is in `BROWSER_TITLE_SCRIPTS` (`Google Chrome` → `title of active tab of front window`, `Safari` → `name of current tab of front window`), Call 2 runs the browser's own AppleScript for the **active tab title**, and the final `window_title` is the non-empty Call 2 result, else the Call 1 generic (fallback) — non-browsers skip Call 2. Call 3 (iter-3, browsers only) runs `BROWSER_URL_SCRIPTS` for the **active-tab URL**, passed through `stripUrl` (drops scheme/query/fragment/`www.`/trailing slash, returns null for non-http(s)) so only **host+path** reaches the nullable `url TEXT` column on `window_history` — query strings (and any tokens in them) are never stored; the grab is best-effort and silent on failure (the Call-2 hint already covers the once-per-browser Automation warning). Calls are deliberately split so JS catches a missing browser-Automation grant (instead of swallowing it in an AppleScript `try`) and logs the `System Settings → Privacy & Security → Automation` hint **once** (latch, like the window-logger blind notice); `WindowSnapshot`/`parseSnapshot` shape and the 5 s timeout / `err → null` semantics are unchanged. Browser tab titles need a **separate** Automation grant per browser (Chrome/Safari) on top of System Events; the map is extensible (Edge/Arc/Firefox later, one line each). `observers/context-switch-detector.ts` is a pure heuristic: detects `[long away-session on app B] → [stable return to app A]` using `CONTEXT_SWITCH_LONG_SESSION_MIN` / `_GAP_MIN` / `_STABLE_NEW_MIN`, deduped per away-app via `context_pings` over `_DEDUPE_WINDOW_H`. The handler publishes a privacy-by-default `🔁 Restore context?` embed (summary only — app + duration); a `Show titles` button (`window:show:<app>:<from>:<to>`) reveals the title list as an ephemeral message. `onPublished` records the ping so each away-app pings at most once per dedupe window. macOS Automation permission required on first run. Self-diagnostics (iter 1.5): the poller counts consecutive blind ticks (`null`/timeout/throw from `osascript`) and, on reaching `WINDOW_LOGGER_BLIND_ALERT_AFTER` (default 10 ≈ 5 min), fires `onBlind` once → `[window-logger] BLIND: …` warning + a single Discord DM via the cognition-publish path (sentinel `runId: -1`); resets on the first good sample (`onRecover` logs, no second DM).
- `distractionPullback` (Digital Observer, Pain #2 iter 2 — **supersedes `contextSwitch`**) — registered when `DISTRACTION_ENABLED=true` AND `process.platform === 'darwin'` AND Discord is live (same triple gate). Reuses the iter-1 `window-logger` poller / `window_history`; the iter-1 `contextSwitch` is now gated behind a separate `CONTEXT_SWITCH_ENABLED=true` (default false) so only the proactive handler runs by default. Two stages, both cost-aware. **Filter (pure):** `observers/distraction-detector.ts:shouldEvaluateDistraction` coalesces consecutive titles into one **app-level dwell** by `current.app_name` (a string of YouTube clips = one dwell, not a reset per title), computes `dwell = now - runStart`, and flags a candidate only when `dwell >= DISTRACTION_DWELL_MIN`, a real non-idle session of a *different* app preceded `runStart` (within `_WORK_LOOKBACK_MIN`), no active snooze, under the daily cap, and not already deduped — dedup/re-eval key is `(app_name, runStart)`, re-judged only when the dwell grows `>= _REEVAL_MIN` **or** the `window_title` flips (catches a fast localhost→YouTube swap). **Judge (haiku):** `cognition/handlers/distractionPullback.judge.ts` — `buildJudgePrompt(timeline, current)` (pure; most-recent-first app+title lines) + `judgeDistraction({anthropic, model, signal}, …)` runs one `messages.create` with a forced `report_verdict` tool (`verdict: distracted|break|working|unknown`, `confidence: 0..100`, `reason`, `work_summary`). Work-vs-leisure inside one app (a YouTube tutorial on the user's stack ⇒ `working`; an IDE never triggers) is decided here from titles; when titles are empty/uninformative and the judge can't tell what the user is doing it returns `unknown` (silent — better than guessing `distracted` on a blank signal, the fix for the false "~104 min in Chrome, undefined activity" ping). The handler (`createDistractionHandler(deps)`, injectable `judge` for tests) does a defensive re-check in `run`, builds the timeline via `store.findRecentRows(firedAt - _JUDGE_LOOKBACK_MIN)`, and publishes a nudge only on `distracted && confidence >= DISTRACTION_CONFIDENCE_PCT` (so `break`/`working`/`unknown` never ping — `unknown` is also in the `DistractionVerdict` eval-store type); every non-ping verdict records an eval and `{skip}`; a judge throw records `verdict='error'` and `{skip}` — **never publishes on error** (silent on failure, no false ping). State lives in `distraction_evals` (`observers/distraction-eval-store.ts`: `findLatestEvalForDwell`, `findRecentPing`, `countEvalsSince`, `activeSnoozeUntil`, `recordEval`, `recordFeedback`) for dedup, daily cap and snooze. **Nudge UI:** `channels/discord/embeds.ts:buildDistractionNudge(event)` → 4 buttons `distract:back:{runStart}` (ack «Возвращаюсь»), `distract:work:{app}:{runStart}` (records `work` feedback, mutes re-eval of that dwell), `distract:done:{app}:{runStart}` (records `done` feedback — «✅ Закончил», a data signal for iter-2 judge learning; behaves like `work` for re-nag suppression, no detector/schema change since `feedback` is free TEXT), `distract:snooze:{app}:{runStart}` (snoozes all pullbacks for `DISTRACTION_SNOOZE_MIN`) — work+done+snooze all carry `{app}` because `recordFeedback(app, dwellStart, …)` addresses the row by the `(app, runStart)` dwell key; a customId >100 chars drops work+done+snooze but keeps the ack. `DistractionFeedback = 'back' | 'work' | 'snooze' | 'done'`. Button routing: `channels/discord/interactions.ts:handleDistractFeedback` from `routeButton`, ephemeral reply; bot gets `distractionEvalStore` + `distractionSnoozeMin` via `DiscordBotDeps` (mirror `windowStore`). Env (all `envInt`, in `.env.example`): `DISTRACTION_DWELL_MIN` 25, `_WORK_LOOKBACK_MIN` 120, `_JUDGE_LOOKBACK_MIN` 60, `_DEDUPE_H` 3, `_REEVAL_MIN` 30, `_CONFIDENCE_PCT` 70, `_SNOOZE_MIN` 60, `_DAILY_LLM_CAP` 40, plus `DISTRACTION_JUDGE_MODEL` (string, default `claude-haiku-4-5`).
- `@r2/tool-activity` (`activity` tool — read-only on-demand query of the Digital Observer, complements the proactive `distractionPullback`) — `createTool({store, evalStore})` exposes one tool (`name: 'activity'`, `permissionLevel: 'auto'`, `provider: 'all'`, slash `/активність`, param `period` enum `today|yesterday|last_24h`). Injected from `index.ts` with `store: windowLoggerEnabled ? windowStore : null` and `evalStore: windowLoggerEnabled ? distractionEvalStore : null` (both gated the same way; the two stores are hoisted above `discoverTools` so the tool + the Discord buttons share one instance). Null `store` → handler returns `{success:false, error:'digital observer выключен (WINDOW_LOGGER_ENABLED)'}` instead of an empty digest. **Flow:** `resolveRange(period, now)` maps `today`→`[localMidnight, now]`, `yesterday`→`[midnight−24h, midnight]`, `last_24h`→`[now−24h, now]` (RU labels); the handler calls `store.findRowsInWindow(from, to, 2000)` + `evalStore.listEvalsInWindow(from, to)` and runs the **pure** `buildActivityDigest(rows, evals, range)` (`digest.ts`): drops idle apps (`loginwindow`/`ScreenSaverEngine`), clamps each row to the window, builds `by_app` + `share`, `top_sites` by URL host, glues same-app runs → `context_switches` + notable `timeline` (≥3 min), an `observer` layer (episodes/counts/coverage_note from evals), plus a ready-to-voice RU `summary`. The whole package is `try/catch`-wrapped → `{success:false, error}` on any store throw. Structural types (`WindowRowLike`/`EvalLike`/`ActivityStoreLike`/`ActivityEvalStoreLike`) are local to the package (self-contained like `tool-weather`), satisfied structurally by the server's `WindowHistoryStore`/`DistractionEvalStore`. **Store methods added for this:** `window-history-store.ts:findRowsInWindow(from, to, limit)` (rows overlapping `[from,to]`, upper-bounded by `started_at < to` so a past-day query isn't truncated by newer out-of-window rows eating the `LIMIT`) and `distraction-eval-store.ts:listEvalsInWindow(from, to)` (evals with `evaluated_at` in `[from,to]`, chronological). **Routing:** an `ACTIVITY_RULES` block in `prompts.ts` is injected into **both** `getSystemPrompt` (Claude) and `getLocalSystemPrompt` (Ollama) so activity questions go to the tool and the agent stops falsely claiming it has no access. **Presence/away (idle tracking):** the digest signature is `buildActivityDigest(rows, evals, awaySpans, range)` — the handler also injects an optional `presence` store (`PresenceStore|null` on `ToolDeps`, gated on `WINDOW_LOGGER_ENABLED` like `store`/`evalStore`) and passes `presence?.listAwayInWindow(from, to)` (spans overlapping the range) as `awaySpans`. `digest.ts` clamps each span to `range`, sums `away_min = Σ max(0, min(to,range.to) − max(from,range.from)) / 60000`, exposes `away_spans:[{from,to,min}]`, and the RU `summary` reads "активно ~X, отошёл ~Y (N отлучек)" (the away clause is omitted when there are no spans). See the presence pipeline below.
- Presence / away detection (idle tracking) — the focus-only observer counted a window left in front (or an overnight YouTube tab) as active time (the `activity` tool reported ~19.6 h/day). Fix lives in three pieces, all macOS-gated under the same poller block. **Idle source** (`observers/idle-source.ts`, `createIoregIdleSource()` → `IdleSource = {getIdleSeconds(): Promise<number|null>}`): runs `ioreg -c IOHIDSystem`, regex-parses `HIDIdleTime` (ns) → `Math.round(ns/1e9)` seconds; any failure / non-macOS / unparseable output → `null` (injectable exec-runner for tests). **State machine** in `observers/window-logger.ts` (new deps `idleSource`, `presence`, `idleThresholdSec`; all optional → without `idleSource` the logger behaves exactly as before, backward-compat): each tick reads `idleSec = await idleSource.getIdleSeconds()`; **away** (`idleSec >= idleThresholdSec`) → skip `recordSample`, and if `awayStartedAt == null` open the span back-dated to `now − idleSec*1000` (never before the last active tick); **active** (`idleSec` below threshold **or** `null`) → if a span is open, `presence.recordAway(awayStartedAt, now)` and reset, then `recordSample` as usual. Open spans are never persisted; only closed `[awayStart, now]` spans land in `presence_log`. The idle check never touches blind-detection (a `null` idle reading is "active", not "blind"). **Store** (`observers/presence-store.ts`, `createPresenceStore({db})`): `recordAway(from, to)` (only `to > from`), `listAwayInWindow(from, to)` (spans overlapping `[from,to]`), `purgeOlderThan(cutoff)`; table `presence_log (id, away_started_at INTEGER, away_ended_at INTEGER)` + index on `away_ended_at`, created in `db.ts` (`CREATE TABLE IF NOT EXISTS`). **Gap-aware `recordSample`:** `createWindowHistoryStore({db, maxGapMs})` (default 90 000 ms ≈ 3× the 30 s interval) — `recordSample` extends the latest row only when `(app_name, window_title)` match **and** `sampled_at − last_seen_at <= maxGapMs`, else INSERT; this stops a long away/blind gap from stitching two separate same-app sessions into one bridged row (the original root cause). **Wiring** (`index.ts`, inside the `darwin + discord` poller block): real `idleSource` + a `presenceStore` (created unconditionally like `windowStore`; exposed in tool deps gated on the flag) are passed to `startWindowLogger` and `discoverTools`. **Env** (`envInt`): `IDLE_THRESHOLD_SEC` (300, range 60–3600), `WINDOW_SESSION_MAX_GAP_MS` (90000, range 35000–600000, threaded into the store). `presence_log` accumulates only from deploy day onward; historical `window_history` rows are not rewritten.
- Pending action buttons (morning brief, iter-1 of 3) — surfaces still-open external actions from finalized conversations in the brief as one-tap «✓ Готово» buttons. **Schema:** three nullable `chat_topics` columns (`action_required TEXT`, `action_dismissed_at INTEGER`, `target_url TEXT`) added via idempotent `PRAGMA table_info`-guarded `ALTER TABLE … ADD COLUMN` migrations in `db.ts`; a finalized topic with no external action leaves `action_required` NULL and behaves exactly as before. **Extract:** `topics/finalizer.ts` extends the Haiku JSON schema/prompt to pull `action_required` (≤7-word external manual action the owner still owes, else null) + `target_url`; `parseNullableString` normalizes missing / real-null / literal `"null"` / empty/whitespace → `null`, and both fields thread into `store.finalize` (optional params; only the topic finalizer passes them). **Read/close:** `topics/store.ts` gains `getOpenActions()` (`status='finalized' AND action_required IS NOT NULL AND action_dismissed_at IS NULL`, newest-finalized-first — give-up placeholders leave `action_required` NULL so they're excluded) and idempotent `dismissAction(topicId, now)` (`… WHERE action_dismissed_at IS NULL`). **Surface:** `morningBrief.helpers.ts:gatherData` reads them (capped `MAX_PENDING_ACTIONS=5`) and `composePrompt` injects a "Висящие действия" section directing the model to list them under «что висит» with their `target_url`; `morningBrief.ts:run` attaches `channels/discord/embeds.ts:buildPendingActionsComponents` — one «✓ Готово» `followup:done:<topicId>` success button per action (single row, label truncated to 78 chars so `✓ `+label ≤ 80); empty → omit `components` so the brief stays a plain-text DM. **Button routing:** `interactions.ts:handleFollowupDone` from `routeButton` (`domain==='followup' && action==='done'`) → `topicStore.dismissAction(topicId, Date.now())` → `rebuildComponentsWithout` drops only the tapped button (and empty rows, so Discord doesn't reject a zero-component row) → `ixn.update`. Idempotent: a stale tap on an already-closed action is a safe no-op that still updates the message; a non-integer topicId is ignored; an unwired `topicStore` replies ephemerally. `topicStore` is threaded into `InteractionDeps` (via `DiscordBotDeps`, `index.ts:857`→`bot.ts:342`) and into the `morningBrief` handler deps (`index.ts:919`). **Channel-layer invariant:** `bot.ts:deliverCognitionPush`'s plain-text-with-components branch now splits the body at 2000 chars like `sendReply` and attaches `components` to the **final** chunk — the brief is unclamped LLM output that routinely exceeds Discord's 2000-char cap, and an oversized single send throws 50035 *before* `markPublished`, stranding the run as undelivered and re-thrown on every redelivery retry. Both follow-up auto-close paths have shipped: iter-2 (`emailActionMatch`) and iter-3 (`actionActivityMatch`).
- `actionActivityMatch` (Digital Observer, Pain #2 iter 3) — auto-closes a pending action when the owner actually visits the page it points to. Handler in `cognition/handlers/actionActivityMatch.ts` (`createActionActivityMatchHandler({windowHistoryStore, topicStore, lookbackHours?, cooldownMs?})`); deterministic, no LLM. **Read:** `windowHistoryStore.recentUrlsSince(since, MAX_URLS=500)` (distinct non-null URLs, `last_seen_at >= since`, newest first) over a `lookbackHours` (default 72) window. **Match:** each open action's full `target_url` is normalized by `stripUrl` → `splitHostPath` to `{host, segments}`; a target with `< MIN_PATH_SEGMENTS (2)` is ignored (a bare domain / single generic segment would over-match the home page). A visit matches on host equality **and** segment-boundary path-prefix (`/org/repo` matches `/org/repo/issues` but never `/org/repo-other`), and only when `last_seen_at >= action.startedAt` (a visit predating the task can't have completed it). `autoCloseBlocked` (reopened) actions are skipped in both `trigger` and `run`. **Close:** publishes a reversible notice (`formatNotice`, singular/plural) with `buildActionReopenComponents` «↩ Вернуть» buttons; `dismissAction` runs only in `onPublished`, so a Discord publish failure leaves actions open for the next tick (mirrors `emailActionMatch`). `trigger` gates cheaply on an eligible open action and a post-publish `cooldownMs` (default 6 h); skips/errors stay retry-able. Registered in `index.ts` inside the same `windowFlag && isDarwin && discordReady` block as the poller it depends on; lookback via `ACTION_ACTIVITY_MATCH_LOOKBACK_H` (`envInt`, default 72, range 1–720).
- `weatherAlert` (Weather — proactive change ping) — registered when `WEATHER_ALERT_ENABLED=true` AND coordinates resolve at boot AND Discord is live. **Trigger (cheap, no network):** `now - lastCheckAt >= WEATHER_CHECK_INTERVAL_H` AND not in quiet hours (`WEATHER_QUIET_START..WEATHER_QUIET_END`, local) AND coordinates present. **Run (dear):** `weather/open-meteo.ts:fetchForecast` → `weather/detect.ts:detectWeatherChanges(forecast, now, thresholds)` (pure — emits `Event{type,when,key,message}` for temp swing ≥ `WEATHER_TEMP_SWING_C`, incoming precip ≥ `WEATHER_PRECIP_PROB_PCT` in the `WEATHER_LEAD_HOURS` window / next day, frost `tmin≤0`, storm-wind/thunder by weathercode+wind; `key = type+date` for dedup). For each fresh event (no `findRecentAlert` within `WEATHER_ALERT_DEDUPE_H` and `when` inside the lead window) it publishes one `cognition_publish` ping (RU, ⚠️/🌧/🥶 by type) and `recordAlert`s it; then `setLastCheckAt`. A `fetch` error → `{skip}` (no crash). State in `weather_alerts` (dedup) + `weather_meta` (KV `lastCheckAt`) via `weather/alert-store.ts:createWeatherAlertStore` (`recordAlert`, `findRecentAlert`, `lastCheckAt`/`setLastCheckAt`). Coordinates come from `weather/coords.ts:resolveCoords(db, city, geocodeFn)` — reads/caches `user.coords` in `memory_facts`, re-geocodes on city change, `WEATHER_LAT`/`WEATHER_LON` override wins. The on-demand `weather` tool (`@r2/tool-weather`) shares the same client + `resolveCoords` closure, injected from `index.ts` like `imapClientForTool`. The tool honors the override for the home location too: when the requested `location` matches the resolved home city (`isSamePlace` — normalized first comma-segment equality), it short-circuits to the override coords instead of geocoding the name; genuinely different cities are geocoded, and an unknown city returns an explicit error with no silent fallback to a nearby place.
- IMAP thread walk (used by the draft-reply flow): `emails/imap-client.ts` exports `fetchHeaders(account, uid)` (parses `Message-ID` / `In-Reply-To` / `References`, RFC 5322 line-unfolding, case-insensitive, dedupes refs) and `fetchByMessageId(account, messageId)` (INBOX SEARCH by header; returns a `FullMessage` with `bodyText` or `null` on miss / server NO/BAD). `emails/thread-fetcher.ts:fetchThread(account, uid)` walks the References chain to assemble an oldest-first `FullMessage[]`, capped at 20 messages; missing refs (e.g. messages in Sent) are silently skipped. The current message is always appended via `fetchFullBody(uid)` directly — robust to a null `Message-ID` header and to the message having been moved between the urgent ping and the user click.
- Email implicit feedback (Pain #1 iter 4) — gated on `EMAIL_FEEDBACK_ENABLED=true` AND email enabled; default off ⇒ `emailFeedbackStore` is `null`, the urgent handler and poll tick receive `undefined`, and nothing is recorded (zero behaviour change). The goal: learn from how the user reacts to urgent pings and stop pinging senders that keep getting ignored. **Collect:** on a successful urgent publish, `emailUrgent.ts` calls `feedbackStore.recordPinged(rowId, now)` (the `-1` suppression-sentinel path never records). State lives in `email_feedback` (`pending_id` PK, `pinged_at`, `seen_at`, `answered_at`, `resolved_at`, `outcome ∈ replied|read|ignored`). **Resolve:** each per-account poll tick (`multi-account-poller.ts`), after fetching new mail and reusing the live IMAP connection, gathers unresolved UIDs (capped at `EMAIL_FEEDBACK_MAX_REPOLL`), re-reads `\Seen`/`\Answered` via `imap-client.ts:fetchFlagsForUids` (swallows IMAP errors → empty, never throws into the loop), and runs the state machine: `\Answered` ⇒ `replied`; else once `now - pinged_at >= EMAIL_FEEDBACK_IGNORE_HOURS` ⇒ `read` (seen) or `ignored` (never seen); within the window it stays unresolved. **Act (downgrade-only, sender-level):** `emails/feedback-scorer.ts:evaluateSender` runs whenever an outcome finalizes — if negative outcomes (`ignored` + `read`) for the sender within the `EMAIL_FEEDBACK_SUPPRESS_TTL_DAYS` lookback reach `EMAIL_FEEDBACK_SUPPRESS_AFTER` and no active rule exists, it inserts a `rule_type='sender'` rule with `created_via='auto_feedback'` and `expires_at = now + TTL` into `email_suppression_rules`. Demotion is then automatic — the existing `findActiveMatch` check in `emailUrgent.ts` marks the next match `urgent_pinged_at = -1`, dropping it into the digest. A `replied` outcome deletes any active `auto_feedback` rule for that sender (trust re-earned); manual `discord_button` rules are never touched. **Known limitation:** clearing only fires for a reply to a *still-tracked* pinged email — once a sender is suppressed their future emails are demoted (`-1`) and never get a feedback row, so a reply from a normal mail client to a demoted email isn't observed (the watcher-only email scope doesn't scan INBOX by sender). The auto-rule then lapses at its TTL; a reply to the next post-TTL urgent ping prevents re-suppression. A true reply-driven self-heal (an INBOX `\Answered` sweep over recently-suppressed senders) is deferred to a later iter. **Explain:** `/why` surfaces the sender's replied/read/ignored counts over the lookback plus any active `auto_feedback` suppression and its expiry. Boost direction and subject-pattern scoring are deferred to a later iter.
- UIDVALIDITY blind-detection / self-heal (Pain #1 email iter) — IMAP UIDs are stable only while the mailbox's `UIDVALIDITY` is unchanged; if a provider recreates the mailbox the value flips and UIDs restart low, so a watcher remembering only a high `last_seen_uid` would silently stop ingesting (new mail sits below the stale watermark, or `uid:${last_seen_uid+1}:*` grabs only a partial high-UID tail and permanently drops the rest). Fix: `email_account_state.uid_validity` (nullable column, idempotent `PRAGMA`-guarded migration in `db.ts`) stores `UIDVALIDITY` next to `last_seen_uid`; `store.ts` gains `getUidValidity` + `setLastSeenAndValidity` (upsert, clears `last_error`). `imap-client.ts:getUidValidity(account)` is a light probe (mirror of `getMaxUid`, `mailboxOpen` only, no `SEARCH`) coercing imapflow's BigInt `mailbox.uidValidity` → `Number()` (32-bit per RFC 3501) and throwing on absence (probe-failure ⇒ `setAccountError` ⇒ retry). On each ongoing tick `multi-account-poller.ts` reads `storedValidity` and probes `currentValidity` **before** `fetcher` (so we never act on another epoch's UIDs): `storedValidity == null` ⇒ backfill (adopt current as baseline, no reset, fetch continues — covers pre-column accounts and new accounts on their 2nd tick); `current !== stored` ⇒ `console.warn('[emails] UIDVALIDITY changed …')` + `maxUidProbe` + `setLastSeenAndValidity(maxUid, current)` (skip backlog, first-tick strategy) + `onUidValidityReset?.({account, previous, current})` then `return` (no ingest this tick); `current === stored` ⇒ normal path. `validityProbe` is **required** in `TickParams` (forgetting the wiring must not silently re-introduce the blindness it fixes — like `provider` for window-logger), `onUidValidityReset` is **optional** (alert-only, like `onBlind`). Wiring in `index.ts:startEmailPoller`: `validityProbe: getUidValidity`, `onUidValidityReset` mirrors window-logger's `onBlind` — `console.warn` + `reminderBus.emit('push', { type:'cognition_publish', runId:-1, handler:'email-poller', content })` (sentinel `runId:-1` ⇒ `markPublished(-1)` is a harmless 0-row update; not in `cognition status`). The alert fires **exactly once per reset** (no counter/threshold/env-var needed — a `UIDVALIDITY` change is discrete, and the post-reset persist makes the next tick see `stored == current`), which is the deliberate divergence from window-logger's duration-based blind threshold. **No new env-var.**
- Email-poller resilience to IMAP drops (Pain #1 email iter) — a transient socket `'error'` from ImapFlow (`ETIMEOUT`/`ECONNRESET`) is an unhandled `'error'` event = hard process exit in Node, which crashed the poll worker mid-tick and left the account stuck with `last_error` (R2 saw only the other mailbox). **Root fix:** `imap-client.ts:withClient` attaches `client.on('error', …)` immediately after `new Ctor({...})` (guarded by `typeof client.on === 'function'` for stub clients) so a socket failure becomes a normal rejection that flows into the per-account catch instead of crashing; the listener also covers `finally { logout() }` teardown. **Visibility:** `multi-account-poller.ts` per-account catch now `console.error('[emails] poll failed for <id>:', msg)` alongside `setAccountError`; second account keeps polling (Promise.all isolation). **Counter + alert:** `db.ts` adds idempotent `consecutive_errors INTEGER NOT NULL DEFAULT 0` and `blind_alerted INTEGER NOT NULL DEFAULT 0` columns on `email_account_state`; `store.ts:setAccountError` does `consecutive_errors = consecutive_errors + 1`, while every success path resets `consecutive_errors = 0, blind_alerted = 0`: `updateLastSeenUid` / `setLastSeenAndValidity` when the watermark advances, and `clearAccountError(accountId, now)` on the no-new-mail branch (which takes neither, so without it a recovered-but-quiet mailbox would keep a stale `last_error` + latched `blind_alerted` until new mail next arrived). So a recovered account self-heals — the first successful poll clears `last_error` + counter, no manual step. New store methods: `getAccountErrorState(accountId)` → `{consecutive_errors, blind_alerted, last_error}|null`, `markBlindAlerted(accountId)`, and `clearAccountError(accountId, now)`. The poller's `TickParams`/`StartParams` gain `blindAlertAfter: number` and optional `onAccountBlind?: ({account, consecutive, lastError}) => void`; after `setAccountError` it reads `getAccountErrorState` and, when `consecutive_errors >= blindAlertAfter` AND `blind_alerted === 0`, calls `onAccountBlind(...)` once then `markBlindAlerted` (`>=` not `===` so an operator lowering the threshold mid-outage still trips it; fires exactly once per blind spell, re-armable only after a success resets the flag). Wiring in `index.ts:startEmailPoller`: `blindAlertAfter = envInt(process.env.EMAIL_ACCOUNT_BLIND_ALERT_AFTER, 3, 1, 100)`; `onAccountBlind` mirrors window-logger's `onBlind` — `console.warn` + `reminderBus.emit('push', { type:'cognition_publish', runId:-1, handler:'email-poller', content })`, gated on a live `discordBot` (else `console.warn` only). Concurrency-limited connects and retry-backoff are deferred (Future in the spec).
- Email `\Seen` sync / auto-clear awaiting queue (Pain #1 email iter) — **always-on** (not gated on `EMAIL_FEEDBACK_ENABLED`; only skipped when no `flagFetcher` is wired). The awaiting queue tracks what the user actually did, not just what R2 pinged: each poll tick, after new-mail handling, `multi-account-poller.ts:syncSeenStatus(account, params)` fetches `store.fetchAwaitingForAccount(account.id, SEEN_SYNC_CAP=50)` — awaiting rows (`delivered_at IS NULL AND (urgent_pinged_at IS NULL OR urgent_pinged_at < 0)`, so suppressed `-1` rows stay in scope; delivered + real-urgent-pinged rows excluded), ordered **oldest-first** (`received_at ASC`) so the longest-waiting mail is re-checked first when the cap bites — and re-reads their IMAP flags via the top-level `flagFetcher?` in `TickParams` (wired in `index.ts` to `fetchFlagsForUids`, the same probe the urgent feedback re-poll uses). `handled = flag.seen === true || (flags !== null && !flagMap.has(uid))` — read (`\Seen`) **OR** absent from a *successful* fetch (left INBOX: archived/deleted/moved). The `null`-vs-`[]` distinction is load-bearing: `null` = hard fetch failure ⇒ bail, change nothing this tick (an absent UID carries no evidence); an empty `[]` is a real "all UIDs left INBOX" signal that *does* dismiss. `answered` is deliberately ignored here (that's the urgent-only feedback pass's job). Handled ids → one `store.markDelivered(ids, params.now)` (row leaves the awaiting set / `countPendingUndelivered` but stays in `email_pending` for period queries — identical semantics to the manual `emails_dismiss` tool; `markDelivered`'s `... AND delivered_at IS NULL` guard makes it idempotent). Distinct from the feedback re-poll (line above): that's urgent-ping-only and records sender scoring; this sweeps the awaiting non-pinged rows and records **no** feedback signal. Best-effort: own try/catch (`[emails] \Seen sync failed for <id>: …`) so a flag-fetch failure logs and never escalates to `setAccountError`; runs in both the no-new-mail and normal tick branches; on an empty awaiting set it returns before calling `flagFetcher` (no wasted IMAP round-trip on quiet ticks). Additive: no schema change, no new env-var, the feedback loop / `emails_dismiss` tool untouched.

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
- **Relative-path env vars:** для любой новой env-переменной с относительным путём (DB, evals, файлы, etc.) использовать `resolveProjectPath` из `packages/server/src/path-utils.ts` — канонический хелпер. Сам читает absolute paths (passthrough), relative paths (resolve от project root через `import.meta.url`) и unset/empty (default от project root). Не звать `process.cwd()` для persistent state — это даёт silent drift при запуске из разных директорий.

### Тестирование
- **Temp directories для тестов с файлами:** `fs.mkdtempSync()` в `beforeEach`, `fs.rmSync(tmpDir, { recursive: true })` в `afterEach`. Не использовать фиксированные пути.
- **Mock vs integration:** Tool loop тесты без DB — `logToolCall` в try/catch, падает тихо. Отдельный describe с `initDb()` для тестов аудит-лога. Оба подхода нужны.
- **Проверять что тест реально тестирует:** Тест должен упасть если убрать тестируемый код. Если тест проходит с пустой реализацией — тест бесполезен.
