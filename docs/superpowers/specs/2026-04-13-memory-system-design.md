# R2 Memory System

## Summary

R2 becomes an assistant that remembers. Every chat turn — user message, assistant response, tool results — is indexed into a local vector database. Ollama extracts structured facts about the user from the conversation and stores them with versioning (so "user lived in Kyiv" → "user lives in Odesa" preserves history but knows the current state). Before every LLM call, R2 auto-retrieves the most relevant memories and facts, injecting them into the system prompt. A `memory_search` tool lets R2 dig deeper on demand.

## Goals

- R2 remembers facts about the user across sessions
- Semantic search over full chat history
- Understands state changes over time (user moves, phone changes, preferences evolve)
- No external services — everything runs on the user's machine

## Non-Goals (out of scope)

- UI for browsing/editing memory
- Cross-user memory sharing
- Memory export/import
- Manual fact deletion
- Re-indexing of pre-existing chat history (memory starts fresh at deploy)

## 1. Storage

Uses the existing `data/r2.db` SQLite database with the `sqlite-vec` extension loaded at startup.

### Schema

```sql
CREATE TABLE memory_entries (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,         -- 'user_msg' | 'assistant_msg' | 'tool_result'
  source_id TEXT,             -- chat_messages.message_id or tool call id
  content TEXT NOT NULL,      -- possibly truncated to 2000 chars for tool results
  created_at INTEGER NOT NULL -- unix ms
);

CREATE INDEX idx_memory_entries_kind ON memory_entries(kind, created_at);

CREATE TABLE memory_facts (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL,              -- canonical path: user.location, user.phone, ...
  value TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  superseded_by INTEGER REFERENCES memory_facts(id),
  last_mentioned_at INTEGER NOT NULL
);

CREATE INDEX idx_facts_key_active
  ON memory_facts(key) WHERE superseded_by IS NULL;

-- sqlite-vec virtual table for vector similarity search
CREATE VIRTUAL TABLE memory_vec USING vec0(
  entity_id INTEGER PRIMARY KEY,  -- references memory_entries.id or memory_facts.id
  entity_type TEXT,               -- 'entry' | 'fact'
  embedding FLOAT[768]
);
```

### Versioning logic

When a new fact `{key, value}` arrives:

1. Semantic similarity check against active facts (where `superseded_by IS NULL`)
2. If `similarity > 0.95` with an active fact of the **same key and value** → update only `last_mentioned_at`
3. Otherwise, if an active fact exists with the same `key` but different value → set its `superseded_by` to the new fact id, and insert the new fact
4. Otherwise, insert the new fact fresh

This preserves history (`SELECT * FROM memory_facts WHERE key='user.location' ORDER BY created_at` returns the full timeline) while letting current-state queries be fast (`WHERE superseded_by IS NULL`).

## 2. Write Path

### MemoryService.indexTurn

Called from chat route after the `done` SSE event fires. Does NOT block the user-visible response.

1. Embed `userMessage` via Ollama nomic-embed-text → insert into `memory_entries` (`kind='user_msg'`) + `memory_vec`
2. Embed `assistantMessage` → same, with `kind='assistant_msg'`
3. For each tool result (truncated to 2000 chars):
   - Embed → insert with `kind='tool_result'`
4. Fact extraction:
   - Call Ollama chat with the turn content + extraction prompt
   - Parse JSON array of `{key, value}` objects
   - For each fact, apply versioning logic above
   - Embed fact `"${key}: ${value}"` → insert into `memory_vec`

### Failure modes

- Ollama down → log warning, skip indexing for this turn, no user impact
- One embedding call fails → skip that entry, continue with others
- Invalid JSON from extractor → log warning, skip fact extraction for this turn
- SQLite write failure → single atomic transaction per turn, rolls back cleanly

### Fact extraction prompt

```
Витягни стійкі факти про юзера з наступного діалогу у форматі JSON масиву:
[{"key": "user.location", "value": "Одеса"}, ...]

Використовуй канонічні ключі з цього списку коли можливо:
- user.location — де юзер живе
- user.phone — номер телефону
- user.email — email
- user.preferences.<topic> — уподобання (food, music, work, ...)
- user.name — як юзера звати
- task.deadline.<project> — дедлайни
- project.<name>.status — стан проектів

Правила:
- Витягуй ТІЛЬКИ стійкі факти про юзера, не тимчасові стани
- Не вигадуй факти яких немає в діалозі
- Якщо фактів немає — поверни []

Діалог:
User: <userMessage>
R2: <assistantMessage>

Відповідь (JSON масив):
```

## 3. Read Path

### Channel 1: Auto-retrieval (transparent)

Before every LLM call (Ollama or Claude), router calls `memoryService.buildContextPrefix(userMessage)`:

1. Embed `userMessage` via nomic-embed-text
2. Vector similarity search in `memory_vec`:
   - Top 10 entries with score ≥ 0.6
   - All active facts (`superseded_by IS NULL`) with score ≥ 0.7 (capped at 20)
3. Format as system prompt prefix:

```
=== ПАМ'ЯТЬ R2 ===
Активні факти про юзера:
- user.location: Одеса (оновлено 2026-04-10)
- user.phone: +380...

Релевантні попередні розмови:
[2026-04-05] Юзер: хочу переїхати в Одесу
[2026-04-10] R2: записав замітку про переїзд
...
=== КОНЕЦ ПАМ'ЯТІ ===
```

4. Token budget: 2000 tokens max (truncate by dropping lower-ranked hits)
5. Entry content is truncated to 300 chars per hit
6. Router injects this prefix before the system prompt when calling Ollama/Claude

### Channel 2: memory_search tool

New tool package `packages/tool-memory/` with a single tool:

```typescript
{
  name: 'memory_search',
  description: 'Search R2 memory for relevant facts and past conversations.',
  permissionLevel: 'auto',
  provider: 'all',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Semantic search query' },
      kind: {
        type: 'string',
        enum: ['fact', 'entry', 'all'],
        description: 'Filter by result kind (default: all)',
      },
      limit: { type: 'number', description: 'Max results (default 10, max 50)' },
    },
    required: ['query'],
  },
  command: {
    name: 'память',
    description: 'Пошук у пам\'яті',
    params: [{ name: 'query', required: true, description: 'Що шукати' }],
  },
  ...
}
```

The tool handler calls the same `memoryService.search()` used by auto-retrieval and returns hits as structured data for the LLM to summarize.

## 4. File Structure

### New files

```
packages/server/src/memory/
├── service.ts           # MemoryService interface + createMemoryService factory
├── embeddings.ts        # Ollama nomic-embed-text client
├── extractor.ts         # Fact extraction via Ollama chat
├── db.ts                # SQL queries (insert entry, insert fact with versioning, search)
├── schema.sql           # CREATE TABLE statements loaded at init
└── service.test.ts      # Unit tests with mocked embeddings + fact extractor

packages/tool-memory/
├── package.json
├── tsconfig.json
└── src/index.ts         # memory_search tool definition (createTool factory)
```

### Modified files

```
packages/server/src/db.ts
  — loadExtension('sqlite-vec') at init
  — include memory/schema.sql in CREATE TABLE block

packages/server/src/index.ts
  — import createMemoryService
  — instantiate memoryService with db + ollama client
  — pass memoryService to router and to discoverTools deps

packages/server/src/ai/router.ts
  — before ollama.chat() and claude runLoop, call buildContextPrefix
  — prepend the prefix to the system prompt

packages/server/src/routes/chat.ts
  — after emitting 'done' event, call memoryService.indexTurn(...)
  — pass accumulated assistantText, toolCalls (as tool results), last user message
  — wrap in try/catch so indexing never breaks the response

packages/server/src/tools/base.ts
  — add memoryService to ToolDeps interface (for tool-memory to use)

package.json
  — add "sqlite-vec": "^x.y.z" as dependency
```

## 5. Interfaces

```typescript
// packages/server/src/memory/service.ts

export interface MemoryHit {
  text: string;
  kind: 'fact' | 'user_msg' | 'assistant_msg' | 'tool_result';
  score: number;
  timestamp: number;
}

export interface ExtractedFact {
  key: string;
  value: string;
}

export interface MemoryService {
  indexTurn(params: {
    userMessage: string;
    assistantMessage: string;
    toolResults: Array<{ id: string; name: string; content: string }>;
    timestamp: number;
  }): Promise<void>;

  search(params: {
    query: string;
    kind?: 'fact' | 'entry' | 'all';
    limit?: number;
  }): Promise<MemoryHit[]>;

  getActiveFacts(): Promise<Array<{ key: string; value: string; lastMentionedAt: number }>>;

  buildContextPrefix(userMessage: string): Promise<string>;
}

export function createMemoryService(deps: {
  db: Database;
  ollama: OllamaClient;
  embeddingModel?: string;     // default 'nomic-embed-text'
  extractorModel?: string;     // default 'qwen2.5:7b'
  maxContextTokens?: number;   // default 2000
}): MemoryService;
```

## 6. Configuration

New env vars:

```
# Memory system
MEMORY_EMBED_MODEL=nomic-embed-text      # Ollama model for embeddings
MEMORY_EXTRACT_MODEL=qwen2.5:7b          # Ollama model for fact extraction
MEMORY_MAX_CONTEXT_TOKENS=2000           # token budget for auto-retrieval prefix
MEMORY_ENABLED=true                      # kill switch
```

If `MEMORY_ENABLED=false`, indexTurn and buildContextPrefix become no-ops.

## 7. Testing

- `service.test.ts` — mock embeddings + extractor, verify indexing flow, versioning logic, search ranking, context budget enforcement
- `extractor.test.ts` — mock Ollama chat responses, verify JSON parsing and key whitelist
- `db.test.ts` — integration test with real SQLite, verify schema, indexes, `superseded_by` updates, similarity dedup
- Integration test in `packages/server` — end-to-end: send chat → indexTurn runs → next chat auto-retrieves

## 8. Edge Cases

- **Ollama unreachable:** `indexTurn` logs warning and returns. User response already delivered. Memory catches up on next turn.
- **Tool result > 10KB:** Truncate content to 2000 chars before embedding (prevents BLOB bloat from code_task diffs, web_search dumps)
- **Invalid JSON from extractor:** log warning, skip fact extraction (entries still indexed)
- **Key not in whitelist:** accept anyway — whitelist is a hint for the model, not enforcement
- **Duplicate key within same turn:** treat as idempotent update (`last_mentioned_at`)
- **Context budget overflow:** drop lower-ranked hits until under 2000 tokens
- **First run with no memory:** `buildContextPrefix` returns empty string, LLM call unaffected
- **Pre-existing chat_messages:** NOT re-indexed automatically; memory starts empty on first deploy

## 9. Performance

- Per turn: 2 entry embeddings + 1 extractor LLM call + ~2-3 fact embeddings = ~500-800ms background
- Per LLM call: 1 query embedding + 1 vector search + 1 SQL facts query = ~100ms added latency
- Storage: ~3MB per 1000 entries (768 dim × float32 + metadata)

## 10. Rollout Path

1. Install sqlite-vec + pull nomic-embed-text model
2. Deploy with `MEMORY_ENABLED=true`
3. Memory starts empty, populates as user chats
4. No migration of old chat_messages (they remain browsable via message history, just not semantically searchable)
5. If problems arise, flip `MEMORY_ENABLED=false` — zero-impact disable
