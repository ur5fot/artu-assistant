# Ollama-Free Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Memory module work fully without Ollama by adding a Voyage embedding provider and a Claude text provider, with a one-time wipe + reindex when the active embed model changes.

**Architecture:** Bottom-up changes inside `packages/server/src/memory/*` plus bootstrap wiring in `index.ts`. The wider system (router, scorer, morningBrief) is untouched. Tasks 1–5 land safely without changing the embedding dimension; Task 6 bumps the standard to 1024 dim atomically with migration logic. Each task ends green and commitable.

**Tech Stack:** TypeScript, vitest, better-sqlite3 + sqlite-vec (`memory_vec_*` virtual tables), Ollama HTTP API, Voyage AI HTTP API, Anthropic SDK (`@anthropic-ai/sdk`).

**Spec:** [`docs/superpowers/specs/2026-05-11-ollama-free-memory-design.md`](../specs/2026-05-11-ollama-free-memory-design.md)

**Test runner:** `npx vitest run <path>` for single file, `npm test` for all.

---

## File Structure

**Created:**
- `packages/server/src/memory/voyageEmbeddings.ts` — Voyage HTTP client implementing `EmbeddingsClient`
- `packages/server/src/memory/textProvider.ts` — `TextProvider` interface + Ollama and Claude wraps
- `packages/server/src/memory/migration.ts` — `ensureEmbedModelMatches(db, embeddings)` — wipe + reindex
- `packages/server/src/memory/__tests__/voyageEmbeddings.test.ts`
- `packages/server/src/memory/__tests__/textProvider.test.ts`
- `packages/server/src/memory/__tests__/migration.test.ts`

**Modified:**
- `packages/server/src/memory/embeddings.ts` — extend `EmbeddingsClient` interface (add `dimension`, `identity`, `embedDocument`, `embedQuery`), rename `createEmbeddingsClient` → `createOllamaEmbeddingsClient`
- `packages/server/src/memory/extractor.ts` — `extractFacts` signature: `OllamaClient` → `TextProvider`
- `packages/server/src/memory/service.ts` — deps swap (`ollama` → `textProvider`), use `embedDocument`/`embedQuery`, call migration on init
- `packages/server/src/db.ts` — schema `FLOAT[768]` → `FLOAT[1024]`, add `memory_metadata` table
- `packages/server/src/index.ts` — `pickEmbeddingProvider`, `pickTextProvider` factories, wire results into `createMemoryService`
- `packages/server/src/memory/__tests__/embeddings.test.ts` — update for new interface
- `packages/server/src/memory/__tests__/service.test.ts` — switch mocks to `textProvider`, verify `embedDocument`/`embedQuery` split
- `packages/server/src/memory/__tests__/schema.test.ts` — schema is 1024
- `README.md` — add "Running R2 without Ollama" section

---

### Task 1: Extend `EmbeddingsClient` interface

Add `dimension`, `identity`, `embedDocument`, `embedQuery` to the interface. Rename `createEmbeddingsClient` → `createOllamaEmbeddingsClient`. Keep dimension=768 for now (no schema change yet). All call sites in `service.ts` switch to `embedDocument`/`embedQuery`. Tests updated.

**Files:**
- Modify: `packages/server/src/memory/embeddings.ts`
- Modify: `packages/server/src/memory/service.ts:148-150,162,204,238,268,311,351,414,488`
- Modify: `packages/server/src/index.ts:33-34,234`
- Modify: `packages/server/src/memory/__tests__/embeddings.test.ts`
- Modify: `packages/server/src/memory/__tests__/service.test.ts`

- [x] **Step 1: Read current embeddings test**

Run: `cat packages/server/src/memory/__tests__/embeddings.test.ts`
Note shape — uses `vi.stubGlobal('fetch', mockFetch)`, `createEmbeddingsClient` factory, calls `.embed()`.

- [x] **Step 2: Rewrite `embeddings.ts` with extended interface**

Replace the contents of `packages/server/src/memory/embeddings.ts` with:

```ts
export interface EmbeddingsClient {
  readonly dimension: number;
  readonly identity: string;
  embedDocument(text: string, signal?: AbortSignal): Promise<number[]>;
  embedQuery(text: string, signal?: AbortSignal): Promise<number[]>;
}

interface OllamaEmbeddingsClientConfig {
  url: string;
  model: string;
  timeoutMs?: number;
}

const EMBED_INPUT_MAX_CHARS = 8000;

// Must match the FLOAT[<dim>] in src/db.ts memory_vec_* virtual tables. If a
// user points MEMORY_EMBED_MODEL at a model with a different output dimension,
// inserts fail deep inside sqlite-vec with an opaque error. Fail loudly instead.
const EXPECTED_EMBED_DIM = 768;

// Circuit breaker: if Ollama is unreachable, stop hammering it. After a failure
// we refuse new embed calls for a cool-down window.
const CIRCUIT_OPEN_MS = 30_000;

export function createOllamaEmbeddingsClient(config: OllamaEmbeddingsClientConfig): EmbeddingsClient {
  const timeoutMs = config.timeoutMs ?? 15000;
  let openedAt = 0;

  async function callOllama(text: string, signal?: AbortSignal): Promise<number[]> {
    if (openedAt && Date.now() - openedAt < CIRCUIT_OPEN_MS) {
      throw new Error('Embeddings circuit open (recent failure)');
    }
    openedAt = 0;
    const input = text.length > EMBED_INPUT_MAX_CHARS ? text.slice(0, EMBED_INPUT_MAX_CHARS) : text;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    try {
      const res = await fetch(`${config.url}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: config.model, prompt: input }),
        signal: combinedSignal,
      });
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        throw new Error(`Embeddings error ${res.status}`);
      }
      const data = (await res.json()) as { embedding?: number[] };
      if (!Array.isArray(data.embedding)) {
        throw new Error('Embeddings response missing embedding');
      }
      if (data.embedding.length !== EXPECTED_EMBED_DIM) {
        throw new Error(
          `Embeddings dimension mismatch: model '${config.model}' returned ${data.embedding.length}, expected ${EXPECTED_EMBED_DIM}.`,
        );
      }
      for (const n of data.embedding) {
        if (typeof n !== 'number' || !Number.isFinite(n)) {
          throw new Error('Embeddings response contains non-finite values');
        }
      }
      return data.embedding;
    } catch (err) {
      const abortedByCaller = signal?.aborted === true;
      if (!abortedByCaller) {
        openedAt = Date.now();
      }
      throw err;
    }
  }

  return {
    dimension: EXPECTED_EMBED_DIM,
    identity: `ollama:${config.model}`,
    embedDocument: callOllama,
    embedQuery: callOllama,
  };
}
```

- [x] **Step 3: Run unit tests, expect them to break**

Run: `npx vitest run packages/server/src/memory/__tests__/embeddings.test.ts`
Expected: FAIL — old test imports `createEmbeddingsClient`, calls `.embed()`. We need to update them.

- [x] **Step 4: Update `embeddings.test.ts`**

Replace the contents of `packages/server/src/memory/__tests__/embeddings.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createOllamaEmbeddingsClient } from '../embeddings.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('OllamaEmbeddingsClient', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('exposes dimension and identity', () => {
    const client = createOllamaEmbeddingsClient({ url: 'http://localhost:11434', model: 'nomic-embed-text' });
    expect(client.dimension).toBe(768);
    expect(client.identity).toBe('ollama:nomic-embed-text');
  });

  it('embedDocument calls Ollama /api/embeddings and returns vector', async () => {
    const fakeVec = Array.from({ length: 768 }, (_, i) => i / 768);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ embedding: fakeVec }),
    });

    const client = createOllamaEmbeddingsClient({ url: 'http://localhost:11434', model: 'nomic-embed-text' });
    const result = await client.embedDocument('hello');

    expect(result).toHaveLength(768);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:11434/api/embeddings',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ model: 'nomic-embed-text', prompt: 'hello' }),
      }),
    );
  });

  it('embedQuery uses the same Ollama call (no input_type for Ollama)', async () => {
    const fakeVec = Array.from({ length: 768 }, () => 0);
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ embedding: fakeVec }) });

    const client = createOllamaEmbeddingsClient({ url: 'http://localhost:11434', model: 'nomic-embed-text' });
    await client.embedQuery('query');

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:11434/api/embeddings',
      expect.objectContaining({
        body: JSON.stringify({ model: 'nomic-embed-text', prompt: 'query' }),
      }),
    );
  });

  it('throws on HTTP error', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
    const client = createOllamaEmbeddingsClient({ url: 'http://localhost:11434', model: 'nomic-embed-text' });
    await expect(client.embedDocument('hello')).rejects.toThrow('Embeddings error 500');
  });

  it('throws on invalid response shape', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    const client = createOllamaEmbeddingsClient({ url: 'http://localhost:11434', model: 'nomic-embed-text' });
    await expect(client.embedDocument('hello')).rejects.toThrow('missing embedding');
  });

  it('throws on dimension mismatch', async () => {
    const wrongDim = Array.from({ length: 1024 }, () => 0);
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ embedding: wrongDim }) });
    const client = createOllamaEmbeddingsClient({ url: 'http://localhost:11434', model: 'nomic-embed-text' });
    await expect(client.embedDocument('hello')).rejects.toThrow('dimension mismatch');
  });
});
```

- [x] **Step 5: Run embeddings tests, expect pass**

Run: `npx vitest run packages/server/src/memory/__tests__/embeddings.test.ts`
Expected: PASS (5 tests).

- [x] **Step 6: Update `service.ts` to use new methods**

Edit `packages/server/src/memory/service.ts`. Replace the `safeEmbed` helper and all call sites:

Replace the `safeEmbed` function (around line 148):

```ts
  async function safeEmbedDocument(text: string, signal?: AbortSignal): Promise<number[] | null> {
    try {
      return await embeddings.embedDocument(text, signal);
    } catch (err) {
      console.warn('[memory] embedDocument failed:', err instanceof Error ? err.message : err);
      return null;
    }
  }

  async function safeEmbedQuery(text: string, signal?: AbortSignal): Promise<number[] | null> {
    try {
      return await embeddings.embedQuery(text, signal);
    } catch (err) {
      console.warn('[memory] embedQuery failed:', err instanceof Error ? err.message : err);
      return null;
    }
  }
```

Now find each call site of `safeEmbed(...)` and replace:

| Line | Context | Replace with |
|---|---|---|
| ~162 (`indexOne`) | indexing user/assistant turn | `safeEmbedDocument(content)` |
| ~204 (in `runIndexTurn`) | fact text indexing | `safeEmbedDocument(factText)` |
| ~238 (`search`) | search query | `safeEmbedQuery(query)` |
| ~268 (`saveFact`) | fact text indexing | `safeEmbedDocument(factText)` |
| ~311 (`forgetFact`) | semantic search for forget | `safeEmbedQuery(query)` |
| ~351 (`updateFact`) | fact text indexing | `safeEmbedDocument(factText)` |
| ~414 (`buildContextPrefix`) | user message → search | `safeEmbedQuery(userMessage, signal)` |

Search for `safeEmbed(` in the file and review each occurrence to pick the right variant (index-time → Document, search-time → Query).

- [x] **Step 7: Update `index.ts` bootstrap import**

Edit `packages/server/src/index.ts`. Change line 33:

```ts
import { createOllamaEmbeddingsClient } from './memory/embeddings.js';
```

And the call site (~line 234):

```ts
  const embeddings = createOllamaEmbeddingsClient({
    url: process.env.OLLAMA_URL || 'http://localhost:11434',
    model: process.env.MEMORY_EMBED_MODEL || 'nomic-embed-text',
  });
```

- [x] **Step 8: Update `service.test.ts` mock to provide new methods**

Open `packages/server/src/memory/__tests__/service.test.ts`. Find every place that constructs a mock `embeddings`. The current shape is `{ embed: vi.fn().mockResolvedValue([...]) }`. Replace with:

```ts
function makeMockEmbeddings(dim = 768, identity = 'ollama:nomic-embed-text'): EmbeddingsClient {
  return {
    dimension: dim,
    identity,
    embedDocument: vi.fn().mockResolvedValue(Array.from({ length: dim }, () => 0)),
    embedQuery: vi.fn().mockResolvedValue(Array.from({ length: dim }, () => 0)),
  };
}
```

And update all `embeddings: { embed: ... }` constructors to use this helper. Add `import type { EmbeddingsClient } from '../embeddings.js';` to the top of the test file if not already there.

- [x] **Step 9: Run full memory test suite, expect pass**

Run: `npx vitest run packages/server/src/memory/__tests__/`
Expected: ALL PASS. If `service.test.ts` still expects `.embed()`, fix those specific assertions.

- [x] **Step 10: Run full project tests**

Run: `npm test`
Expected: ALL PASS. No regressions outside memory module.

- [x] **Step 11: Commit**

```bash
git add packages/server/src/memory/embeddings.ts \
        packages/server/src/memory/service.ts \
        packages/server/src/memory/__tests__/embeddings.test.ts \
        packages/server/src/memory/__tests__/service.test.ts \
        packages/server/src/index.ts
git commit -m "refactor(memory): extend EmbeddingsClient with dimension/identity, document/query split"
```

---

### Task 2: `memory_metadata` table + migration scaffolding

Add a key/value `memory_metadata` table. Add `memory/migration.ts` with `ensureEmbedModelMatches(db, embeddings)` that records identity on first run and performs wipe + reindex on identity mismatch. Wire it into `createMemoryService`. No dim change yet — on first run with existing 768-dim data, identity becomes `ollama:nomic-embed-text` and no wipe happens.

**Files:**
- Modify: `packages/server/src/db.ts` (add `memory_metadata` CREATE)
- Create: `packages/server/src/memory/migration.ts`
- Create: `packages/server/src/memory/__tests__/migration.test.ts`
- Modify: `packages/server/src/memory/service.ts` (call `ensureEmbedModelMatches` in init)

- [x] **Step 1: Add `memory_metadata` table to `db.ts`**

In `packages/server/src/db.ts`, after the existing `memory_facts` index creation (around line 67), add:

```ts
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
```

- [x] **Step 2: Write failing migration test (first-run empty DB)**

Create `packages/server/src/memory/__tests__/migration.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { ensureEmbedModelMatches } from '../migration.js';
import type { EmbeddingsClient } from '../embeddings.js';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  sqliteVec.load(db);
  db.exec(`
    CREATE TABLE memory_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL, source_id TEXT, content TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE memory_facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL, value TEXT NOT NULL, created_at INTEGER NOT NULL,
      superseded_by INTEGER REFERENCES memory_facts(id),
      last_mentioned_at INTEGER NOT NULL,
      importance INTEGER NOT NULL DEFAULT 1,
      forgotten INTEGER NOT NULL DEFAULT 0,
      source_message_id TEXT
    );
    CREATE TABLE memory_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE VIRTUAL TABLE memory_vec_entries USING vec0(
      entity_id INTEGER PRIMARY KEY, embedding FLOAT[768] distance_metric=cosine
    );
    CREATE VIRTUAL TABLE memory_vec_facts USING vec0(
      entity_id INTEGER PRIMARY KEY, embedding FLOAT[768] distance_metric=cosine
    );
  `);
  return db;
}

function makeEmbeddings(identity: string, dim = 768): EmbeddingsClient {
  return {
    dimension: dim,
    identity,
    embedDocument: vi.fn().mockResolvedValue(Array.from({ length: dim }, () => 0)),
    embedQuery: vi.fn().mockResolvedValue(Array.from({ length: dim }, () => 0)),
  };
}

describe('ensureEmbedModelMatches', () => {
  it('on empty DB with no stored identity, records current identity, no embed calls', async () => {
    const db = makeDb();
    const embeddings = makeEmbeddings('ollama:nomic-embed-text');

    await ensureEmbedModelMatches(db, embeddings);

    const row = db.prepare('SELECT value FROM memory_metadata WHERE key=?').get('embed_model') as { value: string };
    expect(row.value).toBe('ollama:nomic-embed-text');
    expect(embeddings.embedDocument).not.toHaveBeenCalled();
  });

  it('on subsequent boot with same identity, is a no-op', async () => {
    const db = makeDb();
    db.prepare('INSERT INTO memory_metadata (key, value) VALUES (?, ?)').run(
      'embed_model',
      'ollama:nomic-embed-text',
    );
    const embeddings = makeEmbeddings('ollama:nomic-embed-text');

    await ensureEmbedModelMatches(db, embeddings);

    expect(embeddings.embedDocument).not.toHaveBeenCalled();
  });
});
```

- [x] **Step 3: Run migration test, expect fail (file does not exist)**

Run: `npx vitest run packages/server/src/memory/__tests__/migration.test.ts`
Expected: FAIL — `Cannot find module '../migration.js'`.

- [x] **Step 4: Create `migration.ts` with `ensureEmbedModelMatches`**

Create `packages/server/src/memory/migration.ts`:

```ts
import type Database from 'better-sqlite3';
import type { EmbeddingsClient } from './embeddings.js';

const KEY = 'embed_model';

function readStoredIdentity(db: Database.Database): string | null {
  const row = db.prepare('SELECT value FROM memory_metadata WHERE key=?').get(KEY) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

function writeStoredIdentity(db: Database.Database, identity: string): void {
  db.prepare(
    `INSERT INTO memory_metadata (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
  ).run(KEY, identity);
}

function toBuffer(vec: number[]): Buffer {
  return Buffer.from(new Float32Array(vec).buffer);
}

interface ReindexParams {
  db: Database.Database;
  embeddings: EmbeddingsClient;
  newIdentity: string;
}

async function wipeAndReindex({ db, embeddings, newIdentity }: ReindexParams): Promise<void> {
  const entries = db
    .prepare('SELECT id, content FROM memory_entries')
    .all() as Array<{ id: number; content: string }>;
  const facts = db
    .prepare(
      `SELECT id, key, value FROM memory_facts WHERE superseded_by IS NULL AND forgotten = 0`,
    )
    .all() as Array<{ id: number; key: string; value: string }>;

  console.log(
    `[memory] reindexing under ${newIdentity}: ${entries.length} entries, ${facts.length} facts`,
  );

  // Embeddings are awaited up-front so the schema rebuild + INSERTs run in a
  // single synchronous transaction (better-sqlite3 transactions must stay
  // synchronous — interleaved awaits would commit a half-rebuilt index).
  const entryVecs: Array<{ id: number; vec: number[] }> = [];
  for (const e of entries) {
    entryVecs.push({ id: e.id, vec: await embeddings.embedDocument(e.content) });
  }
  const factVecs: Array<{ id: number; vec: number[] }> = [];
  for (const f of facts) {
    factVecs.push({ id: f.id, vec: await embeddings.embedDocument(`${f.key}: ${f.value}`) });
  }

  const tx = db.transaction(() => {
    db.exec('DROP TABLE IF EXISTS memory_vec_entries');
    db.exec('DROP TABLE IF EXISTS memory_vec_facts');
    db.exec(
      `CREATE VIRTUAL TABLE memory_vec_entries USING vec0(
        entity_id INTEGER PRIMARY KEY,
        embedding FLOAT[${embeddings.dimension}] distance_metric=cosine
      )`,
    );
    db.exec(
      `CREATE VIRTUAL TABLE memory_vec_facts USING vec0(
        entity_id INTEGER PRIMARY KEY,
        embedding FLOAT[${embeddings.dimension}] distance_metric=cosine
      )`,
    );

    const insE = db.prepare('INSERT INTO memory_vec_entries (entity_id, embedding) VALUES (?, ?)');
    for (const { id, vec } of entryVecs) {
      insE.run(BigInt(id), toBuffer(vec));
    }
    const insF = db.prepare('INSERT INTO memory_vec_facts (entity_id, embedding) VALUES (?, ?)');
    for (const { id, vec } of factVecs) {
      insF.run(BigInt(id), toBuffer(vec));
    }

    writeStoredIdentity(db, newIdentity);
  });
  tx();
}

export async function ensureEmbedModelMatches(
  db: Database.Database,
  embeddings: EmbeddingsClient,
): Promise<void> {
  const stored = readStoredIdentity(db);
  const current = embeddings.identity;

  if (stored === current) return;

  if (stored === null) {
    // First boot under this code version. If the vec tables are non-empty, this
    // is an existing DB that was indexed under whatever model was active before
    // the metadata key was introduced — reindex under the current provider.
    const row = db
      .prepare('SELECT COUNT(*) AS c FROM memory_vec_entries')
      .get() as { c: number };
    const factRow = db
      .prepare('SELECT COUNT(*) AS c FROM memory_vec_facts')
      .get() as { c: number };
    if (row.c === 0 && factRow.c === 0) {
      writeStoredIdentity(db, current);
      return;
    }
  }

  await wipeAndReindex({ db, embeddings, newIdentity: current });
}
```

- [x] **Step 5: Run migration tests, expect pass (2 cases)**

Run: `npx vitest run packages/server/src/memory/__tests__/migration.test.ts`
Expected: PASS (2 tests).

- [x] **Step 6: Add identity-mismatch test (triggers wipe + reindex)**

Append to `migration.test.ts`:

```ts
  it('on identity change with existing data, wipes vec tables and reindexes', async () => {
    const db = makeDb();
    // Seed: one entry + one fact with old embeddings present
    const buf = Buffer.from(new Float32Array(Array.from({ length: 768 }, () => 0.1)).buffer);
    db.prepare(
      `INSERT INTO memory_entries (kind, source_id, content, created_at) VALUES (?, ?, ?, ?)`,
    ).run('user_msg', null, 'hello world', 1000);
    db.prepare('INSERT INTO memory_vec_entries (entity_id, embedding) VALUES (?, ?)').run(
      BigInt(1),
      buf,
    );
    db.prepare(
      `INSERT INTO memory_facts (key, value, created_at, last_mentioned_at, importance, forgotten)
       VALUES (?, ?, ?, ?, ?, 0)`,
    ).run('user.location', 'Одеса', 1000, 1000, 1);
    db.prepare('INSERT INTO memory_vec_facts (entity_id, embedding) VALUES (?, ?)').run(
      BigInt(1),
      buf,
    );
    db.prepare('INSERT INTO memory_metadata (key, value) VALUES (?, ?)').run(
      'embed_model',
      'ollama:nomic-embed-text',
    );

    const embeddings = makeEmbeddings('voyage:voyage-3', 1024);
    await ensureEmbedModelMatches(db, embeddings);

    // Both entries should be re-embedded
    expect(embeddings.embedDocument).toHaveBeenCalledTimes(2);
    expect(embeddings.embedDocument).toHaveBeenCalledWith('hello world');
    expect(embeddings.embedDocument).toHaveBeenCalledWith('user.location: Одеса');

    // Metadata should be updated
    const row = db.prepare('SELECT value FROM memory_metadata WHERE key=?').get('embed_model') as { value: string };
    expect(row.value).toBe('voyage:voyage-3');

    // Schema dim verified by inserting a 1024-dim vector through the new index
    expect(db.prepare('SELECT COUNT(*) AS c FROM memory_vec_entries').get()).toEqual({ c: 1 });
    expect(db.prepare('SELECT COUNT(*) AS c FROM memory_vec_facts').get()).toEqual({ c: 1 });
  });

  it('migration is idempotent: re-running after success is a no-op', async () => {
    const db = makeDb();
    const embeddings = makeEmbeddings('ollama:nomic-embed-text');
    await ensureEmbedModelMatches(db, embeddings);
    (embeddings.embedDocument as any).mockClear();

    await ensureEmbedModelMatches(db, embeddings);
    expect(embeddings.embedDocument).not.toHaveBeenCalled();
  });
```

- [x] **Step 7: Run all migration tests, expect pass (4 tests)**

Run: `npx vitest run packages/server/src/memory/__tests__/migration.test.ts`
Expected: PASS (4 tests).

- [x] **Step 8: Call migration from `index.ts` before `createMemoryService`**

Migration must run before the service is constructed (so the schema is correct when service methods start firing). Easiest: call it synchronously in the existing bootstrap.

Edit `packages/server/src/index.ts`. Add import (after existing memory imports, ~line 34):

```ts
import { ensureEmbedModelMatches } from './memory/migration.js';
```

Replace the existing memory bootstrap block (~lines 232-249). Find:

```ts
let memoryService: MemoryService | null = null;
if (memoryEnabled && ollamaForMemory) {
  const embeddings = createOllamaEmbeddingsClient({
    url: process.env.OLLAMA_URL || 'http://localhost:11434',
    model: process.env.MEMORY_EMBED_MODEL || 'nomic-embed-text',
  });
  ...
```

Replace with:

```ts
let memoryService: MemoryService | null = null;
if (memoryEnabled && ollamaForMemory) {
  const embeddings = createOllamaEmbeddingsClient({
    url: process.env.OLLAMA_URL || 'http://localhost:11434',
    model: process.env.MEMORY_EMBED_MODEL || 'nomic-embed-text',
  });

  // Run migration before constructing the service so the schema matches the
  // active provider. On first boot with a fresh DB this just records identity;
  // on identity change it wipes and re-embeds.
  try {
    await ensureEmbedModelMatches(getDb(), embeddings);
  } catch (err) {
    console.error('[memory] migration failed, disabling memory:', err instanceof Error ? err.message : err);
    memoryService = null;
  }

  if (memoryService === null) {
    // migration failed above
  } else {
    const parsedMaxTokens = Number(process.env.MEMORY_MAX_CONTEXT_TOKENS);
    const maxContextTokens = Number.isFinite(parsedMaxTokens) && parsedMaxTokens > 0 ? parsedMaxTokens : 2000;
    memoryService = createMemoryService({
      db: getDb(),
      embeddings,
      ollama: ollamaForMemory,
      extractorModel: process.env.MEMORY_EXTRACT_MODEL || 'qwen2.5:7b',
      maxContextTokens,
    });
    console.log('[memory] enabled with', embeddings.identity);
  }
} else {
  console.log('[memory] disabled');
}
```

Note: the `memoryService === null` gate is awkward — `memoryService` is already `null` initially, so the try-catch must distinguish "migration succeeded" from "migration failed". Cleaner version:

```ts
let memoryService: MemoryService | null = null;
if (memoryEnabled && ollamaForMemory) {
  const embeddings = createOllamaEmbeddingsClient({
    url: process.env.OLLAMA_URL || 'http://localhost:11434',
    model: process.env.MEMORY_EMBED_MODEL || 'nomic-embed-text',
  });

  let migrationOk = false;
  try {
    await ensureEmbedModelMatches(getDb(), embeddings);
    migrationOk = true;
  } catch (err) {
    console.error('[memory] migration failed, disabling memory:', err instanceof Error ? err.message : err);
  }

  if (migrationOk) {
    const parsedMaxTokens = Number(process.env.MEMORY_MAX_CONTEXT_TOKENS);
    const maxContextTokens = Number.isFinite(parsedMaxTokens) && parsedMaxTokens > 0 ? parsedMaxTokens : 2000;
    memoryService = createMemoryService({
      db: getDb(),
      embeddings,
      ollama: ollamaForMemory,
      extractorModel: process.env.MEMORY_EXTRACT_MODEL || 'qwen2.5:7b',
      maxContextTokens,
    });
    console.log('[memory] enabled with', embeddings.identity);
  }
} else {
  console.log('[memory] disabled');
}
```

This requires `index.ts` to support top-level `await`. The current file is an ES module so top-level await should work without changes. If TypeScript complains about `await` outside an async context, verify `tsconfig.base.json` has `"module": "esnext"` or similar; if not, wrap the whole bootstrap in an `async function main() { ... } main();` IIFE.

- [x] **Step 9: Run service tests + migration tests**

Run: `npx vitest run packages/server/src/memory/__tests__/`
Expected: PASS. `service.test.ts` should be unchanged — `createMemoryService` is still synchronous; migration is the caller's responsibility now.

- [x] **Step 10: Commit**

```bash
git add packages/server/src/db.ts \
        packages/server/src/memory/migration.ts \
        packages/server/src/memory/service.ts \
        packages/server/src/memory/__tests__/migration.test.ts \
        packages/server/src/memory/__tests__/service.test.ts
git commit -m "feat(memory): add migration scaffolding with wipe+reindex on identity change"
```

---

### Task 3: `TextProvider` interface + Ollama and Claude wraps

Create the `TextProvider` abstraction. `extractFacts` is ported in Task 4.

**Files:**
- Create: `packages/server/src/memory/textProvider.ts`
- Create: `packages/server/src/memory/__tests__/textProvider.test.ts`

- [x] **Step 1: Look up existing OllamaClient.chat shape**

Run: `grep -n "interface OllamaClient\|chat:" packages/server/src/ai/ollama.ts | head -10`
Note: confirm `chat({ messages, model }) → Promise<{ text: string }>` shape so we can mirror it.

- [x] **Step 2: Write failing test for `createOllamaTextProvider`**

Create `packages/server/src/memory/__tests__/textProvider.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { createOllamaTextProvider, createClaudeTextProvider } from '../textProvider.js';

describe('createOllamaTextProvider', () => {
  it('passes through to ollama.chat and returns its text', async () => {
    const ollama = { chat: vi.fn().mockResolvedValue({ text: 'hello' }) } as any;
    const provider = createOllamaTextProvider(ollama);

    const result = await provider.chat({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'qwen2.5:7b',
    });

    expect(result.text).toBe('hello');
    expect(ollama.chat).toHaveBeenCalledWith({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'qwen2.5:7b',
    });
  });
});

describe('createClaudeTextProvider', () => {
  it('calls anthropic.messages.create and returns first text block', async () => {
    const anthropic = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: 'text', text: 'claude response' }],
        }),
      },
    } as any;

    const provider = createClaudeTextProvider(anthropic);
    const result = await provider.chat({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'claude-haiku-4-5-20251001',
    });

    expect(result.text).toBe('claude response');
    expect(anthropic.messages.create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'hi' }],
        system: undefined,
      }),
    );
  });

  it('merges system messages into the system parameter', async () => {
    const anthropic = {
      messages: {
        create: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] }),
      },
    } as any;

    const provider = createClaudeTextProvider(anthropic);
    await provider.chat({
      messages: [
        { role: 'system', content: 'be terse' },
        { role: 'user', content: 'hi' },
      ],
      model: 'claude-haiku-4-5-20251001',
    });

    expect(anthropic.messages.create).toHaveBeenCalledWith(
      expect.objectContaining({
        system: 'be terse',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    );
  });

  it('returns empty string when no text content block is present', async () => {
    const anthropic = {
      messages: {
        create: vi.fn().mockResolvedValue({ content: [{ type: 'tool_use', id: 'x' }] }),
      },
    } as any;

    const provider = createClaudeTextProvider(anthropic);
    const result = await provider.chat({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'claude-haiku-4-5-20251001',
    });

    expect(result.text).toBe('');
  });
});
```

- [x] **Step 3: Run test, expect fail (module missing)**

Run: `npx vitest run packages/server/src/memory/__tests__/textProvider.test.ts`
Expected: FAIL — cannot find `../textProvider.js`.

- [x] **Step 4: Create `textProvider.ts`**

Create `packages/server/src/memory/textProvider.ts`:

```ts
import type Anthropic from '@anthropic-ai/sdk';
import type { OllamaClient } from '../ai/ollama.js';

export interface TextMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface TextProvider {
  chat(params: { messages: TextMessage[]; model: string }): Promise<{ text: string }>;
}

export function createOllamaTextProvider(ollama: OllamaClient): TextProvider {
  return {
    async chat(params) {
      return ollama.chat(params);
    },
  };
}

const CLAUDE_MAX_TOKENS = 1024;

export function createClaudeTextProvider(anthropic: Anthropic): TextProvider {
  return {
    async chat(params) {
      const systemContent = params.messages
        .filter((m) => m.role === 'system')
        .map((m) => m.content)
        .join('\n\n');

      const nonSystem = params.messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        }));

      const response = await anthropic.messages.create({
        model: params.model,
        max_tokens: CLAUDE_MAX_TOKENS,
        system: systemContent || undefined,
        messages: nonSystem,
      });

      const firstText = response.content.find((b) => b.type === 'text');
      return { text: firstText && 'text' in firstText ? firstText.text : '' };
    },
  };
}
```

- [x] **Step 5: Run tests, expect pass**

Run: `npx vitest run packages/server/src/memory/__tests__/textProvider.test.ts`
Expected: PASS (4 tests).

- [x] **Step 6: Commit**

```bash
git add packages/server/src/memory/textProvider.ts \
        packages/server/src/memory/__tests__/textProvider.test.ts
git commit -m "feat(memory): add TextProvider abstraction with Ollama and Claude wraps"
```

---

### Task 4: Port `extractFacts` to `TextProvider`

Change the `extractFacts` signature from `OllamaClient` → `TextProvider`. Update `service.ts` deps. Existing prompt and parsing logic stays intact.

**Files:**
- Modify: `packages/server/src/memory/extractor.ts:1,96-103`
- Modify: `packages/server/src/memory/service.ts:2,115-121,191`
- Modify: `packages/server/src/memory/__tests__/extractor.test.ts`

- [x] **Step 1: Update `extractor.ts` signature**

Edit `packages/server/src/memory/extractor.ts`.

Change line 1:

```ts
import type { TextProvider } from './textProvider.js';
```

Change the `extractFacts` signature (around line 96):

```ts
export async function extractFacts(
  textProvider: TextProvider,
  params: {
    userMessage: string;
    assistantMessage: string;
    model: string;
  },
): Promise<ExtractedFact[]> {
```

And the call inside the function (around line 117):

```ts
  let response;
  try {
    response = await textProvider.chat({
      messages: [{ role: 'user', content: prompt }],
      model: params.model,
    });
  } catch (err) {
    console.warn('[memory] fact extraction failed:', err instanceof Error ? err.message : err);
    return [];
  }
```

- [x] **Step 2: Update `service.ts` deps**

Edit `packages/server/src/memory/service.ts`.

Replace line 2:

```ts
import type { TextProvider } from './textProvider.js';
```

Replace the deps interface (around line 115-121):

```ts
interface MemoryServiceDeps {
  db: Database.Database;
  embeddings: EmbeddingsClient;
  textProvider: TextProvider;
  extractorModel: string;
  maxContextTokens?: number;
}
```

Replace the destructure (around line 142):

```ts
  const { db, embeddings, textProvider } = deps;
```

Replace the `extractFacts(ollama, ...)` call (around line 191):

```ts
        facts = await extractFacts(textProvider, {
          userMessage,
          assistantMessage,
          model: deps.extractorModel,
        });
```

- [x] **Step 3: Update `index.ts` to pass a `TextProvider` instead of `OllamaClient`**

Edit `packages/server/src/index.ts`. Add to imports (~line 34):

```ts
import { createOllamaTextProvider } from './memory/textProvider.js';
```

Replace the `createMemoryService` call (~line 240):

```ts
  memoryService = createMemoryService({
    db: getDb(),
    embeddings,
    textProvider: createOllamaTextProvider(ollamaForMemory),
    extractorModel: process.env.MEMORY_EXTRACT_MODEL || 'qwen2.5:7b',
    maxContextTokens,
  });
```

- [x] **Step 4: Update `extractor.test.ts` mocks**

Open `packages/server/src/memory/__tests__/extractor.test.ts`. Find every place that constructs an `OllamaClient` mock for `extractFacts(...)`. Replace with:

```ts
function makeTextProvider(response: string) {
  return { chat: vi.fn().mockResolvedValue({ text: response }) };
}
```

Replace each `extractFacts(ollamaMock, ...)` with `extractFacts(makeTextProvider('...'), ...)` (or pass the existing mock that already has matching `.chat()` shape).

- [x] **Step 5: Update `service.test.ts` mocks**

Open `packages/server/src/memory/__tests__/service.test.ts`. Find places that build `ollama: { chat: ... }` and pass into `createMemoryService`. Rename to `textProvider:` and ensure shape matches:

```ts
textProvider: { chat: vi.fn().mockResolvedValue({ text: '[]' }) }
```

- [x] **Step 6: Run memory tests**

Run: `npx vitest run packages/server/src/memory/__tests__/`
Expected: PASS.

- [x] **Step 7: Run full project tests**

Run: `npm test`
Expected: PASS. No regressions.

- [x] **Step 8: Commit**

```bash
git add packages/server/src/memory/extractor.ts \
        packages/server/src/memory/service.ts \
        packages/server/src/index.ts \
        packages/server/src/memory/__tests__/extractor.test.ts \
        packages/server/src/memory/__tests__/service.test.ts
git commit -m "refactor(memory): port extractFacts to TextProvider abstraction"
```

---

### Task 5: Voyage embeddings client

Add Voyage HTTP client with `embedDocument`/`embedQuery` (asymmetric `input_type`), circuit breaker, 429 retry. Not wired into bootstrap yet.

**Files:**
- Create: `packages/server/src/memory/voyageEmbeddings.ts`
- Create: `packages/server/src/memory/__tests__/voyageEmbeddings.test.ts`

- [x] **Step 1: Write failing test (happy path + document/query split)**

Create `packages/server/src/memory/__tests__/voyageEmbeddings.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createVoyageEmbeddingsClient } from '../voyageEmbeddings.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function ok(vec: number[]) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ data: [{ embedding: vec, index: 0 }] }),
  };
}

describe('VoyageEmbeddingsClient', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('exposes dimension and identity', () => {
    const client = createVoyageEmbeddingsClient({ apiKey: 'sk', model: 'voyage-3' });
    expect(client.dimension).toBe(1024);
    expect(client.identity).toBe('voyage:voyage-3');
  });

  it('rejects unsupported model', () => {
    expect(() =>
      createVoyageEmbeddingsClient({ apiKey: 'sk', model: 'voyage-3-lite' as any }),
    ).toThrow('Unsupported VOYAGE_MODEL');
  });

  it('embedDocument calls /v1/embeddings with input_type=document', async () => {
    const vec = Array.from({ length: 1024 }, () => 0.1);
    mockFetch.mockResolvedValueOnce(ok(vec));

    const client = createVoyageEmbeddingsClient({ apiKey: 'sk-test', model: 'voyage-3' });
    const result = await client.embedDocument('hello');

    expect(result).toHaveLength(1024);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.voyageai.com/v1/embeddings',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer sk-test',
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({ input: ['hello'], model: 'voyage-3', input_type: 'document' }),
      }),
    );
  });

  it('embedQuery calls with input_type=query', async () => {
    mockFetch.mockResolvedValueOnce(ok(Array.from({ length: 1024 }, () => 0)));

    const client = createVoyageEmbeddingsClient({ apiKey: 'sk', model: 'voyage-3' });
    await client.embedQuery('search me');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.voyageai.com/v1/embeddings',
      expect.objectContaining({
        body: JSON.stringify({ input: ['search me'], model: 'voyage-3', input_type: 'query' }),
      }),
    );
  });

  it('retries on 429 with exponential backoff', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 429, body: { cancel: () => Promise.resolve() } });
    mockFetch.mockResolvedValueOnce({ ok: false, status: 429, body: { cancel: () => Promise.resolve() } });
    mockFetch.mockResolvedValueOnce(ok(Array.from({ length: 1024 }, () => 0)));

    const client = createVoyageEmbeddingsClient({
      apiKey: 'sk',
      model: 'voyage-3',
      retryBackoffMs: 1, // override so test runs fast
    });
    const result = await client.embedDocument('hello');
    expect(result).toHaveLength(1024);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('throws after 3 failed retries on 429', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 429, body: { cancel: () => Promise.resolve() } });

    const client = createVoyageEmbeddingsClient({
      apiKey: 'sk',
      model: 'voyage-3',
      retryBackoffMs: 1,
    });
    await expect(client.embedDocument('hello')).rejects.toThrow('Voyage rate limit');
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('throws on 401 without retry', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401, body: { cancel: () => Promise.resolve() } });
    const client = createVoyageEmbeddingsClient({ apiKey: 'bad', model: 'voyage-3' });
    await expect(client.embedDocument('hi')).rejects.toThrow('Voyage auth failed (401)');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('opens circuit breaker after 5xx', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503, body: { cancel: () => Promise.resolve() } });
    const client = createVoyageEmbeddingsClient({ apiKey: 'sk', model: 'voyage-3' });

    await expect(client.embedDocument('a')).rejects.toThrow('Voyage error 503');
    // Second call within cooldown should be refused immediately, not hit fetch
    await expect(client.embedDocument('b')).rejects.toThrow('Voyage circuit open');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('rejects dimension mismatch in response', async () => {
    const wrongDim = Array.from({ length: 512 }, () => 0);
    mockFetch.mockResolvedValueOnce(ok(wrongDim));
    const client = createVoyageEmbeddingsClient({ apiKey: 'sk', model: 'voyage-3' });
    await expect(client.embedDocument('x')).rejects.toThrow('Voyage dimension mismatch');
  });

  it('caller abort does not open circuit', async () => {
    const ac = new AbortController();
    ac.abort();
    mockFetch.mockImplementation(() => {
      const err = new Error('aborted') as any;
      err.name = 'AbortError';
      throw err;
    });

    const client = createVoyageEmbeddingsClient({ apiKey: 'sk', model: 'voyage-3' });
    await expect(client.embedDocument('hello', ac.signal)).rejects.toThrow();
    // Subsequent call should NOT see open circuit
    mockFetch.mockResolvedValueOnce(ok(Array.from({ length: 1024 }, () => 0)));
    await expect(client.embedDocument('hello again')).resolves.toHaveLength(1024);
  });
});
```

- [x] **Step 2: Run test, expect fail (file missing)**

Run: `npx vitest run packages/server/src/memory/__tests__/voyageEmbeddings.test.ts`
Expected: FAIL — `Cannot find module '../voyageEmbeddings.js'`.

- [x] **Step 3: Create `voyageEmbeddings.ts`**

Create `packages/server/src/memory/voyageEmbeddings.ts`:

```ts
import type { EmbeddingsClient } from './embeddings.js';

const VOYAGE_DIMENSIONS: Record<string, number> = {
  'voyage-3': 1024,
  'voyage-3-large': 1024,
};

const EMBED_INPUT_MAX_CHARS = 8000;
const CIRCUIT_OPEN_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 3;
const DEFAULT_BACKOFF_MS = 1000;

interface VoyageConfig {
  apiKey: string;
  model: string;
  timeoutMs?: number;
  retryBackoffMs?: number;
}

interface VoyageResponse {
  data?: Array<{ embedding?: number[]; index?: number }>;
}

export function createVoyageEmbeddingsClient(config: VoyageConfig): EmbeddingsClient {
  const dimension = VOYAGE_DIMENSIONS[config.model];
  if (!dimension) {
    throw new Error(
      `Unsupported VOYAGE_MODEL: ${config.model}. Supported: ${Object.keys(VOYAGE_DIMENSIONS).join(', ')}`,
    );
  }
  if (!config.apiKey) {
    throw new Error('VOYAGE_API_KEY required for Voyage embeddings client');
  }

  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const baseBackoff = config.retryBackoffMs ?? DEFAULT_BACKOFF_MS;
  let circuitOpenedAt = 0;

  async function callVoyage(
    text: string,
    inputType: 'document' | 'query',
    signal?: AbortSignal,
  ): Promise<number[]> {
    if (circuitOpenedAt && Date.now() - circuitOpenedAt < CIRCUIT_OPEN_MS) {
      throw new Error('Voyage circuit open (recent failure)');
    }
    circuitOpenedAt = 0;

    const input = text.length > EMBED_INPUT_MAX_CHARS ? text.slice(0, EMBED_INPUT_MAX_CHARS) : text;

    let lastErr: Error | null = null;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      try {
        const res = await fetch('https://api.voyageai.com/v1/embeddings', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${config.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ input: [input], model: config.model, input_type: inputType }),
          signal: combinedSignal,
        });

        if (res.status === 401) {
          await res.body?.cancel().catch(() => {});
          throw new Error('Voyage auth failed (401) — check VOYAGE_API_KEY');
        }

        if (res.status === 429) {
          await res.body?.cancel().catch(() => {});
          lastErr = new Error('Voyage rate limit (429)');
          if (attempt < MAX_RETRIES - 1) {
            await new Promise((r) => setTimeout(r, baseBackoff * 2 ** attempt));
            continue;
          }
          throw lastErr;
        }

        if (!res.ok) {
          await res.body?.cancel().catch(() => {});
          throw new Error(`Voyage error ${res.status}`);
        }

        const data = (await res.json()) as VoyageResponse;
        const embedding = data.data?.[0]?.embedding;
        if (!Array.isArray(embedding)) {
          throw new Error('Voyage response missing embedding');
        }
        if (embedding.length !== dimension) {
          throw new Error(
            `Voyage dimension mismatch: model '${config.model}' returned ${embedding.length}, expected ${dimension}`,
          );
        }
        for (const n of embedding) {
          if (typeof n !== 'number' || !Number.isFinite(n)) {
            throw new Error('Voyage response contains non-finite values');
          }
        }
        return embedding;
      } catch (err) {
        const abortedByCaller = signal?.aborted === true;
        const isRetriable429 = err instanceof Error && err.message.includes('429');
        if (isRetriable429 && attempt < MAX_RETRIES - 1) {
          continue;
        }
        if (!abortedByCaller) {
          circuitOpenedAt = Date.now();
        }
        throw err;
      }
    }
    throw lastErr ?? new Error('Voyage request failed');
  }

  return {
    dimension,
    identity: `voyage:${config.model}`,
    embedDocument: (text, signal) => callVoyage(text, 'document', signal),
    embedQuery: (text, signal) => callVoyage(text, 'query', signal),
  };
}
```

- [x] **Step 4: Run Voyage tests, expect pass**

Run: `npx vitest run packages/server/src/memory/__tests__/voyageEmbeddings.test.ts`
Expected: PASS (9 tests).

If any test fails, inspect: 429 retry order, circuit-breaker reset on success, abort signal handling.

- [x] **Step 5: Run full memory tests**

Run: `npx vitest run packages/server/src/memory/__tests__/`
Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add packages/server/src/memory/voyageEmbeddings.ts \
        packages/server/src/memory/__tests__/voyageEmbeddings.test.ts
git commit -m "feat(memory): add Voyage embeddings client with document/query split"
```

---

### Task 6: Bump standard to 1024 dim (atomic with migration)

Change schema `FLOAT[768]` → `FLOAT[1024]`, bump `EXPECTED_EMBED_DIM` to 1024, update default `MEMORY_EMBED_MODEL` to `mxbai-embed-large`. The migration code from Task 2 detects the identity change (`ollama:nomic-embed-text` → `ollama:mxbai-embed-large`) and runs wipe + reindex automatically.

**Files:**
- Modify: `packages/server/src/db.ts:72,79` (FLOAT[768] → FLOAT[1024])
- Modify: `packages/server/src/memory/embeddings.ts` (EXPECTED_EMBED_DIM)
- Modify: `packages/server/src/index.ts:236,247` (default model)
- Modify: `packages/server/src/memory/__tests__/embeddings.test.ts` (1024 dim in fixtures)
- Modify: `packages/server/src/memory/__tests__/schema.test.ts` (if it asserts FLOAT[768])

- [x] **Step 1: Find any existing test referencing FLOAT[768] or 768 dimension assumption**

Run: `grep -rn "768\|FLOAT\[768\]\|nomic-embed-text" packages/server/src/`
List all hits. Each will need updating. Common spots: `embeddings.test.ts`, `schema.test.ts`, `service.test.ts` (mock dim), `db.test.ts`.

- [x] **Step 2: Update `db.ts` schema**

Edit `packages/server/src/db.ts`. Replace both occurrences of `FLOAT[768]` with `FLOAT[1024]` (lines ~72 and ~79):

```ts
        embedding FLOAT[1024] distance_metric=cosine
```

- [x] **Step 3: Update `EXPECTED_EMBED_DIM`**

Edit `packages/server/src/memory/embeddings.ts`. Change:

```ts
const EXPECTED_EMBED_DIM = 1024;
```

- [x] **Step 4: Update `index.ts` defaults**

Edit `packages/server/src/index.ts`. Replace both occurrences of `'nomic-embed-text'` with `'mxbai-embed-large'` (lines ~236 and ~247).

- [x] **Step 5: Update `embeddings.test.ts` fixtures**

In `packages/server/src/memory/__tests__/embeddings.test.ts`, replace:
- `768` → `1024` in vector array lengths and dim assertions
- `'nomic-embed-text'` → `'mxbai-embed-large'` in `createOllamaEmbeddingsClient({...})` constructor calls
- The "throws on dimension mismatch" test: change `wrongDim` length to something other than 1024 (e.g., 768).

- [x] **Step 6: Update `schema.test.ts`**

Open `packages/server/src/memory/__tests__/schema.test.ts`. If it asserts dimension, change 768 → 1024.

- [x] **Step 7: Update `service.test.ts` mock embeddings dim default**

In `packages/server/src/memory/__tests__/service.test.ts`, change the helper:

```ts
function makeMockEmbeddings(dim = 1024, identity = 'ollama:mxbai-embed-large'): EmbeddingsClient {
```

- [x] **Step 8: Update `migration.test.ts` makeDb helper schema**

In `packages/server/src/memory/__tests__/migration.test.ts`, update `makeDb()`:

```ts
    CREATE VIRTUAL TABLE memory_vec_entries USING vec0(
      entity_id INTEGER PRIMARY KEY, embedding FLOAT[1024] distance_metric=cosine
    );
    CREATE VIRTUAL TABLE memory_vec_facts USING vec0(
      entity_id INTEGER PRIMARY KEY, embedding FLOAT[1024] distance_metric=cosine
    );
```

And update the "identity change" test seed vectors: change the `Array.from({ length: 768 })` to `Array.from({ length: 1024 })` so the seed write succeeds with the new schema, and verify the post-migration counts unchanged.

Actually — that test seeds a 1024-dim row purporting to be from the old 768-dim model. That's fine for the migration logic (it doesn't validate stored vec dim; it just trusts the metadata). What matters is that the OLD metadata says `ollama:nomic-embed-text` (768) and the NEW provider says `voyage:voyage-3` (1024) — identity mismatch triggers wipe + reindex. Keep the seed at FLOAT[1024] now since schema is 1024.

- [x] **Step 9: Run memory tests**

Run: `npx vitest run packages/server/src/memory/__tests__/`
Expected: PASS.

If `service.test.ts` fails because `createMemoryService` triggers `ensureEmbedModelMatches` and the in-memory test DB has 768-dim seed data that no longer matches schema — fix by ensuring test DBs are seeded with 1024-dim vectors OR start clean.

- [x] **Step 10: Run full project tests**

Run: `npm test`
Expected: PASS.

- [x] **Step 11: Sanity check: existing dev DB will reindex on next boot** (skipped - manual verification, not automatable)

If you have a local `db.sqlite3` from before this change, it has 768-dim vec tables. Don't delete it — the migration code (from Task 2) is supposed to handle this. Verify by inspection:

```bash
sqlite3 packages/server/db.sqlite3 "SELECT * FROM memory_metadata"
```

If the row says `ollama:nomic-embed-text` (or is missing), the next server start with `MEMORY_EMBED_MODEL=mxbai-embed-large` will trigger migration. **But:** you must have `mxbai-embed-large` pulled in Ollama for the reindex to succeed. If unsure, run `ollama pull mxbai-embed-large` before booting. (Don't actually boot — that's Task 7 territory.)

- [x] **Step 12: Commit**

```bash
git add packages/server/src/db.ts \
        packages/server/src/memory/embeddings.ts \
        packages/server/src/index.ts \
        packages/server/src/memory/__tests__/embeddings.test.ts \
        packages/server/src/memory/__tests__/schema.test.ts \
        packages/server/src/memory/__tests__/service.test.ts \
        packages/server/src/memory/__tests__/migration.test.ts
git commit -m "feat(memory): bump embedding dim standard to 1024 (mxbai-embed-large default)"
```

---

### Task 7: Bootstrap provider selection in `index.ts`

Add `pickEmbeddingProvider(env)` and `pickTextProvider(env, ollama, anthropic)` factories. Wire results into `createMemoryService`. Add env validation that fails loudly when `EMBEDDING_PROVIDER=voyage` and `VOYAGE_API_KEY` is missing.

**Files:**
- Modify: `packages/server/src/index.ts`

- [x] **Step 1: Add imports**

Edit `packages/server/src/index.ts`. Update the existing import (line ~33):

```ts
import { createOllamaEmbeddingsClient, type EmbeddingsClient } from './memory/embeddings.js';
import { createVoyageEmbeddingsClient } from './memory/voyageEmbeddings.js';
import { createOllamaTextProvider, createClaudeTextProvider, type TextProvider } from './memory/textProvider.js';
```

- [x] **Step 2: Add `pickEmbeddingProvider` factory**

After the imports and before the bootstrap section (around line 140), add:

```ts
type EmbeddingProviderMode = 'auto' | 'ollama' | 'voyage';

function pickEmbeddingProvider(opts: {
  mode: EmbeddingProviderMode;
  ollamaUrl: string | undefined;
  ollamaModel: string;
  voyageKey: string | undefined;
  voyageModel: string;
}): EmbeddingsClient | null {
  const { mode, ollamaUrl, ollamaModel, voyageKey, voyageModel } = opts;

  if (mode === 'ollama') {
    if (!ollamaUrl) throw new Error('EMBEDDING_PROVIDER=ollama requires OLLAMA_URL');
    return createOllamaEmbeddingsClient({ url: ollamaUrl, model: ollamaModel });
  }

  if (mode === 'voyage') {
    if (!voyageKey) throw new Error('EMBEDDING_PROVIDER=voyage requires VOYAGE_API_KEY');
    return createVoyageEmbeddingsClient({ apiKey: voyageKey, model: voyageModel });
  }

  // auto
  if (ollamaUrl) {
    return createOllamaEmbeddingsClient({ url: ollamaUrl, model: ollamaModel });
  }
  if (voyageKey) {
    return createVoyageEmbeddingsClient({ apiKey: voyageKey, model: voyageModel });
  }
  return null;
}

type TextProviderMode = 'auto' | 'ollama' | 'claude';

function pickTextProvider(opts: {
  mode: TextProviderMode;
  ollama: OllamaClient | null;
  anthropic: Anthropic;
  localLlmMode: 'enabled' | 'disabled';
}): TextProvider {
  const { mode, ollama, anthropic, localLlmMode } = opts;

  if (mode === 'ollama') {
    if (!ollama || localLlmMode === 'disabled') {
      throw new Error('MEMORY_TEXT_PROVIDER=ollama requires ollama client and LOCAL_LLM_MODE!=disabled');
    }
    return createOllamaTextProvider(ollama);
  }

  if (mode === 'claude') {
    return createClaudeTextProvider(anthropic);
  }

  // auto
  if (ollama && localLlmMode !== 'disabled') {
    return createOllamaTextProvider(ollama);
  }
  return createClaudeTextProvider(anthropic);
}
```

You'll need `import Anthropic from '@anthropic-ai/sdk';` for the type. If `createClaudeClient()` returns the typed Anthropic instance, just use `ReturnType<typeof createClaudeClient>` instead.

- [x] **Step 3: Replace the memory bootstrap block**

Find the block (around line 232-249) that starts with `let memoryService: MemoryService | null = null;` and replace through `console.log('[memory] disabled');`:

```ts
let memoryService: MemoryService | null = null;
if (memoryEnabled) {
  const embeddingMode = (process.env.EMBEDDING_PROVIDER ?? 'auto') as EmbeddingProviderMode;
  const textMode = (process.env.MEMORY_TEXT_PROVIDER ?? 'auto') as TextProviderMode;

  const embeddings = pickEmbeddingProvider({
    mode: embeddingMode,
    ollamaUrl: process.env.OLLAMA_URL || (ollamaForMemory ? 'http://localhost:11434' : undefined),
    ollamaModel: process.env.MEMORY_EMBED_MODEL || 'mxbai-embed-large',
    voyageKey: process.env.VOYAGE_API_KEY,
    voyageModel: process.env.VOYAGE_MODEL || 'voyage-3',
  });

  if (!embeddings) {
    console.log('[memory] disabled — no embedding provider configured (set OLLAMA_URL or VOYAGE_API_KEY)');
  } else {
    let migrationOk = false;
    try {
      await ensureEmbedModelMatches(getDb(), embeddings);
      migrationOk = true;
    } catch (err) {
      console.error('[memory] migration failed, disabling memory:', err instanceof Error ? err.message : err);
    }

    if (migrationOk) {
      const textProvider = pickTextProvider({
        mode: textMode,
        ollama: ollamaForMemory,
        anthropic: client,
        localLlmMode,
      });

      const usingOllamaText =
        textMode === 'ollama' || (textMode === 'auto' && !!ollamaForMemory && localLlmMode !== 'disabled');
      const extractorModel = usingOllamaText
        ? (process.env.MEMORY_EXTRACT_MODEL || 'qwen2.5:7b')
        : (process.env.MEMORY_EXTRACT_MODEL_CLAUDE || 'claude-haiku-4-5-20251001');

      const parsedMaxTokens = Number(process.env.MEMORY_MAX_CONTEXT_TOKENS);
      const maxContextTokens =
        Number.isFinite(parsedMaxTokens) && parsedMaxTokens > 0 ? parsedMaxTokens : 2000;

      memoryService = createMemoryService({
        db: getDb(),
        embeddings,
        textProvider,
        extractorModel,
        maxContextTokens,
      });
      console.log(`[memory] enabled (embeddings=${embeddings.identity}, text=${usingOllamaText ? 'ollama' : 'claude'}, model=${extractorModel})`);
    }
  }
} else {
  console.log('[memory] disabled');
}
```

- [x] **Step 4: Update `routerNeedsOllama` / `memoryNeedsOllama` gating**

The existing logic (~line 145-180) was:

```ts
const memoryNeedsOllama = memoryEnabled;
```

Memory no longer requires Ollama. Replace with:

```ts
const memoryNeedsOllama =
  memoryEnabled &&
  (process.env.EMBEDDING_PROVIDER ?? 'auto') !== 'voyage' &&
  (process.env.MEMORY_TEXT_PROVIDER ?? 'auto') !== 'claude';
```

This ensures the loopback PII check (~line 153) doesn't run for users who explicitly went Voyage + Claude. If they're on `auto` and Ollama is configured (`OLLAMA_URL` present), the check is still appropriate.

Also update the error message at line 168 to mention the new escape hatch:

```ts
        `To skip Ollama entirely, set LOCAL_LLM_MODE=disabled, EMBEDDING_PROVIDER=voyage, MEMORY_TEXT_PROVIDER=claude.`,
```

- [x] **Step 5: Run all server tests**

Run: `npm test`
Expected: PASS. Index.ts may not have its own tests but other modules that import from index will fail-compile if types drifted — TypeScript checks come through tests.

- [x] **Step 6: Manual smoke check — Ollama path still works** (skipped - manual test, not automatable)

```bash
# In a separate terminal, ensure Ollama is running and mxbai-embed-large is pulled:
ollama pull mxbai-embed-large
# Then boot the server (without touching VOYAGE_API_KEY):
npm run dev:server
```

In the server log, look for: `[memory] enabled (embeddings=ollama:mxbai-embed-large, text=auto, model=qwen2.5:7b)`. If the DB previously held 768-dim vectors, you should also see `[memory] reindexing under ollama:mxbai-embed-large: N entries, M facts`.

Ctrl-C after confirming.

- [x] **Step 7: Manual smoke check — Voyage path** (skipped - manual test, not automatable)

Get a Voyage API key from https://www.voyageai.com/. Set env and reboot:

```bash
export VOYAGE_API_KEY="<your-key>"
export EMBEDDING_PROVIDER=voyage
export MEMORY_TEXT_PROVIDER=claude
export LOCAL_LLM_MODE=disabled
# (optional) move the existing db out of the way to start fresh
mv packages/server/db.sqlite3 packages/server/db.sqlite3.bak
npm run dev:server
```

In the log expect: `[memory] enabled (embeddings=voyage:voyage-3, text=auto, model=claude-haiku-4-5-20251001)`.

Send a chat turn through Discord (or whichever channel is active). Check `select * from memory_facts` and `select * from memory_metadata` after a few turns. The `embed_model` row should be `voyage:voyage-3`.

Restore the original db if needed: `mv packages/server/db.sqlite3.bak packages/server/db.sqlite3`.

- [x] **Step 8: Commit**

```bash
git add packages/server/src/index.ts
git commit -m "feat(memory): bootstrap Voyage/Claude provider selection via env"
```

---

### Task 8: Documentation

Add user-facing docs for the new env vars.

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md` (if it documents memory setup) — check first

- [ ] **Step 1: Find existing memory docs in README**

Run: `grep -n -i "memory\|ollama\|MEMORY_ENABLED" /Users/dim/code/R2-D2/README.md`
Skim the lines around hits to find the right place to add a section.

- [ ] **Step 2: Add "Running R2 without Ollama" section to README**

Add a new section (placement: under existing "Memory" or "Configuration" section). Use this content:

```markdown
### Running R2 without Ollama (API-only mode)

By default R2 uses local Ollama for memory embeddings (`mxbai-embed-large`) and fact extraction (`qwen2.5:7b`). To run fully without Ollama (e.g. on a laptop with no GPU), use Voyage AI for embeddings and Claude for fact extraction:

```bash
# Required
export EMBEDDING_PROVIDER=voyage
export VOYAGE_API_KEY="<get from https://www.voyageai.com/>"
export MEMORY_TEXT_PROVIDER=claude
export LOCAL_LLM_MODE=disabled

# Optional defaults (override if needed)
export VOYAGE_MODEL=voyage-3                                # 1024 dim, default
export MEMORY_EXTRACT_MODEL_CLAUDE=claude-haiku-4-5-20251001
```

Costs (rough, at low-volume personal use):
- Voyage embeddings: ~$0.06 / 1M tokens — typical chat is fractions of a cent per turn
- Claude Haiku fact extraction: ~$0.003 per turn

On first start under a new provider, R2 wipes and re-embeds existing memory facts/entries automatically. Takes ~15 seconds for typical memory sizes.

To switch back to local Ollama later, unset the env vars (or `EMBEDDING_PROVIDER=ollama`, `MEMORY_TEXT_PROVIDER=ollama`). The migration runs again automatically — re-embeds everything under Ollama.

**Embedding standard:** all R2 memory uses 1024-dim embeddings. Supported models: `mxbai-embed-large` (Ollama), `voyage-3` / `voyage-3-large` (Voyage). Custom models with different dimensions are rejected at boot.
```

- [ ] **Step 3: Check AGENTS.md for memory references**

Run: `grep -n -i "memory\|ollama" /Users/dim/code/R2-D2/AGENTS.md | head -20`
If memory setup is documented there, update it to mention the API-only option.

- [ ] **Step 4: Commit**

```bash
git add README.md AGENTS.md
git commit -m "docs: add 'Running R2 without Ollama' section"
```

---

## Done definition checklist

- [ ] `npm test` green
- [ ] Manual smoke: boot with `EMBEDDING_PROVIDER=voyage`, `LOCAL_LLM_MODE=disabled` on a clean DB → fact extraction + search round-trip works
- [ ] Manual smoke: boot with existing 768-dim DB + default config (`mxbai-embed-large`) → migration auto-runs, search works after
- [ ] README updated
- [ ] All 8 task commits made (or squashed to a sensible series)
