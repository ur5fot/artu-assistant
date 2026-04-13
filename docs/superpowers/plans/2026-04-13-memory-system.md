# R2 Memory System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give R2 persistent memory — index every chat turn as embeddings in SQLite, extract structured facts with versioning, auto-retrieve relevant context before every LLM call, and expose a `memory_search` tool for on-demand lookup.

**Architecture:** sqlite-vec extension adds vector search to existing `data/r2.db`. New `packages/server/src/memory/` module owns schema, embeddings, extraction, and search. New `packages/tool-memory/` package exposes `memory_search` tool. Router injects auto-retrieved context into the system prompt before every LLM call.

**Tech Stack:** sqlite-vec, better-sqlite3, Ollama nomic-embed-text, Ollama qwen2.5:7b (for fact extraction), TypeScript, Vitest.

---

### Task 1: Install sqlite-vec and pull embedding model

**Files:**
- Modify: `package.json`
- Modify: `packages/server/package.json`

- [x] **Step 1: Install sqlite-vec in the server package**

Run: `cd /Users/dim/code/R2-D2 && npm install sqlite-vec -w packages/server`
Expected: `sqlite-vec` added to `packages/server/package.json` dependencies.

- [x] **Step 2: Pull nomic-embed-text model**

Run: `ollama pull nomic-embed-text`
Expected: `success` — model downloaded (~274MB).

- [x] **Step 3: Verify embedding endpoint works**

Run: `curl -s http://localhost:11434/api/embeddings -d '{"model":"nomic-embed-text","prompt":"привіт"}' | python3 -m json.tool | head -5`
Expected: JSON with `embedding` array of 768 floats.

- [x] **Step 4: Commit**

```bash
git add package.json package-lock.json packages/server/package.json
git commit -m "feat: add sqlite-vec dependency for memory system"
```

---

### Task 2: Load sqlite-vec extension and create memory tables

**Files:**
- Modify: `packages/server/src/db.ts`

- [ ] **Step 1: Load sqlite-vec extension and add memory schema**

In `packages/server/src/db.ts`, add the import at the top:

```typescript
import * as sqliteVec from 'sqlite-vec';
```

Then update `initDb` to load the extension and create memory tables. Insert this block right after `db.pragma('journal_mode = WAL');`:

```typescript
  sqliteVec.load(db);

  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      source_id TEXT,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_memory_entries_kind
      ON memory_entries(kind, created_at)
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      superseded_by INTEGER REFERENCES memory_facts(id),
      last_mentioned_at INTEGER NOT NULL
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_facts_key_active
      ON memory_facts(key) WHERE superseded_by IS NULL
  `);

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_vec USING vec0(
      entity_id INTEGER PRIMARY KEY,
      entity_type TEXT,
      embedding FLOAT[768]
    )
  `);
```

- [ ] **Step 2: Write a smoke test for schema creation**

Create `packages/server/src/memory/__tests__/schema.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDb, closeDb, getDb } from '../../db.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('memory schema', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-memory-schema-'));
    initDb(path.join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates memory_entries, memory_facts, and memory_vec tables', () => {
    const db = getDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','virtual')")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain('memory_entries');
    expect(names).toContain('memory_facts');
    expect(names).toContain('memory_vec');
  });

  it('loads sqlite-vec extension and allows vec0 insert', () => {
    const db = getDb();
    const vec = new Float32Array(768);
    vec[0] = 0.5;
    vec[1] = -0.3;
    db.prepare(
      `INSERT INTO memory_vec (entity_id, entity_type, embedding) VALUES (?, ?, ?)`,
    ).run(1, 'entry', Buffer.from(vec.buffer));
    const row = db.prepare('SELECT entity_type FROM memory_vec WHERE entity_id = 1').get() as { entity_type: string };
    expect(row.entity_type).toBe('entry');
  });
});
```

- [ ] **Step 3: Run the test**

Run: `cd /Users/dim/code/R2-D2 && npx vitest run packages/server/src/memory/__tests__/schema.test.ts`
Expected: PASS — both tests.

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/db.ts packages/server/src/memory/__tests__/schema.test.ts
git commit -m "feat: load sqlite-vec and create memory tables"
```

---

### Task 3: Embeddings client

**Files:**
- Create: `packages/server/src/memory/embeddings.ts`
- Create: `packages/server/src/memory/__tests__/embeddings.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/memory/__tests__/embeddings.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createEmbeddingsClient } from '../embeddings.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('EmbeddingsClient', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('calls Ollama /api/embeddings and returns vector', async () => {
    const fakeVec = Array.from({ length: 768 }, (_, i) => i / 768);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ embedding: fakeVec }),
    });

    const client = createEmbeddingsClient({ url: 'http://localhost:11434', model: 'nomic-embed-text' });
    const result = await client.embed('hello');

    expect(result).toHaveLength(768);
    expect(result[0]).toBeCloseTo(0);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:11434/api/embeddings',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ model: 'nomic-embed-text', prompt: 'hello' }),
      }),
    );
  });

  it('throws on HTTP error', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
    const client = createEmbeddingsClient({ url: 'http://localhost:11434', model: 'nomic-embed-text' });
    await expect(client.embed('hello')).rejects.toThrow('Embeddings error 500');
  });

  it('throws on invalid response shape', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    const client = createEmbeddingsClient({ url: 'http://localhost:11434', model: 'nomic-embed-text' });
    await expect(client.embed('hello')).rejects.toThrow('missing embedding');
  });
});
```

- [ ] **Step 2: Run test to see it fail**

Run: `cd /Users/dim/code/R2-D2 && npx vitest run packages/server/src/memory/__tests__/embeddings.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement embeddings client**

Create `packages/server/src/memory/embeddings.ts`:

```typescript
export interface EmbeddingsClient {
  embed(text: string): Promise<number[]>;
}

interface EmbeddingsClientConfig {
  url: string;
  model: string;
  timeoutMs?: number;
}

export function createEmbeddingsClient(config: EmbeddingsClientConfig): EmbeddingsClient {
  const timeoutMs = config.timeoutMs ?? 15000;
  return {
    async embed(text: string): Promise<number[]> {
      const res = await fetch(`${config.url}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: config.model, prompt: text }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        throw new Error(`Embeddings error ${res.status}`);
      }
      const data = (await res.json()) as { embedding?: number[] };
      if (!Array.isArray(data.embedding)) {
        throw new Error('Embeddings response missing embedding');
      }
      return data.embedding;
    },
  };
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `cd /Users/dim/code/R2-D2 && npx vitest run packages/server/src/memory/__tests__/embeddings.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/memory/embeddings.ts packages/server/src/memory/__tests__/embeddings.test.ts
git commit -m "feat: add Ollama embeddings client"
```

---

### Task 4: Fact extractor

**Files:**
- Create: `packages/server/src/memory/extractor.ts`
- Create: `packages/server/src/memory/__tests__/extractor.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/memory/__tests__/extractor.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { extractFacts } from '../extractor.js';

describe('extractFacts', () => {
  it('calls Ollama chat and parses JSON array', async () => {
    const mockOllama = {
      chat: vi.fn().mockResolvedValue({
        text: '[{"key":"user.location","value":"Одеса"},{"key":"user.phone","value":"+380"}]',
      }),
    };
    const facts = await extractFacts(mockOllama as any, {
      userMessage: 'я живу в Одесі',
      assistantMessage: 'зрозумів',
      model: 'qwen2.5:7b',
    });
    expect(facts).toEqual([
      { key: 'user.location', value: 'Одеса' },
      { key: 'user.phone', value: '+380' },
    ]);
  });

  it('returns empty array when Ollama returns non-JSON', async () => {
    const mockOllama = { chat: vi.fn().mockResolvedValue({ text: 'no facts found' }) };
    const facts = await extractFacts(mockOllama as any, {
      userMessage: 'привіт',
      assistantMessage: 'hi',
      model: 'qwen2.5:7b',
    });
    expect(facts).toEqual([]);
  });

  it('filters out entries missing key or value', async () => {
    const mockOllama = {
      chat: vi.fn().mockResolvedValue({
        text: '[{"key":"user.name","value":"Діма"},{"key":"bad"},{"value":"orphan"}]',
      }),
    };
    const facts = await extractFacts(mockOllama as any, {
      userMessage: 'x',
      assistantMessage: 'y',
      model: 'qwen2.5:7b',
    });
    expect(facts).toEqual([{ key: 'user.name', value: 'Діма' }]);
  });

  it('parses JSON embedded in surrounding text', async () => {
    const mockOllama = {
      chat: vi.fn().mockResolvedValue({
        text: 'Ось факти: [{"key":"user.email","value":"a@b.com"}] готово.',
      }),
    };
    const facts = await extractFacts(mockOllama as any, {
      userMessage: 'x',
      assistantMessage: 'y',
      model: 'qwen2.5:7b',
    });
    expect(facts).toEqual([{ key: 'user.email', value: 'a@b.com' }]);
  });
});
```

- [ ] **Step 2: Run test to see it fail**

Run: `cd /Users/dim/code/R2-D2 && npx vitest run packages/server/src/memory/__tests__/extractor.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement extractor**

Create `packages/server/src/memory/extractor.ts`:

```typescript
import type { OllamaClient } from '../ai/ollama.js';

export interface ExtractedFact {
  key: string;
  value: string;
}

const EXTRACT_PROMPT_HEADER = `Витягни стійкі факти про юзера з наступного діалогу у форматі JSON масиву:
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

Відповідь має бути ТІЛЬКИ JSON масив, без коментарів.`;

export async function extractFacts(
  ollama: OllamaClient,
  params: {
    userMessage: string;
    assistantMessage: string;
    model: string;
  },
): Promise<ExtractedFact[]> {
  const prompt = `${EXTRACT_PROMPT_HEADER}

Діалог:
User: ${params.userMessage}
R2: ${params.assistantMessage}

Відповідь (JSON масив):`;

  let response;
  try {
    response = await ollama.chat({
      messages: [{ role: 'user', content: prompt }],
    });
  } catch (err) {
    console.warn('[memory] fact extraction failed:', err instanceof Error ? err.message : err);
    return [];
  }

  const text = response.text || '';
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) return [];

  const facts: ExtractedFact[] = [];
  for (const item of parsed) {
    if (
      typeof item === 'object' &&
      item !== null &&
      typeof (item as any).key === 'string' &&
      typeof (item as any).value === 'string' &&
      (item as any).key.length > 0 &&
      (item as any).value.length > 0
    ) {
      facts.push({ key: (item as any).key, value: (item as any).value });
    }
  }
  return facts;
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `cd /Users/dim/code/R2-D2 && npx vitest run packages/server/src/memory/__tests__/extractor.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/memory/extractor.ts packages/server/src/memory/__tests__/extractor.test.ts
git commit -m "feat: add fact extractor via Ollama chat"
```

---

### Task 5: Memory DB queries

**Files:**
- Create: `packages/server/src/memory/db.ts`
- Create: `packages/server/src/memory/__tests__/db.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/memory/__tests__/db.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDb, closeDb, getDb } from '../../db.js';
import {
  insertEntry,
  insertOrSupersede Fact,
  getActiveFacts,
  vectorSearch,
} from '../db.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('memory db', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-memory-db-'));
    initDb(path.join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeVec(seed: number): number[] {
    const vec = new Array(768).fill(0);
    vec[0] = seed;
    vec[1] = 1 - seed;
    return vec;
  }

  it('inserts an entry and its embedding', () => {
    const id = insertEntry(getDb(), {
      kind: 'user_msg',
      sourceId: 'msg-1',
      content: 'hello world',
      createdAt: 1000,
      embedding: makeVec(0.5),
    });
    expect(id).toBeGreaterThan(0);
    const row = getDb().prepare('SELECT kind, content FROM memory_entries WHERE id = ?').get(id) as { kind: string; content: string };
    expect(row.kind).toBe('user_msg');
    expect(row.content).toBe('hello world');
  });

  it('inserts a new fact when key is empty', () => {
    const id = insertOrSupersedeFact(getDb(), {
      key: 'user.location',
      value: 'Київ',
      createdAt: 1000,
      embedding: makeVec(0.5),
    });
    expect(id).toBeGreaterThan(0);
    const facts = getActiveFacts(getDb());
    expect(facts).toEqual([
      expect.objectContaining({ key: 'user.location', value: 'Київ' }),
    ]);
  });

  it('supersedes an existing fact with same key but different value', () => {
    const firstId = insertOrSupersedeFact(getDb(), {
      key: 'user.location',
      value: 'Київ',
      createdAt: 1000,
      embedding: makeVec(0.5),
    });
    const secondId = insertOrSupersedeFact(getDb(), {
      key: 'user.location',
      value: 'Одеса',
      createdAt: 2000,
      embedding: makeVec(0.6),
    });

    const firstRow = getDb().prepare('SELECT superseded_by FROM memory_facts WHERE id = ?').get(firstId) as { superseded_by: number };
    expect(firstRow.superseded_by).toBe(secondId);

    const active = getActiveFacts(getDb());
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ key: 'user.location', value: 'Одеса' });
  });

  it('updates last_mentioned_at when inserting same key+value', () => {
    const id = insertOrSupersedeFact(getDb(), {
      key: 'user.name',
      value: 'Діма',
      createdAt: 1000,
      embedding: makeVec(0.5),
    });
    const again = insertOrSupersedeFact(getDb(), {
      key: 'user.name',
      value: 'Діма',
      createdAt: 2000,
      embedding: makeVec(0.5),
    });
    expect(again).toBe(id);
    const row = getDb().prepare('SELECT last_mentioned_at FROM memory_facts WHERE id = ?').get(id) as { last_mentioned_at: number };
    expect(row.last_mentioned_at).toBe(2000);
  });

  it('vectorSearch returns entries sorted by similarity', () => {
    insertEntry(getDb(), { kind: 'user_msg', sourceId: 'a', content: 'apple', createdAt: 1, embedding: makeVec(0.1) });
    insertEntry(getDb(), { kind: 'user_msg', sourceId: 'b', content: 'banana', createdAt: 2, embedding: makeVec(0.9) });
    const hits = vectorSearch(getDb(), { embedding: makeVec(0.1), limit: 2 });
    expect(hits).toHaveLength(2);
    expect(hits[0].content).toBe('apple');
  });
});
```

Note the test has a typo (`insertOrSupersede Fact`) — rename to `insertOrSupersedeFact`. Fix before running.

- [ ] **Step 2: Fix the typo**

In `packages/server/src/memory/__tests__/db.test.ts`, find `insertOrSupersede Fact` on the import line and replace with `insertOrSupersedeFact`.

- [ ] **Step 3: Run test to see it fail**

Run: `cd /Users/dim/code/R2-D2 && npx vitest run packages/server/src/memory/__tests__/db.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 4: Implement db module**

Create `packages/server/src/memory/db.ts`:

```typescript
import type Database from 'better-sqlite3';

export interface InsertEntryParams {
  kind: 'user_msg' | 'assistant_msg' | 'tool_result';
  sourceId: string | null;
  content: string;
  createdAt: number;
  embedding: number[];
}

export interface InsertFactParams {
  key: string;
  value: string;
  createdAt: number;
  embedding: number[];
}

export interface VectorSearchParams {
  embedding: number[];
  limit: number;
  kind?: 'fact' | 'entry' | 'all';
}

export interface EntryHit {
  entityId: number;
  entityType: 'entry' | 'fact';
  score: number;
  content: string;
  kind: string;
  createdAt: number;
}

function toBuffer(vec: number[]): Buffer {
  return Buffer.from(new Float32Array(vec).buffer);
}

export function insertEntry(db: Database.Database, params: InsertEntryParams): number {
  const result = db
    .prepare(
      `INSERT INTO memory_entries (kind, source_id, content, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(params.kind, params.sourceId, params.content, params.createdAt);
  const id = Number(result.lastInsertRowid);

  db.prepare(
    `INSERT INTO memory_vec (entity_id, entity_type, embedding) VALUES (?, 'entry', ?)`,
  ).run(id, toBuffer(params.embedding));

  return id;
}

export function insertOrSupersedeFact(db: Database.Database, params: InsertFactParams): number {
  // Check for active fact with the same key
  const existing = db
    .prepare(
      `SELECT id, value FROM memory_facts
       WHERE key = ? AND superseded_by IS NULL`,
    )
    .get(params.key) as { id: number; value: string } | undefined;

  if (existing && existing.value === params.value) {
    // Same fact — just bump last_mentioned_at
    db.prepare(
      `UPDATE memory_facts SET last_mentioned_at = ? WHERE id = ?`,
    ).run(params.createdAt, existing.id);
    return existing.id;
  }

  // Insert new fact
  const result = db
    .prepare(
      `INSERT INTO memory_facts (key, value, created_at, last_mentioned_at, superseded_by)
       VALUES (?, ?, ?, ?, NULL)`,
    )
    .run(params.key, params.value, params.createdAt, params.createdAt);
  const newId = Number(result.lastInsertRowid);

  // Supersede old fact (different value, same key)
  if (existing) {
    db.prepare(
      `UPDATE memory_facts SET superseded_by = ? WHERE id = ?`,
    ).run(newId, existing.id);
  }

  // Store embedding
  db.prepare(
    `INSERT INTO memory_vec (entity_id, entity_type, embedding) VALUES (?, 'fact', ?)`,
  ).run(newId, toBuffer(params.embedding));

  return newId;
}

export function getActiveFacts(db: Database.Database): Array<{
  id: number;
  key: string;
  value: string;
  lastMentionedAt: number;
}> {
  return db
    .prepare(
      `SELECT id, key, value, last_mentioned_at AS lastMentionedAt
       FROM memory_facts
       WHERE superseded_by IS NULL
       ORDER BY last_mentioned_at DESC`,
    )
    .all() as Array<{ id: number; key: string; value: string; lastMentionedAt: number }>;
}

export function vectorSearch(db: Database.Database, params: VectorSearchParams): EntryHit[] {
  const results = db
    .prepare(
      `SELECT entity_id, entity_type, distance
       FROM memory_vec
       WHERE embedding MATCH ? AND k = ?
       ORDER BY distance`,
    )
    .all(toBuffer(params.embedding), params.limit) as Array<{
      entity_id: number;
      entity_type: string;
      distance: number;
    }>;

  const hits: EntryHit[] = [];
  for (const r of results) {
    if (r.entity_type === 'entry') {
      const row = db
        .prepare('SELECT content, kind, created_at FROM memory_entries WHERE id = ?')
        .get(r.entity_id) as { content: string; kind: string; created_at: number } | undefined;
      if (row) {
        hits.push({
          entityId: r.entity_id,
          entityType: 'entry',
          score: 1 - r.distance,
          content: row.content,
          kind: row.kind,
          createdAt: row.created_at,
        });
      }
    } else if (r.entity_type === 'fact') {
      const row = db
        .prepare('SELECT key, value, created_at FROM memory_facts WHERE id = ?')
        .get(r.entity_id) as { key: string; value: string; created_at: number } | undefined;
      if (row) {
        hits.push({
          entityId: r.entity_id,
          entityType: 'fact',
          score: 1 - r.distance,
          content: `${row.key}: ${row.value}`,
          kind: 'fact',
          createdAt: row.created_at,
        });
      }
    }
  }
  return hits;
}
```

- [ ] **Step 5: Run test to verify pass**

Run: `cd /Users/dim/code/R2-D2 && npx vitest run packages/server/src/memory/__tests__/db.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/memory/db.ts packages/server/src/memory/__tests__/db.test.ts
git commit -m "feat: memory db queries with fact versioning and vector search"
```

---

### Task 6: MemoryService

**Files:**
- Create: `packages/server/src/memory/service.ts`
- Create: `packages/server/src/memory/__tests__/service.test.ts`

- [ ] **Step 1: Write failing test**

Create `packages/server/src/memory/__tests__/service.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { initDb, closeDb, getDb } from '../../db.js';
import { createMemoryService } from '../service.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('MemoryService', () => {
  let tmpDir: string;
  let mockEmbeddings: { embed: ReturnType<typeof vi.fn> };
  let mockOllama: { chat: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-memory-svc-'));
    initDb(path.join(tmpDir, 'test.db'));
    mockEmbeddings = {
      embed: vi.fn().mockImplementation(async (_text: string) => {
        const vec = new Array(768).fill(0);
        vec[0] = Math.random();
        return vec;
      }),
    };
    mockOllama = { chat: vi.fn().mockResolvedValue({ text: '[]' }) };
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('indexTurn stores user, assistant, and tool result entries', async () => {
    const svc = createMemoryService({
      db: getDb(),
      embeddings: mockEmbeddings as any,
      ollama: mockOllama as any,
      extractorModel: 'qwen2.5:7b',
    });

    await svc.indexTurn({
      userMessage: 'привіт',
      assistantMessage: 'вітаю',
      toolResults: [{ id: 't1', name: 'web_search', content: 'some result' }],
      timestamp: 1000,
    });

    const count = getDb().prepare('SELECT COUNT(*) AS c FROM memory_entries').get() as { c: number };
    expect(count.c).toBe(3);
    expect(mockEmbeddings.embed).toHaveBeenCalledTimes(3);
  });

  it('indexTurn extracts and stores facts', async () => {
    mockOllama.chat.mockResolvedValue({
      text: '[{"key":"user.name","value":"Діма"}]',
    });

    const svc = createMemoryService({
      db: getDb(),
      embeddings: mockEmbeddings as any,
      ollama: mockOllama as any,
      extractorModel: 'qwen2.5:7b',
    });

    await svc.indexTurn({
      userMessage: 'мене звати Діма',
      assistantMessage: 'приємно познайомитись',
      toolResults: [],
      timestamp: 1000,
    });

    const facts = await svc.getActiveFacts();
    expect(facts).toEqual([
      expect.objectContaining({ key: 'user.name', value: 'Діма' }),
    ]);
  });

  it('indexTurn truncates tool results > 2000 chars', async () => {
    const svc = createMemoryService({
      db: getDb(),
      embeddings: mockEmbeddings as any,
      ollama: mockOllama as any,
      extractorModel: 'qwen2.5:7b',
    });

    const bigContent = 'x'.repeat(5000);
    await svc.indexTurn({
      userMessage: 'u',
      assistantMessage: 'a',
      toolResults: [{ id: 't1', name: 'big', content: bigContent }],
      timestamp: 1000,
    });

    const row = getDb().prepare("SELECT content FROM memory_entries WHERE kind = 'tool_result'").get() as { content: string };
    expect(row.content.length).toBeLessThanOrEqual(2000);
  });

  it('indexTurn does not throw when embeddings fail', async () => {
    mockEmbeddings.embed.mockRejectedValueOnce(new Error('ollama down'));
    const svc = createMemoryService({
      db: getDb(),
      embeddings: mockEmbeddings as any,
      ollama: mockOllama as any,
      extractorModel: 'qwen2.5:7b',
    });
    await expect(svc.indexTurn({
      userMessage: 'x',
      assistantMessage: 'y',
      toolResults: [],
      timestamp: 1000,
    })).resolves.not.toThrow();
  });

  it('buildContextPrefix returns empty string when memory is empty', async () => {
    const svc = createMemoryService({
      db: getDb(),
      embeddings: mockEmbeddings as any,
      ollama: mockOllama as any,
      extractorModel: 'qwen2.5:7b',
    });
    const prefix = await svc.buildContextPrefix('test');
    expect(prefix).toBe('');
  });

  it('buildContextPrefix injects active facts and entries', async () => {
    // Seed the DB by calling indexTurn
    mockOllama.chat.mockResolvedValue({
      text: '[{"key":"user.location","value":"Одеса"}]',
    });
    const svc = createMemoryService({
      db: getDb(),
      embeddings: mockEmbeddings as any,
      ollama: mockOllama as any,
      extractorModel: 'qwen2.5:7b',
    });

    await svc.indexTurn({
      userMessage: 'я з Одеси',
      assistantMessage: 'круто',
      toolResults: [],
      timestamp: 1000,
    });

    const prefix = await svc.buildContextPrefix('де я живу?');
    expect(prefix).toContain('ПАМ\'ЯТЬ R2');
    expect(prefix).toContain('user.location');
    expect(prefix).toContain('Одеса');
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `cd /Users/dim/code/R2-D2 && npx vitest run packages/server/src/memory/__tests__/service.test.ts`
Expected: FAIL — service.ts does not exist.

- [ ] **Step 3: Implement MemoryService**

Create `packages/server/src/memory/service.ts`:

```typescript
import type Database from 'better-sqlite3';
import type { OllamaClient } from '../ai/ollama.js';
import type { EmbeddingsClient } from './embeddings.js';
import {
  insertEntry,
  insertOrSupersedeFact,
  getActiveFacts,
  vectorSearch,
  type EntryHit,
} from './db.js';
import { extractFacts } from './extractor.js';

export interface MemoryHit {
  text: string;
  kind: 'fact' | 'user_msg' | 'assistant_msg' | 'tool_result';
  score: number;
  timestamp: number;
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

interface MemoryServiceDeps {
  db: Database.Database;
  embeddings: EmbeddingsClient;
  ollama: OllamaClient;
  extractorModel: string;
  maxContextTokens?: number;
}

const TOOL_RESULT_MAX_CHARS = 2000;
const ENTRY_PREVIEW_MAX_CHARS = 300;
const DEFAULT_CONTEXT_BUDGET_CHARS = 8000; // ~2000 tokens approx

export function createMemoryService(deps: MemoryServiceDeps): MemoryService {
  const { db, embeddings, ollama } = deps;
  const contextBudget = (deps.maxContextTokens ?? 2000) * 4;

  async function safeEmbed(text: string): Promise<number[] | null> {
    try {
      return await embeddings.embed(text);
    } catch (err) {
      console.warn('[memory] embed failed:', err instanceof Error ? err.message : err);
      return null;
    }
  }

  async function indexOne(kind: 'user_msg' | 'assistant_msg' | 'tool_result', content: string, sourceId: string | null, createdAt: number): Promise<void> {
    const vec = await safeEmbed(content);
    if (!vec) return;
    try {
      insertEntry(db, { kind, sourceId, content, createdAt, embedding: vec });
    } catch (err) {
      console.warn('[memory] insertEntry failed:', err instanceof Error ? err.message : err);
    }
  }

  return {
    async indexTurn(params) {
      const { userMessage, assistantMessage, toolResults, timestamp } = params;

      // Index entries in parallel — failures are swallowed per item
      await Promise.all([
        indexOne('user_msg', userMessage, null, timestamp),
        indexOne('assistant_msg', assistantMessage, null, timestamp),
        ...toolResults.map((tr) =>
          indexOne(
            'tool_result',
            tr.content.length > TOOL_RESULT_MAX_CHARS
              ? tr.content.slice(0, TOOL_RESULT_MAX_CHARS)
              : tr.content,
            tr.id,
            timestamp,
          ),
        ),
      ]);

      // Extract facts and index them
      const facts = await extractFacts(ollama, {
        userMessage,
        assistantMessage,
        model: deps.extractorModel,
      });

      for (const fact of facts) {
        const factText = `${fact.key}: ${fact.value}`;
        const vec = await safeEmbed(factText);
        if (!vec) continue;
        try {
          insertOrSupersedeFact(db, {
            key: fact.key,
            value: fact.value,
            createdAt: timestamp,
            embedding: vec,
          });
        } catch (err) {
          console.warn('[memory] insertFact failed:', err instanceof Error ? err.message : err);
        }
      }
    },

    async search(params) {
      const { query, kind = 'all', limit = 10 } = params;
      const vec = await safeEmbed(query);
      if (!vec) return [];

      const hits = vectorSearch(db, { embedding: vec, limit: limit * 2 });
      return hits
        .filter((h) => {
          if (kind === 'fact') return h.entityType === 'fact';
          if (kind === 'entry') return h.entityType === 'entry';
          return true;
        })
        .slice(0, limit)
        .map((h): MemoryHit => ({
          text: h.content,
          kind: h.entityType === 'fact' ? 'fact' : (h.kind as 'user_msg' | 'assistant_msg' | 'tool_result'),
          score: h.score,
          timestamp: h.createdAt,
        }));
    },

    async getActiveFacts() {
      return getActiveFacts(db).map((f) => ({
        key: f.key,
        value: f.value,
        lastMentionedAt: f.lastMentionedAt,
      }));
    },

    async buildContextPrefix(userMessage) {
      const vec = await safeEmbed(userMessage);
      if (!vec) return '';

      const facts = getActiveFacts(db);
      const hits = vectorSearch(db, { embedding: vec, limit: 10 });
      const entryHits = hits.filter((h) => h.entityType === 'entry' && h.score >= 0.6).slice(0, 10);

      if (facts.length === 0 && entryHits.length === 0) return '';

      const lines: string[] = ['=== ПАМ\'ЯТЬ R2 ==='];
      if (facts.length > 0) {
        lines.push('Активні факти про юзера:');
        for (const f of facts.slice(0, 20)) {
          const date = new Date(f.lastMentionedAt).toISOString().slice(0, 10);
          lines.push(`- ${f.key}: ${f.value} (оновлено ${date})`);
        }
        lines.push('');
      }
      if (entryHits.length > 0) {
        lines.push('Релевантні попередні розмови:');
        for (const h of entryHits) {
          const date = new Date(h.createdAt).toISOString().slice(0, 10);
          const preview = h.content.length > ENTRY_PREVIEW_MAX_CHARS
            ? h.content.slice(0, ENTRY_PREVIEW_MAX_CHARS) + '...'
            : h.content;
          const label = h.kind === 'user_msg' ? 'Юзер' : h.kind === 'assistant_msg' ? 'R2' : h.kind;
          lines.push(`[${date}] ${label}: ${preview}`);
        }
      }
      lines.push('=== КОНЕЦ ПАМ\'ЯТІ ===');

      let prefix = lines.join('\n');
      if (prefix.length > contextBudget) {
        prefix = prefix.slice(0, contextBudget) + '\n...';
      }
      return prefix;
    },
  };
}
```

- [ ] **Step 4: Run test**

Run: `cd /Users/dim/code/R2-D2 && npx vitest run packages/server/src/memory/__tests__/service.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/memory/service.ts packages/server/src/memory/__tests__/service.test.ts
git commit -m "feat: MemoryService orchestrates indexing, search, context prefix"
```

---

### Task 7: Wire MemoryService into server

**Files:**
- Modify: `packages/server/src/index.ts`
- Modify: `packages/server/src/tools/base.ts`
- Modify: `packages/server/src/ai/router.ts`
- Modify: `packages/server/src/routes/chat.ts`

- [ ] **Step 1: Add memoryService to ToolDeps**

In `packages/server/src/tools/base.ts`, update `ToolDeps` interface:

```typescript
import type { MemoryService } from '../memory/service.js';

export interface ToolDeps {
  runLoop: RunLoopFn;
  client: ClaudeClient;
  registry: ToolRegistry;
  piiProxy: PiiProxy;
  memoryService: MemoryService;
}
```

- [ ] **Step 2: Instantiate MemoryService in index.ts**

In `packages/server/src/index.ts`, add imports near the existing ones:

```typescript
import { createEmbeddingsClient } from './memory/embeddings.js';
import { createMemoryService, type MemoryService } from './memory/service.js';
import { getDb } from './db.js';
```

After `const registry = createRegistry();` (around line 83), add:

```typescript
const memoryEnabled = (process.env.MEMORY_ENABLED ?? 'true') !== 'false';
let memoryService: MemoryService | null = null;
if (memoryEnabled && ollama) {
  const embeddings = createEmbeddingsClient({
    url: process.env.OLLAMA_URL || 'http://localhost:11434',
    model: process.env.MEMORY_EMBED_MODEL || 'nomic-embed-text',
  });
  memoryService = createMemoryService({
    db: getDb(),
    embeddings,
    ollama,
    extractorModel: process.env.MEMORY_EXTRACT_MODEL || 'qwen2.5:7b',
    maxContextTokens: Number(process.env.MEMORY_MAX_CONTEXT_TOKENS) || 2000,
  });
  console.log('[memory] enabled with model', process.env.MEMORY_EMBED_MODEL || 'nomic-embed-text');
} else {
  console.log('[memory] disabled');
}
```

Update `discoverTools` call to pass memoryService:

```typescript
await discoverTools(registry, {
  runLoop: runLoopFn,
  client,
  registry,
  piiProxy,
  memoryService: memoryService!,
});
```

Update `createChatRouter` call to pass memoryService:

```typescript
const chatRouter = createChatRouter({
  runLoop: ({ messages, onEvent, signal, pendingConfirms: pc, pendingPlanReviews: ppr, piiProxy: pp }) =>
    runToolLoop({ messages, client, registry, onEvent, signal, pendingConfirms: pc, pendingPlanReviews: ppr, piiProxy: pp }),
  pendingConfirms,
  pendingPlanReviews,
  piiProxy,
  ollama,
  registry,
  memoryService,
});
```

- [ ] **Step 3: Add memoryService to router and auto-retrieval**

In `packages/server/src/ai/router.ts`, update `RunChatRequestParams` to include `memoryService`:

```typescript
import type { MemoryService } from '../memory/service.js';

export interface RunChatRequestParams {
  messages: MessageParam[];
  onEvent: (event: SSEEvent) => void;
  signal?: AbortSignal;
  pendingConfirms?: PendingConfirms;
  pendingPlanReviews?: PendingPlanReviews;
  piiProxy: PiiProxy;
  ollama: OllamaClient | null;
  registry: ToolRegistry;
  memoryService: MemoryService | null;
  forceProvider?: 'claude';
  runLoop: (params: {
    messages: MessageParam[];
    onEvent: (event: SSEEvent) => void;
    signal?: AbortSignal;
    pendingConfirms?: PendingConfirms;
    pendingPlanReviews?: PendingPlanReviews;
    piiProxy: PiiProxy;
  }) => Promise<void>;
}
```

In `runChatRequest`, before the `params.ollama.chat` call (around where `getLocalSystemPrompt(toolSummary)` is built), prepend memory context:

```typescript
    const basePrompt = getLocalSystemPrompt(toolSummary);
    let systemPrompt = basePrompt;
    if (params.memoryService) {
      const lastUserMsg = params.messages[params.messages.length - 1];
      const userText = typeof lastUserMsg?.content === 'string' ? lastUserMsg.content : '';
      if (userText) {
        try {
          const prefix = await params.memoryService.buildContextPrefix(userText);
          if (prefix) systemPrompt = prefix + '\n\n' + basePrompt;
        } catch (err) {
          console.warn('[router] memory context failed:', err instanceof Error ? err.message : err);
        }
      }
    }

    const result = await params.ollama.chat({
      messages: params.messages,
      system: systemPrompt,
      signal: params.signal,
      tools: ollamaToolDefs.length > 0 ? ollamaToolDefs : undefined,
    });
```

Similarly, update `callClaudeFallback` to inject memory prefix into Claude's system prompt. Modify `callClaudeFallback`:

```typescript
async function callClaudeFallback(params: RunChatRequestParams): Promise<void> {
  if (!params.signal?.aborted) {
    params.onEvent({ type: 'assistant_source', source: 'claude' });
  }
  // Note: Claude uses its own prompt via tool-loop.ts. Memory context is
  // passed through by rewriting the first user message to include it.
  // This keeps the change surface small — tool-loop does not need to know
  // about memory.
  let messagesForClaude = params.messages;
  if (params.memoryService && params.messages.length > 0) {
    const lastUserIdx = [...params.messages].reverse().findIndex((m) => m.role === 'user');
    if (lastUserIdx !== -1) {
      const idx = params.messages.length - 1 - lastUserIdx;
      const msg = params.messages[idx];
      const userText = typeof msg.content === 'string' ? msg.content : '';
      if (userText) {
        try {
          const prefix = await params.memoryService.buildContextPrefix(userText);
          if (prefix) {
            const rewritten = [...params.messages];
            rewritten[idx] = { ...msg, content: `${prefix}\n\n${userText}` };
            messagesForClaude = rewritten;
          }
        } catch (err) {
          console.warn('[router] memory context failed for claude:', err instanceof Error ? err.message : err);
        }
      }
    }
  }

  await params.runLoop({
    messages: messagesForClaude,
    onEvent: params.onEvent,
    signal: params.signal,
    pendingConfirms: params.pendingConfirms,
    pendingPlanReviews: params.pendingPlanReviews,
    piiProxy: params.piiProxy,
  });
}
```

- [ ] **Step 4: Call indexTurn from chat route**

In `packages/server/src/routes/chat.ts`, update `ChatRouterDeps`:

```typescript
import type { MemoryService } from '../memory/service.js';

interface ChatRouterDeps {
  runLoop: (params: {
    messages: MessageParam[];
    onEvent: (event: SSEEvent) => void;
    signal?: AbortSignal;
    pendingConfirms?: PendingConfirms;
    pendingPlanReviews?: PendingPlanReviews;
    piiProxy: PiiProxy;
  }) => Promise<void>;
  pendingConfirms: PendingConfirms;
  pendingPlanReviews: PendingPlanReviews;
  piiProxy: PiiProxy;
  ollama: OllamaClient | null;
  registry: ToolRegistry;
  memoryService: MemoryService | null;
}
```

Destructure `memoryService` in the router factory and pass it to `runChatRequest`:

```typescript
export function createChatRouter({ runLoop, pendingConfirms, pendingPlanReviews, piiProxy, ollama, registry, memoryService }: ChatRouterDeps): Router {
```

Find the `await runChatRequest({...})` call and add `memoryService`:

```typescript
      await runChatRequest({
        messages: addTimestamps(messages),
        signal: abortController.signal,
        pendingConfirms,
        pendingPlanReviews,
        piiProxy,
        ollama,
        registry,
        memoryService,
        runLoop,
        onEvent: (event: SSEEvent) => {
          // ... existing handler
        },
      });
```

In the `case 'done':` handler, add indexing call after `saveMessage`:

```typescript
          } else if (event.type === 'done') {
            if (assistantText || assistantToolCalls.length > 0) {
              try {
                saveMessage({
                  messageId: assistantId,
                  role: 'assistant',
                  content: assistantText,
                  toolCalls: assistantToolCalls.length > 0 ? assistantToolCalls : undefined,
                  piiEntities: assistantPiiEntities,
                  timestamp: Date.now(),
                  source: assistantSource,
                });
              } catch (err) {
                console.error('Failed to save assistant message:', err instanceof Error ? err.message : err);
              }

              // Background memory indexing — do not block the response
              if (memoryService) {
                const lastUserMsg = messages[messages.length - 1];
                const userText = typeof lastUserMsg?.content === 'string' ? lastUserMsg.content : '';
                const toolResults = assistantToolCalls
                  .filter((tc) => tc.result && tc.result.success)
                  .map((tc) => ({
                    id: tc.id,
                    name: tc.name,
                    content: typeof tc.result?.data === 'string'
                      ? tc.result.data
                      : JSON.stringify(tc.result?.data ?? ''),
                  }));
                memoryService
                  .indexTurn({
                    userMessage: userText,
                    assistantMessage: assistantText,
                    toolResults,
                    timestamp: Date.now(),
                  })
                  .catch((err) => console.warn('[memory] indexTurn failed:', err instanceof Error ? err.message : err));
              }
            }
          }
```

- [ ] **Step 5: Build server**

Run: `cd /Users/dim/code/R2-D2 && npm run build -w packages/server`
Expected: PASS — no TypeScript errors.

- [ ] **Step 6: Run full server test suite**

Run: `cd /Users/dim/code/R2-D2 && npx vitest run packages/server`
Expected: PASS — all existing tests + new memory tests.

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/tools/base.ts packages/server/src/index.ts packages/server/src/ai/router.ts packages/server/src/routes/chat.ts
git commit -m "feat: wire MemoryService into router, chat route, tool deps"
```

---

### Task 8: memory_search tool package

**Files:**
- Create: `packages/tool-memory/package.json`
- Create: `packages/tool-memory/tsconfig.json`
- Create: `packages/tool-memory/src/index.ts`

- [ ] **Step 1: Create package.json**

Create `packages/tool-memory/package.json`:

```json
{
  "name": "@r2/tool-memory",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc"
  },
  "dependencies": {
    "@r2/shared": "*"
  },
  "devDependencies": {
    "typescript": "^5.7.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

Create `packages/tool-memory/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create tool implementation**

Create `packages/tool-memory/src/index.ts`:

```typescript
import type { ToolDefinition, ToolResult } from '@r2/shared';

interface MemoryServiceLike {
  search(params: {
    query: string;
    kind?: 'fact' | 'entry' | 'all';
    limit?: number;
  }): Promise<Array<{
    text: string;
    kind: string;
    score: number;
    timestamp: number;
  }>>;
}

export function createTool(deps: { memoryService: MemoryServiceLike | null }): ToolDefinition {
  return {
    name: 'memory_search',
    description: 'Search R2 memory for relevant facts and past conversations. Use when you need to recall what the user told you before, what was done in past tasks, or to verify facts about the user.',
    permissionLevel: 'auto',
    provider: 'all',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Semantic search query in natural language',
        },
        kind: {
          type: 'string',
          enum: ['fact', 'entry', 'all'],
          description: 'Filter by result kind. fact = structured user facts, entry = past messages/tool results, all = both (default).',
        },
        limit: {
          type: 'number',
          description: 'Max results (default 10, max 50)',
        },
      },
      required: ['query'],
    },
    command: {
      name: 'память',
      description: 'Пошук у пам\'яті R2',
      params: [{ name: 'query', required: true, description: 'Що шукати' }],
    },
    async handler(params: Record<string, unknown>): Promise<ToolResult> {
      if (!deps.memoryService) {
        return { success: false, error: 'Memory service is disabled' };
      }
      const query = typeof params.query === 'string' ? params.query : '';
      if (!query) {
        return { success: false, error: 'query parameter is required' };
      }
      const kind = params.kind === 'fact' || params.kind === 'entry' ? params.kind : 'all';
      const rawLimit = Number(params.limit);
      const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 10, 1), 50);

      try {
        const hits = await deps.memoryService.search({ query, kind, limit });
        if (hits.length === 0) {
          return {
            success: true,
            data: [],
            display: { type: 'text', content: 'Нічого не знайдено в пам\'яті.' },
          };
        }
        const lines = hits.map((h) => {
          const date = new Date(h.timestamp).toISOString().slice(0, 10);
          return `[${date}] (${h.kind}, ${h.score.toFixed(2)}) ${h.text.slice(0, 200)}`;
        });
        return {
          success: true,
          data: hits,
          display: { type: 'text', content: lines.join('\n') },
        };
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'memory_search failed',
        };
      }
    },
  };
}

export default createTool;
```

- [ ] **Step 4: Install package in workspace**

Run: `cd /Users/dim/code/R2-D2 && npm install`
Expected: `@r2/tool-memory` linked into the workspace.

- [ ] **Step 5: Build**

Run: `cd /Users/dim/code/R2-D2 && npm run build -w packages/tool-memory`
Expected: PASS — creates `packages/tool-memory/dist/`.

- [ ] **Step 6: Full build to verify discovery**

Run: `cd /Users/dim/code/R2-D2 && npm run build -w packages/server`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/tool-memory/
git commit -m "feat: add memory_search tool package"
```

---

### Task 9: Configuration and docs

**Files:**
- Modify: `.env.example`
- Modify: `AGENTS.md`

- [ ] **Step 1: Add memory env vars to .env.example**

In `/Users/dim/code/R2-D2/.env.example`, append:

```
# Memory system — indexes chat history into local vector DB (sqlite-vec + Ollama embeddings)
MEMORY_ENABLED=true
MEMORY_EMBED_MODEL=nomic-embed-text
MEMORY_EXTRACT_MODEL=qwen2.5:7b
MEMORY_MAX_CONTEXT_TOKENS=2000
```

- [ ] **Step 2: Document in AGENTS.md**

In `/Users/dim/code/R2-D2/AGENTS.md`, add a new section (find the section about Presidio and add memory after it):

```markdown
### Memory System

R2 remembers past conversations via a local vector database. Every chat turn is embedded with `nomic-embed-text` (via Ollama) and stored in sqlite-vec tables inside `data/r2.db`. Ollama also extracts structured facts about the user (`user.location`, `user.phone`, etc.) with versioning — when a fact changes, the old one is marked superseded and history is preserved.

Read path has two channels:
- **Auto-retrieval**: before every LLM call, router injects relevant memories into the system prompt (top 10 entries + all active facts, ≤2000 tokens).
- **Tool**: `memory_search` lets the model dig deeper on demand. Available to both Ollama and Claude.

Configuration via env vars:
- `MEMORY_ENABLED=true` — kill switch
- `MEMORY_EMBED_MODEL=nomic-embed-text` — embedding model
- `MEMORY_EXTRACT_MODEL=qwen2.5:7b` — fact extractor model
- `MEMORY_MAX_CONTEXT_TOKENS=2000` — budget for auto-retrieval prefix

Memory starts empty on first deploy — pre-existing `chat_messages` are NOT re-indexed.
```

- [ ] **Step 3: Commit**

```bash
git add .env.example AGENTS.md
git commit -m "docs: document memory system configuration and usage"
```

---

### Task 10: End-to-end smoke test

**Files:** none (verification only)

- [ ] **Step 1: Full build**

Run: `cd /Users/dim/code/R2-D2 && npm run build`
Expected: PASS — all packages compile.

- [ ] **Step 2: Run full test suite**

Run: `cd /Users/dim/code/R2-D2 && npx vitest run`
Expected: PASS — all tests including new memory tests.

- [ ] **Step 3: Manual test with running server**

Start the dev server: `cd /Users/dim/code/R2-D2 && npm run dev`

Test scenarios in the chat:
1. Send: "мене звати Діма, я живу в Одесі"
2. Check logs for `[memory] enabled` and no index errors
3. Start a new conversation (clear messages or wait): "як мене звати?"
4. Expected: R2 references "Діма" from memory (auto-retrieval)
5. Run `/память Одеса` → memory_search should return the fact
6. Send: "я переїхав до Києва"
7. Send: "де я зараз живу?"
8. Expected: R2 says "Київ" (superseded fact works)

- [ ] **Step 4: Verify DB state**

Run: `sqlite3 /Users/dim/code/R2-D2/data/r2.db "SELECT key, value, superseded_by FROM memory_facts ORDER BY id"`
Expected: two rows for `user.location` — first with `superseded_by` set to second's id, second with `superseded_by` NULL.
