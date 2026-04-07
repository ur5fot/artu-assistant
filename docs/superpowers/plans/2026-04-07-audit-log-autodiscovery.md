# Phase 2A: Audit Log + Tool Auto-Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add SQLite audit logging for every tool call and automatic tool discovery from `packages/tool-*` at server startup.

**Architecture:** New `db.ts` module in server handles SQLite connection, table creation, cleanup, and logging. Registry gains `discoverTools()` that scans filesystem for tool packages. Tool loop calls `logToolCall()` after each handler execution. Manual tool registration in `index.ts` replaced with auto-discovery.

**Tech Stack:** better-sqlite3, Node.js fs/path, Vitest

**Spec:** `docs/superpowers/specs/2026-04-07-audit-log-autodiscovery-design.md`

---

## File Map

```
packages/server/
├── package.json                              # Add better-sqlite3 dependency
├── src/
│   ├── index.ts                              # Replace manual tool registration with discoverTools()
│   ├── db.ts                                 # NEW: SQLite connection, initDb, logToolCall, cleanup
│   ├── db.test.ts                            # NEW: Tests for db module
│   ├── ai/
│   │   ├── tool-loop.ts                      # Add audit logging after tool execution
│   │   └── __tests__/tool-loop.test.ts       # Add test for audit log integration
│   └── tools/
│       ├── registry.ts                       # Add discoverTools() function
│       └── __tests__/registry.test.ts        # Add tests for auto-discovery
```

---

## Task 1: Add better-sqlite3 Dependency

**Files:**
- Modify: `packages/server/package.json`

- [ ] **Step 1: Add better-sqlite3 to server dependencies**

Edit `packages/server/package.json` — add to `dependencies`:

```json
"better-sqlite3": "^11.8.0"
```

And add to `devDependencies`:

```json
"@types/better-sqlite3": "^7.6.12"
```

- [ ] **Step 2: Install dependencies**

```bash
cd /Users/dim/code/R2-D2 && npm install
```

Expected: clean install, no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/server/package.json package-lock.json
git commit -m "chore: add better-sqlite3 dependency"
```

---

## Task 2: Database Module — Init + Cleanup

**Files:**
- Create: `packages/server/src/db.ts`
- Test: `packages/server/src/db.test.ts`

- [ ] **Step 1: Write failing tests for db module**

Create `packages/server/src/db.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initDb, logToolCall, cleanupAuditLog, getDb, closeDb } from './db.js';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

describe('Database Module', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-test-'));
    dbPath = path.join(tmpDir, 'test.db');
    initDb(dbPath);
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('initDb', () => {
    it('creates audit_log table', () => {
      const db = getDb();
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='audit_log'"
      ).all();
      expect(tables).toHaveLength(1);
    });
  });

  describe('logToolCall', () => {
    it('inserts a record with correct fields', () => {
      logToolCall({
        toolName: 'web_search',
        input: { query: 'test' },
        result: { success: true, data: 'results' },
        success: true,
        durationMs: 150,
      });

      const db = getDb();
      const rows = db.prepare('SELECT * FROM audit_log').all() as any[];
      expect(rows).toHaveLength(1);
      expect(rows[0].tool_name).toBe('web_search');
      expect(JSON.parse(rows[0].input)).toEqual({ query: 'test' });
      expect(JSON.parse(rows[0].result)).toEqual({ success: true, data: 'results' });
      expect(rows[0].success).toBe(1);
      expect(rows[0].duration_ms).toBe(150);
      expect(rows[0].created_at).toBeTruthy();
    });
  });

  describe('cleanupAuditLog', () => {
    it('deletes records older than 30 days', () => {
      const db = getDb();
      const insert = db.prepare(
        `INSERT INTO audit_log (tool_name, input, result, success, duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      );
      // Insert old record (60 days ago)
      insert.run('old_tool', '{}', '{}', 1, 10, '2026-02-06T00:00:00');
      // Insert recent record
      insert.run('new_tool', '{}', '{}', 1, 10, new Date().toISOString());

      cleanupAuditLog();

      const rows = db.prepare('SELECT * FROM audit_log').all() as any[];
      expect(rows).toHaveLength(1);
      expect(rows[0].tool_name).toBe('new_tool');
    });

    it('keeps only latest 10000 when over limit', () => {
      const db = getDb();
      const insert = db.prepare(
        `INSERT INTO audit_log (tool_name, input, result, success, duration_ms)
         VALUES (?, ?, ?, ?, ?)`
      );
      // Insert 10005 records in a transaction
      const insertMany = db.transaction(() => {
        for (let i = 0; i < 10005; i++) {
          insert.run(`tool_${i}`, '{}', '{}', 1, 10);
        }
      });
      insertMany();

      cleanupAuditLog();

      const count = db.prepare('SELECT COUNT(*) as c FROM audit_log').get() as any;
      expect(count.c).toBe(10000);

      // Verify the oldest 5 were deleted (tool_0 through tool_4)
      const oldest = db.prepare(
        'SELECT tool_name FROM audit_log ORDER BY id ASC LIMIT 1'
      ).get() as any;
      expect(oldest.tool_name).toBe('tool_5');
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run packages/server/src/db.test.ts
```

Expected: FAIL — `db.ts` does not exist.

- [ ] **Step 3: Implement db module**

Create `packages/server/src/db.ts`:

```typescript
import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

let db: Database.Database | null = null;

export function initDb(dbPath?: string): void {
  const resolvedPath = dbPath ?? (process.env.DB_PATH || './data/r2.db');
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  db = new Database(resolvedPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tool_name TEXT NOT NULL,
      input TEXT NOT NULL,
      result TEXT NOT NULL,
      success INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

export function getDb(): Database.Database {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

interface LogToolCallParams {
  toolName: string;
  input: Record<string, unknown>;
  result: unknown;
  success: boolean;
  durationMs: number;
}

export function logToolCall(params: LogToolCallParams): void {
  const d = getDb();
  d.prepare(
    `INSERT INTO audit_log (tool_name, input, result, success, duration_ms)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    params.toolName,
    JSON.stringify(params.input),
    JSON.stringify(params.result),
    params.success ? 1 : 0,
    params.durationMs,
  );
}

export function cleanupAuditLog(): void {
  const d = getDb();
  // Delete records older than 30 days
  d.prepare("DELETE FROM audit_log WHERE created_at < datetime('now', '-30 days')").run();
  // Keep only latest 10000
  d.prepare(
    'DELETE FROM audit_log WHERE id NOT IN (SELECT id FROM audit_log ORDER BY id DESC LIMIT 10000)'
  ).run();
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run packages/server/src/db.test.ts
```

Expected: 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/db.ts packages/server/src/db.test.ts
git commit -m "feat: add SQLite database module with audit log and cleanup"
```

---

## Task 3: Integrate Audit Logging into Tool Loop

**Files:**
- Modify: `packages/server/src/ai/tool-loop.ts`
- Modify: `packages/server/src/ai/__tests__/tool-loop.test.ts`

- [ ] **Step 1: Write failing test for audit log integration**

Add to `packages/server/src/ai/__tests__/tool-loop.test.ts` — new import and test:

Add at the top, after existing imports:

```typescript
import { initDb, getDb, closeDb } from '../../db.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
```

Add a new describe block after the existing `'Agentic Tool Loop'` describe:

```typescript
describe('Agentic Tool Loop — Audit Logging', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-loop-test-'));
    initDb(path.join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('logs tool call to audit_log after execution', async () => {
    const client = mockClaudeClient([
      {
        content: [
          { type: 'tool_use', id: 'call_1', name: 'search', input: { query: 'test' } },
        ],
        stop_reason: 'tool_use',
      },
      {
        content: [{ type: 'text', text: 'Done.' }],
        stop_reason: 'end_turn',
      },
    ]);

    const registry = mockRegistry({
      search: () => ({ success: true, data: 'results' }),
    });

    await runToolLoop({
      messages: [{ role: 'user', content: 'Search' }],
      client,
      registry,
      onEvent: () => {},
    });

    const db = getDb();
    const rows = db.prepare('SELECT * FROM audit_log').all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].tool_name).toBe('search');
    expect(rows[0].success).toBe(1);
    expect(rows[0].duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('logs failed tool call to audit_log', async () => {
    const client = mockClaudeClient([
      {
        content: [
          { type: 'tool_use', id: 'call_err', name: 'search', input: { query: 'fail' } },
        ],
        stop_reason: 'tool_use',
      },
      {
        content: [{ type: 'text', text: 'Error.' }],
        stop_reason: 'end_turn',
      },
    ]);

    const registry = mockRegistry({
      search: () => { throw new Error('API down'); },
    });

    await runToolLoop({
      messages: [{ role: 'user', content: 'Search' }],
      client,
      registry,
      onEvent: () => {},
    });

    const db = getDb();
    const rows = db.prepare('SELECT * FROM audit_log').all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].tool_name).toBe('search');
    expect(rows[0].success).toBe(0);
    expect(rows[0].duration_ms).toBeGreaterThanOrEqual(0);
  });
});
```

Also add `beforeEach` import to the top-level import line:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run packages/server/src/ai/__tests__/tool-loop.test.ts
```

Expected: FAIL — `logToolCall` not called in tool-loop.ts, no rows in audit_log.

- [ ] **Step 3: Add audit logging to tool-loop.ts**

Edit `packages/server/src/ai/tool-loop.ts`. Add import at the top:

```typescript
import { logToolCall } from '../db.js';
```

Replace the tool execution block (lines 82-90) — the section inside `for (const block of toolUseBlocks)` where `toolDef` is found:

Replace:
```typescript
      if (toolDef) {
        try {
          result = await toolDef.handler(block.input as Record<string, unknown>);
        } catch (err) {
          result = {
            success: false,
            error: err instanceof Error ? err.message : 'Unknown error',
          };
        }
      } else {
        result = { success: false, error: `Unknown tool: ${block.name}` };
      }
```

With:
```typescript
      const startTime = Date.now();
      if (toolDef) {
        try {
          result = await toolDef.handler(block.input as Record<string, unknown>);
        } catch (err) {
          result = {
            success: false,
            error: err instanceof Error ? err.message : 'Unknown error',
          };
        }
      } else {
        result = { success: false, error: `Unknown tool: ${block.name}` };
      }
      const durationMs = Date.now() - startTime;

      try {
        logToolCall({
          toolName: block.name,
          input: block.input as Record<string, unknown>,
          result,
          success: result.success,
          durationMs,
        });
      } catch {
        // Audit log failure should not break the tool loop
      }
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run packages/server/src/ai/__tests__/tool-loop.test.ts
```

Expected: all tests PASS (existing 8 + new 2 = 10 tests).

Note: Existing tests that don't call `initDb()` will still pass because `logToolCall` is wrapped in try/catch — it will silently fail when db is not initialized, which is correct behavior.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/ai/tool-loop.ts packages/server/src/ai/__tests__/tool-loop.test.ts
git commit -m "feat: integrate audit logging into tool loop"
```

---

## Task 4: Tool Auto-Discovery

**Files:**
- Modify: `packages/server/src/tools/registry.ts`
- Modify: `packages/server/src/tools/__tests__/registry.test.ts`

- [ ] **Step 1: Write failing tests for discoverTools**

Add to `packages/server/src/tools/__tests__/registry.test.ts` — new imports and test block.

Replace the entire file with:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRegistry, discoverTools } from '../registry.js';
import type { ToolDefinition } from '../base.js';
import path from 'node:path';
import fs from 'node:fs';

const mockTool: ToolDefinition = {
  name: 'test_tool',
  description: 'A test tool',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
  },
  handler: async () => ({ success: true, data: 'ok' }),
};

describe('Tool Registry', () => {
  it('registers and retrieves a tool', () => {
    const registry = createRegistry();
    registry.register(mockTool);
    expect(registry.getAll()).toHaveLength(1);
    expect(registry.get('test_tool')).toBe(mockTool);
  });

  it('returns undefined for unknown tool', () => {
    const registry = createRegistry();
    expect(registry.get('nonexistent')).toBeUndefined();
  });

  it('prevents duplicate registration', () => {
    const registry = createRegistry();
    registry.register(mockTool);
    expect(() => registry.register(mockTool)).toThrow('already registered');
  });
});

describe('discoverTools', () => {
  it('discovers and registers tool packages from packages/tool-*', async () => {
    const packagesDir = path.resolve(process.cwd(), 'packages');
    // tool-web-search should exist from Phase 1
    const hasWebSearch = fs.existsSync(path.join(packagesDir, 'tool-web-search'));
    if (!hasWebSearch) return; // skip if not in full repo context

    const registry = await discoverTools();
    const tools = registry.getAll();
    expect(tools.length).toBeGreaterThanOrEqual(1);
    expect(tools.some((t) => t.name === 'web_search')).toBe(true);
  });

  it('returns empty registry when no tool packages exist', async () => {
    // Pass a directory with no tool-* packages
    const registry = await discoverTools('/tmp/nonexistent-dir-r2-test');
    expect(registry.getAll()).toHaveLength(0);
  });

  it('skips broken tool packages without crashing', async () => {
    // Create a temp directory with a broken tool
    const tmpDir = fs.mkdtempSync(path.join('/tmp', 'r2-discover-test-'));
    const brokenToolDir = path.join(tmpDir, 'tool-broken');
    fs.mkdirSync(brokenToolDir);
    fs.writeFileSync(path.join(brokenToolDir, 'package.json'), '{"name":"@r2/tool-broken","main":"src/index.ts"}');
    fs.mkdirSync(path.join(brokenToolDir, 'src'));
    fs.writeFileSync(path.join(brokenToolDir, 'src', 'index.ts'), 'throw new Error("broken");');

    // Should not throw
    const registry = await discoverTools(tmpDir);
    expect(registry.getAll()).toHaveLength(0);

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run tests to verify new tests fail**

```bash
npx vitest run packages/server/src/tools/__tests__/registry.test.ts
```

Expected: existing 3 PASS, new `discoverTools` tests FAIL — function doesn't exist.

- [ ] **Step 3: Implement discoverTools**

Edit `packages/server/src/tools/registry.ts`. Replace entire file:

```typescript
import type { ToolDefinition } from './base.js';
import fs from 'node:fs';
import path from 'node:path';

export interface ToolRegistry {
  register(tool: ToolDefinition): void;
  get(name: string): ToolDefinition | undefined;
  getAll(): ToolDefinition[];
}

export function createRegistry(): ToolRegistry {
  const tools = new Map<string, ToolDefinition>();

  return {
    register(tool: ToolDefinition): void {
      if (tools.has(tool.name)) {
        throw new Error(`Tool "${tool.name}" already registered`);
      }
      tools.set(tool.name, tool);
    },

    get(name: string): ToolDefinition | undefined {
      return tools.get(name);
    },

    getAll(): ToolDefinition[] {
      return [...tools.values()];
    },
  };
}

export async function discoverTools(packagesDir?: string): Promise<ToolRegistry> {
  const registry = createRegistry();
  const dir = packagesDir ?? path.resolve(process.cwd(), 'packages');

  let entries: string[];
  try {
    entries = fs.readdirSync(dir).filter((name) => name.startsWith('tool-'));
  } catch {
    return registry;
  }

  for (const entry of entries) {
    const toolPackageName = `@r2/${entry}`;
    try {
      const mod = await import(toolPackageName);
      const tool: ToolDefinition = mod.default;
      if (tool && typeof tool.name === 'string' && typeof tool.handler === 'function') {
        registry.register(tool);
        console.log(`  Tool discovered: ${tool.name} (${entry})`);
      }
    } catch (err) {
      console.error(`  Failed to load tool ${entry}:`, err instanceof Error ? err.message : err);
    }
  }

  console.log(`Tools loaded: ${registry.getAll().length}`);
  return registry;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run packages/server/src/tools/__tests__/registry.test.ts
```

Expected: 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/tools/registry.ts packages/server/src/tools/__tests__/registry.test.ts
git commit -m "feat: add tool auto-discovery from packages/tool-*"
```

---

## Task 5: Wire Everything into Server Entry Point

**Files:**
- Modify: `packages/server/src/index.ts`
- Modify: `packages/server/package.json`

- [ ] **Step 1: Update server entry point**

Replace `packages/server/src/index.ts` entirely:

```typescript
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createChatRouter } from './routes/chat.js';
import { createClaudeClient } from './ai/claude.js';
import { runToolLoop } from './ai/tool-loop.js';
import { discoverTools } from './tools/registry.js';
import { initDb, cleanupAuditLog } from './db.js';
import { errorHandler } from './errors.js';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: `http://localhost:${process.env.CLIENT_PORT || 5173}` }));
app.use(express.json({ limit: '10mb' }));

// Initialize database
initDb();
cleanupAuditLog();

// Setup
const client = createClaudeClient();
const registry = await discoverTools();

const chatRouter = createChatRouter({
  runLoop: ({ messages, onEvent, signal }) =>
    runToolLoop({ messages, client, registry, onEvent, signal }),
});

app.use('/api', chatRouter);

app.get('/api/health', (_req, res) => {
  res.json({ status: 'R2 online', timestamp: new Date().toISOString() });
});

app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`R2 server running on http://localhost:${PORT}`);
});
```

- [ ] **Step 2: Remove @r2/tool-web-search from server dependencies**

Edit `packages/server/package.json` — remove this line from `dependencies`:

```json
"@r2/tool-web-search": "*",
```

- [ ] **Step 3: Run npm install to update lockfile**

```bash
cd /Users/dim/code/R2-D2 && npm install
```

- [ ] **Step 4: Run all tests**

```bash
npm test
```

Expected: all tests pass (existing + new).

- [ ] **Step 5: Typecheck all packages**

```bash
npx tsc --noEmit -p packages/server/tsconfig.json && \
npx tsc --noEmit -p packages/shared/tsconfig.json && \
npx tsc --noEmit -p packages/tool-web-search/tsconfig.json && \
npx tsc --noEmit -p packages/client/tsconfig.json
```

Expected: no type errors.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/index.ts packages/server/package.json package-lock.json
git commit -m "feat: wire audit log and auto-discovery into server startup"
```
