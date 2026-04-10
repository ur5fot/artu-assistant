# Phase 3C: Git-in-the-loop (code_task tool)

## Цель

R2 модифицирует сам себя через чат. Юзер даёт задачу → R2 вызывает Claude Agent SDK на dev ветке в изолированном worktree → diff показывается в чате → коммит. Для автоматизированных задач — ralphex с review loop.

## Архитектура

Новый пакет `packages/tool-code-task/` — стандартный R2 tool с `permissionLevel: 'confirm'`. Работает в изолированном git worktree `/tmp/r2-dev`. Интегрируется с существующей системой permission levels, audit log, SSE streaming.

```
User: "добавь dark mode"
  ↓
Chat Claude вызывает tool code_task({task, context})
  ↓
Tool handler:
  1. Destructive check (Haiku) → {destructive, reason}
  2. Ensure worktree /tmp/r2-dev on dev branch
  3. git pull origin dev
  4. Mode=once: Claude Agent SDK напрямую
     Mode=auto: ralphex --max-iterations 20 (с review loop)
  5. git diff master..HEAD → parse files, generate summary
  6. git add -A && git commit -m "r2: <task>"
  7. Return ToolResult { summary, files, shortDiff, fullDiff, commit }
  ↓
SSE progress events во время работы → ToolCallCard обновляется
  ↓
Chat Claude получает ToolResult, рассказывает юзеру
```

## Пакет `@r2/tool-code-task`

### Структура

```
packages/tool-code-task/
├── src/
│   ├── index.ts              # Tool definition + handler
│   ├── destructive-check.ts  # Haiku-based safety check
│   ├── worktree.ts           # Git worktree management
│   ├── agent-sdk.ts          # Claude Agent SDK wrapper
│   ├── ralphex.ts            # Ralphex CLI wrapper
│   └── diff.ts               # git diff parsing + summary
├── __tests__/
│   ├── destructive-check.test.ts
│   ├── worktree.test.ts
│   ├── agent-sdk.test.ts
│   └── code-task.test.ts
├── package.json
└── tsconfig.json
```

### Tool Definition

```typescript
const codeTaskTool: ToolDefinition = {
  name: 'code_task',
  description: 'Execute a coding task on R2 dev branch. Use for any modification to R2 code itself (bugfix, feature, refactor). Works in isolated git worktree.',
  permissionLevel: 'confirm',
  parameters: {
    type: 'object',
    properties: {
      task: {
        type: 'string',
        description: 'Human-readable task description. Be specific about what to change.',
      },
      context: {
        type: 'string',
        description: 'Optional: file paths, links, requirements, constraints',
      },
    },
    required: ['task'],
  },
  handler: async (params, ctx) => { /* ... */ },
};
```

### Handler flow

1. Validate params: `task` required, `context` optional
2. `destructive = await isDestructive(task, context)`
3. If `destructive.destructive === true` — attach warning to ctx for permission dialog (see Permission flow section)
4. `await ensureWorktree('/tmp/r2-dev', 'dev')`
5. `await syncWorktree()` — git pull origin dev
6. Mode detection: check permission rule for `code_task`
   - If rule = `auto` (Allow always был нажат ранее) → use **ralphex mode**
   - Otherwise → use **once mode** (Claude Agent SDK)
7. Execute — stream progress via `ctx.onProgress(message)`
8. `const diff = parseDiff('/tmp/r2-dev', 'master..HEAD')`
9. `await commitChanges('/tmp/r2-dev', `r2: ${task}`)`
10. Return `ToolResult`:

```typescript
{
  success: true,
  data: {
    summary: string,          // "Created 2 files, modified 3, commit abc1234"
    files: Array<{ path: string; added: number; removed: number }>,
    shortDiff: string,        // First 50 lines of diff
    fullDiff: string,         // Complete diff
    commit: string,           // Full commit hash
    mode: 'once' | 'ralphex',
    durationMs: number,
  },
  display: {
    type: 'code',
    content: shortDiff,
  }
}
```

## Destructive check (Haiku)

### Module `destructive-check.ts`

```typescript
interface DestructiveCheck {
  destructive: boolean;
  reason: string;
}

export async function isDestructive(task: string, context?: string): Promise<DestructiveCheck>;
```

### Implementation

- Uses `@anthropic-ai/sdk` with model `claude-haiku-4-5-20251001`
- System prompt:

```
You analyze coding tasks for safety. A task is DESTRUCTIVE or SENSITIVE if it:
- Deletes data (files, DB rows, tables)
- Removes or downgrades dependencies (package.json)
- Modifies authentication, secrets, or security code
- Changes database schema or migrations
- Modifies CI/CD, deployment, or git configuration
- Disables tests or safety checks
- Touches .env files

Reply ONLY with valid JSON: {"destructive": boolean, "reason": "short explanation"}
```

- User message: `Task: ${task}\n\nContext: ${context ?? 'none'}`
- Parse response as JSON
- On parse error or API error: return `{destructive: false, reason: 'check failed'}` (fail-open)
- Max tokens: 256

## Git worktree management

### Module `worktree.ts`

```typescript
export async function ensureWorktree(path: string, branch: string): Promise<void>;
export async function syncWorktree(path: string): Promise<void>;
export async function commitChanges(path: string, message: string): Promise<string>; // returns hash
```

### ensureWorktree

- Check if `path` exists and is a valid git worktree: `git worktree list --porcelain`
- If not exists: `git worktree add -B <branch> <path> origin/<branch>`
- If exists but on wrong branch: `cd <path> && git checkout <branch>`
- Repo root is determined from R2 server cwd (resolves to project root)

### syncWorktree

- `cd <path> && git fetch origin <branch> && git reset --hard origin/<branch>`
- Hard reset is safe because worktree is ephemeral

### commitChanges

- `cd <path> && git add -A`
- Check if there are staged changes: `git diff --cached --quiet`
- If no changes: return empty string
- Otherwise: `git commit -m "<message>"` + return commit SHA

## Claude Agent SDK wrapper

### Module `agent-sdk.ts`

```typescript
interface AgentRunParams {
  workdir: string;
  task: string;
  context?: string;
  onProgress: (message: string) => void;
  signal?: AbortSignal;
}

export async function runAgent(params: AgentRunParams): Promise<void>;
```

### Implementation

- Imports `query` from `@anthropic-ai/claude-agent-sdk`
- Constructs prompt: `Task: ${task}\n\nContext: ${context ?? 'none'}\n\nWork directly in the current directory. Make all changes needed to complete the task.`
- Iterates SDK stream: for each message emit `onProgress` with short description
- Progress mapping:
  - Text block → emit first 80 chars
  - Tool use (Edit/Write/Bash) → emit `Editing <file>` / `Writing <file>` / `Running <cmd>`
  - Tool result → skip
- Signal propagation: pass `signal` to SDK query options for abort support

## Ralphex wrapper (auto mode)

### Module `ralphex.ts`

```typescript
interface RalphexRunParams {
  workdir: string;
  task: string;
  context?: string;
  onProgress: (message: string) => void;
  requestPlanReview: (plan: string) => Promise<{ approved: boolean; editedPlan?: string }>;
  signal?: AbortSignal;
}

export async function runRalphex(params: RalphexRunParams): Promise<void>;
```

### Implementation

1. **Generate draft plan** via Haiku (or use template if draft fails):

```typescript
async function generatePlan(task: string, context?: string): Promise<string>
```
Haiku is given the task + context + R2 project overview, produces a markdown plan with TDD steps.
Fallback: template with placeholder task.

2. **Show plan to user** via `requestPlanReview(plan)`:
   - Emits SSE `tool_plan_review` event with plan content
   - Waits for user response via `POST /api/plan-review { callId, approved, editedPlan? }`
   - User can: approve, edit + approve, or reject
   - Similar to existing `pendingConfirms` pattern

3. **If rejected** → throw error "Plan rejected by user"

4. **Write plan file** at `/tmp/r2-task-<uuid>.md` (using edited plan if provided)

5. **Spawn** `ralphex --max-iterations 20 <plan-path>` (cwd = workdir)

6. **Tail progress** file, stream new lines via `onProgress`

7. **Wait** for process exit; on non-zero exit throw error

8. **Cleanup**: delete plan file

### New SSE event

```typescript
| { type: 'tool_plan_review'; id: string; plan: string }
```

### New API endpoint

`POST /api/plan-review`:
```json
{ "callId": "string", "approved": true, "editedPlan": "markdown..." }
```

Server side: `pendingPlanReviews` Map resolves Promise with user response.

### Integration with tool-loop

Tool-loop passes `requestPlanReview` callback as part of `ToolContext`. In `auto` mode, handler uses ralphex which calls `requestPlanReview` before spawning.

## Progress streaming

### New SSE event type

```typescript
type SSEEvent = ... | { type: 'tool_progress'; id: string; message: string };
```

### Integration with tool-loop

Tool handlers receive a context object:

```typescript
interface ToolContext {
  onProgress?: (message: string) => void;
  requestPlanReview?: (plan: string) => Promise<{ approved: boolean; editedPlan?: string }>;
  signal?: AbortSignal;
  meta?: { autoMode?: boolean };
}

type ToolHandler = (params: Record<string, unknown>, ctx?: ToolContext) => Promise<ToolResult>;
```

In `tool-loop.ts`, when calling handler, pass `ctx` with `onProgress` that emits SSE:

```typescript
const progressCtx = {
  onProgress: (message: string) => onEvent({ type: 'tool_progress', id: block.id, message }),
  signal,
};
result = await toolDef.handler(input, progressCtx);
```

Backwards-compatible: existing tools ignore `ctx` parameter.

## Permission flow (3-button card)

### Updated `PermissionCard.tsx`

For `code_task` tool, render 3 buttons instead of 2:

- **Allow once** (blue `#2A5A8A`) — send `{ callId, allowed: true, remember: false }`
- **Allow always** (green `#10B981` with ⭐) — send `{ callId, allowed: true, remember: true }`
- **Deny** (gray border) — send `{ callId, allowed: false, remember: false }`

Detection: `if (toolCall.name === 'code_task')` render 3 buttons, else existing 2-button layout.

### Destructive warning

Tool handler calls `isDestructive()` BEFORE showing confirmation card. If `destructive === true`:

1. Even if saved rule = `auto` exists, ignore it and force confirmation
2. Emit `tool_confirm_request` with an additional flag `destructiveWarning: { reason: string }`

### Extended SSE event

```typescript
| { type: 'tool_confirm_request'; toolCall: ToolCall; level: 'confirm' | 'forbidden'; destructiveWarning?: { reason: string } }
```

### Card styling for destructive

Red border (`2px #DC2626`), background `#FEF2F2`, reason shown above task params:

```
⚠ Destructive action: <reason>
---
code_task
Task: "delete all logs"
[Allow once] [Allow always] [Deny]
```

### Permission rule check logic (in tool-loop.ts)

Current logic for `confirm` level:
```typescript
const rule = getPermissionRule(block.name);
if (rule) allowed = rule.allowed;
```

Extended logic for `code_task`:
```typescript
if (block.name === 'code_task') {
  const destructive = await isDestructive(input.task, input.context);
  if (destructive.destructive) {
    // Force confirmation even if rule exists
    allowed = null;
    confirmContext = { destructiveWarning: { reason: destructive.reason } };
  } else {
    const rule = getPermissionRule(block.name);
    if (rule) allowed = rule.allowed;
  }
}
```

Note: destructive check runs in tool-loop BEFORE the handler, because the result affects whether to show card. The handler will not re-run it.

## UI — Plan review card (auto mode only)

When `tool_plan_review` event arrives, client renders `PlanReviewCard`:

- Shows generated plan in `<textarea>` (editable)
- Buttons: **Run plan** (blue), **Cancel** (gray)
- User can edit plan text before clicking Run
- On Run → POST `/api/plan-review { callId, approved: true, editedPlan: textarea.value }`
- On Cancel → POST `/api/plan-review { callId, approved: false }`

Card replaces `ToolCallCard` while `running` state is active but `tool_plan_review` received. After user responds, card disappears and normal progress stream resumes.

### useChat integration

New state: `pendingPlanReviews: Map<callId, { plan: string }>`. On `tool_plan_review` event add to map. After `respondToPlanReview()` remove from map.

### Message extension

```typescript
interface ToolCall {
  ...
  pendingPlan?: string;  // set by useChat on tool_plan_review
}
```

## UI — ToolCallCard for code_task

### Running state

Show last progress message in a subtle gray box:

```
┌──────────────────────────────┐
│ 🛠 code_task                 │
│ Task: "добавь dark mode"     │
│                              │
│ ⏵ Editing src/App.tsx        │ ← animated dot, updates
└──────────────────────────────┘
```

### Done state

```
┌──────────────────────────────┐
│ ✓ code_task (2m 14s)         │
│ Commit: abc1234              │
│                              │
│ 📁 3 files changed           │
│  • src/components/Theme.tsx  │
│    +45 lines                 │
│  • src/App.tsx               │
│    ±12 lines                 │
│  • src/styles.css            │
│    +8 lines                  │
│                              │
│ [Show diff ▼]                │
└──────────────────────────────┘
```

Clicking "Show diff" expands `fullDiff` into a `<pre><code>` block with monospace font.

### Implementation

- `ToolCallCard.tsx` detects `toolCall.name === 'code_task'` and renders specialized layout
- Reads `result.data.summary`, `files`, `shortDiff`, `fullDiff`, `commit`
- State for expanded diff: `useState<boolean>(false)`

## Database changes

None. `permission_rules` table already supports `code_task` (`allowed: true` = Allow always).

## Audit log

Existing `logToolCall` automatically logs `code_task` invocations with inputs and results. PII proxy already anonymizes tool inputs, so tasks with PII are safe.

## Configuration

### Env variables (.env.example)

```bash
# Phase 3C: Code task
R2_DEV_WORKTREE=/tmp/r2-dev
R2_DEV_BRANCH=dev
CLAUDE_HAIKU_MODEL=claude-haiku-4-5-20251001
```

### Dependencies

Add to `packages/tool-code-task/package.json`:

```json
{
  "dependencies": {
    "@r2/shared": "*",
    "@anthropic-ai/sdk": "^0.80.0",
    "@anthropic-ai/claude-agent-sdk": "^0.2.98"
  }
}
```

## Testing

### Unit tests (Vitest)

- `destructive-check.test.ts`: mock Anthropic client, verify JSON parsing, fallback on error
- `worktree.test.ts`: mock `child_process.exec`, verify git commands, handle existing/missing worktree
- `diff.test.ts`: parse `git diff` output, generate summary with file stats
- `agent-sdk.test.ts`: mock `query` from SDK, verify progress callback is invoked for tool_use blocks
- `ralphex.test.ts`: mock child_process spawn, verify plan file generation, progress tail
- `code-task.test.ts`: integration of handler flow (mocked git + mocked agent), once vs auto branching

### Manual / E2E

- "Создай файл hello.md с текстом 'hi'" → confirm card (3 buttons) → Allow once → file created on dev branch, commit hash shown in chat
- Same task → Allow always → next task runs without card, ralphex mode
- "Удали все файлы в data/" → destructive warning card with reason (red border), even if auto rule exists
- "Добавь console.log в src/index.ts" → progress stream shows "Editing src/index.ts"
- Abort during task (stop button in UI) → worktree cleanup, no partial commit

## Rollout & fallbacks

- If `@anthropic-ai/claude-agent-sdk` unavailable or errors → tool returns `{success: false, error: 'Agent SDK unavailable'}`
- If worktree creation fails → tool returns error, no partial state
- If Haiku destructive check fails → `destructive: false` (fail-open, rely on user confirmation)
- If ralphex not installed (auto mode) → tool returns error with installation hint

## What's NOT included

- Merge dev → master (Phase 3D)
- Auto-deploy after merge / git watcher (Phase 3D)
- Eval checks before merge (Phase 3E)
- Chat commands `r2 task` / `r2 deploy` (Phase 3F)
- Rollback / undo commits
- Multiple parallel tasks (one task at a time)
- Worktree cleanup policy (deletion of stale worktrees) — handled manually for now
- Streaming diff as it's being generated
