# Memory Editing Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Дать LLM три tool'а для правки memory через чат (`memory_forget`, `memory_update`, `memory_forget_last`), каждый через confirm-dialog с редактируемым текстовым полем. Tracking per-message extraction через `memory_facts.source_message_id`.

**Architecture:** Зеркалим паттерн `plan-review`: новый SSE event `tool_memory_confirm`, `PendingMemoryConfirms` map на backend, `ctx.requestMemoryConfirm(...)` в tool handler, Discord bot рендерит ephemeral buttons + modal для edit. Tools живут в существующем `@r2/tool-memory` пакете. Extractor получает message_id через `indexTurn`.

**Tech Stack:** TypeScript, better-sqlite3, @anthropic-ai/sdk, vitest, discord.js (ButtonBuilder/ModalBuilder/TextInputBuilder), existing `@r2/tool-memory` package.

---

## File Structure

**Schema/DB:**
- Modify: `packages/server/src/db.ts` — ALTER TABLE + CREATE INDEX
- Modify: `packages/server/src/memory/db.ts` — `insertOrSupersedeFact` принимает `sourceMessageId`; новые helpers `findFactsBySourceMessageId`, `findActiveFactByKey`, `findLastUserMessageBefore`, `updateFactValue`
- Modify: `packages/server/src/memory/service.ts` — `indexTurn` принимает `userMessageId`; новые методы `updateFact`, `forgetLast`
- Modify: `packages/server/src/memory/extractor.ts` — без изменений (работает с content)

**Shared types:**
- Modify: `packages/shared/src/types.ts` — `SSEEvent` добавляет `tool_memory_confirm`; `ToolContext` добавляет `requestMemoryConfirm`; новые типы `MemoryConfirmRequest`, `MemoryConfirmResponse`

**Confirm infra:**
- Create: `packages/server/src/routes/memory-confirm.ts` — `PendingMemoryConfirms` map + resolve endpoint
- Create: `packages/server/src/services/memory-confirm-service.ts` — wrapper с `isResolvedByUser`
- Modify: `packages/server/src/ai/tool-helpers.ts` — `createMemoryConfirmRequester`, `buildToolContext` прокидывает метод
- Modify: `packages/server/src/ai/tool-loop.ts` — принимает `pendingMemoryConfirms` в deps и передаёт дальше

**Tools:**
- Modify: `packages/tool-memory/src/index.ts` — `memory_forget` переходит на `requestMemoryConfirm`; добавляются `memory_update` и `memory_forget_last`
- Modify: `packages/tool-memory/__tests__/*.test.ts` — обновить + добавить

**Discord:**
- Modify: `packages/server/src/channels/discord/bot.ts` — listener на SSE `tool_memory_confirm` → ephemeral buttons + track pendingEmbedMsgs
- Modify: `packages/server/src/channels/discord/interactions.ts` — handle button clicks (`memconfirm:approve:<callId>`, `memconfirm:edit:<callId>`, `memconfirm:deny:<callId>`) + modal submit (`memconfirm_modal:<callId>:<field>`)

**Wiring:**
- Modify: `packages/server/src/index.ts` — создать `pendingMemoryConfirms` Map, `memoryConfirmService`, пробросить в chat routes и Discord deps
- Modify: `packages/server/src/routes/chat.ts` — пробросить `pendingMemoryConfirms` в `runChatRequest`
- Modify: `packages/server/src/ai/router.ts` — прокинуть `pendingMemoryConfirms` через router → runLoop
- Modify: `packages/server/src/channels/discord/bot.ts` (выше уже упомянут) — принимает `memoryConfirmService` в deps

---

## Task 1: Schema — add `source_message_id` к `memory_facts`

**Files:**
- Modify: `packages/server/src/db.ts`
- Modify: `packages/server/src/memory/__tests__/db.test.ts`

**Why:** Tracking per-message extraction нужен для `memory_forget_last`. Колонка nullable + idempotent миграция.

- [x] **Step 1: Посмотреть существующий initDb**

```bash
grep -n "memory_facts\|ALTER TABLE" packages/server/src/db.ts | head
```

Зафиксируй где сейчас CREATE TABLE memory_facts (~строка 155) и как выполняется commands.

- [x] **Step 2: Добавить failing тест для новой колонки**

Открой `packages/server/src/memory/__tests__/db.test.ts` (если нет — создай `packages/server/src/__tests__/db-memory.test.ts`). Добавь в подходящий describe:

```typescript
import { initDb, getDb } from '../db.js';

describe('memory_facts schema', () => {
  it('has source_message_id column (nullable text)', () => {
    initDb(':memory:');
    const cols = getDb()
      .prepare("PRAGMA table_info(memory_facts)")
      .all() as Array<{ name: string; type: string; notnull: number }>;
    const col = cols.find((c) => c.name === 'source_message_id');
    expect(col).toBeDefined();
    expect(col!.type.toUpperCase()).toBe('TEXT');
    expect(col!.notnull).toBe(0);
  });

  it('has idx_facts_source_message index', () => {
    initDb(':memory:');
    const idx = getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_facts_source_message'")
      .get();
    expect(idx).toBeDefined();
  });
});
```

- [x] **Step 3: Run tests — expect FAIL**

```bash
npx vitest run --root packages/server -t "memory_facts schema"
```

- [x] **Step 4: Реализовать миграцию в initDb**

В `packages/server/src/db.ts` после CREATE TABLE memory_facts добавь блок:

```typescript
// Idempotent: ADD COLUMN on existing DB; no-op on fresh DB
try {
  db.exec(`ALTER TABLE memory_facts ADD COLUMN source_message_id TEXT`);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  if (!/duplicate column name/i.test(msg)) throw err;
}

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_facts_source_message
    ON memory_facts(source_message_id) WHERE source_message_id IS NOT NULL
`);
```

- [x] **Step 5: Run tests — expect PASS**

```bash
npx vitest run --root packages/server -t "memory_facts schema"
```

- [x] **Step 6: Commit**

```bash
git add packages/server/src/db.ts packages/server/src/__tests__
git commit -m "feat(memory): add source_message_id column to memory_facts"
```

---

## Task 2: DB helpers — source tracking + lookup

**Files:**
- Modify: `packages/server/src/memory/db.ts`
- Modify: `packages/server/src/memory/__tests__/db.test.ts` (или create если нет)

**Why:** `insertOrSupersedeFact` должен писать `source_message_id`. Нужны helpers для `memory_update` (update по key) и `memory_forget_last` (find latest user msg + find facts by source).

- [x] **Step 1: Прочитать существующий insertOrSupersedeFact**

```bash
grep -n "insertOrSupersedeFact\|export function" packages/server/src/memory/db.ts | head -10
```

- [x] **Step 2: Добавить failing тесты helpers**

В `packages/server/src/memory/__tests__/db.test.ts` (создай если не существует — шаблон ниже):

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db.js';
import {
  insertOrSupersedeFact,
  findFactsBySourceMessageId,
  findActiveFactByKey,
  findLastUserMessageBefore,
} from '../db.js';

const FAKE_EMBED = new Array(768).fill(0); // matches EXPECTED_EMBED_DIM

beforeEach(() => initDb(':memory:'));

describe('insertOrSupersedeFact with sourceMessageId', () => {
  it('persists source_message_id', () => {
    const id = insertOrSupersedeFact(getDb(), {
      key: 'user.name',
      value: 'Dim',
      createdAt: 1000,
      embedding: FAKE_EMBED,
      importance: 5,
      sourceMessageId: 'msg-1',
    });
    const row = getDb().prepare('SELECT source_message_id FROM memory_facts WHERE id = ?').get(id) as { source_message_id: string };
    expect(row.source_message_id).toBe('msg-1');
  });

  it('accepts null sourceMessageId for legacy callers', () => {
    const id = insertOrSupersedeFact(getDb(), {
      key: 'user.name',
      value: 'Dim',
      createdAt: 1000,
      embedding: FAKE_EMBED,
      importance: 5,
    });
    const row = getDb().prepare('SELECT source_message_id FROM memory_facts WHERE id = ?').get(id) as { source_message_id: string | null };
    expect(row.source_message_id).toBeNull();
  });
});

describe('findFactsBySourceMessageId', () => {
  it('returns only active (non-forgotten, non-superseded) facts with the given source', () => {
    const db = getDb();
    const active = insertOrSupersedeFact(db, { key: 'user.a', value: 'x', createdAt: 1000, embedding: FAKE_EMBED, importance: 5, sourceMessageId: 'M1' });
    insertOrSupersedeFact(db, { key: 'user.b', value: 'y', createdAt: 1000, embedding: FAKE_EMBED, importance: 5, sourceMessageId: 'M2' }); // different msg
    const forgottenId = insertOrSupersedeFact(db, { key: 'user.c', value: 'z', createdAt: 1000, embedding: FAKE_EMBED, importance: 5, sourceMessageId: 'M1' });
    db.prepare('UPDATE memory_facts SET forgotten = 1 WHERE id = ?').run(forgottenId);

    const found = findFactsBySourceMessageId(db, 'M1');
    expect(found.map((f) => f.id)).toEqual([active]);
  });

  it('returns empty for unknown source', () => {
    expect(findFactsBySourceMessageId(getDb(), 'nope')).toEqual([]);
  });
});

describe('findActiveFactByKey', () => {
  it('returns the single active row or null', () => {
    const db = getDb();
    const id = insertOrSupersedeFact(db, { key: 'user.age', value: '42', createdAt: 1000, embedding: FAKE_EMBED, importance: 5 });
    const found = findActiveFactByKey(db, 'user.age');
    expect(found).toEqual(expect.objectContaining({ id, key: 'user.age', value: '42' }));
    expect(findActiveFactByKey(db, 'user.nope')).toBeNull();
  });
});

describe('findLastUserMessageBefore', () => {
  it('returns most recent user message strictly before `before`', () => {
    const db = getDb();
    const ins = db.prepare(
      "INSERT INTO chat_messages (message_id, role, content, timestamp) VALUES (?, 'user', 'x', ?)",
    );
    ins.run('M1', 1000);
    ins.run('M2', 2000);
    ins.run('M_CURRENT', 3000);
    expect(findLastUserMessageBefore(db, 3000)?.messageId).toBe('M2');
    expect(findLastUserMessageBefore(db, 1500)?.messageId).toBe('M1');
    expect(findLastUserMessageBefore(db, 500)).toBeNull();
  });

  it('ignores assistant messages', () => {
    const db = getDb();
    db.prepare("INSERT INTO chat_messages (message_id, role, content, timestamp) VALUES ('A1', 'assistant', 'x', 1000)").run();
    expect(findLastUserMessageBefore(db, 2000)).toBeNull();
  });
});
```

- [x] **Step 3: Run tests — expect FAIL (helpers not defined)**

```bash
npx vitest run --root packages/server packages/server/src/memory/__tests__/db.test.ts
```

- [x] **Step 4: Реализовать helpers в `packages/server/src/memory/db.ts`**

Найди существующий `insertOrSupersedeFact` и измени signature + INSERT statement:

```typescript
export function insertOrSupersedeFact(
  db: Database.Database,
  params: {
    key: string;
    value: string;
    createdAt: number;
    embedding: number[];
    importance: number;
    sourceMessageId?: string | null;
  },
): number {
  // ...existing logic...
  // В INSERT statement добавь колонку source_message_id и bind params.sourceMessageId ?? null
  //
  // Пример итогового SQL:
  //   INSERT INTO memory_facts (key, value, created_at, last_mentioned_at, superseded_by, importance, forgotten, source_message_id)
  //   VALUES (?, ?, ?, ?, NULL, ?, 0, ?)
}
```

Важно: существующие параметры не трогай, добавь `source_message_id` в хвост INSERT и передай `params.sourceMessageId ?? null`. Embedding insert в `memory_vec_facts` не затрагиваем.

В конец файла добавь новые helpers:

```typescript
export interface FactRow {
  id: number;
  key: string;
  value: string;
  createdAt: number;
  lastMentionedAt: number;
  importance: number;
  sourceMessageId: string | null;
}

export function findFactsBySourceMessageId(
  db: Database.Database,
  sourceMessageId: string,
): FactRow[] {
  return db
    .prepare(
      `SELECT id, key, value, created_at AS createdAt, last_mentioned_at AS lastMentionedAt,
              importance, source_message_id AS sourceMessageId
       FROM memory_facts
       WHERE source_message_id = ?
         AND superseded_by IS NULL
         AND forgotten = 0
       ORDER BY id`,
    )
    .all(sourceMessageId) as FactRow[];
}

export function findActiveFactByKey(
  db: Database.Database,
  key: string,
): FactRow | null {
  const row = db
    .prepare(
      `SELECT id, key, value, created_at AS createdAt, last_mentioned_at AS lastMentionedAt,
              importance, source_message_id AS sourceMessageId
       FROM memory_facts
       WHERE key = ?
         AND superseded_by IS NULL
         AND forgotten = 0
       LIMIT 1`,
    )
    .get(key) as FactRow | undefined;
  return row ?? null;
}

export interface UserMessageRef {
  messageId: string;
  timestamp: number;
}

export function findLastUserMessageBefore(
  db: Database.Database,
  beforeTimestamp: number,
): UserMessageRef | null {
  const row = db
    .prepare(
      `SELECT message_id AS messageId, timestamp
       FROM chat_messages
       WHERE role = 'user' AND timestamp < ?
       ORDER BY timestamp DESC
       LIMIT 1`,
    )
    .get(beforeTimestamp) as UserMessageRef | undefined;
  return row ?? null;
}
```

- [x] **Step 5: Run tests — expect PASS**

```bash
npx vitest run --root packages/server packages/server/src/memory/__tests__/db.test.ts
```

- [x] **Step 6: Убедиться что остальные memory-тесты зелёные (sig change мог что-то сломать)**

```bash
npx vitest run --root packages/server packages/server/src/memory
```

Если что-то красное — скорее всего тест вызывает `insertOrSupersedeFact` и требует обновления. Значение `sourceMessageId` опциональное — старые вызовы должны работать. Если сломалось — посмотри trace и добавь `sourceMessageId: null` или оставь без него.

- [x] **Step 7: Commit**

```bash
git add packages/server/src/memory
git commit -m "feat(memory): source_message_id persistence + lookup helpers"
```

---

## Task 3: Extractor threading — `indexTurn` получает `userMessageId`

**Files:**
- Modify: `packages/server/src/memory/service.ts`
- Modify: `packages/server/src/memory/__tests__/service.test.ts` (или inline тесты)
- Modify: `packages/server/src/channels/discord/bot.ts`
- Modify: `packages/server/src/routes/chat.ts`

**Why:** Extractor должен ставить facts с source_message_id текущего user-сообщения. Без этого forget_last не работает.

- [x] **Step 1: Добавить failing тест в service.test.ts**

В `packages/server/src/memory/__tests__/service.test.ts` (или соответствующий):

```typescript
it('indexTurn passes userMessageId to insertOrSupersedeFact', async () => {
  // Setup: mock extractor → returns one fact; mock embedder;
  // Run service.indexTurn({ userMessage: 'x', userMessageId: 'msg-123',
  //   assistantMessage: 'ok', timestamp: 1000 });
  // Assert: inserted memory_facts row has source_message_id = 'msg-123'

  const fakeOllama = { chat: async () => ({ text: '[{"key":"user.x","value":"y","importance":5}]' }) };
  const { createMemoryService } = await import('../service.js');
  const svc = createMemoryService({
    db: getDb(),
    ollama: fakeOllama as any,
    embedModel: 'stub-embed',
    extractorModel: 'stub',
  });
  // NOTE: if service has internal embedder we may need another stub;
  // if tests already pattern-stub these — mirror that. Use vi.mock/spyOn.
  await svc.indexTurn({
    userMessage: 'катаюсь на велике',
    userMessageId: 'msg-abc',
    assistantMessage: 'ок',
    timestamp: 1000,
  });
  const row = getDb().prepare("SELECT source_message_id FROM memory_facts WHERE key = 'user.x'").get() as { source_message_id: string };
  expect(row?.source_message_id).toBe('msg-abc');
});
```

**Note:** если существующий `service.test.ts` стабит ollama/embed иначе — перепиши этот тест в его стиле. Суть: `indexTurn` с новым полем `userMessageId` должен попасть в `source_message_id` колонку.

- [x] **Step 2: Run test — expect FAIL (new field not supported)**

```bash
npx vitest run --root packages/server packages/server/src/memory/__tests__/service.test.ts -t "userMessageId"
```

- [x] **Step 3: Обновить service signature**

В `packages/server/src/memory/service.ts`:

```typescript
// Обнови тип interface MemoryService.indexTurn
indexTurn(params: {
  userMessage: string;
  userMessageId: string;
  assistantMessage: string;
  timestamp: number;
}): Promise<void>;

// В runIndexTurn приёмник:
async function runIndexTurn(params: {
  userMessage: string;
  userMessageId: string;
  assistantMessage: string;
  timestamp: number;
}): Promise<void> {
  const { userMessage, userMessageId, assistantMessage, timestamp } = params;
  // ... existing logic unchanged ...
  for (const fact of facts) {
    // ... embed vec ...
    insertOrSupersedeFact(db, {
      key: fact.key,
      value: normalizedValue,
      createdAt: timestamp,
      embedding: vec,
      importance: fact.importance,
      sourceMessageId: userMessageId,   // <- add this line
    });
  }
}
```

- [x] **Step 4: Обновить callers**

В `packages/server/src/channels/discord/bot.ts` — найди блок saveMessage({messageId: crypto.randomUUID(), role: 'user', ...}) перед `indexTurn`. Захвати UUID в переменную:

```typescript
const userMessageId = crypto.randomUUID();
deps.saveMessage({ messageId: userMessageId, role: 'user', content: msg.content, timestamp: Date.now(), source });
// ...later...
deps.memoryService.indexTurn({
  userMessage: msg.content,
  userMessageId,
  assistantMessage: assistantText,
  timestamp: Date.now(),
})
```

В `packages/server/src/routes/chat.ts` — то же: найди `saveMessage({messageId: crypto.randomUUID(), role: 'user', ...})` и `indexTurn(...)`. Рефакторь так же чтобы передать один и тот же `userMessageId`.

- [x] **Step 5: Run tests — expect PASS**

```bash
npx vitest run --root packages/server packages/server/src/memory
npx vitest run --root packages/server packages/server/src/channels/discord
npx vitest run --root packages/server packages/server/src/routes
```

Все зелёные. Если тесты бота или роута чата вызывают `indexTurn` без нового поля — обнови мок/spy.

- [x] **Step 6: Typecheck**

```bash
npx tsc --noEmit -p packages/server
```

- [x] **Step 7: Commit**

```bash
git add packages/server/src/memory packages/server/src/channels/discord/bot.ts packages/server/src/routes/chat.ts
git commit -m "feat(memory): thread userMessageId through indexTurn to extractor"
```

---

## Task 4: MemoryService методы `updateFact` и `forgetLast`

**Files:**
- Modify: `packages/server/src/memory/service.ts`
- Modify: `packages/server/src/memory/__tests__/service.test.ts`

**Why:** Business-layer методы используемые LLM tools.

- [x] **Step 1: Failing тесты**

```typescript
describe('updateFact', () => {
  it('supersedes active fact with new value + new sourceMessageId', async () => {
    const svc = /* same setup */;
    await svc.saveFact({ key: 'user.age', value: '42' }); // or seed via insertOrSupersedeFact directly
    const res = await svc.updateFact({ key: 'user.age', newValue: '43', sourceMessageId: 'MSG-X' });
    expect(res).toEqual({ updated: { key: 'user.age', oldValue: '42', newValue: '43' } });
    const row = getDb().prepare("SELECT value, source_message_id FROM memory_facts WHERE key = 'user.age' AND superseded_by IS NULL AND forgotten = 0").get();
    expect(row).toEqual({ value: '43', source_message_id: 'MSG-X' });
  });

  it('returns error when no active fact exists', async () => {
    const svc = /* setup */;
    const res = await svc.updateFact({ key: 'user.missing', newValue: 'x', sourceMessageId: 'M' });
    expect(res).toEqual({ error: 'no active fact', key: 'user.missing' });
  });
});

describe('forgetLast', () => {
  it('forgets all active facts with sourceMessageId of the most recent user msg before given timestamp', async () => {
    const svc = /* setup */;
    const db = getDb();
    db.prepare("INSERT INTO chat_messages (message_id, role, content, timestamp) VALUES ('M_prev', 'user', 'x', 1000)").run();
    db.prepare("INSERT INTO chat_messages (message_id, role, content, timestamp) VALUES ('M_curr', 'user', 'y', 2000)").run();
    // seed two facts from M_prev
    // seed one fact from M_curr (shouldn't be forgotten)
    // (use insertOrSupersedeFact directly with sourceMessageId)
    const res = await svc.forgetLast({ currentMessageTimestamp: 2000 });
    expect(res.forgotten.length).toBe(2);
    expect(res.sourceMessageId).toBe('M_prev');
    // assert M_curr's fact still active
  });

  it('returns empty when no previous user message', async () => {
    const svc = /* setup */;
    const res = await svc.forgetLast({ currentMessageTimestamp: 1000 });
    expect(res).toEqual({ forgotten: [], sourceMessageId: null, reason: 'no previous user message' });
  });

  it('returns empty when previous user message has no active facts', async () => {
    const svc = /* setup */;
    getDb().prepare("INSERT INTO chat_messages (message_id, role, content, timestamp) VALUES ('M_prev', 'user', 'x', 1000)").run();
    const res = await svc.forgetLast({ currentMessageTimestamp: 2000 });
    expect(res).toEqual({ forgotten: [], sourceMessageId: 'M_prev', reason: 'no active facts' });
  });
});
```

- [x] **Step 2: Run — expect FAIL**

- [x] **Step 3: Реализовать в `memory/service.ts`**

Добавь в interface MemoryService:

```typescript
updateFact(params: { key: string; newValue: string; sourceMessageId: string | null }): Promise<
  | { updated: { key: string; oldValue: string; newValue: string } }
  | { error: string; key: string }
>;
forgetLast(params: { currentMessageTimestamp: number }): Promise<{
  forgotten: Array<{ id: number; key: string; value: string }>;
  sourceMessageId: string | null;
  reason?: string;
}>;
```

В реализации (возвращаемый объект):

```typescript
async updateFact(params) {
  const { key, newValue, sourceMessageId } = params;
  const existing = findActiveFactByKey(db, key);
  if (!existing) return { error: 'no active fact', key };
  const normalizedValue = newValue.trim().replace(/\s+/g, ' ');
  if (!normalizedValue) return { error: 'empty new value', key };
  const factText = `${key}: ${normalizedValue}`;
  const vec = await safeEmbed(factText);
  if (!vec) return { error: 'embedding failed', key };
  insertOrSupersedeFact(db, {
    key,
    value: normalizedValue,
    createdAt: Date.now(),
    embedding: vec,
    importance: existing.importance,
    sourceMessageId,
  });
  return { updated: { key, oldValue: existing.value, newValue: normalizedValue } };
},

async forgetLast(params) {
  const prev = findLastUserMessageBefore(db, params.currentMessageTimestamp);
  if (!prev) return { forgotten: [], sourceMessageId: null, reason: 'no previous user message' };
  const facts = findFactsBySourceMessageId(db, prev.messageId);
  if (facts.length === 0) return { forgotten: [], sourceMessageId: prev.messageId, reason: 'no active facts' };
  const forgotten: Array<{ id: number; key: string; value: string }> = [];
  for (const f of facts) {
    if (markFactForgotten(db, f.id)) forgotten.push({ id: f.id, key: f.key, value: f.value });
  }
  return { forgotten, sourceMessageId: prev.messageId };
},
```

- [x] **Step 4: Run — expect PASS**

```bash
npx vitest run --root packages/server packages/server/src/memory
```

- [x] **Step 5: Commit**

```bash
git add packages/server/src/memory
git commit -m "feat(memory): updateFact + forgetLast service methods"
```

---

## Task 5: Shared types — `tool_memory_confirm` SSE event + ToolContext.requestMemoryConfirm

**Files:**
- Modify: `packages/shared/src/types.ts`

**Why:** Типизированный канал связи сервер→клиент для memory confirm requests, плюс расширение ToolContext — tool'ы будут звать `ctx.requestMemoryConfirm(...)`.

- [x] **Step 1: Обновить `packages/shared/src/types.ts`**

Добавь вверху (после существующих типов):

```typescript
export interface MemoryConfirmPayload {
  id: string;
  tool: 'memory_forget' | 'memory_update' | 'memory_forget_last';
  preview: string;
  editableField: 'query' | 'newValue' | null;
  initialValue: string | null;
  params: Record<string, unknown>;
}

export interface MemoryConfirmResponse {
  approved: boolean;
  editedParams?: Record<string, unknown>;
}
```

Расширь `SSEEvent`:

```typescript
export type SSEEvent =
  // ...existing variants...
  | { type: 'tool_memory_confirm'; payload: MemoryConfirmPayload }
  // ...done/error...
```

Расширь `ToolContext`:

```typescript
export interface ToolContext {
  onProgress?: (message: string) => void;
  requestPlanReview?: (plan: string) => Promise<PlanReviewResponse>;
  requestMemoryConfirm?: (
    payload: Omit<MemoryConfirmPayload, 'id'>,
  ) => Promise<MemoryConfirmResponse>;
  signal?: AbortSignal;
  meta?: { autoMode?: boolean; callId?: string };
}
```

- [x] **Step 2: Build shared package**

```bash
npm --workspace @r2/shared run build
```

Если `build` скрипта нет — проверь через tsc:

```bash
npx tsc -p packages/shared
```

- [x] **Step 3: Typecheck server (shared types используются везде)**

```bash
npx tsc --noEmit -p packages/server
```

Expect exit 0. Если ошибки — читай: TypeScript обычно укажет на missing `requestMemoryConfirm` в местах где `ToolContext` собирается. Пока не исправляем — это fallout исправится в Task 6.

Возможно TS жалуется что в `buildToolContext` не задано новое поле. Это ок — поле optional. Не должно падать. Если падает — открой tool-helpers.ts, убедись что возвращаемый объект ToolContext literal не expects все поля (он их не все ставит).

- [x] **Step 4: Commit**

```bash
git add packages/shared/src/types.ts
git commit -m "feat(shared): tool_memory_confirm SSE event + ToolContext method"
```

---

## Task 6: Backend pendingMemoryConfirms + service + requester

**Files:**
- Create: `packages/server/src/routes/memory-confirm.ts`
- Create: `packages/server/src/services/memory-confirm-service.ts`
- Create: `packages/server/src/services/__tests__/memory-confirm-service.test.ts`
- Modify: `packages/server/src/ai/tool-helpers.ts`
- Modify: `packages/server/src/ai/tool-loop.ts`
- Modify: `packages/server/src/ai/router.ts`

**Why:** Инфраструктура для confirm — map callId→resolver, requester который шлёт SSE + ждёт resolution, сервис с `isResolvedByUser`.

- [x] **Step 1: Создать `routes/memory-confirm.ts`**

Файл `packages/server/src/routes/memory-confirm.ts`:

```typescript
import type { Request, Response, Router as RouterType } from 'express';
import type { MemoryConfirmResponse } from '@r2/shared';
import { Router } from 'express';

export type PendingMemoryConfirms = Map<string, (response: MemoryConfirmResponse) => void>;

export function createMemoryConfirmRouter(pending: PendingMemoryConfirms): RouterType {
  const router = Router();
  router.post('/api/memory/confirm/:callId', (req: Request, res: Response) => {
    const { callId } = req.params;
    const body = req.body ?? {};
    const approved = Boolean(body.approved);
    const editedParams = typeof body.editedParams === 'object' && body.editedParams !== null
      ? body.editedParams
      : undefined;
    const resolve = pending.get(callId);
    if (!resolve) return res.status(404).json({ ok: false, reason: 'not_found' });
    resolve({ approved, editedParams });
    res.json({ ok: true });
  });
  return router;
}
```

- [x] **Step 2: Создать service (по образцу plan-review-service)**

Файл `packages/server/src/services/memory-confirm-service.ts`:

```typescript
import type { MemoryConfirmResponse } from '@r2/shared';
import type { PendingMemoryConfirms } from '../routes/memory-confirm.js';

export interface MemoryConfirmService {
  isResolvedByUser(callId: string): boolean;
  resolve(callId: string, approved: boolean, editedParams?: Record<string, unknown>):
    | { ok: true }
    | { ok: false; reason: 'not_found' };
}

interface Deps { pending: PendingMemoryConfirms; }

export function createMemoryConfirmService(deps: Deps): MemoryConfirmService {
  const resolvedByUser = new Set<string>();
  return {
    isResolvedByUser(callId) { return resolvedByUser.has(callId); },
    resolve(callId, approved, editedParams) {
      const resolve = deps.pending.get(callId);
      if (!resolve) return { ok: false, reason: 'not_found' };
      deps.pending.delete(callId);
      resolvedByUser.add(callId);
      // Cap set size to avoid unbounded growth
      if (resolvedByUser.size > 200) {
        const evict = resolvedByUser.values().next().value;
        if (evict) resolvedByUser.delete(evict);
      }
      resolve({ approved, editedParams });
      return { ok: true };
    },
  };
}
```

- [x] **Step 3: Failing тесты для service**

`packages/server/src/services/__tests__/memory-confirm-service.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { createMemoryConfirmService } from '../memory-confirm-service.js';

describe('memory-confirm-service', () => {
  it('resolve delivers response to pending waiter', () => {
    const pending = new Map<string, (r: any) => void>();
    const svc = createMemoryConfirmService({ pending });
    const resolver = vi.fn();
    pending.set('C1', resolver);
    const res = svc.resolve('C1', true, { query: 'user.age' });
    expect(res).toEqual({ ok: true });
    expect(resolver).toHaveBeenCalledWith({ approved: true, editedParams: { query: 'user.age' } });
  });

  it('resolve with unknown id returns not_found', () => {
    const svc = createMemoryConfirmService({ pending: new Map() });
    expect(svc.resolve('nope', true)).toEqual({ ok: false, reason: 'not_found' });
  });

  it('isResolvedByUser tracks resolved ids', () => {
    const pending = new Map<string, (r: any) => void>();
    pending.set('C2', () => {});
    const svc = createMemoryConfirmService({ pending });
    svc.resolve('C2', false);
    expect(svc.isResolvedByUser('C2')).toBe(true);
    expect(svc.isResolvedByUser('other')).toBe(false);
  });
});
```

- [x] **Step 4: Run tests — expect PASS**

```bash
npx vitest run --root packages/server packages/server/src/services/__tests__/memory-confirm-service.test.ts
```

- [x] **Step 5: Requester в tool-helpers**

В `packages/server/src/ai/tool-helpers.ts` добавь импорт:

```typescript
import type { PendingMemoryConfirms } from '../routes/memory-confirm.js';
import type { MemoryConfirmPayload, MemoryConfirmResponse } from '@r2/shared';
```

И функцию:

```typescript
export function createMemoryConfirmRequester(
  callId: string,
  onEvent: (event: SSEEvent) => void,
  pendingMemoryConfirms: PendingMemoryConfirms,
  signal?: AbortSignal,
): (payload: Omit<MemoryConfirmPayload, 'id'>) => Promise<MemoryConfirmResponse> {
  return (payload) => new Promise((resolve) => {
    if (signal?.aborted) { resolve({ approved: false }); return; }
    const onAbort = () => {
      pendingMemoryConfirms.delete(callId);
      resolve({ approved: false });
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    pendingMemoryConfirms.set(callId, (response) => {
      signal?.removeEventListener('abort', onAbort);
      resolve(response);
    });
    onEvent({ type: 'tool_memory_confirm', payload: { id: callId, ...payload } });
  });
}
```

Расширь `buildToolContext` — добавь параметр `pendingMemoryConfirms` и возвращаемый объект:

```typescript
export function buildToolContext(
  blockId: string,
  task: string,
  autoMode: boolean,
  onEvent: (event: SSEEvent) => void,
  pendingPlanReviews: PendingPlanReviews,
  pendingMemoryConfirms: PendingMemoryConfirms,
  signal?: AbortSignal,
): ToolContext {
  return {
    onProgress: (message) => onEvent({ type: 'tool_progress', id: blockId, message }),
    requestPlanReview: createPlanReviewRequester(blockId, task, onEvent, pendingPlanReviews, signal),
    requestMemoryConfirm: createMemoryConfirmRequester(blockId, onEvent, pendingMemoryConfirms, signal),
    signal,
    meta: { autoMode, callId: blockId },
  };
}
```

Найди все вызовы `buildToolContext` — в том же файле `executeToolWithPermission` — и добавь `pendingMemoryConfirms` параметр:

```typescript
// В executeToolWithPermission signature:
pendingMemoryConfirms: PendingMemoryConfirms;
// ...
// В теле метода заменить `buildToolContext(blockId, task, autoMode, onEvent, pendingPlanReviews, signal)`
// на `buildToolContext(blockId, task, autoMode, onEvent, pendingPlanReviews, pendingMemoryConfirms, signal)`
```

- [x] **Step 6: Прокинуть через tool-loop и router**

В `packages/server/src/ai/tool-loop.ts`:

```typescript
// В RunLoopParams:
pendingMemoryConfirms?: PendingMemoryConfirms;
// в default:
pendingMemoryConfirms = new Map(),
// В вызове executeToolWithPermission добавь pendingMemoryConfirms.
```

В `packages/server/src/ai/router.ts` — то же самое: добавить `pendingMemoryConfirms?: PendingMemoryConfirms` в `RunChatRequestParams` и прокинуть внутрь `params.runLoop(...)` вызова.

- [x] **Step 7: Typecheck**

```bash
npx tsc --noEmit -p packages/server
```

Expect exit 0. Если что-то красное — скорее всего тесты/call sites не обновлены. Исправь по trace.

- [x] **Step 8: Run full server tests**

```bash
npx vitest run --root packages/server
```

Тесты могут падать в местах где `executeToolWithPermission` или `runToolLoop` вызываются в тестовом окружении без `pendingMemoryConfirms`. Добавляй `pendingMemoryConfirms: new Map()` в stubs/deps. Падать должно строго из-за этого — никакой другой логики не меняем.

- [x] **Step 9: Commit**

```bash
git add packages/server
git commit -m "feat(memory): pendingMemoryConfirms + requester + service"
```

---

## Task 7: Memory tools — forget (refactor) + update + forget_last

**Files:**
- Modify: `packages/tool-memory/src/index.ts`
- Modify: `packages/tool-memory/__tests__/index.test.ts`

**Why:** Tool'ы, видимые LLM. `memory_forget` уже есть — меняем его, чтобы перед apply зайти в `ctx.requestMemoryConfirm`. `memory_update` и `memory_forget_last` — новые. Все три — `permissionLevel: 'auto'` (confirm происходит внутри через `requestMemoryConfirm`, не через стандартную permission-dialog).

- [x] **Step 1: Failing тесты для новых behaviors**

В `packages/tool-memory/__tests__/index.test.ts` добавь (или создай если файла нет):

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createMemoryForgetTool,
  createMemoryUpdateTool,
  createMemoryForgetLastTool,
} from '../src/index.js';

function makeMemoryService(overrides: any = {}) {
  return {
    forgetFact: vi.fn(async ({ query }) => ({
      forgotten: [{ id: 1, key: 'user.age', value: '42' }],
      candidates: [],
    })),
    updateFact: vi.fn(async ({ key, newValue, sourceMessageId }) => ({
      updated: { key, oldValue: '42', newValue },
    })),
    forgetLast: vi.fn(async () => ({
      forgotten: [{ id: 2, key: 'user.x', value: 'y' }],
      sourceMessageId: 'M_prev',
    })),
    ...overrides,
  };
}

function makeCtx(confirmResponse: any) {
  return {
    requestMemoryConfirm: vi.fn(async () => confirmResponse),
    meta: { callId: 'BLK-1' },
  } as any;
}

describe('memory_forget with confirm', () => {
  it('requests confirm with preview; on approve, applies with original query', async () => {
    const memoryService = makeMemoryService();
    const tool = createMemoryForgetTool({ memoryService });
    const ctx = makeCtx({ approved: true });
    const res = await tool.handler({ query: 'user.age' }, ctx);
    expect(ctx.requestMemoryConfirm).toHaveBeenCalledWith(expect.objectContaining({
      tool: 'memory_forget',
      editableField: 'query',
      initialValue: 'user.age',
      params: { query: 'user.age' },
    }));
    expect(memoryService.forgetFact).toHaveBeenCalledWith({ query: 'user.age' });
    expect(res.success).toBe(true);
  });

  it('on edit & approve, uses edited query', async () => {
    const memoryService = makeMemoryService();
    const tool = createMemoryForgetTool({ memoryService });
    const ctx = makeCtx({ approved: true, editedParams: { query: 'user.age_group' } });
    await tool.handler({ query: 'user.age' }, ctx);
    expect(memoryService.forgetFact).toHaveBeenCalledWith({ query: 'user.age_group' });
  });

  it('on deny, returns error without calling service', async () => {
    const memoryService = makeMemoryService();
    const tool = createMemoryForgetTool({ memoryService });
    const ctx = makeCtx({ approved: false });
    const res = await tool.handler({ query: 'user.age' }, ctx);
    expect(res.success).toBe(false);
    expect(memoryService.forgetFact).not.toHaveBeenCalled();
  });

  it('falls back to direct apply if ctx.requestMemoryConfirm is missing', async () => {
    const memoryService = makeMemoryService();
    const tool = createMemoryForgetTool({ memoryService });
    const ctx = { meta: {} } as any;
    await tool.handler({ query: 'user.age' }, ctx);
    expect(memoryService.forgetFact).toHaveBeenCalled();
  });
});

describe('memory_update', () => {
  it('requests confirm with key + editable newValue', async () => {
    const memoryService = makeMemoryService();
    const tool = createMemoryUpdateTool({ memoryService });
    const ctx = makeCtx({ approved: true });
    const res = await tool.handler({ key: 'user.activity', newValue: 'бег' }, { ...ctx, currentUserMessageId: 'M-10' });
    expect(ctx.requestMemoryConfirm).toHaveBeenCalledWith(expect.objectContaining({
      tool: 'memory_update',
      editableField: 'newValue',
      initialValue: 'бег',
    }));
    expect(memoryService.updateFact).toHaveBeenCalledWith({
      key: 'user.activity',
      newValue: 'бег',
      sourceMessageId: 'M-10',
    });
    expect(res.success).toBe(true);
  });

  it('uses edited newValue when user edits', async () => {
    const memoryService = makeMemoryService();
    const tool = createMemoryUpdateTool({ memoryService });
    const ctx = makeCtx({ approved: true, editedParams: { newValue: 'плавание' } });
    await tool.handler({ key: 'user.activity', newValue: 'бег' }, { ...ctx, currentUserMessageId: 'M-10' });
    expect(memoryService.updateFact).toHaveBeenCalledWith({
      key: 'user.activity',
      newValue: 'плавание',
      sourceMessageId: 'M-10',
    });
  });
});

describe('memory_forget_last', () => {
  it('requests non-editable confirm with forgotten preview; on approve, applies', async () => {
    const memoryService = makeMemoryService();
    const tool = createMemoryForgetLastTool({ memoryService });
    const ctx = makeCtx({ approved: true });
    const res = await tool.handler({}, { ...ctx, currentUserMessageTimestamp: 2000 });
    expect(ctx.requestMemoryConfirm).toHaveBeenCalledWith(expect.objectContaining({
      tool: 'memory_forget_last',
      editableField: null,
    }));
    expect(memoryService.forgetLast).toHaveBeenCalledWith({ currentMessageTimestamp: 2000 });
    expect(res.success).toBe(true);
  });

  it('returns error when no previous facts without confirm', async () => {
    const memoryService = makeMemoryService({
      forgetLast: vi.fn(async () => ({ forgotten: [], sourceMessageId: null, reason: 'no previous user message' })),
    });
    const tool = createMemoryForgetLastTool({ memoryService });
    const ctx = makeCtx({ approved: true });
    // Preview-stage calls memoryService.forgetLast to get list; if empty, short-circuit
    const res = await tool.handler({}, { ...ctx, currentUserMessageTimestamp: 2000 });
    expect(res.success).toBe(false);
    // requestMemoryConfirm may or may not be called — design choice, spec: don't confirm empty
    expect(ctx.requestMemoryConfirm).not.toHaveBeenCalled();
  });
});
```

- [x] **Step 2: Run — expect FAIL (new tools/logic not defined)**

```bash
npx vitest run --root packages/tool-memory
```

- [x] **Step 3: Обновить `packages/tool-memory/src/index.ts`**

Расширь `MemoryServiceLike`:

```typescript
interface MemoryServiceLike {
  // ...existing...
  updateFact?(params: { key: string; newValue: string; sourceMessageId: string | null }): Promise<
    | { updated: { key: string; oldValue: string; newValue: string } }
    | { error: string; key: string }
  >;
  forgetLast?(params: { currentMessageTimestamp: number }): Promise<{
    forgotten: Array<{ id: number; key: string; value: string }>;
    sourceMessageId: string | null;
    reason?: string;
  }>;
}
```

**Refactor `createMemoryForgetTool`:**

```typescript
async handler(params, ctx) {
  const query = typeof params.query === 'string' ? params.query.trim() : '';
  if (!query) return { success: false, error: 'query parameter is required' };
  if (!deps.memoryService?.forgetFact) {
    return { success: false, error: 'Memory service is disabled' };
  }

  // Preview: peek what would match (for user visibility)
  const preview = `Забути: "${query}"`;

  let effectiveQuery = query;
  if (ctx?.requestMemoryConfirm) {
    const response = await ctx.requestMemoryConfirm({
      tool: 'memory_forget',
      preview,
      editableField: 'query',
      initialValue: query,
      params: { query },
    });
    if (!response.approved) return { success: false, error: 'Користувач відхилив' };
    if (response.editedParams && typeof response.editedParams.query === 'string') {
      effectiveQuery = response.editedParams.query.trim();
    }
  }

  try {
    const result = await deps.memoryService.forgetFact({ query: effectiveQuery });
    // ...existing output formatting...
  } catch (err) { /* ... */ }
}
```

**Новый `createMemoryUpdateTool`:**

```typescript
export function createMemoryUpdateTool(deps: { memoryService: MemoryServiceLike | null }): ToolDefinition {
  return {
    name: 'memory_update',
    description: 'Update the value of an existing memory fact. Use when the user corrects a previously stored fact (e.g. "мой возраст не 42 а 43").',
    permissionLevel: 'auto',
    provider: 'all',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Exact fact key, e.g. "user.age"' },
        newValue: { type: 'string', description: 'New value to replace the old one' },
      },
      required: ['key', 'newValue'],
    },
    async handler(params, ctx) {
      if (!deps.memoryService?.updateFact) return { success: false, error: 'Memory service is disabled' };
      const key = typeof params.key === 'string' ? params.key.trim() : '';
      const newValue = typeof params.newValue === 'string' ? params.newValue.trim() : '';
      if (!key || !newValue) return { success: false, error: 'key and newValue are required' };

      const preview = `Оновити ${key} → "${newValue}"`;
      let effectiveNewValue = newValue;
      if (ctx?.requestMemoryConfirm) {
        const response = await ctx.requestMemoryConfirm({
          tool: 'memory_update',
          preview,
          editableField: 'newValue',
          initialValue: newValue,
          params: { key, newValue },
        });
        if (!response.approved) return { success: false, error: 'Користувач відхилив' };
        if (response.editedParams && typeof response.editedParams.newValue === 'string') {
          effectiveNewValue = response.editedParams.newValue.trim();
        }
      }

      const sourceMessageId = (ctx as any)?.currentUserMessageId ?? null;
      const result = await deps.memoryService.updateFact({ key, newValue: effectiveNewValue, sourceMessageId });
      if ('error' in result) return { success: false, error: result.error };
      return {
        success: true,
        data: result,
        display: { type: 'text', content: `Оновлено ${result.updated.key}: "${result.updated.oldValue}" → "${result.updated.newValue}"` },
      };
    },
  };
}
```

**Новый `createMemoryForgetLastTool`:**

```typescript
export function createMemoryForgetLastTool(deps: { memoryService: MemoryServiceLike | null }): ToolDefinition {
  return {
    name: 'memory_forget_last',
    description: 'Forget all facts extracted from the user\'s most recent previous message. Use when the user says "это неверно" / "ерунду запомнил" / "забудь что я только что сказал".',
    permissionLevel: 'auto',
    provider: 'all',
    parameters: { type: 'object', properties: {} },
    async handler(_params, ctx) {
      if (!deps.memoryService?.forgetLast) return { success: false, error: 'Memory service is disabled' };
      const currentMessageTimestamp = (ctx as any)?.currentUserMessageTimestamp ?? Date.now();

      // Preview phase: peek what would be forgotten (without marking yet — but
      // forgetLast is a one-shot mark+return. So we call it for preview only
      // if the ctx supports dry-run. For MVP: we call once, don't support
      // editing (editableField=null). No preview-before-confirm; user sees
      // the facts in the confirm dialog text).
      //
      // Approach: service.forgetLast is idempotent for the DB (marks rows);
      // but we don't want to mark before user approves. Solution: add a
      // dry-run flag. We'll extend the service call shape to include that.

      // DRY-RUN PATH: the tool expects memoryService.forgetLast to accept an
      // optional `dryRun: true`. When true, returns the list without marking.
      const dryResult = await deps.memoryService.forgetLast({ currentMessageTimestamp, dryRun: true } as any);
      if (dryResult.forgotten.length === 0) {
        return { success: false, error: dryResult.reason ?? 'Нічого забувати' };
      }

      const previewItems = dryResult.forgotten.map((f) => `${f.key}=${f.value}`).join(', ');
      const preview = `Забути ${dryResult.forgotten.length} факт(и): ${previewItems}`;
      if (ctx?.requestMemoryConfirm) {
        const response = await ctx.requestMemoryConfirm({
          tool: 'memory_forget_last',
          preview,
          editableField: null,
          initialValue: null,
          params: {},
        });
        if (!response.approved) return { success: false, error: 'Користувач відхилив' };
      }

      // Real run: marks rows
      const result = await deps.memoryService.forgetLast({ currentMessageTimestamp });
      const lines = result.forgotten.map((f) => `${f.key} = ${f.value}`);
      return {
        success: true,
        data: result,
        display: { type: 'text', content: `Забув: ${lines.join(', ')}` },
      };
    },
  };
}
```

**Extension уведомление:** `forgetLast` в memory/service.ts теперь должен принимать `dryRun: true` и не маркировать если true. Изменение небольшое — добавить `if (params.dryRun) return { forgotten: facts.map(...), sourceMessageId: prev.messageId };` перед markFactForgotten цикла.

Обнови `createTool`:

```typescript
export function createTool(deps: { memoryService: MemoryServiceLike | null }): ToolDefinition[] {
  return [
    createMemorySearchTool(deps),
    createMemoryRememberTool(deps),
    createMemoryForgetTool(deps),
    createMemoryUpdateTool(deps),
    createMemoryForgetLastTool(deps),
  ];
}
```

- [x] **Step 4: Реализовать dryRun в `forgetLast` service method**

В `packages/server/src/memory/service.ts` обнови signature и implementation `forgetLast`:

```typescript
forgetLast(params: { currentMessageTimestamp: number; dryRun?: boolean }): Promise<{
  forgotten: Array<{ id: number; key: string; value: string }>;
  sourceMessageId: string | null;
  reason?: string;
}>;

// Implementation:
async forgetLast(params) {
  const prev = findLastUserMessageBefore(db, params.currentMessageTimestamp);
  if (!prev) return { forgotten: [], sourceMessageId: null, reason: 'no previous user message' };
  const facts = findFactsBySourceMessageId(db, prev.messageId);
  if (facts.length === 0) return { forgotten: [], sourceMessageId: prev.messageId, reason: 'no active facts' };
  if (params.dryRun) {
    return {
      forgotten: facts.map((f) => ({ id: f.id, key: f.key, value: f.value })),
      sourceMessageId: prev.messageId,
    };
  }
  const forgotten: Array<{ id: number; key: string; value: string }> = [];
  for (const f of facts) {
    if (markFactForgotten(db, f.id)) forgotten.push({ id: f.id, key: f.key, value: f.value });
  }
  return { forgotten, sourceMessageId: prev.messageId };
}
```

Соответственно обнови MemoryServiceLike в tool-memory с `dryRun?: boolean` полем.

- [x] **Step 5: Run — expect PASS**

```bash
npx vitest run --root packages/tool-memory
npx vitest run --root packages/server packages/server/src/memory
```

- [x] **Step 6: Typecheck**

```bash
npx tsc --noEmit -p packages/server
```

- [x] **Step 7: Commit**

```bash
git add packages/tool-memory packages/server/src/memory
git commit -m "feat(tool-memory): forget with confirm + update + forget_last tools"
```

---

## Task 8: Tool context — currentUserMessageId/Timestamp

**Files:**
- Modify: `packages/server/src/ai/tool-helpers.ts`
- Modify: `packages/shared/src/types.ts`

**Why:** `memory_update` и `memory_forget_last` нуждаются в id/timestamp текущего user-message — прокидываем через ToolContext.

- [x] **Step 1: Расширить ToolContext в shared**

В `packages/shared/src/types.ts`:

```typescript
export interface ToolContext {
  // ...existing fields...
  currentUserMessageId?: string;
  currentUserMessageTimestamp?: number;
}
```

- [x] **Step 2: Расширить buildToolContext и executeToolWithPermission**

`buildToolContext` принимает новые параметры и ставит их в ctx:

```typescript
export function buildToolContext(
  blockId: string,
  task: string,
  autoMode: boolean,
  onEvent: (event: SSEEvent) => void,
  pendingPlanReviews: PendingPlanReviews,
  pendingMemoryConfirms: PendingMemoryConfirms,
  currentUserMessageId: string | undefined,
  currentUserMessageTimestamp: number | undefined,
  signal?: AbortSignal,
): ToolContext {
  return {
    onProgress: (message) => onEvent({ type: 'tool_progress', id: blockId, message }),
    requestPlanReview: createPlanReviewRequester(blockId, task, onEvent, pendingPlanReviews, signal),
    requestMemoryConfirm: createMemoryConfirmRequester(blockId, onEvent, pendingMemoryConfirms, signal),
    signal,
    meta: { autoMode, callId: blockId },
    currentUserMessageId,
    currentUserMessageTimestamp,
  };
}
```

`executeToolWithPermission` получает в params два новых optional поля `currentUserMessageId?: string, currentUserMessageTimestamp?: number` и прокидывает в buildToolContext.

- [x] **Step 3: Прокинуть через tool-loop.ts**

В `runToolLoop` — есть доступ к `messages`: последний user-msg можно извлечь. Но message_id в MessageParam нет (это SDK тип). Проще: передать снаружи.

```typescript
// RunToolLoopParams:
currentUserMessageId?: string;
currentUserMessageTimestamp?: number;

// При вызове executeToolWithPermission в теле loop:
await executeToolWithPermission({ ..., currentUserMessageId, currentUserMessageTimestamp });
```

Вверх по цепочке — router.ts `runChatRequest` принимает те же параметры. Соответственно каждый caller (`routes/chat.ts`, `channels/discord/bot.ts`) извлекает UUID и timestamp своего только что-созданного user-message и передаёт в `runChatRequest` → router → runLoop.

- [x] **Step 4: Обновить callers**

В `packages/server/src/channels/discord/bot.ts`, там где вызывается `runChatRequest(...)`, передай:

```typescript
await runChatRequest({
  // ...existing fields...
  currentUserMessageId: userMessageId,           // тот что захватили в Task 3
  currentUserMessageTimestamp: userMessageTimestamp,
});
```

В `routes/chat.ts` аналогично — захвати timestamp и id user-message до вызова runChatRequest.

- [x] **Step 5: Run tests — expect PASS**

```bash
npx vitest run --root packages/server
```

- [x] **Step 6: Typecheck**

```bash
npx tsc --noEmit -p packages/server
```

- [x] **Step 7: Commit**

```bash
git add packages/shared packages/server
git commit -m "feat(memory): thread currentUserMessageId/Timestamp into ToolContext"
```

---

## Task 9: Discord UI — tool_memory_confirm → buttons + modal + interactions

**Files:**
- Modify: `packages/server/src/channels/discord/bot.ts`
- Modify: `packages/server/src/channels/discord/interactions.ts`
- Modify: `packages/server/src/channels/discord/__tests__/interactions.test.ts`

**Why:** Пользовательский UX для confirm с edit.

- [x] **Step 1: Добавить handler в `bot.ts` рядом с tool_plan_review**

В `packages/server/src/channels/discord/bot.ts` в блоке `if (event.type === 'tool_plan_review') {...}` — добавь аналогичный ниже:

```typescript
if (event.type === 'tool_memory_confirm') {
  await flush();
  const p = event.payload;
  const baseText = `🧠 **Memory ${p.tool}**\n${p.preview}`;
  const row: any = { type: 1, components: [] };
  row.components.push(
    { type: 2, style: 3, label: '✅ Approve', custom_id: `memconfirm:approve:${p.id}` },
  );
  if (p.editableField) {
    row.components.push(
      { type: 2, style: 1, label: '✏️ Edit & approve', custom_id: `memconfirm:edit:${p.id}:${p.editableField}` },
    );
  }
  row.components.push(
    { type: 2, style: 4, label: '❌ Deny', custom_id: `memconfirm:deny:${p.id}` },
  );
  const sent = await dmChannel.send({ content: baseText, components: [row] });
  pendingEmbedMsgs.push({ callId: p.id, kind: 'memconfirm', messageIds: [sent.id] });
  return;
}
```

Обнови тип `pendingEmbedMsgs` если нужно — чтобы `kind` включал `'memconfirm'`.

- [x] **Step 2: Handle кнопки в `interactions.ts`**

В `packages/server/src/channels/discord/interactions.ts` найди блок handling custom_id prefixes (где уже есть `plan_review:...`). Добавь блок:

```typescript
if (customId.startsWith('memconfirm:')) {
  const [, action, callId, field] = customId.split(':'); // field only for 'edit'
  if (!deps.memoryConfirmService) {
    await (ixn as any).reply({ flags: MessageFlags.Ephemeral, content: 'Memory confirm не настроен' });
    return;
  }
  if (action === 'approve') {
    deps.memoryConfirmService.resolve(callId, true);
    await (ixn as any).update({ content: (ixn as any).message.content + '\n\n✅ Approved', components: [] });
    return;
  }
  if (action === 'deny') {
    deps.memoryConfirmService.resolve(callId, false);
    await (ixn as any).update({ content: (ixn as any).message.content + '\n\n❌ Denied', components: [] });
    return;
  }
  if (action === 'edit') {
    // Open modal with pre-filled text input
    const modal = {
      title: 'Edit parameter',
      custom_id: `memconfirm_modal:${callId}:${field}`,
      components: [
        {
          type: 1,
          components: [
            {
              type: 4,
              custom_id: 'value',
              label: field === 'query' ? 'Query' : 'New value',
              style: 1,
              value: '', // modal doesn't have prefilled if via button; use showModal with builder
              required: true,
            },
          ],
        },
      ],
    };
    await (ixn as any).showModal(modal);
    return;
  }
}

// Modal submit:
if (customId.startsWith('memconfirm_modal:')) {
  const [, , callId, field] = customId.split(':');
  const value = (ixn as any).fields.getTextInputValue('value');
  if (!deps.memoryConfirmService) return;
  deps.memoryConfirmService.resolve(callId, true, { [field]: value });
  await (ixn as any).reply({ flags: MessageFlags.Ephemeral, content: `✅ Approved with edit: ${field}="${value}"` });
  return;
}
```

**Предупреждение:** Discord.js правильный способ открыть Modal — через `ModalBuilder` и `TextInputBuilder`. Для TDD-подхода сохрани raw-JSON вариант до первого integration; затем перепиши через builder'ы когда появятся import conflicts. Минимум:

```typescript
import { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } from 'discord.js';

const modal = new ModalBuilder()
  .setCustomId(`memconfirm_modal:${callId}:${field}`)
  .setTitle('Edit parameter');
const input = new TextInputBuilder()
  .setCustomId('value')
  .setLabel(field === 'query' ? 'Query' : 'New value')
  .setStyle(TextInputStyle.Short)
  .setRequired(true);
// Prefill via setValue — requires the initialValue from payload. Passed
// via custom_id is not possible (32-char limit). Alternative: keep a
// pendingEmbedMsgs entry with initialValue, look it up here.
input.setValue(pendingLookup?.initialValue ?? '');
modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
await ixn.showModal(modal);
```

Вариант с prefill: в `pendingEmbedMsgs` сохраняй `initialValue` при `tool_memory_confirm` event. В edit handler смотри в `pendingEmbedMsgs` по callId и ставь `input.setValue(entry.initialValue)`.

- [x] **Step 3: Failing тест — interactions**

В `packages/server/src/channels/discord/__tests__/interactions.test.ts` добавь 3 теста:

```typescript
it('memconfirm approve resolves with true', async () => {
  const memoryConfirmService = { resolve: vi.fn() } as any;
  const ixn = {
    isButton: () => true,
    customId: 'memconfirm:approve:CALL-1',
    message: { content: '🧠 Memory' },
    update: vi.fn(),
  } as any;
  await routeInteraction(ixn, { ...commonDeps(), memoryConfirmService });
  expect(memoryConfirmService.resolve).toHaveBeenCalledWith('CALL-1', true);
});

it('memconfirm deny resolves with false', async () => {
  const memoryConfirmService = { resolve: vi.fn() } as any;
  const ixn = {
    isButton: () => true,
    customId: 'memconfirm:deny:CALL-1',
    message: { content: '🧠 Memory' },
    update: vi.fn(),
  } as any;
  await routeInteraction(ixn, { ...commonDeps(), memoryConfirmService });
  expect(memoryConfirmService.resolve).toHaveBeenCalledWith('CALL-1', false);
});

it('memconfirm modal submit resolves with edited params', async () => {
  const memoryConfirmService = { resolve: vi.fn() } as any;
  const ixn = {
    isModalSubmit: () => true,
    customId: 'memconfirm_modal:CALL-2:query',
    fields: { getTextInputValue: () => 'user.age_group' },
    reply: vi.fn(),
  } as any;
  await routeInteraction(ixn, { ...commonDeps(), memoryConfirmService });
  expect(memoryConfirmService.resolve).toHaveBeenCalledWith('CALL-2', true, { query: 'user.age_group' });
});
```

`commonDeps` — helper в существующем test-файле, создаёт stubs для других сервисов.

- [x] **Step 4: Run — expect PASS**

```bash
npx vitest run --root packages/server packages/server/src/channels/discord/__tests__/interactions.test.ts
```

- [x] **Step 5: Commit**

```bash
git add packages/server/src/channels/discord
git commit -m "feat(discord): memory confirm buttons + modal"
```

---

## Task 10: Wire в index.ts + HTTP route

**Files:**
- Modify: `packages/server/src/index.ts`

**Why:** Регистрация `pendingMemoryConfirms`, `memoryConfirmService`, HTTP endpoint, передача в Discord deps и chat routes.

- [ ] **Step 1: Инициализировать в index.ts**

Найди место где создаются `pendingConfirms` и `pendingPlanReviews`:

```typescript
const pendingConfirms: PendingConfirms = new Map();
const permissionService = createPermissionService({ pending: pendingConfirms });
const pendingPlanReviews: PendingPlanReviews = new Map();
const planReviewService = createPlanReviewService({ pending: pendingPlanReviews });
```

Добавь рядом:

```typescript
import { createMemoryConfirmRouter, type PendingMemoryConfirms } from './routes/memory-confirm.js';
import { createMemoryConfirmService } from './services/memory-confirm-service.js';

const pendingMemoryConfirms: PendingMemoryConfirms = new Map();
const memoryConfirmService = createMemoryConfirmService({ pending: pendingMemoryConfirms });
```

- [ ] **Step 2: Подключить HTTP router**

Найди где `app.use(...)` другие routers. Добавь:

```typescript
app.use(createMemoryConfirmRouter(pendingMemoryConfirms));
```

- [ ] **Step 3: Прокинуть в Discord deps**

В `deps` объекте что передаётся в `startDiscordBot(...)`:

```typescript
memoryConfirmService,
pendingMemoryConfirms,
// ...
```

Соответственно в `packages/server/src/channels/discord/bot.ts` `Deps` interface и в `interactions.ts` `routeInteraction` — добавь поле `memoryConfirmService?: MemoryConfirmService`.

- [ ] **Step 4: Прокинуть в chat pipeline**

В вызове `runChatRequest(...)` (bot.ts и routes/chat.ts) добавь `pendingMemoryConfirms`.

- [ ] **Step 5: Full typecheck**

```bash
npx tsc --noEmit -p packages/server
```

Все места использования новых deps должны быть покрыты. Если TS жалуется где-то — добавь `pendingMemoryConfirms: new Map()` в тестах или поля в deps объектах.

- [ ] **Step 6: Full suite**

```bash
npx vitest run --root packages/server
```

- [ ] **Step 7: Проверить запуск сервера**

```bash
timeout 5 npm --prefix packages/server run dev 2>&1 | head -50 || true
```

Ожидается что нет ошибок на startup. Цели: `[memory] enabled`, `[discord] bot started`, `Tools loaded: 13+`.

- [ ] **Step 8: Commit**

```bash
git add packages/server/src/index.ts
git commit -m "feat: wire memoryConfirmService + pendingMemoryConfirms in index"
```

---

## Task 11: Full suite + typecheck pass

- [ ] **Step 1: Full vitest**

```bash
npx vitest run --root packages/server
npx vitest run --root packages/tool-memory
```

Все зелёные. Зафиксируй итог (`N passed`).

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit -p packages/server
npx tsc -p packages/shared
npx tsc -p packages/tool-memory
```

- [ ] **Step 3: Commit any touch-ups (если были)**

---

## Task 12: Manual E2E

**Files:** none (live verification)

- [ ] **Step 1: Start dev server**

```bash
npm run dev
```

Проверь логи: `Tools loaded: N+` (должно стать на 2 больше — memory_update + memory_forget_last).

- [ ] **Step 2: Forget with approve**

В Discord DM:
```
убери user.age
```
Ожидается: ephemeral сообщение `🧠 Memory memory_forget\nЗабути: "user.age"` + 3 кнопки. Нажми **✅ Approve**. R2 должен ответить что факт забыт (или что не найден, если нет такого). `/memory` больше не показывает этот ключ.

- [ ] **Step 3: Forget with edit**

Напиши что-то чего сейчас нет: `убери user.nickname`. Диалог появляется. Нажми **✏️ Edit & approve** → modal → меняешь на реально существующий ключ (например `user.name` если есть) → Submit. R2 применяет edited query.

- [ ] **Step 4: Update**

Напиши: `поменяй user.activity на плавание` (предполагая что есть `user.activity`). Диалог:
`🧠 Memory memory_update\nОновити user.activity → "плавание"` + 3 кнопки. Approve. Проверь через `/memory` — обновлено.

- [ ] **Step 5: Forget last**

Сейчас: скажи что-то запоминаемое: `мне 43 года, люблю бегать` → R2 обработает, extractor сохранит user.age=43, user.activity=бег (или подобное). Затем напиши: `это неверно, забудь`. R2 зовёт `memory_forget_last` → диалог показывает preview с конкретными ключами+значениями. Approve → факты stored с forgotten=1.

- [ ] **Step 6: Deny**

Напиши: `забудь всё про меня`. Диалог с forget. Нажми **❌ Deny**. R2 получает error → в ответе пользователю объясняет «подтверждение отклонено».

- [ ] **Step 7: Document findings**

Дописать в `docs/superpowers/specs/2026-04-19-memory-editing-tools-design.md`:

```markdown
## Execution Status (YYYY-MM-DD)

**Automated verification — PASSED.** N/N vitest, typecheck clean.

**Manual Discord E2E — PASSED.**
- Forget via approve: fact removed, /memory confirms.
- Forget via edit: modal prefill works, edited query applied.
- Update: supersede correct, new value active.
- Forget_last: preview shows specific keys, approve marks them forgotten.
- Deny: handler returns user-denied, LLM surfaces это юзеру.
```

Commit:

```bash
git add docs/superpowers/specs/2026-04-19-memory-editing-tools-design.md
git commit -m "docs(spec): mark memory editing E2E verified"
```

---

## Self-Review Notes

Сверено с `docs/superpowers/specs/2026-04-19-memory-editing-tools-design.md`:

- **Goal 1** 3 tools → Task 7.
- **Goal 2** confirm with edit → Task 5 (SSE), Task 6 (backend), Task 7 (tools), Task 9 (Discord UI).
- **Goal 3** source_message_id tracking → Task 1 (schema), Task 2 (helpers), Task 3 (extractor).
- **Goal 4** allow_always через existing permission_rules — НЕ реализовано в плане как отдельный шаг. Причина: `permissionLevel: 'auto'` означает что tools НЕ идут через `permissionService` вовсе. Альтернатива (MVP): always show confirm для memory tools. Follow-up: добавить отдельный rule `memory_forget.allow_always` как property `memoryConfirmService` — deferred.

**Type consistency:** `MemoryConfirmPayload`, `MemoryConfirmResponse`, `PendingMemoryConfirms`, `MemoryConfirmService` — все согласованы через shared types + routes/memory-confirm.

**Known gaps:**
- Allow-always bypass — deferred.
- Web UI endpoint есть (route), но frontend не подтянут — spec flagged как web frozen.
- Modal prefill через pendingEmbedMsgs lookup — небольшой trick (task 9 step 2) — если в процессе реализации станет мешать, альтернатива: сохранять initialValue в отдельном Map<callId, string>.
