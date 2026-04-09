# Chat Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Save chat messages to SQLite so the conversation survives worker restarts.

**Architecture:** New `chat_messages` table in existing r2.db stores full messages (text + tool calls + PII entities). Chat route saves user message on receive, assistant message on done. New GET /api/messages endpoint returns history. Client loads history on mount.

**Tech Stack:** better-sqlite3, Express, React hooks

---

### Task 1: Database — chat_messages table and CRUD functions

**Files:**
- Modify: `packages/server/src/db.ts`
- Modify: `packages/server/src/db.test.ts`

- [x] **Step 1: Write failing tests for saveMessage and getMessages**

Add to `packages/server/src/db.test.ts`, after the existing `Permission Rules` describe block:

```typescript
  describe('Chat Messages', () => {
    it('saves and retrieves a user message', () => {
      saveMessage({
        messageId: 'msg-1',
        role: 'user',
        content: 'Hello R2',
        timestamp: 1700000000000,
      });

      const messages = getMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0].id).toBe('msg-1');
      expect(messages[0].role).toBe('user');
      expect(messages[0].content).toBe('Hello R2');
      expect(messages[0].timestamp).toBe(1700000000000);
      expect(messages[0].toolCalls).toBeUndefined();
      expect(messages[0].piiEntities).toBeUndefined();
    });

    it('saves assistant message with tool calls', () => {
      saveMessage({
        messageId: 'msg-2',
        role: 'assistant',
        content: 'Searching...',
        toolCalls: [{
          id: 'tc-1',
          name: 'web_search',
          input: { query: 'test' },
          status: 'done',
          result: { success: true, data: 'results' },
        }],
        timestamp: 1700000001000,
      });

      const messages = getMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0].toolCalls).toHaveLength(1);
      expect(messages[0].toolCalls![0].name).toBe('web_search');
      expect(messages[0].toolCalls![0].result).toEqual({ success: true, data: 'results' });
    });

    it('saves message with piiEntities', () => {
      saveMessage({
        messageId: 'msg-3',
        role: 'assistant',
        content: 'Found it',
        piiEntities: [{ type: 'EMAIL_ADDRESS', count: 2 }],
        timestamp: 1700000002000,
      });

      const messages = getMessages();
      expect(messages[0].piiEntities).toEqual([{ type: 'EMAIL_ADDRESS', count: 2 }]);
    });

    it('returns messages ordered by timestamp ASC', () => {
      saveMessage({ messageId: 'msg-a', role: 'user', content: 'First', timestamp: 1700000000000 });
      saveMessage({ messageId: 'msg-b', role: 'assistant', content: 'Second', timestamp: 1700000001000 });
      saveMessage({ messageId: 'msg-c', role: 'user', content: 'Third', timestamp: 1700000002000 });

      const messages = getMessages();
      expect(messages).toHaveLength(3);
      expect(messages[0].content).toBe('First');
      expect(messages[1].content).toBe('Second');
      expect(messages[2].content).toBe('Third');
    });

    it('is idempotent — duplicate messageId is ignored', () => {
      saveMessage({ messageId: 'msg-dup', role: 'user', content: 'Hello', timestamp: 1700000000000 });
      saveMessage({ messageId: 'msg-dup', role: 'user', content: 'Hello again', timestamp: 1700000001000 });

      const messages = getMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('Hello');
    });

    it('clears all messages', () => {
      saveMessage({ messageId: 'msg-x', role: 'user', content: 'Hello', timestamp: 1700000000000 });
      saveMessage({ messageId: 'msg-y', role: 'assistant', content: 'Hi', timestamp: 1700000001000 });
      clearMessages();

      const messages = getMessages();
      expect(messages).toHaveLength(0);
    });
  });
```

Also add `saveMessage`, `getMessages`, `clearMessages` to the import at line 3:

```typescript
import { initDb, logToolCall, cleanupAuditLog, getDb, closeDb, getPermissionRule, savePermissionRule, clearPermissionRules, saveMessage, getMessages, clearMessages } from './db.js';
```

- [x] **Step 2: Run tests to verify they fail**

Run: `cd packages/server && npx vitest run src/db.test.ts`
Expected: FAIL — `saveMessage` is not exported.

- [x] **Step 3: Add chat_messages table and functions to db.ts**

In `packages/server/src/db.ts`:

After the `pii_tokens` table creation (after line 55), add:

```typescript
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      tool_calls TEXT,
      pii_entities TEXT,
      timestamp INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
```

After `cleanupAuditLog()` function (after line 121), add:

```typescript
interface SaveMessageParams {
  messageId: string;
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: unknown[];
  piiEntities?: Array<{ type: string; count: number }>;
  timestamp: number;
}

export function saveMessage(params: SaveMessageParams): void {
  const d = getDb();
  d.prepare(
    `INSERT OR IGNORE INTO chat_messages (message_id, role, content, tool_calls, pii_entities, timestamp)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    params.messageId,
    params.role,
    params.content,
    params.toolCalls ? JSON.stringify(params.toolCalls) : null,
    params.piiEntities ? JSON.stringify(params.piiEntities) : null,
    params.timestamp,
  );
}

export function getMessages(): Array<{
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: unknown[];
  piiEntities?: Array<{ type: string; count: number }>;
  timestamp: number;
}> {
  const d = getDb();
  const rows = d.prepare(
    'SELECT message_id, role, content, tool_calls, pii_entities, timestamp FROM chat_messages ORDER BY timestamp ASC'
  ).all() as Array<{
    message_id: string;
    role: string;
    content: string;
    tool_calls: string | null;
    pii_entities: string | null;
    timestamp: number;
  }>;

  return rows.map((row) => ({
    id: row.message_id,
    role: row.role as 'user' | 'assistant',
    content: row.content,
    toolCalls: row.tool_calls ? JSON.parse(row.tool_calls) : undefined,
    piiEntities: row.pii_entities ? JSON.parse(row.pii_entities) : undefined,
    timestamp: row.timestamp,
  }));
}

export function clearMessages(): void {
  const d = getDb();
  d.prepare('DELETE FROM chat_messages').run();
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `cd packages/server && npx vitest run src/db.test.ts`
Expected: all tests PASS (existing + 6 new).

- [x] **Step 5: Commit**

```bash
git add packages/server/src/db.ts packages/server/src/db.test.ts
git commit -m "feat: add chat_messages table with save/get/clear functions"
```

---

### Task 2: GET /api/messages endpoint

**Files:**
- Create: `packages/server/src/routes/messages.ts`
- Modify: `packages/server/src/index.ts`

- [x] **Step 1: Create messages route**

Create `packages/server/src/routes/messages.ts`:

```typescript
import { Router } from 'express';
import type { Request, Response } from 'express';
import { getMessages, clearMessages } from '../db.js';

export function createMessagesRouter(): Router {
  const router = Router();

  router.get('/messages', (_req: Request, res: Response) => {
    const messages = getMessages();
    res.json(messages);
  });

  router.delete('/messages', (_req: Request, res: Response) => {
    clearMessages();
    res.json({ ok: true });
  });

  return router;
}
```

- [x] **Step 2: Register route in index.ts**

In `packages/server/src/index.ts`, add import after line 12:

```typescript
import { createMessagesRouter } from './routes/messages.js';
```

After `app.use('/api', createPermissionsRouter());` (line 84), add:

```typescript
app.use('/api', createMessagesRouter());
```

- [x] **Step 3: Run typecheck**

Run: `npx tsc --noEmit -p packages/server/tsconfig.json`
Expected: no errors.

- [x] **Step 4: Commit**

```bash
git add packages/server/src/routes/messages.ts packages/server/src/index.ts
git commit -m "feat: add GET /api/messages and DELETE /api/messages endpoints"
```

---

### Task 3: Save messages in chat route

**Files:**
- Modify: `packages/server/src/routes/chat.ts`

- [x] **Step 1: Add message saving to chat route**

In `packages/server/src/routes/chat.ts`:

Add import at top (after line 5):

```typescript
import { saveMessage } from '../db.js';
import type { ToolCall } from '@r2/shared';
```

Inside the `router.post('/chat', ...)` handler, after validation (after line 72), before setting SSE headers (line 74), save the latest user message:

```typescript
    // Save the latest user message to DB
    const lastMsg = messages[messages.length - 1];
    if (lastMsg && lastMsg.role === 'user') {
      try {
        saveMessage({
          messageId: lastMsg.id || crypto.randomUUID(),
          role: 'user',
          content: lastMsg.content,
          timestamp: lastMsg.timestamp || Date.now(),
        });
      } catch (err) {
        console.error('Failed to save user message:', err instanceof Error ? err.message : err);
      }
    }
```

Add assistant message accumulation and saving. Before the `try` block (before line 82), add:

```typescript
    // Accumulate assistant response for persistence
    let assistantText = '';
    const assistantToolCalls: ToolCall[] = [];
    let assistantPiiEntities: Array<{ type: string; count: number }> | undefined;
    const assistantId = crypto.randomUUID();
```

Replace the `onEvent` callback (lines 88-91) with:

```typescript
        onEvent: (event: SSEEvent) => {
          // Accumulate assistant data for persistence
          if (event.type === 'text_delta') {
            assistantText += event.content;
          } else if (event.type === 'tool_call_start') {
            assistantToolCalls.push(event.toolCall);
          } else if (event.type === 'tool_call_result') {
            const tc = assistantToolCalls.find((t) => t.id === event.id);
            if (tc) {
              tc.result = event.result;
              tc.status = event.result.success ? 'done' : 'error';
            }
          } else if (event.type === 'pii_masked') {
            assistantPiiEntities = event.entities;
          } else if (event.type === 'done') {
            // Save assistant message on completion
            if (assistantText || assistantToolCalls.length > 0) {
              try {
                saveMessage({
                  messageId: assistantId,
                  role: 'assistant',
                  content: assistantText,
                  toolCalls: assistantToolCalls.length > 0 ? assistantToolCalls : undefined,
                  piiEntities: assistantPiiEntities,
                  timestamp: Date.now(),
                });
              } catch (err) {
                console.error('Failed to save assistant message:', err instanceof Error ? err.message : err);
              }
            }
          }

          // Forward to SSE stream
          if (!res.writableEnded && !res.destroyed) {
            res.write(`data: ${JSON.stringify(event)}\n\n`);
          }
        },
```

Add `crypto` import if not already present. At the top of the file, after existing imports:

```typescript
import crypto from 'node:crypto';
```

- [x] **Step 2: Update message validation to accept id and timestamp**

The client sends `id` and `timestamp` with messages. The validation (lines 60-68) only checks `role` and `content`. No changes needed to validation — extra fields are just ignored by the validator but passed through. However, we need to ensure the client sends `id` in the messages array.

Check the client SSE call at `useChat.ts:44`:
```typescript
messages: [...messages, userMessage].map((m) => ({ role: m.role, content: m.content, timestamp: m.timestamp })),
```

This doesn't send `id`. Update `packages/client/src/hooks/useChat.ts` line 44 to include `id`:

```typescript
      messages: [...messages, userMessage].map((m) => ({ id: m.id, role: m.role, content: m.content, timestamp: m.timestamp })),
```

- [x] **Step 3: Run typecheck**

Run: `npx tsc --noEmit -p packages/server/tsconfig.json && npx tsc --noEmit -p packages/client/tsconfig.json`
Expected: no errors.

- [x] **Step 4: Run existing tests**

Run: `cd packages/server && npx vitest run`
Expected: all tests PASS.

- [x] **Step 5: Commit**

```bash
git add packages/server/src/routes/chat.ts packages/client/src/hooks/useChat.ts
git commit -m "feat: save user and assistant messages to DB in chat route"
```

---

### Task 4: Client — load history on mount

**Files:**
- Modify: `packages/client/src/hooks/useChat.ts`

- [ ] **Step 1: Add history loading to useChat**

In `packages/client/src/hooks/useChat.ts`:

Add a new state for initial loading. After line 13 (`const [pendingConfirms, ...`):

```typescript
  const [historyLoaded, setHistoryLoaded] = useState(false);
```

Add useEffect to load history on mount. After the existing cleanup useEffect (after line 205), add:

```typescript
  // Load chat history on mount
  useEffect(() => {
    fetch('/api/messages')
      .then((res) => res.json())
      .then((msgs: Message[]) => {
        if (msgs.length > 0) {
          setMessages(msgs);
        }
      })
      .catch((err) => {
        console.error('Failed to load chat history:', err);
      })
      .finally(() => {
        setHistoryLoaded(true);
      });
  }, []);
```

Update the return statement (line 207) to include `historyLoaded`:

```typescript
  return { messages, loading, error, send, stop, pendingConfirms, respondToConfirm, historyLoaded };
```

- [ ] **Step 2: Run client typecheck**

Run: `npx tsc --noEmit -p packages/client/tsconfig.json`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/client/src/hooks/useChat.ts
git commit -m "feat: load chat history from server on mount"
```

---

### Task 5: Full typecheck and test suite

**Files:**
- All modified files

- [ ] **Step 1: Full typecheck across all packages**

Run: `npx tsc --noEmit -p packages/shared/tsconfig.json && npx tsc --noEmit -p packages/server/tsconfig.json && npx tsc --noEmit -p packages/client/tsconfig.json`
Expected: no type errors.

- [ ] **Step 2: Run all server tests**

Run: `cd packages/server && npx vitest run`
Expected: all tests PASS.

- [ ] **Step 3: Fix any issues found**

If any type errors or test failures, fix them.

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "chore: Phase 3B — chat persistence complete"
```
