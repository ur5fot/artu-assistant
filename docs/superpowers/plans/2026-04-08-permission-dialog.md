# Phase 2D: Permission Dialog — План реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Цель:** Inline карточка подтверждения в чате для tools с `confirm`/`forbidden`, с запоминанием решений в SQLite.

**Архитектура:** Tool loop при `confirm`/`forbidden` отправляет SSE `tool_confirm_request` и ждёт ответа через Promise. Клиент показывает карточку с кнопками, отправляет решение на `POST /api/confirm`. Сервер resolve'ит Promise и продолжает loop. Решения можно запоминать в `permission_rules` таблице.

**Стек:** Express, React, SSE, SQLite (better-sqlite3), Vitest

**Спек:** `docs/superpowers/specs/2026-04-08-permission-dialog-design.md`

---

## Карта файлов

```
packages/
├── shared/src/
│   ├── types.ts                                    # Добавить tool_confirm_request в SSEEvent
│   └── index.ts                                    # Re-export (без изменений)
├── server/src/
│   ├── db.ts                                       # Добавить permission_rules таблицу + функции
│   ├── db.test.ts                                  # Тесты permission rules
│   ├── ai/
│   │   ├── tool-loop.ts                            # Заменить блокировку на confirm flow
│   │   └── __tests__/tool-loop.test.ts             # Тесты confirm/forbidden flow
│   ├── routes/
│   │   ├── chat.ts                                 # Передать pendingConfirms в runLoop
│   │   ├── confirm.ts                              # НОВЫЙ: POST /api/confirm
│   │   ├── permissions.ts                          # НОВЫЙ: DELETE /api/permissions
│   │   └── __tests__/
│   │       ├── confirm.test.ts                     # НОВЫЙ: тесты confirm route
│   │       └── permissions.test.ts                 # НОВЫЙ: тесты permissions route
│   └── index.ts                                    # Подключить новые routes
└── client/src/
    ├── components/
    │   └── PermissionCard.tsx                       # НОВЫЙ: карточка подтверждения
    └── hooks/
        └── useChat.ts                              # Обработка tool_confirm_request
```

---

## Задача 1: Обновить shared types

**Файлы:**
- Изменить: `packages/shared/src/types.ts`

- [x] **Шаг 1: Добавить tool_confirm_request в SSEEvent**

Изменить `packages/shared/src/types.ts`. Добавить новый тип в union SSEEvent:

```typescript
export type SSEEvent =
  | { type: 'text_delta'; content: string }
  | { type: 'tool_call_start'; toolCall: ToolCall }
  | { type: 'tool_call_result'; id: string; result: ToolResult }
  | { type: 'tool_confirm_request'; toolCall: ToolCall; level: 'confirm' | 'forbidden' }
  | { type: 'done' }
  | { type: 'error'; message: string };
```

- [x] **Шаг 2: Typecheck**

```bash
npx tsc --noEmit -p packages/shared/tsconfig.json
```

Ожидание: нет ошибок.

- [x] **Шаг 3: Коммит**

```bash
git add packages/shared/src/types.ts
git commit -m "feat: add tool_confirm_request SSE event type"
```

---

## Задача 2: Permission rules в SQLite

**Файлы:**
- Изменить: `packages/server/src/db.ts`
- Изменить: `packages/server/src/db.test.ts`

- [x] **Шаг 1: Написать failing тесты**

Добавить в `packages/server/src/db.test.ts` новый describe блок после существующих:

```typescript
describe('Permission Rules', () => {
  it('returns null for unknown tool', () => {
    const rule = getPermissionRule('unknown_tool');
    expect(rule).toBeNull();
  });

  it('saves and retrieves permission rule', () => {
    savePermissionRule('file_write', true);
    const rule = getPermissionRule('file_write');
    expect(rule).toEqual({ allowed: true });
  });

  it('overwrites existing rule for same tool', () => {
    savePermissionRule('file_write', true);
    savePermissionRule('file_write', false);
    const rule = getPermissionRule('file_write');
    expect(rule).toEqual({ allowed: false });
  });

  it('clears all permission rules', () => {
    savePermissionRule('file_write', true);
    savePermissionRule('file_delete', false);
    clearPermissionRules();
    expect(getPermissionRule('file_write')).toBeNull();
    expect(getPermissionRule('file_delete')).toBeNull();
  });
});
```

Добавить в import вверху файла: `getPermissionRule, savePermissionRule, clearPermissionRules`.

- [x] **Шаг 2: Запустить тесты — убедиться что падает**

```bash
npx vitest run packages/server/src/db.test.ts
```

Ожидание: FAIL — функции не существуют.

- [x] **Шаг 3: Реализовать permission rules**

Добавить в `packages/server/src/db.ts`. В функцию `initDb()` добавить создание таблицы после `audit_log`:

```typescript
  db.exec(`
    CREATE TABLE IF NOT EXISTS permission_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tool_name TEXT NOT NULL UNIQUE,
      allowed INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
```

Добавить функции в конец файла:

```typescript
export function getPermissionRule(toolName: string): { allowed: boolean } | null {
  const d = getDb();
  const row = d.prepare('SELECT allowed FROM permission_rules WHERE tool_name = ?').get(toolName) as { allowed: number } | undefined;
  if (!row) return null;
  return { allowed: row.allowed === 1 };
}

export function savePermissionRule(toolName: string, allowed: boolean): void {
  const d = getDb();
  d.prepare(
    `INSERT INTO permission_rules (tool_name, allowed)
     VALUES (?, ?)
     ON CONFLICT(tool_name) DO UPDATE SET allowed = excluded.allowed, created_at = datetime('now')`
  ).run(toolName, allowed ? 1 : 0);
}

export function clearPermissionRules(): void {
  const d = getDb();
  d.prepare('DELETE FROM permission_rules').run();
}
```

- [x] **Шаг 4: Запустить тесты**

```bash
npx vitest run packages/server/src/db.test.ts
```

Ожидание: все тесты PASS.

- [x] **Шаг 5: Коммит**

```bash
git add packages/server/src/db.ts packages/server/src/db.test.ts
git commit -m "feat: add permission_rules table with get/save/clear"
```

---

## Задача 3: Confirm route + Permissions route

**Файлы:**
- Создать: `packages/server/src/routes/confirm.ts`
- Создать: `packages/server/src/routes/permissions.ts`
- Создать: `packages/server/src/routes/__tests__/confirm.test.ts`
- Создать: `packages/server/src/routes/__tests__/permissions.test.ts`

- [x] **Шаг 1: Написать failing тесты для confirm route**

Создать `packages/server/src/routes/__tests__/confirm.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createConfirmRouter, type PendingConfirms } from '../confirm.js';

describe('POST /api/confirm', () => {
  it('returns 400 when callId missing', async () => {
    const app = express();
    app.use(express.json());
    const pending: PendingConfirms = new Map();
    app.use('/api', createConfirmRouter(pending));

    const res = await request(app)
      .post('/api/confirm')
      .send({ allowed: true })
      .expect(400);

    expect(res.body.error).toContain('callId');
  });

  it('returns 404 when callId not found', async () => {
    const app = express();
    app.use(express.json());
    const pending: PendingConfirms = new Map();
    app.use('/api', createConfirmRouter(pending));

    const res = await request(app)
      .post('/api/confirm')
      .send({ callId: 'nonexistent', allowed: true })
      .expect(404);

    expect(res.body.error).toContain('not found');
  });

  it('resolves pending confirm and returns ok', async () => {
    const app = express();
    app.use(express.json());
    const pending: PendingConfirms = new Map();
    const resolve = vi.fn();
    pending.set('call_1', resolve);
    app.use('/api', createConfirmRouter(pending));

    const res = await request(app)
      .post('/api/confirm')
      .send({ callId: 'call_1', allowed: true, remember: false })
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(resolve).toHaveBeenCalledWith({ allowed: true, remember: false });
    expect(pending.has('call_1')).toBe(false);
  });
});
```

- [x] **Шаг 2: Написать failing тесты для permissions route**

Создать `packages/server/src/routes/__tests__/permissions.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createPermissionsRouter } from '../permissions.js';
import { initDb, closeDb, savePermissionRule, getPermissionRule } from '../../db.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('DELETE /api/permissions', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-perm-test-'));
    initDb(path.join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('clears all permission rules', async () => {
    savePermissionRule('file_write', true);
    savePermissionRule('file_delete', false);

    const app = express();
    app.use('/api', createPermissionsRouter());

    await request(app)
      .delete('/api/permissions')
      .expect(200);

    expect(getPermissionRule('file_write')).toBeNull();
    expect(getPermissionRule('file_delete')).toBeNull();
  });
});
```

- [x] **Шаг 3: Запустить тесты — убедиться что падает**

```bash
npx vitest run packages/server/src/routes/__tests__/confirm.test.ts packages/server/src/routes/__tests__/permissions.test.ts
```

Ожидание: FAIL — модули не существуют.

- [x] **Шаг 4: Реализовать confirm route**

Создать `packages/server/src/routes/confirm.ts`:

```typescript
import { Router } from 'express';
import type { Request, Response } from 'express';
import { savePermissionRule } from '../db.js';

export interface ConfirmResponse {
  allowed: boolean;
  remember: boolean;
}

export type PendingConfirms = Map<string, (response: ConfirmResponse) => void>;

export function createConfirmRouter(pendingConfirms: PendingConfirms): Router {
  const router = Router();

  router.post('/confirm', (req: Request, res: Response) => {
    const { callId, allowed, remember } = req.body;

    if (!callId || typeof callId !== 'string') {
      res.status(400).json({ error: 'callId (string) required' });
      return;
    }

    if (typeof allowed !== 'boolean') {
      res.status(400).json({ error: 'allowed (boolean) required' });
      return;
    }

    const resolve = pendingConfirms.get(callId);
    if (!resolve) {
      res.status(404).json({ error: `Pending confirm "${callId}" not found` });
      return;
    }

    pendingConfirms.delete(callId);

    if (remember) {
      try {
        // Tool name is encoded in the callId context — we need it from the caller
        // The resolve callback handles saving the rule
      } catch {
        // Permission save failure shouldn't block the confirm
      }
    }

    resolve({ allowed: !!allowed, remember: !!remember });
    res.json({ ok: true });
  });

  return router;
}
```

- [x] **Шаг 5: Реализовать permissions route**

Создать `packages/server/src/routes/permissions.ts`:

```typescript
import { Router } from 'express';
import type { Request, Response } from 'express';
import { clearPermissionRules } from '../db.js';

export function createPermissionsRouter(): Router {
  const router = Router();

  router.delete('/permissions', (_req: Request, res: Response) => {
    clearPermissionRules();
    res.json({ ok: true });
  });

  return router;
}
```

- [x] **Шаг 6: Запустить тесты**

```bash
npx vitest run packages/server/src/routes/__tests__/confirm.test.ts packages/server/src/routes/__tests__/permissions.test.ts
```

Ожидание: все тесты PASS.

- [x] **Шаг 7: Коммит**

```bash
git add packages/server/src/routes/confirm.ts packages/server/src/routes/permissions.ts packages/server/src/routes/__tests__/confirm.test.ts packages/server/src/routes/__tests__/permissions.test.ts
git commit -m "feat: add confirm and permissions API routes"
```

---

## Задача 4: Обновить tool loop — confirm/forbidden flow с ожиданием

**Файлы:**
- Изменить: `packages/server/src/ai/tool-loop.ts`
- Изменить: `packages/server/src/ai/__tests__/tool-loop.test.ts`

- [ ] **Шаг 1: Написать failing тесты**

Добавить в `packages/server/src/ai/__tests__/tool-loop.test.ts`. Заменить существующие тесты `'blocks tool with confirm permission level'` и `'blocks tool with forbidden permission level'` на новые:

```typescript
  it('waits for confirm response and executes tool when allowed', async () => {
    const client = mockClaudeClient([
      {
        content: [
          { type: 'tool_use', id: 'call_c', name: 'write_file', input: { path: 'test.txt' } },
        ],
        stop_reason: 'tool_use',
      },
      {
        content: [{ type: 'text', text: 'File written.' }],
        stop_reason: 'end_turn',
      },
    ]);

    const toolDefs = [{
      name: 'write_file',
      description: 'Write a file',
      permissionLevel: 'confirm' as const,
      parameters: { type: 'object' as const, properties: {}, required: [] },
      handler: vi.fn(async () => ({ success: true, data: 'written' })),
    }];

    const registry: ToolRegistry = {
      register: vi.fn(),
      get: (name: string) => toolDefs.find((t) => t.name === name),
      getAll: () => toolDefs,
    };

    const events: SSEEvent[] = [];
    const pendingConfirms = new Map();

    // Auto-approve after confirm request
    const originalOnEvent = (e: SSEEvent) => {
      events.push(e);
      if (e.type === 'tool_confirm_request') {
        const resolve = pendingConfirms.get(e.toolCall.id);
        if (resolve) {
          pendingConfirms.delete(e.toolCall.id);
          resolve({ allowed: true, remember: false });
        }
      }
    };

    await runToolLoop({
      messages: [{ role: 'user', content: 'Write file' }],
      client,
      registry,
      onEvent: originalOnEvent,
      pendingConfirms,
    });

    expect(toolDefs[0].handler).toHaveBeenCalled();
    expect(events.some(e => e.type === 'tool_confirm_request')).toBe(true);
  });

  it('rejects tool when confirm response is denied', async () => {
    const client = mockClaudeClient([
      {
        content: [
          { type: 'tool_use', id: 'call_d', name: 'write_file', input: { path: 'test.txt' } },
        ],
        stop_reason: 'tool_use',
      },
      {
        content: [{ type: 'text', text: 'Denied.' }],
        stop_reason: 'end_turn',
      },
    ]);

    const toolDefs = [{
      name: 'write_file',
      description: 'Write a file',
      permissionLevel: 'confirm' as const,
      parameters: { type: 'object' as const, properties: {}, required: [] },
      handler: vi.fn(async () => ({ success: true, data: 'written' })),
    }];

    const registry: ToolRegistry = {
      register: vi.fn(),
      get: (name: string) => toolDefs.find((t) => t.name === name),
      getAll: () => toolDefs,
    };

    const events: SSEEvent[] = [];
    const pendingConfirms = new Map();

    const originalOnEvent = (e: SSEEvent) => {
      events.push(e);
      if (e.type === 'tool_confirm_request') {
        const resolve = pendingConfirms.get(e.toolCall.id);
        if (resolve) {
          pendingConfirms.delete(e.toolCall.id);
          resolve({ allowed: false, remember: false });
        }
      }
    };

    await runToolLoop({
      messages: [{ role: 'user', content: 'Write file' }],
      client,
      registry,
      onEvent: originalOnEvent,
      pendingConfirms,
    });

    expect(toolDefs[0].handler).not.toHaveBeenCalled();
    const resultEvent = events.find(e => e.type === 'tool_call_result');
    expect(resultEvent).toBeDefined();
    if (resultEvent && resultEvent.type === 'tool_call_result') {
      expect(resultEvent.result.success).toBe(false);
      expect(resultEvent.result.error).toContain('denied');
    }
  });

  it('auto-applies saved permission rule without showing card', async () => {
    // Setup DB with saved rule
    initDb(path.join(tmpDir, 'perm-test.db'));

    const { savePermissionRule } = await import('../../db.js');
    savePermissionRule('write_file', true);

    const client = mockClaudeClient([
      {
        content: [
          { type: 'tool_use', id: 'call_auto', name: 'write_file', input: { path: 'test.txt' } },
        ],
        stop_reason: 'tool_use',
      },
      {
        content: [{ type: 'text', text: 'Done.' }],
        stop_reason: 'end_turn',
      },
    ]);

    const toolDefs = [{
      name: 'write_file',
      description: 'Write a file',
      permissionLevel: 'confirm' as const,
      parameters: { type: 'object' as const, properties: {}, required: [] },
      handler: vi.fn(async () => ({ success: true, data: 'written' })),
    }];

    const registry: ToolRegistry = {
      register: vi.fn(),
      get: (name: string) => toolDefs.find((t) => t.name === name),
      getAll: () => toolDefs,
    };

    const events: SSEEvent[] = [];
    const pendingConfirms = new Map();

    await runToolLoop({
      messages: [{ role: 'user', content: 'Write file' }],
      client,
      registry,
      onEvent: (e) => events.push(e),
      pendingConfirms,
    });

    // Handler should be called (auto-approved)
    expect(toolDefs[0].handler).toHaveBeenCalled();
    // No confirm request should have been sent
    expect(events.some(e => e.type === 'tool_confirm_request')).toBe(false);

    closeDb();
  });

  it('shows forbidden card with forbidden level', async () => {
    const client = mockClaudeClient([
      {
        content: [
          { type: 'tool_use', id: 'call_f', name: 'dangerous', input: {} },
        ],
        stop_reason: 'tool_use',
      },
      {
        content: [{ type: 'text', text: 'OK.' }],
        stop_reason: 'end_turn',
      },
    ]);

    const toolDefs = [{
      name: 'dangerous',
      description: 'Dangerous tool',
      permissionLevel: 'forbidden' as const,
      parameters: { type: 'object' as const, properties: {}, required: [] },
      handler: vi.fn(async () => ({ success: true, data: 'done' })),
    }];

    const registry: ToolRegistry = {
      register: vi.fn(),
      get: (name: string) => toolDefs.find((t) => t.name === name),
      getAll: () => toolDefs,
    };

    const events: SSEEvent[] = [];
    const pendingConfirms = new Map();

    const originalOnEvent = (e: SSEEvent) => {
      events.push(e);
      if (e.type === 'tool_confirm_request') {
        const resolve = pendingConfirms.get(e.toolCall.id);
        if (resolve) {
          pendingConfirms.delete(e.toolCall.id);
          resolve({ allowed: true, remember: false });
        }
      }
    };

    await runToolLoop({
      messages: [{ role: 'user', content: 'Do it' }],
      client,
      registry,
      onEvent: originalOnEvent,
      pendingConfirms,
    });

    const confirmEvent = events.find(e => e.type === 'tool_confirm_request');
    expect(confirmEvent).toBeDefined();
    if (confirmEvent && confirmEvent.type === 'tool_confirm_request') {
      expect(confirmEvent.level).toBe('forbidden');
    }
    expect(toolDefs[0].handler).toHaveBeenCalled();
  });
```

Также добавить в imports вверху файла:

```typescript
import { initDb, closeDb } from '../../db.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
```

И добавить tmpDir setup в основной describe (или создать новый describe для permission tests с beforeEach/afterEach).

- [ ] **Шаг 2: Запустить тесты — убедиться что падает**

```bash
npx vitest run packages/server/src/ai/__tests__/tool-loop.test.ts
```

Ожидание: FAIL — `pendingConfirms` не принимается `runToolLoop`.

- [ ] **Шаг 3: Обновить tool-loop.ts**

Заменить содержимое `packages/server/src/ai/tool-loop.ts`:

```typescript
import type { MessageParam, Tool } from '@anthropic-ai/sdk/resources/messages';
import type { SSEEvent, ToolCall, ToolResult } from '@r2/shared';
import type { ClaudeClient } from './claude.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ConfirmResponse } from '../routes/confirm.js';
import { toClaudeTool } from '../tools/base.js';
import { logToolCall, getPermissionRule, savePermissionRule } from '../db.js';

const MAX_ITERATIONS = 10;

export type PendingConfirms = Map<string, (response: ConfirmResponse) => void>;

interface ToolLoopParams {
  messages: MessageParam[];
  client: ClaudeClient;
  registry: ToolRegistry;
  onEvent: (event: SSEEvent) => void;
  signal?: AbortSignal;
  pendingConfirms?: PendingConfirms;
}

async function requestConfirmation(
  callId: string,
  toolCall: ToolCall,
  level: 'confirm' | 'forbidden',
  onEvent: (event: SSEEvent) => void,
  pendingConfirms: PendingConfirms,
): Promise<ConfirmResponse> {
  return new Promise((resolve) => {
    pendingConfirms.set(callId, resolve);
    onEvent({ type: 'tool_confirm_request', toolCall, level });
  });
}

export async function runToolLoop({
  messages,
  client,
  registry,
  onEvent,
  signal,
  pendingConfirms = new Map(),
}: ToolLoopParams): Promise<void> {
  const allTools = registry.getAll();
  const tools: Tool[] = allTools.map(toClaudeTool) as Tool[];
  let currentMessages: MessageParam[] = [...messages];
  let iterations = 0;
  let lastEndedWithToolUse = false;

  while (iterations < MAX_ITERATIONS) {
    if (signal?.aborted) return;
    iterations++;

    const response = await client.sendMessage({
      messages: currentMessages,
      tools,
      signal,
    });

    if (signal?.aborted) return;

    const textBlocks = response.content.filter((b) => b.type === 'text');
    const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use');

    // Emit text
    for (const block of textBlocks) {
      if (block.type === 'text') {
        onEvent({ type: 'text_delta', content: block.text });
      }
    }

    // No tool calls — done
    if (toolUseBlocks.length === 0 || response.stop_reason !== 'tool_use') {
      lastEndedWithToolUse = false;
      break;
    }

    lastEndedWithToolUse = true;

    // Execute tools and collect results
    const toolResultContents: Array<{
      type: 'tool_result';
      tool_use_id: string;
      content: string;
      is_error?: boolean;
    }> = [];

    for (const block of toolUseBlocks) {
      if (block.type !== 'tool_use') continue;
      if (signal?.aborted) return;

      const toolCall: ToolCall = {
        id: block.id,
        name: block.name,
        input: block.input as Record<string, unknown>,
        status: 'running',
      };
      onEvent({ type: 'tool_call_start', toolCall });

      const toolDef = registry.get(block.name);
      let result: ToolResult;

      const startTime = Date.now();
      if (!toolDef) {
        result = { success: false, error: `Unknown tool: ${block.name}` };
      } else if (toolDef.permissionLevel === 'confirm' || toolDef.permissionLevel === 'forbidden') {
        // Check saved permission rule
        let allowed: boolean | null = null;
        try {
          const rule = getPermissionRule(block.name);
          if (rule) allowed = rule.allowed;
        } catch {
          // DB not initialized — proceed to ask user
        }

        if (allowed === null) {
          // Ask user for confirmation
          const confirmResponse = await requestConfirmation(
            block.id,
            toolCall,
            toolDef.permissionLevel,
            onEvent,
            pendingConfirms,
          );
          allowed = confirmResponse.allowed;

          if (confirmResponse.remember) {
            try {
              savePermissionRule(block.name, confirmResponse.allowed);
            } catch {
              // Permission save failure shouldn't break the flow
            }
          }
        }

        if (allowed) {
          try {
            result = await toolDef.handler(block.input as Record<string, unknown>);
          } catch (err) {
            result = {
              success: false,
              error: err instanceof Error ? err.message : 'Unknown error',
            };
          }
        } else {
          result = { success: false, error: 'Action denied by user' };
        }
      } else {
        try {
          result = await toolDef.handler(block.input as Record<string, unknown>);
        } catch (err) {
          result = {
            success: false,
            error: err instanceof Error ? err.message : 'Unknown error',
          };
        }
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
      } catch (err) {
        console.error('Audit log write failed:', err instanceof Error ? err.message : err);
      }

      onEvent({ type: 'tool_call_result', id: block.id, result });

      toolResultContents.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(result.success ? (result.data ?? '') : (result.error ?? 'Unknown error')),
        ...(result.success ? {} : { is_error: true }),
      });
    }

    // Continue conversation with tool results
    currentMessages = [
      ...currentMessages,
      { role: 'assistant', content: response.content },
      { role: 'user', content: toolResultContents },
    ];
  }

  // If we hit max iterations without Claude giving a final text answer, ask it to wrap up
  if (iterations >= MAX_ITERATIONS && lastEndedWithToolUse && !signal?.aborted) {
    const finalResponse = await client.sendMessage({
      messages: [
        ...currentMessages,
        { role: 'user', content: 'Max tool iterations reached. Give a final answer now.' },
      ],
      tools: [],
      signal,
    });

    for (const block of finalResponse.content) {
      if (block.type === 'text') {
        onEvent({ type: 'text_delta', content: block.text });
      }
    }
  }

  onEvent({ type: 'done' });
}
```

- [ ] **Шаг 4: Запустить тесты**

```bash
npx vitest run packages/server/src/ai/__tests__/tool-loop.test.ts
```

Ожидание: все тесты PASS.

- [ ] **Шаг 5: Коммит**

```bash
git add packages/server/src/ai/tool-loop.ts packages/server/src/ai/__tests__/tool-loop.test.ts
git commit -m "feat: implement confirm/forbidden flow with Promise-based waiting"
```

---

## Задача 5: Подключить routes в server entry point

**Файлы:**
- Изменить: `packages/server/src/routes/chat.ts`
- Изменить: `packages/server/src/index.ts`

- [ ] **Шаг 1: Обновить chat.ts — передать pendingConfirms**

В `packages/server/src/routes/chat.ts` обновить интерфейс `ChatRouterDeps`:

```typescript
import type { PendingConfirms } from '../ai/tool-loop.js';

interface ChatRouterDeps {
  runLoop: (params: {
    messages: MessageParam[];
    onEvent: (event: SSEEvent) => void;
    signal?: AbortSignal;
    pendingConfirms: PendingConfirms;
  }) => Promise<void>;
  pendingConfirms: PendingConfirms;
}
```

И в router.post('/chat') передать `pendingConfirms`:

```typescript
      await runLoop({
        messages,
        signal: abortController.signal,
        pendingConfirms,
        onEvent: (event: SSEEvent) => {
```

- [ ] **Шаг 2: Обновить index.ts**

Заменить `packages/server/src/index.ts`:

```typescript
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '..', '..', '..', '.env') });
import express from 'express';
import cors from 'cors';
import { createChatRouter } from './routes/chat.js';
import { createConfirmRouter, type PendingConfirms } from './routes/confirm.js';
import { createPermissionsRouter } from './routes/permissions.js';
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
const pendingConfirms: PendingConfirms = new Map();

const chatRouter = createChatRouter({
  runLoop: ({ messages, onEvent, signal, pendingConfirms: pc }) =>
    runToolLoop({ messages, client, registry, onEvent, signal, pendingConfirms: pc }),
  pendingConfirms,
});

app.use('/api', chatRouter);
app.use('/api', createConfirmRouter(pendingConfirms));
app.use('/api', createPermissionsRouter());

app.get('/api/health', (_req, res) => {
  res.json({ status: 'R2 online', timestamp: new Date().toISOString() });
});

app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`R2 server running on http://localhost:${PORT}`);
});
```

- [ ] **Шаг 3: Запустить все серверные тесты**

```bash
npm test
```

Ожидание: все тесты PASS.

- [ ] **Шаг 4: Коммит**

```bash
git add packages/server/src/routes/chat.ts packages/server/src/index.ts
git commit -m "feat: wire confirm and permissions routes into server"
```

---

## Задача 6: Клиент — PermissionCard компонент

**Файлы:**
- Создать: `packages/client/src/components/PermissionCard.tsx`

- [ ] **Шаг 1: Создать PermissionCard.tsx**

Создать `packages/client/src/components/PermissionCard.tsx`:

```tsx
import { useState, useEffect } from 'react';
import type { ToolCall } from '@r2/shared';

interface Props {
  toolCall: ToolCall;
  level: 'confirm' | 'forbidden';
  onRespond: (callId: string, allowed: boolean, remember: boolean) => void;
}

export function PermissionCard({ toolCall, level, onRespond }: Props) {
  const [responded, setResponded] = useState(false);
  const [decision, setDecision] = useState<'allowed' | 'denied' | null>(null);
  const [remember, setRemember] = useState(false);
  const [pulse, setPulse] = useState(false);

  // Pulse reminder after 60 seconds
  useEffect(() => {
    if (responded) return;
    const timer = setTimeout(() => setPulse(true), 60_000);
    return () => clearTimeout(timer);
  }, [responded]);

  const handleRespond = (allowed: boolean) => {
    setResponded(true);
    setDecision(allowed ? 'allowed' : 'denied');
    onRespond(toolCall.id, allowed, remember);
  };

  const isForbidden = level === 'forbidden';

  const cardStyle: React.CSSProperties = {
    background: isForbidden ? '#FEF2F2' : '#f8f8f8',
    border: isForbidden ? '2px solid #DC2626' : '1px solid #e5e5e5',
    borderRadius: 14,
    padding: 16,
    marginBottom: 6,
    maxWidth: '80%',
    fontSize: 13,
    opacity: responded ? 0.7 : 1,
    animation: pulse && !responded ? 'pulse-border 1.5s ease-in-out infinite' : undefined,
  };

  const params = Object.entries(toolCall.input);

  return (
    <>
      <style>{`
        @keyframes pulse-border {
          0%, 100% { box-shadow: 0 0 0 0 rgba(245, 158, 11, 0); }
          50% { box-shadow: 0 0 0 4px rgba(245, 158, 11, 0.3); }
        }
      `}</style>
      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <div style={{
            width: 28, height: 28, borderRadius: '50%',
            background: isForbidden ? '#DC2626' : '#F59E0B',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: '#fff', fontSize: 12, fontWeight: 700,
          }}>
            {isForbidden ? '🔴' : '⚠'}
          </div>
          <div style={{ fontWeight: 600, fontSize: 14 }}>
            {toolCall.name} — {isForbidden ? 'Опасное действие' : 'Подтверждение'}
          </div>
        </div>

        <div style={{
          background: '#fff', border: '1px solid #e5e5e5',
          borderRadius: 8, padding: 10, marginBottom: 12,
          fontFamily: 'monospace', fontSize: 12,
        }}>
          {params.map(([key, value]) => (
            <div key={key} style={{ marginBottom: 4 }}>
              <span style={{ color: '#666' }}>{key}: </span>
              <span style={{
                display: 'inline-block', maxHeight: 60, overflow: 'hidden',
                wordBreak: 'break-all',
              }}>
                {typeof value === 'string' ? value : JSON.stringify(value)}
              </span>
            </div>
          ))}
        </div>

        {responded ? (
          <div style={{
            fontWeight: 600, fontSize: 13,
            color: decision === 'allowed' ? '#059669' : '#DC2626',
          }}>
            {decision === 'allowed' ? '✓ Разрешено' : '✗ Отклонено'}
          </div>
        ) : (
          <>
            <label style={{
              display: 'flex', alignItems: 'center', gap: 6,
              marginBottom: 10, fontSize: 12, color: '#666', cursor: 'pointer',
            }}>
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
              />
              Запомнить
            </label>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={() => handleRespond(true)}
                style={{
                  flex: 1, padding: 8, borderRadius: 8, border: 'none',
                  background: '#2A5A8A', color: '#fff', fontSize: 13, cursor: 'pointer',
                }}
              >
                Разрешить
              </button>
              <button
                onClick={() => handleRespond(false)}
                style={{
                  flex: 1, padding: 8, borderRadius: 8,
                  border: '1px solid #ddd', background: '#fff',
                  color: '#666', fontSize: 13, cursor: 'pointer',
                }}
              >
                Отклонить
              </button>
            </div>
          </>
        )}
      </div>
    </>
  );
}
```

- [ ] **Шаг 2: Коммит**

```bash
git add packages/client/src/components/PermissionCard.tsx
git commit -m "feat: add PermissionCard component for confirm/forbidden tools"
```

---

## Задача 7: Клиент — обработка tool_confirm_request в useChat

**Файлы:**
- Изменить: `packages/client/src/hooks/useChat.ts`
- Изменить: `packages/client/src/components/MessageBubble.tsx`

- [ ] **Шаг 1: Обновить useChat.ts**

Добавить обработку `tool_confirm_request` и функцию `respondToConfirm`.

В `useChat.ts` добавить state для pending confirms и обработчик:

Добавить тип для pending confirm:

```typescript
interface PendingConfirm {
  callId: string;
  level: 'confirm' | 'forbidden';
}
```

Добавить state:

```typescript
const [pendingConfirms, setPendingConfirms] = useState<Map<string, PendingConfirm>>(new Map());
```

В switch добавить case для `tool_confirm_request`:

```typescript
          case 'tool_confirm_request':
            // Add to pending confirms
            setPendingConfirms((prev) => {
              const next = new Map(prev);
              next.set(event.toolCall.id, { callId: event.toolCall.id, level: event.level });
              return next;
            });
            // Also add tool call to display
            toolCalls.push({ ...event.toolCall, status: 'running' });
            setMessages((prev) => {
              const base = prev[prev.length - 1]?.id === assistantId ? prev.slice(0, -1) : prev;
              return [
                ...base,
                {
                  id: assistantId,
                  role: 'assistant' as const,
                  content: assistantText,
                  toolCalls: [...toolCalls],
                  timestamp: Date.now(),
                },
              ];
            });
            break;
```

Добавить функцию `respondToConfirm`:

```typescript
  const respondToConfirm = useCallback(async (callId: string, allowed: boolean, remember: boolean) => {
    try {
      await fetch('/api/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callId, allowed, remember }),
      });
      setPendingConfirms((prev) => {
        const next = new Map(prev);
        next.delete(callId);
        return next;
      });
    } catch (err) {
      console.error('Failed to send confirm response:', err);
    }
  }, []);
```

Обновить return:

```typescript
  return { messages, loading, error, send, stop, pendingConfirms, respondToConfirm };
```

- [ ] **Шаг 2: Обновить MessageBubble.tsx**

Изменить `packages/client/src/components/MessageBubble.tsx` — рендерить `PermissionCard` для tool calls с pending confirm:

```tsx
import type { Message } from '@r2/shared';
import { ToolCallCard } from './ToolCallCard';
import { PermissionCard } from './PermissionCard';

interface PendingConfirm {
  callId: string;
  level: 'confirm' | 'forbidden';
}

interface Props {
  message: Message;
  pendingConfirms: Map<string, PendingConfirm>;
  onRespond: (callId: string, allowed: boolean, remember: boolean) => void;
}

export function MessageBubble({ message, pendingConfirms, onRespond }: Props) {
  const isUser = message.role === 'user';

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: isUser ? 'flex-end' : 'flex-start',
      marginBottom: 12,
    }}>
      {message.toolCalls?.map((tc) => {
        const pending = pendingConfirms.get(tc.id);
        if (pending) {
          return (
            <PermissionCard
              key={tc.id}
              toolCall={tc}
              level={pending.level}
              onRespond={onRespond}
            />
          );
        }
        return <ToolCallCard key={tc.id} toolCall={tc} />;
      })}
      {message.content && (
        <div style={{
          maxWidth: '80%',
          padding: '10px 14px',
          borderRadius: 14,
          fontSize: 14,
          lineHeight: 1.5,
          background: isUser ? '#2A5A8A' : '#f0f0f0',
          color: isUser ? '#fff' : '#222',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}>
          {message.content}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Шаг 3: Обновить Chat.tsx — передать props**

Изменить `packages/client/src/components/Chat.tsx`:

```tsx
import { useRef, useEffect } from 'react';
import { useChat } from '../hooks/useChat';
import { MessageBubble } from './MessageBubble';
import { ChatInput } from './ChatInput';

export function Chat() {
  const { messages, loading, error, send, pendingConfirms, respondToConfirm } = useChat();
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  return (
    <>
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px' }}>
        {messages.length === 0 && (
          <div style={{
            textAlign: 'center', color: '#aaa',
            marginTop: '30vh', fontSize: 14,
          }}>
            R2 ready. What do you need?
          </div>
        )}
        {messages.map((m) => (
          <MessageBubble
            key={m.id}
            message={m}
            pendingConfirms={pendingConfirms}
            onRespond={respondToConfirm}
          />
        ))}
        {loading && (
          <div style={{ fontSize: 13, color: '#aaa', padding: '4px 0' }}>
            R2 thinking...
          </div>
        )}
        {error && (
          <div style={{ fontSize: 13, color: '#c00', padding: '4px 0' }}>
            Error: {error}
          </div>
        )}
        <div ref={bottomRef} />
      </div>
      <ChatInput onSend={send} disabled={loading} />
    </>
  );
}
```

- [ ] **Шаг 4: Коммит**

```bash
git add packages/client/src/hooks/useChat.ts packages/client/src/components/MessageBubble.tsx packages/client/src/components/Chat.tsx
git commit -m "feat: integrate PermissionCard into chat flow"
```

---

## Задача 8: Убрать фильтрацию forbidden tools из Claude API

**Файлы:**
- Изменить: `packages/server/src/ai/tool-loop.ts`

- [ ] **Шаг 1: Убрать filter по permissionLevel**

В `packages/server/src/ai/tool-loop.ts` строка 25-27, заменить:

```typescript
  const allTools = registry.getAll();
  const tools: Tool[] = allTools.map(toClaudeTool) as Tool[];
```

Было (удалить `.filter`):
```typescript
  const tools: Tool[] = registry.getAll()
    .filter(t => t.permissionLevel !== 'forbidden')
    .map(toClaudeTool) as Tool[];
```

Claude теперь видит все tools — confirm и forbidden тоже. Решение принимает пользователь через карточку.

- [ ] **Шаг 2: Запустить все тесты**

```bash
npm test
```

Ожидание: все тесты PASS.

- [ ] **Шаг 3: Typecheck всех пакетов**

```bash
npx tsc --noEmit -p packages/shared/tsconfig.json && \
npx tsc --noEmit -p packages/server/tsconfig.json && \
npx tsc --noEmit -p packages/client/tsconfig.json
```

Ожидание: нет ошибок.

- [ ] **Шаг 4: Коммит**

```bash
git add packages/server/src/ai/tool-loop.ts
git commit -m "feat: show all tools to Claude, enforce permissions at execution time"
```

---

## Задача 9: Финальная интеграция

- [ ] **Шаг 1: Установить зависимости**

```bash
cd /Users/dim/code/R2-D2 && npm install
```

- [ ] **Шаг 2: Запустить все тесты**

```bash
npm test
```

Ожидание: все тесты PASS.

- [ ] **Шаг 3: Typecheck всех пакетов**

```bash
npx tsc --noEmit -p packages/shared/tsconfig.json && \
npx tsc --noEmit -p packages/server/tsconfig.json && \
npx tsc --noEmit -p packages/tool-web-search/tsconfig.json && \
npx tsc --noEmit -p packages/tool-files/tsconfig.json && \
npx tsc --noEmit -p packages/client/tsconfig.json
```

Ожидание: нет ошибок.

- [ ] **Шаг 4: Коммит**

```bash
git add -A
git commit -m "feat: complete Phase 2D — permission dialog with remember rules"
```
