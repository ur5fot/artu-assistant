# Memory Editing via Chat — design

## Problem

Memory system (specs/2026-04-13) автоматически извлекает факты из разговоров и хранит их в `memory_facts` (канонический key/value, supersede-логика, soft-delete через `forgotten=1`). Но у юзера **нет естественного UX для правок** — только Discord `/memory` list/search readonly.

Сценарии, которые сейчас не покрыты:
- «Убери user.age» — явное удаление по ключу
- «Это неверно» / «ерунду запомнил» — удаление фактов, извлечённых из последнего user-сообщения
- «user.activity не велосипед а бег» — замена значения существующего factа

`memoryService.forgetFact(query)` уже реализован, но не экспонирован как LLM tool. Update/forget-last-extraction отсутствуют вовсе.

## Goals

1. LLM через tool-use правит memory в ответ на natural language юзера: delete, update, delete-last-extracted.
2. Каждый вызов проходит через confirmation с возможностью редактировать параметры до approve (по образцу существующего `plan-review`).
3. Tracking последнего извлечения per user-message — через новую колонку `memory_facts.source_message_id`.
4. «Allow always for memory_forget» сохраняется через существующий `permission_rules` — юзер не жмёт кнопку каждый раз после первого согласия.

## Non-goals

- Hard delete из БД (soft-delete через `forgotten=1` достаточно; DB prune — отдельная забота).
- История правок / undo stack — reverting это отдельный feature.
- UI для списка всех forgotten fact'ов — `/memory` остаётся показывать только активные.
- Bulk-edit («забудь всё про работу») — узкий scope MVP.
- Права per-value (не per-tool): `Allow always memory_forget` разрешает любые forget без диалога. Хочется per-key — future work.

## Architecture

### 1. Schema

`memory_facts` расширяется (`db.ts` initDb):

```sql
ALTER TABLE memory_facts ADD COLUMN source_message_id TEXT;
CREATE INDEX IF NOT EXISTS idx_facts_source_message
  ON memory_facts(source_message_id) WHERE source_message_id IS NOT NULL;
```

Миграция идемпотентная: `ADD COLUMN` обёрнут в try/catch на «duplicate column». Legacy rows остаются с `NULL` — они не участвуют в `memory_forget_last`, но участвуют в `memory_forget`/`memory_update` по key.

### 2. Extractor threading

`MemoryService.indexTurn({ userMessage, userMessageId, assistantMessage, timestamp })` — новое обязательное поле `userMessageId`. Значение пробрасывается в `insertOrSupersedeFact(db, { ..., sourceMessageId })`, оттуда в SQL insert.

Callers:
- `packages/server/src/channels/discord/bot.ts` — захватывает UUID из `saveMessage` в локальную переменную и передаёт.
- `packages/server/src/routes/chat.ts` — аналогично.

### 3. Три LLM-тула

Все три регистрируются в `ToolRegistry` и видны Claude + ollama через tool-use. Каждый before-execute запрашивает memory-confirm (см. §4).

**`memory_forget`**

- Input: `{ query: string }` — либо key (normalized), либо описание для vector search
- Делегирует в `memoryService.forgetFact({query})` (существующий метод, уже имеет exact-match + vector fallback)
- Output:
  - `{ forgotten: [{id, key, value}] }` — один матч, удалён
  - `{ forgotten: [], candidates: [{id, key, value}] }` — несколько матчей, LLM выбирает и зовёт повторно
  - `{ forgotten: [], candidates: [] }` — нет матчей, LLM объясняет юзеру

**`memory_update`**

- Input: `{ key: string, newValue: string }`
- Проверяет что существует активный fact с данным key (`superseded_by IS NULL AND forgotten=0`)
- Если есть — `insertOrSupersedeFact({key, value: newValue, sourceMessageId: <current user msg id>})` супер­седит старый. Новая строка получает `source_message_id` текущего user-msg (тот, после которого LLM вызвал update).
- Если нет — возвращает `{ error: 'no active fact for key', key }`
- Output: `{ updated: { key, oldValue, newValue } }`

**`memory_forget_last`**

- Input: `{}`
- Находит `source_message_id` самого свежего user-message **кроме текущего**:
  ```sql
  SELECT message_id FROM chat_messages
  WHERE role = 'user' AND timestamp < :currentUserMessageTimestamp
  ORDER BY timestamp DESC LIMIT 1
  ```
- Затем:
  ```sql
  SELECT id, key, value FROM memory_facts
  WHERE source_message_id = ? AND forgotten = 0 AND superseded_by IS NULL
  ```
- Для каждого ID — `markFactForgotten`. Возвращает `{ forgotten: [{key, value}], sourceMessageId }`.
- Если нет previous user message или нет active facts — `{ forgotten: [], reason: 'nothing to forget' }`.
- Tool получает `currentUserMessageTimestamp` через tool context (buildToolContext расширяется на это поле — уже знает текущее сообщение через chat history).

### 4. Memory confirmation с editable params

Новый сервис `packages/server/src/services/memory-confirm-service.ts` — по образцу `plan-review-service`:

```typescript
export interface MemoryConfirmRequest {
  callId: string;
  tool: 'memory_forget' | 'memory_update' | 'memory_forget_last';
  params: Record<string, unknown>;
  preview: string; // human-readable: "Забыть: user.age = 42"
  editableField: 'query' | 'newValue' | null; // null для forget_last
}

export interface MemoryConfirmService {
  request(req: MemoryConfirmRequest): Promise<{ approved: boolean; editedParams?: Record<string, unknown> }>;
  resolve(callId: string, approved: boolean, editedParams?: Record<string, unknown>): { ok: true } | { ok: false; reason: 'not_found' };
  hasPending(callId: string): boolean;
  size(): number;
}
```

**Preview formatters** (в самих tool'ах, перед request):
- `memory_forget` — `Забыть: ${match.key} = "${match.value}"` если exact, иначе `Забыть (искать по "${query}")`
- `memory_update` — `Обновить ${key}: "${oldValue}" → "${newValue}"`
- `memory_forget_last` — `Забыть ${n} факт(а): ${keys.join(', ')}`

**Wiring:**
- `index.ts` создаёт `memoryConfirmService` (хранит `Map<callId, resolver>` по образцу `pendingPlanReviews`) и пробрасывает в `runToolLoop` через deps (рядом с `pendingConfirms`, `pendingPlanReviews`).
- Tool-handler: создаёт callId, регистрирует resolver в service, эмитит SSE event `onEvent({type: 'tool_memory_confirm', callId, tool, preview, editableField, params})`, `await`-ит resolution. По результату: approved → применить с `editedParams ?? originalParams`; rejected → вернуть `{ error: 'user denied' }` в LLM.

**Discord UI:**
- bot.ts следит за SSE-event `tool_memory_confirm` (так же как `tool_plan_review`) → шлёт ephemeral DM с preview + buttons.
- Buttons: `[✅ Approve]` `[✏️ Edit & approve]` `[❌ Deny]` (для forget_last — только `Approve`/`Deny`).
- Button `Edit & approve` → `interaction.showModal(...)` с prefilled TextInput по `editableField`.
- Modal submit — `interactions.ts` route получает `editedParams` и зовёт `memoryConfirmService.resolve(callId, true, { [editableField]: newText })`.
- Plain buttons зовут `resolve(callId, true)` или `resolve(callId, false)`.

**Web UI:**
- Новый endpoint `POST /api/memory/confirm/:callId` с body `{ approved, editedParams? }`.
- Frontend (отдельный issue, web заморожен 2026-04-17) — inline form под tool call. Пока endpoint есть, UI можно подтянуть позже.

**Permission persistence:**
- Plain `Approve` идёт через существующий `permissionService` — если rule `allow_always` для memory tool уже есть, пропускает confirm вовсе. Rule хранится per-tool (не per-params).
- `Edit & approve` **не** сохраняет `allow_always` (explicit user action каждый раз).
- `Deny` может через permission dialog поставить `block_always` — не реализуем в MVP.

### 5. Tool context расширение

`ToolContext` (сейчас в `tools/base.ts`) получает `currentUserMessageId: string`, `currentUserMessageTimestamp: number`. `buildToolContext(...)` вычисляет из последнего user-сообщения в истории.

Используется только `memory_forget_last`, остальные tools игнорируют.

### 6. Data flow (forget scenario)

1. Юзер: «убери user.age»
2. LLM → `memory_forget({query: 'user.age'})`
3. Tool: `findActiveFactByKey('user.age')` → найден id=42, value='42'
4. Tool: preview = `Забыть: user.age = 42`
5. Tool: `await memoryConfirmService.request({...})`
6. Server → emit `memory_confirm_request` event
7. bot.ts слушатель → DM с кнопками
8. Юзер: `Edit & approve` → modal → меняет на `user.age_group`
9. Modal submit → `resolve(callId, true, {query: 'user.age_group'})`
10. Tool resumes с `editedParams.query = 'user.age_group'` → `forgetFact({query: 'user.age_group'})` → нет матча → возвращает `{forgotten: [], candidates: []}`
11. LLM видит и отвечает юзеру: «не нашёл `user.age_group`, может ты имел в виду `user.age`?»

## Testing

**DB layer:**
- `insertOrSupersedeFact` сохраняет `source_message_id`.
- `findLastUserFacts(currentMsgId)` — (а) находит facts previous user msg; (б) исключает current msg; (в) исключает forgotten/superseded; (г) возвращает пусто если нет previous msg.
- ADD COLUMN идемпотентен.

**Service/tools:**
- `memory_forget` — три кейса output (single, multi, none).
- `memory_update` — success + no-active-fact.
- `memory_forget_last` — happy path, empty result, пропускает current message.

**Memory-confirm-service:**
- request→resolve approve, reject, approveWithEdit (editedParams проходят).
- timeout (15 мин) — `{approved: false, reason: 'timeout'}`.
- hasPending/size — корректно отражают состояние.

**Discord interaction (добавить в существующий interactions.test.ts):**
- button `Approve` → `resolve(callId, true)`.
- button `Edit & approve` → `showModal`; modal submit → `resolve(callId, true, editedParams)`.
- button `Deny` → `resolve(callId, false)`.

**Integration (index.ts smoke):**
- Startup не падает, регистрируются 3 новых tools + 1 новый confirm service.

**Manual E2E (последний task):**
- «Убери user.age» → confirm dialog → Edit → modal → change → apply → LLM reply.
- «это неверно» после «мне 42 года» → forget_last → preview показывает `user.age=42` → Approve → fact forgotten → R2 спрашивает корректное значение.
- «поменяй user.activity на бег» → update → preview `велосипед → бег` → Approve → supersede.

## Risks / open points

- **`forget_last` полагается на timing**: extraction асинхронна, запускается после `indexTurn`. Если юзер шлёт M2 до завершения extraction по M1 — `forget_last` в контексте M2 не найдёт facts (они ещё не записаны). Ловим: возвращаем `{forgotten:[], reason: 'extraction may still be in progress'}` — LLM пересказывает юзеру.
- **Discord Modal UX**: разрешает один TextInput per field — для `memory_forget` с single field ОК. Для forget_last edit (если когда-либо захотим) — нужно было бы multi-select, не Modal. Пока forget_last non-editable.
- **Legacy facts без `source_message_id`**: НЕ участвуют в `memory_forget_last`. Юзер их правит только через `memory_forget`/`memory_update` по key. Документируем.
- **Confirm timeout 15 мин**: если юзер не ответил, tool возвращает ошибку, LLM пишет «не получил подтверждения». Consistent с plan-review.
- **Race: два `memory_forget` на один и тот же fact параллельно**: `markFactForgotten` атомарен (`WHERE forgotten=0`). Второй получит `false` → tool возвращает `{forgotten:[], reason: 'already forgotten'}`.
- **Empty query / empty newValue**: tool rejects с ошибкой до confirm-request (нет смысла confirmить no-op).
