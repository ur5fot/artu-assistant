# Phase 3F: Chat Commands + UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add command palette (Cmd+K / `/`), bottom status bar (LLM + messages + response time), and colored unified diff view to the R2 chat interface.

**Architecture:** Server exposes `/api/commands` from tool registry, chat route intercepts `/command` messages for direct tool dispatch. Client adds CommandPalette modal, StatusBar component, and DiffView using diff2html library.

**Tech Stack:** React 19, TypeScript, diff2html, existing Express SSE infrastructure.

---

### Task 1: Add `command` field to ToolDefinition

**Files:**
- Modify: `packages/shared/src/types.ts:42-54`

- [x] **Step 1: Add command field to ToolDefinition interface**

In `packages/shared/src/types.ts`, add `command` after `preCheck`:

```typescript
export interface ToolDefinition {
  name: string;
  description: string;
  permissionLevel: 'auto' | 'confirm' | 'forbidden';
  provider: 'ollama' | 'claude' | 'all';
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  handler: (params: Record<string, unknown>, ctx?: ToolContext) => Promise<ToolResult>;
  preCheck?: (input: Record<string, unknown>) => Promise<{ destructive: boolean; reason: string }>;
  command?: {
    name: string;
    description: string;
    params?: Array<{
      name: string;
      required: boolean;
      description?: string;
    }>;
  };
}
```

- [x] **Step 2: Build shared to verify**

Run: `cd /Users/dim/code/R2-D2 && npm run build -w packages/shared`
Expected: PASS

- [x] **Step 3: Commit**

```bash
git add packages/shared/src/types.ts
git commit -m "feat: add command field to ToolDefinition"
```

---

### Task 2: Set `command` on all tool packages

**Files:**
- Modify: `packages/tool-web-search/src/index.ts`
- Modify: `packages/tool-files/src/index.ts`
- Modify: `packages/tool-code-task/src/index.ts`
- Modify: `packages/tool-code-deploy/src/index.ts`
- Modify: `packages/tool-eval-add/src/index.ts`
- Modify: `packages/tool-eval-run/src/index.ts`

- [x] **Step 1: Add command to web_search**

In `packages/tool-web-search/src/index.ts`, add after `provider`:

```typescript
  command: {
    name: 'пошук',
    description: 'Пошук в інтернеті',
    params: [{ name: 'query', required: true, description: 'Пошуковий запит' }],
  },
```

- [x] **Step 2: Add command to file tools**

In `packages/tool-files/src/index.ts`, add command to each tool:

For `file_read`:
```typescript
    command: {
      name: 'читати',
      description: 'Прочитати файл',
      params: [{ name: 'path', required: true, description: 'Шлях до файлу' }],
    },
```

For `file_write`:
```typescript
    command: {
      name: 'записати',
      description: 'Записати у файл',
      params: [
        { name: 'path', required: true, description: 'Шлях до файлу' },
        { name: 'content', required: true, description: 'Вміст файлу' },
      ],
    },
```

For `file_list`:
```typescript
    command: {
      name: 'файли',
      description: 'Список файлів',
      params: [{ name: 'path', required: false, description: 'Шлях до папки' }],
    },
```

For `file_delete`:
```typescript
    command: {
      name: 'видалити',
      description: 'Видалити файл',
      params: [{ name: 'path', required: true, description: 'Шлях до файлу' }],
    },
```

For `file_move`:
```typescript
    command: {
      name: 'перемістити',
      description: 'Перемістити файл',
      params: [
        { name: 'source', required: true, description: 'Поточний шлях' },
        { name: 'destination', required: true, description: 'Новий шлях' },
      ],
    },
```

- [x] **Step 3: Add command to code_task**

In `packages/tool-code-task/src/index.ts`, find the tool definition object and add:

```typescript
    command: {
      name: 'задача',
      description: 'Запустити задачу програмування',
      params: [{ name: 'task', required: true, description: 'Опис задачі' }],
    },
```

- [x] **Step 4: Add command to code_deploy**

In `packages/tool-code-deploy/src/index.ts`, add inside the returned object:

```typescript
    command: {
      name: 'деплой',
      description: 'Задеплоїти зміни в продакшн',
    },
```

- [x] **Step 5: Add command to eval_add**

In `packages/tool-eval-add/src/index.ts`, add:

```typescript
  command: {
    name: 'евал',
    description: 'Додати поведінковий тест',
    params: [
      { name: 'input', required: true, description: 'Повідомлення юзера' },
      { name: 'expected', required: true, description: 'Очікувана поведінка' },
    ],
  },
```

- [x] **Step 6: Add command to eval_run**

In `packages/tool-eval-run/src/index.ts`, add inside the returned object:

```typescript
    command: {
      name: 'тести',
      description: 'Запустити всі поведінкові тести',
    },
```

- [x] **Step 7: Build all to verify**

Run: `cd /Users/dim/code/R2-D2 && npm run build`
Expected: PASS

- [x] **Step 8: Commit**

```bash
git add packages/tool-web-search/src/index.ts packages/tool-files/src/index.ts packages/tool-code-task/src/index.ts packages/tool-code-deploy/src/index.ts packages/tool-eval-add/src/index.ts packages/tool-eval-run/src/index.ts
git commit -m "feat: add Ukrainian slash commands to all tools"
```

---

### Task 3: Add `getCommands()` to registry and create commands route

**Files:**
- Modify: `packages/server/src/tools/registry.ts:7-38`
- Create: `packages/server/src/routes/commands.ts`
- Modify: `packages/server/src/index.ts:124`

- [x] **Step 1: Add getCommands to ToolRegistry**

In `packages/server/src/tools/registry.ts`, update the interface and implementation:

```typescript
export interface ToolRegistry {
  register(tool: ToolDefinition): void;
  get(name: string): ToolDefinition | undefined;
  getAll(): ToolDefinition[];
  getForProvider(provider: 'ollama' | 'claude'): ToolDefinition[];
  getCommands(): Array<{ name: string; tool: string; description: string; params?: Array<{ name: string; required: boolean; description?: string }> }>;
  getByCommandName(commandName: string): ToolDefinition | undefined;
}
```

In `createRegistry()`, add the methods:

```typescript
    getCommands() {
      return [...tools.values()]
        .filter((t) => t.command)
        .map((t) => ({
          name: t.command!.name,
          tool: t.name,
          description: t.command!.description,
          params: t.command!.params,
        }));
    },

    getByCommandName(commandName: string): ToolDefinition | undefined {
      return [...tools.values()].find((t) => t.command?.name === commandName);
    },
```

- [x] **Step 2: Create commands route**

Create `packages/server/src/routes/commands.ts`:

```typescript
import { Router } from 'express';
import type { ToolRegistry } from '../tools/registry.js';

export function createCommandsRouter(registry: ToolRegistry): Router {
  const router = Router();

  router.get('/commands', (_req, res) => {
    res.json(registry.getCommands());
  });

  return router;
}
```

- [x] **Step 3: Register commands route in index.ts**

In `packages/server/src/index.ts`, add import:

```typescript
import { createCommandsRouter } from './routes/commands.js';
```

Add after the existing `app.use('/api', ...)` lines (after line 129):

```typescript
app.use('/api', createCommandsRouter(registry));
```

- [x] **Step 4: Build to verify**

Run: `cd /Users/dim/code/R2-D2 && npm run build -w packages/server`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add packages/server/src/tools/registry.ts packages/server/src/routes/commands.ts packages/server/src/index.ts
git commit -m "feat: add /api/commands endpoint from tool registry"
```

---

### Task 4: Command dispatch in chat route

**Files:**
- Modify: `packages/server/src/routes/chat.ts:62-72`

- [x] **Step 1: Add command parsing and dispatch**

In `packages/server/src/routes/chat.ts`, add the import:

```typescript
import type { ToolRegistry } from '../tools/registry.js';
```

The `ChatRouterDeps` interface already has `registry` (added in the Ollama tool calling feature). No change needed there.

Inside the `router.post('/chat', ...)` handler, after message validation (after line 81), before the user message save, add command interception:

```typescript
    // Check if the latest user message is a slash command
    const lastUserMsg = messages[messages.length - 1];
    if (lastUserMsg?.role === 'user' && typeof lastUserMsg.content === 'string') {
      const match = lastUserMsg.content.match(/^\/(\S+)\s*(.*)/s);
      if (match) {
        const [, commandName, argsStr] = match;
        const toolDef = registry.getByCommandName(commandName);
        if (toolDef) {
          // Map positional args to tool parameters
          const params: Record<string, unknown> = {};
          const requiredParams = toolDef.command?.params?.filter((p) => p.required) ?? [];
          if (requiredParams.length > 0 && argsStr.trim()) {
            params[requiredParams[0].name] = argsStr.trim();
          }

          // Rewrite user message to instruct LLM to use the specific tool
          const rewritten = messages.map((m: any, i: number) => {
            if (i === messages.length - 1) {
              const paramDesc = Object.entries(params).map(([k, v]) => `${k}: ${v}`).join(', ');
              return {
                ...m,
                content: `[User used command /${commandName}] Use tool "${toolDef.name}" with parameters: ${paramDesc || 'none'}. Execute the tool and respond with the result.`,
              };
            }
            return m;
          });

          // Replace messages with rewritten version for the rest of the handler
          req.body.messages = rewritten;
        }
        // If command not found, fall through — send as normal message to LLM
      }
    }
```

This approach rewrites the user message to instruct the LLM to call the specific tool, keeping the existing tool-loop flow intact (permissions, audit, PII all work as normal).

- [x] **Step 2: Build to verify**

Run: `cd /Users/dim/code/R2-D2 && npm run build -w packages/server`
Expected: PASS

- [x] **Step 3: Commit**

```bash
git add packages/server/src/routes/chat.ts
git commit -m "feat: intercept slash commands in chat route"
```

---

### Task 5: DiffView component

**Files:**
- Create: `packages/client/src/components/DiffView.tsx`
- Modify: `packages/client/src/components/ToolCallCard.tsx:144-165`
- Modify: `packages/client/src/theme.css`
- Modify: `packages/client/package.json`

- [x] **Step 1: Install diff2html**

Run: `cd /Users/dim/code/R2-D2 && npm install diff2html -w packages/client`
Expected: package added to client dependencies

- [x] **Step 2: Create DiffView component**

Create `packages/client/src/components/DiffView.tsx`:

```tsx
import { useMemo } from 'react';
import { html, Diff2HtmlConfig } from 'diff2html';
import 'diff2html/bundles/css/diff2html.min.css';

interface Props {
  diff: string;
}

const config: Diff2HtmlConfig = {
  outputFormat: 'line-by-line',
  drawFileList: false,
  matching: 'lines',
  diffStyle: 'word',
};

export function DiffView({ diff }: Props) {
  const rendered = useMemo(() => html(diff, config), [diff]);

  return (
    <div
      className="r2-diff-view"
      dangerouslySetInnerHTML={{ __html: rendered }}
    />
  );
}
```

- [x] **Step 3: Add dark theme overrides for diff2html**

In `packages/client/src/theme.css`, add at the end:

```css
/* Diff view overrides */
.r2-diff-view .d2h-wrapper {
  border-radius: 6px;
  overflow: hidden;
}

.r2-diff-view .d2h-file-header {
  background: #1e293b;
  color: #e2e8f0;
  border-bottom: 1px solid #334155;
  padding: 6px 10px;
  font-family: 'SF Mono', Menlo, monospace;
  font-size: 12px;
}

.r2-diff-view .d2h-file-stats {
  font-size: 11px;
}

.r2-diff-view .d2h-file-stats .d2h-lines-added { color: #86efac; }
.r2-diff-view .d2h-file-stats .d2h-lines-deleted { color: #fca5a5; }

.r2-diff-view .d2h-code-linenumber,
.r2-diff-view .d2h-code-line-ctn {
  font-family: 'SF Mono', Menlo, monospace;
  font-size: 11px;
}

.r2-diff-view .d2h-code-linenumber {
  color: #475569;
  background: #1e293b;
  border-right: 1px solid #334155;
}

.r2-diff-view .d2h-code-line {
  padding: 0;
}

.r2-diff-view .d2h-del {
  background: #3b1111;
  border-color: #5c1d1d;
}
.r2-diff-view .d2h-del .d2h-code-line-ctn { color: #fca5a5; }

.r2-diff-view .d2h-ins {
  background: #0b3d1a;
  border-color: #14532d;
}
.r2-diff-view .d2h-ins .d2h-code-line-ctn { color: #86efac; }

.r2-diff-view .d2h-cntx {
  background: #1e293b;
  border-color: #334155;
}
.r2-diff-view .d2h-cntx .d2h-code-line-ctn { color: #94a3b8; }

.r2-diff-view .d2h-info {
  background: #1e293b;
  color: #64748b;
  border-color: #334155;
}

.r2-diff-view .d2h-file-diff {
  border: none;
}

.r2-diff-view .d2h-diff-table {
  font-size: 11px;
}

/* Dark theme: no changes needed, base styles already dark */
/* Light theme: also use dark diff (code blocks are always dark in R2) */
```

- [x] **Step 4: Replace raw diff in ToolCallCard**

In `packages/client/src/components/ToolCallCard.tsx`, add import at top:

```typescript
import { DiffView } from './DiffView';
```

Replace the diff rendering block (lines 144-165) — the entire `{(data.shortDiff || data.fullDiff) && (...)}` section:

```tsx
      {(data.shortDiff || data.fullDiff) && (
        <div>
          <button
            onClick={() => setShowFullDiff(!showFullDiff)}
            style={{
              background: 'none', border: 'none', color: '#2A5A8A',
              cursor: 'pointer', padding: 0, fontSize: 12, marginBottom: 4,
            }}
          >
            {showFullDiff ? 'Hide diff ▲' : 'Show diff ▼'}
          </button>
          {showFullDiff && (
            <DiffView diff={data.fullDiff ?? data.shortDiff ?? ''} />
          )}
        </div>
      )}
```

- [x] **Step 5: Build client to verify**

Run: `cd /Users/dim/code/R2-D2 && npm run build -w packages/client`
Expected: PASS

- [x] **Step 6: Commit**

```bash
git add packages/client/package.json packages/client/src/components/DiffView.tsx packages/client/src/components/ToolCallCard.tsx packages/client/src/theme.css package-lock.json
git commit -m "feat: add colored unified diff view with diff2html"
```

---

### Task 6: StatusBar component

**Files:**
- Create: `packages/client/src/components/StatusBar.tsx`
- Modify: `packages/client/src/components/Chat.tsx`
- Modify: `packages/client/src/hooks/useChat.ts:238-241`

- [x] **Step 1: Add response time tracking to useChat**

In `packages/client/src/hooks/useChat.ts`, add new state:

```typescript
const [lastResponseTime, setLastResponseTime] = useState<number | null>(null);
const [lastSource, setLastSource] = useState<'ollama' | 'claude' | null>(null);
const sendStartRef = useRef<number>(0);
```

In the `send` callback, right after `sendingRef.current = true;` (line 31), add:

```typescript
    sendStartRef.current = Date.now();
```

In the `case 'assistant_source':` handler (line 194), add:

```typescript
          case 'assistant_source':
            source = event.source;
            setLastSource(event.source);
```

(keep the existing `setMessages` call after this)

In the `case 'done':` handler (line 238), add:

```typescript
          case 'done':
            setLastResponseTime((Date.now() - sendStartRef.current) / 1000);
            setLoading(false);
            sendingRef.current = false;
            break;
```

Update the return object (line 334) to include new values:

```typescript
  return {
    messages,
    loading,
    error,
    send,
    stop,
    pendingConfirms,
    respondToConfirm,
    pendingPlanReviews,
    respondToPlanReview,
    historyLoaded,
    lastResponseTime,
    lastSource,
  };
```

- [x] **Step 2: Create StatusBar component**

Create `packages/client/src/components/StatusBar.tsx`:

```tsx
interface Props {
  source: 'ollama' | 'claude' | null;
  messageCount: number;
  responseTime: number | null;
}

export function StatusBar({ source, messageCount, responseTime }: Props) {
  const modelName = source === 'ollama'
    ? 'Ollama'
    : source === 'claude'
      ? 'Claude'
      : 'R2';

  return (
    <div style={{
      padding: '4px 16px',
      borderTop: '1px solid var(--border)',
      display: 'flex',
      justifyContent: 'space-between',
      fontSize: 11,
      color: 'var(--text-secondary)',
    }}>
      <span>{modelName}</span>
      <span>{messageCount} повідомлень</span>
      <span>{responseTime !== null ? `${responseTime.toFixed(1)}s` : '—'}</span>
    </div>
  );
}
```

- [x] **Step 3: Integrate StatusBar into Chat**

In `packages/client/src/components/Chat.tsx`, add import:

```typescript
import { StatusBar } from './StatusBar';
```

Update useChat destructuring:

```typescript
const { messages, loading, error, send, pendingConfirms, respondToConfirm, pendingPlanReviews, respondToPlanReview, historyLoaded, lastResponseTime, lastSource } = useChat();
```

Add StatusBar after ChatInput (line 47):

```tsx
      <ChatInput onSend={send} disabled={loading || !historyLoaded} />
      <StatusBar
        source={lastSource}
        messageCount={messages.length}
        responseTime={lastResponseTime}
      />
```

- [x] **Step 4: Build to verify**

Run: `cd /Users/dim/code/R2-D2 && npm run build -w packages/client`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add packages/client/src/components/StatusBar.tsx packages/client/src/components/Chat.tsx packages/client/src/hooks/useChat.ts
git commit -m "feat: add bottom status bar with LLM source and response time"
```

---

### Task 7: CommandPalette component

**Files:**
- Create: `packages/client/src/components/CommandPalette.tsx`
- Modify: `packages/client/src/components/Chat.tsx`
- Modify: `packages/client/src/components/ChatInput.tsx`

- [x] **Step 1: Create CommandPalette component**

Create `packages/client/src/components/CommandPalette.tsx`:

```tsx
import { useState, useEffect, useRef, useCallback } from 'react';

interface CommandDef {
  name: string;
  tool: string;
  description: string;
  params?: Array<{ name: string; required: boolean; description?: string }>;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onSelect: (command: CommandDef) => void;
}

export function CommandPalette({ open, onClose, onSelect }: Props) {
  const [commands, setCommands] = useState<CommandDef[]>([]);
  const [filter, setFilter] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch('/api/commands')
      .then((res) => res.json())
      .then(setCommands)
      .catch((err) => console.error('Failed to load commands:', err));
  }, []);

  useEffect(() => {
    if (open) {
      setFilter('');
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  const filtered = commands.filter((c) =>
    c.name.toLowerCase().includes(filter.toLowerCase()) ||
    c.description.toLowerCase().includes(filter.toLowerCase()),
  );

  useEffect(() => {
    setSelectedIndex(0);
  }, [filter]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filtered[selectedIndex]) {
        onSelect(filtered[selectedIndex]);
      }
    }
  }, [filtered, selectedIndex, onClose, onSelect]);

  if (!open) return null;

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        paddingTop: '20vh', zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--bg)', borderRadius: 12,
          border: '1px solid var(--border)', width: 400,
          maxHeight: 360, display: 'flex', flexDirection: 'column',
          boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
        }}
      >
        <div style={{ padding: '12px 12px 8px' }}>
          <input
            ref={inputRef}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Знайти команду..."
            style={{
              width: '100%', padding: '8px 12px', borderRadius: 8,
              border: '1px solid var(--border)', fontSize: 14,
              outline: 'none', background: 'var(--surface)',
              color: 'var(--text)',
            }}
          />
        </div>
        <div style={{ overflowY: 'auto', padding: '0 4px 8px' }}>
          {filtered.length === 0 && (
            <div style={{ padding: '12px', color: 'var(--text-muted)', fontSize: 13, textAlign: 'center' }}>
              Нічого не знайдено
            </div>
          )}
          {filtered.map((cmd, i) => (
            <div
              key={cmd.name}
              onClick={() => onSelect(cmd)}
              style={{
                padding: '8px 12px', borderRadius: 8, cursor: 'pointer',
                display: 'flex', alignItems: 'center', gap: 10,
                background: i === selectedIndex ? 'var(--surface-alt)' : 'transparent',
                margin: '0 4px',
              }}
            >
              <span style={{
                fontFamily: 'monospace', fontSize: 13,
                color: 'var(--primary)', fontWeight: 600,
              }}>
                /{cmd.name}
              </span>
              <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                {cmd.description}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
```

- [x] **Step 2: Update ChatInput to detect `/` and expose input control**

In `packages/client/src/components/ChatInput.tsx`, update the props and add palette trigger:

```tsx
import { useState, useRef, useEffect, type KeyboardEvent } from 'react';

interface Props {
  onSend: (text: string) => void;
  disabled: boolean;
  onSlashTyped?: () => void;
  inputValue?: string;
  onInputChange?: (value: string) => void;
}

export function ChatInput({ onSend, disabled, onSlashTyped, inputValue, onInputChange }: Props) {
  const [localInput, setLocalInput] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Support controlled mode from parent (for command palette injection)
  const input = inputValue !== undefined ? inputValue : localInput;
  const setInput = (v: string) => {
    if (onInputChange) onInputChange(v);
    else setLocalInput(v);
  };

  // Focus input when inputValue changes externally (command selected)
  useEffect(() => {
    if (inputValue !== undefined) {
      inputRef.current?.focus();
    }
  }, [inputValue]);

  const handleSend = () => {
    if (!input.trim() || disabled) return;
    onSend(input);
    setInput('');
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setInput(val);
    // If user just typed `/` as the first character, open palette
    if (val === '/' && onSlashTyped) {
      onSlashTyped();
    }
  };

  return (
    <div style={{
      padding: '12px 16px',
      borderTop: '1px solid var(--border)',
      display: 'flex',
      gap: 8,
    }}>
      <input
        ref={inputRef}
        value={input}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder="Message R2..."
        disabled={disabled}
        style={{
          flex: 1, padding: '10px 14px', borderRadius: 10,
          border: '1px solid var(--border)', fontSize: 14, outline: 'none',
          background: 'var(--bg)', color: 'var(--text)',
        }}
      />
      <button
        onClick={handleSend}
        disabled={disabled || !input.trim()}
        style={{
          padding: '10px 20px', borderRadius: 10, border: 'none',
          background: 'var(--primary)', color: 'var(--primary-text)', fontSize: 14,
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled || !input.trim() ? 0.5 : 1,
        }}
      >Send</button>
    </div>
  );
}
```

- [x] **Step 3: Integrate CommandPalette into Chat**

In `packages/client/src/components/Chat.tsx`, update to full integration:

```tsx
import { useRef, useEffect, useState, useCallback } from 'react';
import { useChat } from '../hooks/useChat';
import { MessageBubble } from './MessageBubble';
import { ChatInput } from './ChatInput';
import { StatusBar } from './StatusBar';
import { CommandPalette } from './CommandPalette';

export function Chat() {
  const { messages, loading, error, send, pendingConfirms, respondToConfirm, pendingPlanReviews, respondToPlanReview, historyLoaded, lastResponseTime, lastSource } = useChat();
  const bottomRef = useRef<HTMLDivElement>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [inputValue, setInputValue] = useState('');

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  // Cmd+K to open palette
  useEffect(() => {
    const handler = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        if (!loading) setPaletteOpen(true);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [loading]);

  const handleSlashTyped = useCallback(() => {
    if (!loading) {
      setPaletteOpen(true);
      setInputValue('');
    }
  }, [loading]);

  const handleCommandSelect = useCallback((cmd: { name: string; params?: Array<{ name: string; required: boolean }> }) => {
    setPaletteOpen(false);
    const hasRequiredParams = cmd.params?.some((p) => p.required);
    if (hasRequiredParams) {
      setInputValue(`/${cmd.name} `);
    } else {
      setInputValue('');
      send(`/${cmd.name}`);
    }
  }, [send]);

  const handleSend = useCallback((text: string) => {
    setInputValue('');
    send(text);
  }, [send]);

  return (
    <>
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px' }}>
        {messages.length === 0 && (
          <div style={{
            textAlign: 'center', color: 'var(--text-muted)',
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
            pendingPlanReviews={pendingPlanReviews}
            onRespond={respondToConfirm}
            onRespondPlanReview={respondToPlanReview}
          />
        ))}
        {loading && (
          <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: '4px 0' }}>
            R2 thinking...
          </div>
        )}
        {error && (
          <div style={{ fontSize: 13, color: 'var(--error)', padding: '4px 0' }}>
            Error: {error}
          </div>
        )}
        <div ref={bottomRef} />
      </div>
      <ChatInput
        onSend={handleSend}
        disabled={loading || !historyLoaded}
        onSlashTyped={handleSlashTyped}
        inputValue={inputValue}
        onInputChange={setInputValue}
      />
      <StatusBar
        source={lastSource}
        messageCount={messages.length}
        responseTime={lastResponseTime}
      />
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onSelect={handleCommandSelect}
      />
    </>
  );
}
```

- [x] **Step 4: Build to verify**

Run: `cd /Users/dim/code/R2-D2 && npm run build -w packages/client`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add packages/client/src/components/CommandPalette.tsx packages/client/src/components/ChatInput.tsx packages/client/src/components/Chat.tsx
git commit -m "feat: add command palette with Cmd+K and slash trigger"
```

---

### Task 8: Build and smoke test

**Files:** none (verification only)

- [ ] **Step 1: Full build**

Run: `cd /Users/dim/code/R2-D2 && npm run build`
Expected: PASS — all packages compile

- [ ] **Step 2: Run existing tests**

Run: `cd /Users/dim/code/R2-D2 && npm test`
Expected: All tests pass

- [ ] **Step 3: Manual smoke test**

Start dev server: `cd /Users/dim/code/R2-D2 && npm run dev`

Test scenarios:
1. **Command palette** — press Cmd+K → palette opens, shows all commands in Ukrainian
2. **Slash trigger** — type `/` in input → palette opens
3. **Filter** — type `/пош` → filters to show only "пошук"
4. **Execute command** — select `/деплой` → sends immediately (no required params)
5. **Command with params** — select `/пошук` → inserts `/пошук ` in input, user types query and sends
6. **Status bar** — visible at bottom, shows LLM source, message count, response time
7. **Diff view** — run a code_task, check colored diff renders with green/red lines
8. **Unknown command** — type `/foo bar` → goes to LLM as normal message
