# Ollama-Free Memory: Design

**Date:** 2026-05-11
**Status:** Draft (awaiting user review)
**Author:** brainstorm with user
**Scope:** A — minimum work to enable `EMBEDDING_PROVIDER=voyage` so R2 can run fully without local Ollama

## Problem

R2 today depends on Ollama for two things inside the Memory module:

1. **Embeddings** — vectorising text for semantic search over saved facts/entries (`memory_vec_entries`, `memory_vec_facts` SQLite vec tables, `FLOAT[768]`).
2. **Fact extraction** — running an LLM over the user/assistant turn to pull structured `subject.attribute = value` facts.

Outside Memory, R2 already degrades gracefully without Ollama:

- `ai/router.ts` falls back to Claude when Ollama is unreachable.
- `emails/scorer.ts` has an `Ollama → Claude` chain.
- `LOCAL_LLM_MODE=disabled` short-circuits the router straight to Claude.

But Memory has no Claude fallback — `embeddings.ts` only knows how to talk to Ollama, and `extractor.ts` only accepts an `OllamaClient`. So setting `LOCAL_LLM_MODE=disabled` today silently disables Memory.

**Goal:** make Memory work end-to-end without Ollama by adding a Voyage embedding provider and a Claude text provider. After this change, a laptop with no Ollama installed (e.g. travel scenarios) can still run R2 with full Memory functionality.

## Scope

**In scope:**
- Voyage AI embedding client.
- Claude text provider for fact extraction.
- Bootstrap-time provider selection via env vars.
- One-time wipe + reindex when the active embed model changes.
- Schema move from `FLOAT[768]` to `FLOAT[1024]` (fixed standard).

**Out of scope (YAGNI for now):**
- Generalised `Provider` abstraction across the whole codebase. Router/scorer/morningBrief already have their own provider switching — not unifying them here.
- Runtime fallback between providers (e.g. Ollama → Voyage mid-session). One provider per process lifetime — switching dim mid-run would corrupt the index.
- `voyage-3-lite` support (512 dim). Sticking to a single 1024-dim standard.
- Cost cap / token budget tracking for Voyage. Add later if it becomes a real cost.
- Batch embedding endpoint. Reindex loop uses single-call embeds; ~15 sec for typical memory size is acceptable.

## Decisions

### One embedding dimension everywhere: **1024**

All embeddings — whether produced by Ollama or Voyage — are 1024-dim. Schema is fixed `FLOAT[1024]`, not parameterised. Models supported:

| Provider | Model | Native dim |
|---|---|---|
| Ollama | `mxbai-embed-large` (new default) | 1024 |
| Voyage | `voyage-3` (default) | 1024 |
| Voyage | `voyage-3-large` | 1024 |

Existing default `nomic-embed-text` (768) is dropped. User installs `mxbai-embed-large` once: `ollama pull mxbai-embed-large`.

Any other model that returns ≠ 1024 fails loudly at first `embed()` call (existing behaviour, just with new constant).

### One provider per process lifetime

The active provider is resolved at bootstrap from env, then never changes. Switching providers requires a process restart. This avoids dim mismatch in the index during a session.

### Asymmetric document/query embeddings

Voyage's embedding space is asymmetric — same text gets different vectors depending on whether it's being indexed (`input_type: document`) or used as a search query (`input_type: query`). Mixing them hurts recall.

The `EmbeddingsClient` interface exposes both:

```ts
interface EmbeddingsClient {
  readonly dimension: number;
  readonly identity: string;  // "ollama:mxbai-embed-large", "voyage:voyage-3" — used by migration tracker
  embedDocument(text: string, signal?: AbortSignal): Promise<number[]>;
  embedQuery(text: string, signal?: AbortSignal): Promise<number[]>;
}
```

`identity` is a stable string the migration logic compares against `memory_metadata.embed_model`. Format: `<provider>:<model>`.

Ollama implementation maps both methods to the same `/api/embeddings` call (Ollama doesn't distinguish). Voyage implementation sends the corresponding `input_type`.

### Fact extraction via `TextProvider` abstraction

A small new interface lets `extractFacts` accept either Ollama or Claude:

```ts
interface TextProvider {
  chat(params: {
    messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
    model: string;
  }): Promise<{ text: string }>;
}
```

`createOllamaTextProvider(ollamaClient)` is a thin pass-through. `createClaudeTextProvider(anthropic)` wraps `anthropic.messages.create(...)` and returns the first text content block.

The prompt in `extractor.ts` stays unchanged (Ukrainian, JSON output) — Claude handles multilingual structured output well. JSON parser, key normalisation, importance boost, security guards (key regex, value sanitisation, length caps) — all untouched.

## Architecture

```
┌────────────────────────────────────────────────────────┐
│ bootstrap (index.ts)                                   │
│  ├─ pickEmbeddingProvider(env) → EmbeddingsClient      │
│  └─ pickTextProvider(env, ollama, anthropic)           │
│                  → TextProvider                        │
└────────────────────────────────────────────────────────┘
                       │
                       ▼
┌────────────────────────────────────────────────────────┐
│ memory/                                                │
│  embeddings.ts        EmbeddingsClient interface       │
│   ├─ createOllamaEmbeddingsClient (existing, renamed)  │
│   └─ createVoyageEmbeddingsClient (NEW)                │
│                                                        │
│  textProvider.ts (NEW)   TextProvider interface        │
│   ├─ createOllamaTextProvider                          │
│   └─ createClaudeTextProvider                          │
│                                                        │
│  extractor.ts          extractFacts(textProvider, …)   │
│                                                        │
│  service.ts            deps: { embeddings, textProvider } │
│   └─ uses migration.ts on init                         │
│                                                        │
│  migration.ts (NEW)    ensureEmbedModelMatches()       │
│                                                        │
│  db.ts                 FLOAT[1024] + memory_metadata   │
└────────────────────────────────────────────────────────┘
```

Unchanged: `ai/router.ts`, `ai/ollama.ts`, `ai/escalation-check.ts`, `emails/scorer.ts`. The wider system's Ollama-free path (`LOCAL_LLM_MODE=disabled`) already works.

## Environment variables

**New:**

| Name | Values | Default | Required when |
|---|---|---|---|
| `EMBEDDING_PROVIDER` | `auto` / `ollama` / `voyage` | `auto` | — |
| `VOYAGE_API_KEY` | string | — | `EMBEDDING_PROVIDER=voyage` (or `auto` falling back to voyage) |
| `VOYAGE_MODEL` | `voyage-3` / `voyage-3-large` | `voyage-3` | — |
| `MEMORY_TEXT_PROVIDER` | `auto` / `ollama` / `claude` | `auto` | — |
| `MEMORY_EXTRACT_MODEL_CLAUDE` | string | `claude-haiku-4-5-20251001` | text provider is Claude |

**Changed default:**

| Name | Old default | New default |
|---|---|---|
| `MEMORY_EMBED_MODEL` | `nomic-embed-text` | `mxbai-embed-large` |

**Unchanged:** `OLLAMA_HOST`, `MEMORY_ENABLED`, `LOCAL_LLM_MODE`, `ANTHROPIC_API_KEY`, `MEMORY_EXTRACT_MODEL`.

## Provider selection logic (bootstrap)

### Embedding provider

```
if EMBEDDING_PROVIDER == 'ollama':
    require OLLAMA_HOST → createOllamaEmbeddingsClient
    fail loud if missing

if EMBEDDING_PROVIDER == 'voyage':
    require VOYAGE_API_KEY → createVoyageEmbeddingsClient
    fail loud if missing

if EMBEDDING_PROVIDER == 'auto':
    if OLLAMA_HOST is set:
        → createOllamaEmbeddingsClient
    elif VOYAGE_API_KEY is set:
        → createVoyageEmbeddingsClient
    else:
        force MEMORY_ENABLED=false, warn
```

No runtime ping. If Ollama is configured but actually unreachable, the existing circuit breaker handles it on the first `embed()` call — Memory degrades silently as today. User wanting strict API-only mode sets `EMBEDDING_PROVIDER=voyage` explicitly.

### Text provider

```
if MEMORY_TEXT_PROVIDER == 'ollama':
    require ollama client + LOCAL_LLM_MODE != 'disabled'

if MEMORY_TEXT_PROVIDER == 'claude':
    require ANTHROPIC_API_KEY

if MEMORY_TEXT_PROVIDER == 'auto':
    if ollama configured AND LOCAL_LLM_MODE != 'disabled':
        → Ollama
    else:
        → Claude
```

### Sample configs

| Scenario | Env |
|---|---|
| Home, with Ollama | (defaults) — Ollama for both |
| Travel, laptop only | `EMBEDDING_PROVIDER=voyage`, `VOYAGE_API_KEY=…`, `LOCAL_LLM_MODE=disabled` |
| Ollama for chat, Voyage for memory | `EMBEDDING_PROVIDER=voyage`, `VOYAGE_API_KEY=…` (LOCAL_LLM_MODE left default) |
| Memory disabled | `MEMORY_ENABLED=false` |

## Migration: wipe + reindex on model change

### `memory_metadata` table

```sql
CREATE TABLE IF NOT EXISTS memory_metadata (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

Stored keys:
- `embed_model` — e.g. `ollama:mxbai-embed-large`, `voyage:voyage-3`

### Bootstrap migration flow

In `createMemoryService`, before serving any embed/search:

```
ensureEmbedModelMatches(db, embeddings):
  current = `${providerName}:${modelName}`   (from embeddings.identity)
  stored = SELECT value FROM memory_metadata WHERE key='embed_model'

  if stored is null:
      // first run after deploy OR fresh DB
      if memory_vec_entries has rows:
          // existing pre-migration data with old 768-dim model — wipe + reindex
          migrate(current)
      else:
          // truly empty — just record current
          INSERT memory_metadata (embed_model, current)

  elif stored == current:
      // no change, nothing to do

  else:
      // model or provider changed
      migrate(current)

migrate(newModel):
  BEGIN TRANSACTION
    DROP TABLE memory_vec_entries
    DROP TABLE memory_vec_facts
    CREATE virtual table memory_vec_entries (FLOAT[1024])
    CREATE virtual table memory_vec_facts (FLOAT[1024])
    for each row in memory_entries:
        embed via embedDocument → INSERT into memory_vec_entries
    for each row in memory_facts:
        embed via embedDocument → INSERT into memory_vec_facts
    UPDATE memory_metadata SET value=newModel WHERE key='embed_model'
       (or INSERT if missing)
  COMMIT
  on error: ROLLBACK, throw — server fails to start
```

Progress logged every 100 rows: `[memory] reindexing 1247 facts via voyage:voyage-3 (487/1247)...`.

### Failure modes

| Scenario | Behaviour |
|---|---|
| Voyage 429 during reindex | Voyage client retries with exp backoff (1s → 2s → 4s). If all three fail, embed throws, migration rolls back, server fails to start. |
| Voyage 5xx / Ollama timeout | Circuit breaker opens; migration fails, server doesn't start. User reverts env or fixes upstream. |
| Server killed mid-migration | Transaction rolls back. Next start retries from scratch (idempotent). |
| User flips provider back | Reindex runs again. Costs ~$0.005 and ~15 sec for typical memory size. |
| `embeddings.dimension` ≠ schema (1024) | Inserts fail with the existing dim-mismatch error in `embeddings.ts`. Fail loud, not silent. |

## Voyage client

### HTTP

```
POST https://api.voyageai.com/v1/embeddings
Authorization: Bearer <VOYAGE_API_KEY>
Content-Type: application/json

{
  "input": ["<text>"],
  "model": "voyage-3",
  "input_type": "document"   // or "query"
}
```

Response:

```json
{ "data": [{ "embedding": [...], "index": 0 }], "usage": {...} }
```

### Client structure

`memory/voyageEmbeddings.ts`:

```ts
const VOYAGE_DIMENSIONS: Record<string, number> = {
  'voyage-3': 1024,
  'voyage-3-large': 1024,
};

export function createVoyageEmbeddingsClient(config: {
  apiKey: string;
  model: string;
  timeoutMs?: number;
}): EmbeddingsClient {
  const dimension = VOYAGE_DIMENSIONS[config.model];
  if (!dimension) {
    throw new Error(
      `Unsupported VOYAGE_MODEL: ${config.model}. ` +
      `Supported: ${Object.keys(VOYAGE_DIMENSIONS).join(', ')}`,
    );
  }
  // ... circuit breaker + fetch with retry on 429 ...
}
```

### Error handling (per call)

| Scenario | Behaviour |
|---|---|
| 401 Unauthorized | Throw, no retry. Caller (bootstrap) fails loud. |
| 429 Rate limit | Retry with exp backoff: 1s → 2s → 4s. After third, throw. |
| 500 / 503 | Throw → circuit breaker opens (30s cooldown). |
| Network timeout (default 15s) | Throw → circuit breaker. |
| Response missing `data[0].embedding` | Throw — malformed response. |
| `embedding.length !== dimension` | Throw — config bug, shouldn't happen with whitelist. |
| Non-finite values in array | Throw — corrupt response. |
| Caller's `AbortSignal` aborts | Don't open circuit (not a server health signal). |
| `text.length > 8000` chars | Truncate to first 8000 chars (matches existing Ollama client). |

### Circuit breaker

Reuse the same pattern as `createOllamaEmbeddingsClient`: `openedAt` timestamp, `CIRCUIT_OPEN_MS = 30_000`. Either extract to a shared helper or inline-duplicate the ~30 lines (acceptable for scope A).

## Claude text provider

`memory/textProvider.ts`:

```ts
export function createClaudeTextProvider(
  anthropic: Anthropic,
): TextProvider {
  return {
    async chat({ messages, model }) {
      const systemMessages = messages.filter(m => m.role === 'system');
      const nonSystem = messages.filter(m => m.role !== 'system');
      const response = await anthropic.messages.create({
        model,
        max_tokens: 1024,
        system: systemMessages.map(m => m.content).join('\n\n') || undefined,
        messages: nonSystem.map(m => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        })),
      });
      const firstText = response.content.find(b => b.type === 'text');
      return { text: firstText?.text ?? '' };
    },
  };
}
```

### Cost

Haiku 4.5: $0.80 / 1M input tokens, $4 / 1M output tokens. Typical fact extraction call: ~2000 in + ~200 out ≈ **$0.003 per call**. At 50 chats/day, ~$0.15/day. At 1000/month, ~$3/month. Tolerable.

### Error handling (extractFacts)

The existing `try/catch` in `extractor.ts` already swallows any error from `chat()` with `console.warn('[memory] fact extraction failed:', ...)` and returns `[]`. Same graceful degradation pattern — extraction is best-effort, chat never blocks on it.

## File-by-file changes

| File | Change |
|---|---|
| `memory/embeddings.ts` | Add `dimension` getter to `EmbeddingsClient`. Replace `embed()` with `embedDocument()` + `embedQuery()` (Ollama: both map to same call). Update `EXPECTED_EMBED_DIM` 768 → 1024. Rename `createEmbeddingsClient` → `createOllamaEmbeddingsClient`. Add `identity` field (e.g. `'ollama:mxbai-embed-large'`) for migration tracking. |
| `memory/voyageEmbeddings.ts` 🆕 | `createVoyageEmbeddingsClient` with whitelist, circuit breaker, 429 retry, document/query split. |
| `memory/textProvider.ts` 🆕 | `TextProvider` interface, `createOllamaTextProvider`, `createClaudeTextProvider`. |
| `memory/extractor.ts` | Signature change: `ollama: OllamaClient` → `textProvider: TextProvider`. Body unchanged. |
| `memory/service.ts` | Deps type: `ollama` → `textProvider`. Update embed call sites: index-time → `embedDocument`, search-time → `embedQuery`. Call `ensureEmbedModelMatches` on init. |
| `memory/db.ts` | Schema `FLOAT[768]` → `FLOAT[1024]`. Add `memory_metadata` table creation. Make table creation idempotent (it already is for memory_vec_*). |
| `memory/migration.ts` 🆕 | `ensureEmbedModelMatches(db, embeddings)`: reads stored model, compares to current, runs wipe + reindex transaction if changed. |
| `index.ts` | New factories `pickEmbeddingProvider(env)` and `pickTextProvider(env, ollama, anthropic)`. Wire results into `createMemoryService`. Update env validation. |

## Testing strategy

**New test files:**

- `memory/__tests__/voyageEmbeddings.test.ts` — fetch mock with msw or similar. Cases: 200 happy path with `document` vs `query`, 401 throws, 429 retries 3× then throws, 500 opens circuit, dim validation rejects wrong size, abort doesn't open circuit, model whitelist rejects unknown model.
- `memory/__tests__/textProvider.test.ts` — Ollama wrapper passes through, Claude wrapper extracts first text block correctly, system messages merged, empty content returns empty string.
- `memory/__tests__/migration.test.ts` — first-run with empty DB just records identity, first-run with existing 768-dim data triggers reindex, identity match skips, identity change triggers reindex, mid-migration error rolls back, idempotent on retry.

**Updated test files:**

- `memory/__tests__/embeddings.test.ts` — new `dimension` constant, new method names, dim 1024.
- `memory/__tests__/service.test.ts` — mocks switched to `TextProvider`, document/query split verified at call sites.
- `memory/__tests__/db.test.ts` — schema is `FLOAT[1024]`, `memory_metadata` table created.

**Integration check (manual):** boot R2 with `EMBEDDING_PROVIDER=voyage`, `LOCAL_LLM_MODE=disabled`, real Voyage key, fresh DB. Have a chat. Confirm facts get extracted, indexed, recalled by `memory_search`.

## Rollout

1. Ship behind the existing `MEMORY_ENABLED` flag — nothing changes for users with default config except `MEMORY_EMBED_MODEL` default. Migration auto-runs on first start.
2. README: add "Running R2 without Ollama" section listing the two env vars (`EMBEDDING_PROVIDER=voyage`, `VOYAGE_API_KEY`).
3. AGENTS.md / CLAUDE.md: note the new default embed model and migration behaviour.
4. Release note: "First start after upgrade re-indexes Memory under `mxbai-embed-large` (1024 dim). Takes ~15 seconds for typical memory size; transparent."

## Open questions (none blocking)

- Should `EMBEDDING_PROVIDER=auto` prefer Voyage when both are configured? Current decision: prefer Ollama (cheaper, privacy). User wanting strict API-only sets it explicitly. Revisit if the home/travel switch is annoying.
- Worth exposing `voyage-code-3` for code-heavy memory in future? Out of scope here.

## Done definition

- All new files written, tests pass.
- `npm test` green (root, vitest).
- Boot with `EMBEDDING_PROVIDER=voyage`, `LOCAL_LLM_MODE=disabled` on a clean DB → fact extraction + search round-trip works.
- Boot with existing 768-dim DB → migration runs, search works after.
- README updated.
