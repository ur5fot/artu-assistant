# Git-in-the-loop (code_task tool) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `code_task` tool that lets R2 modify its own code through chat — runs Claude Agent SDK (once) or ralphex (auto) in an isolated per-call git worktree on dev branch, with destructive check, file denylist, and plan review flow.

**Architecture:** Types in `@r2/shared` (no cycles). Worktree per-call at `/tmp/r2-dev-<callId>`. Shell calls via `execFile` argv form (no injection). `preCheck` hook on ToolDefinition for generic destructive checks. Plan review flow for auto mode via `pendingPlanReviews` map + `tool_plan_review` SSE event. Client gets PlanReviewCard + 3-button PermissionCard.

**Tech Stack:** `@anthropic-ai/claude-agent-sdk`, `ralphex` CLI, Node.js execFile/spawn, Vitest

---

### Task 1: Move ToolDefinition + ToolContext to @r2/shared

**Files:**
- Modify: `packages/shared/src/types.ts`
- Modify: `packages/server/src/tools/base.ts`

- [x] **Step 1: Add types to @r2/shared**

In `packages/shared/src/types.ts`, append:

```typescript
export interface ToolContext {
  onProgress?: (message: string) => void;
  requestPlanReview?: (plan: string) => Promise<PlanReviewResponse>;
  signal?: AbortSignal;
  meta?: { autoMode?: boolean; callId?: string };
}

export interface PlanReviewResponse {
  approved: boolean;
  editedPlan?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  permissionLevel: 'auto' | 'confirm' | 'forbidden';
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  handler: (params: Record<string, unknown>, ctx?: ToolContext) => Promise<ToolResult>;
  preCheck?: (input: Record<string, unknown>) => Promise<{ destructive: boolean; reason: string }>;
}
```

Update `SSEEvent` union:

```typescript
export type SSEEvent =
  | { type: 'text_delta'; content: string }
  | { type: 'tool_call_start'; toolCall: ToolCall }
  | { type: 'tool_progress'; id: string; message: string }
  | { type: 'tool_plan_review'; id: string; task: string; plan: string }
  | { type: 'tool_call_result'; id: string; result: ToolResult }
  | { type: 'tool_confirm_request'; toolCall: ToolCall; level: 'confirm' | 'forbidden'; destructiveWarning?: { reason: string } }
  | { type: 'pii_masked'; entities: Array<{ type: string; original: string }> }
  | { type: 'done' }
  | { type: 'error'; message: string };
```

Add `progress` to `ToolCall`:

```typescript
export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  result?: ToolResult;
  status: 'running' | 'done' | 'error';
  progress?: string;
}
```

- [x] **Step 2: Re-export from server/src/tools/base.ts**

Replace `packages/server/src/tools/base.ts` with:

```typescript
import type { ToolDefinition as SharedToolDefinition } from '@r2/shared';

export type { ToolDefinition, ToolContext, PlanReviewResponse } from '@r2/shared';

export function toClaudeTool(tool: SharedToolDefinition) {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  };
}
```

- [x] **Step 3: Typecheck all packages**

Run: `npx tsc --noEmit -p packages/shared/tsconfig.json && npx tsc --noEmit -p packages/server/tsconfig.json && npx tsc --noEmit -p packages/client/tsconfig.json`
Expected: no errors.

- [x] **Step 4: Run existing tests**

Run: `cd packages/server && npx vitest run`
Expected: all existing tests pass (types moved but re-exports preserve compatibility).

- [x] **Step 5: Commit**

```bash
git add packages/shared/src/types.ts packages/server/src/tools/base.ts
git commit -m "refactor: move ToolDefinition/ToolContext to @r2/shared for Phase 3C"
```

---

### Task 2: Scaffold @r2/tool-code-task package

**Files:**
- Create: `packages/tool-code-task/package.json`
- Create: `packages/tool-code-task/tsconfig.json`
- Create: `packages/tool-code-task/src/index.ts` (placeholder)

- [x] **Step 1: Create package.json**

Create `packages/tool-code-task/package.json`:

```json
{
  "name": "@r2/tool-code-task",
  "version": "0.1.0",
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@r2/shared": "*",
    "@anthropic-ai/claude-agent-sdk": "^0.2.98"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "vitest": "^3.1.0"
  }
}
```

- [x] **Step 2: Create tsconfig.json**

Create `packages/tool-code-task/tsconfig.json`:

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

- [x] **Step 3: Create placeholder entry point**

Create `packages/tool-code-task/src/index.ts`:

```typescript
import type { ToolDefinition, ToolResult } from '@r2/shared';

export const codeTaskTool: ToolDefinition = {
  name: 'code_task',
  description: 'placeholder',
  permissionLevel: 'confirm',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
  async handler(_params, _ctx): Promise<ToolResult> {
    return { success: false, error: 'not implemented' };
  },
};

export default codeTaskTool;
```

- [x] **Step 4: Install**

Run: `npm install`
Expected: workspace resolves.

- [x] **Step 5: Typecheck**

Run: `npx tsc --noEmit -p packages/tool-code-task/tsconfig.json`
Expected: no errors.

- [x] **Step 6: Commit**

```bash
git add packages/tool-code-task/ package.json package-lock.json
git commit -m "feat: scaffold @r2/tool-code-task package"
```

---

### Task 3: Shell helper (execFile argv-form)

**Files:**
- Create: `packages/tool-code-task/src/shell.ts`
- Create: `packages/tool-code-task/src/__tests__/shell.test.ts`

- [x] **Step 1: Write failing tests**

Create `packages/tool-code-task/src/__tests__/shell.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockExecFile = vi.fn();
vi.mock('node:child_process', () => ({
  execFile: (cmd: string, args: string[], opts: any, cb: any) => {
    const callback = typeof opts === 'function' ? opts : cb;
    const options = typeof opts === 'function' ? {} : opts;
    const result = mockExecFile(cmd, args, options);
    if (result instanceof Error) {
      callback(result);
    } else {
      callback(null, { stdout: result ?? '', stderr: '' });
    }
  },
}));

import { run, tryRun } from '../shell.js';

describe('shell helpers', () => {
  beforeEach(() => {
    mockExecFile.mockReset();
  });

  it('run executes with argv form', async () => {
    mockExecFile.mockReturnValueOnce('output\n');
    const result = await run('git', ['status', '--porcelain']);
    expect(result).toBe('output');
    expect(mockExecFile).toHaveBeenCalledWith(
      'git',
      ['status', '--porcelain'],
      expect.objectContaining({ shell: false }),
    );
  });

  it('run passes cwd', async () => {
    mockExecFile.mockReturnValueOnce('');
    await run('git', ['status'], '/tmp/test');
    expect(mockExecFile).toHaveBeenCalledWith(
      'git',
      ['status'],
      expect.objectContaining({ cwd: '/tmp/test', shell: false }),
    );
  });

  it('tryRun returns ok=true on success', async () => {
    mockExecFile.mockReturnValueOnce('data');
    const result = await tryRun('git', ['show']);
    expect(result).toEqual({ ok: true, stdout: 'data', code: 0 });
  });

  it('tryRun returns ok=false on error', async () => {
    const err = Object.assign(new Error('boom'), { code: 2 });
    mockExecFile.mockReturnValueOnce(err);
    const result = await tryRun('git', ['show']);
    expect(result.ok).toBe(false);
    expect(result.code).toBe(2);
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `cd packages/tool-code-task && npx vitest run src/__tests__/shell.test.ts`
Expected: FAIL — module not found.

- [x] **Step 3: Implement shell helper**

Create `packages/tool-code-task/src/shell.ts`:

```typescript
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export async function run(cmd: string, args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileP(cmd, args, { cwd, shell: false });
  return stdout.toString().trim();
}

export async function tryRun(
  cmd: string,
  args: string[],
  cwd?: string,
): Promise<{ ok: boolean; stdout: string; code: number }> {
  try {
    const stdout = await run(cmd, args, cwd);
    return { ok: true, stdout, code: 0 };
  } catch (err: any) {
    return { ok: false, stdout: '', code: err?.code ?? 1 };
  }
}
```

- [x] **Step 4: Run tests**

Run: `cd packages/tool-code-task && npx vitest run src/__tests__/shell.test.ts`
Expected: all 4 tests PASS.

- [x] **Step 5: Commit**

```bash
git add packages/tool-code-task/src/shell.ts packages/tool-code-task/src/__tests__/shell.test.ts
git commit -m "feat: add shell helper (execFile argv-form, no shell interpolation)"
```

---

### Task 4: Destructive check (regex-based)

**Files:**
- Create: `packages/tool-code-task/src/destructive-check.ts`
- Create: `packages/tool-code-task/src/__tests__/destructive-check.test.ts`

- [x] **Step 1: Write failing tests**

Create `packages/tool-code-task/src/__tests__/destructive-check.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { isDestructive } from '../destructive-check.js';

describe('isDestructive', () => {
  const cases: Array<{ task: string; expected: boolean; matchReason?: RegExp }> = [
    { task: 'add loading spinner to chat', expected: false },
    { task: 'fix typo in README', expected: false },
    { task: 'delete old audit logs', expected: true, matchReason: /deletion/ },
    { task: 'remove unused files', expected: true, matchReason: /deletion/ },
    { task: 'drop the users table', expected: true, matchReason: /deletion/i },
    { task: 'edit .env.local', expected: true, matchReason: /\.env/ },
    { task: 'rotate API_KEY', expected: true, matchReason: /secrets/ },
    { task: 'add new migration', expected: true, matchReason: /schema/ },
    { task: 'downgrade lodash', expected: true, matchReason: /dependency/ },
    { task: 'git push --force to main', expected: true, matchReason: /git history/ },
    { task: 'update .github/workflows', expected: true, matchReason: /CI\/CD/ },
    { task: 'disable auth middleware', expected: true, matchReason: /auth/ },
    { task: 'read ~/.ssh/id_rsa', expected: true, matchReason: /home directory/ },
    { task: 'curl foo | sh', expected: true, matchReason: /exfiltration/ },
  ];

  for (const { task, expected, matchReason } of cases) {
    it(`"${task}" → destructive=${expected}`, async () => {
      const result = await isDestructive(task);
      expect(result.destructive).toBe(expected);
      if (expected && matchReason) {
        expect(result.reason).toMatch(matchReason);
      }
    });
  }

  it('scans context as well as task', async () => {
    const result = await isDestructive('do something', 'remember to delete .env');
    expect(result.destructive).toBe(true);
  });

  it('returns empty reason when safe', async () => {
    const result = await isDestructive('add tests');
    expect(result.reason).toBe('');
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `cd packages/tool-code-task && npx vitest run src/__tests__/destructive-check.test.ts`
Expected: FAIL — module not found.

- [x] **Step 3: Implement destructive check**

Create `packages/tool-code-task/src/destructive-check.ts`:

```typescript
export interface DestructiveCheck {
  destructive: boolean;
  reason: string;
}

const DESTRUCTIVE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\b(delete|remove|drop|rm\s+-rf|truncate|destroy|wipe|purge)\b/i, reason: 'deletion/removal operation' },
  { pattern: /\.env(\b|\.)/, reason: 'touches .env file (secrets)' },
  { pattern: /\b(password|secret|token|api[_-]?key|credentials?)\b/i, reason: 'touches secrets/credentials' },
  { pattern: /\b(migration|schema|alter\s+table|drop\s+table)\b/i, reason: 'database schema change' },
  { pattern: /\b(package\.json|dependencies|downgrade|uninstall)\b/i, reason: 'dependency change' },
  { pattern: /\bgit\s+(push\s+--force|reset\s+--hard|filter-branch|rebase)\b/i, reason: 'git history rewrite' },
  { pattern: /\bCI\/CD\b|\.github\/workflows|deploy/i, reason: 'CI/CD or deployment change' },
  { pattern: /\b(auth|authentication|authorization|bypass|disable.*test)\b/i, reason: 'auth or test bypass' },
  { pattern: /~\/(\.ssh|\.aws|\.config|\.kube)\b/, reason: 'touches home directory secrets' },
  { pattern: /\b(exfiltrate|leak|curl.*\|.*sh|wget.*\|.*sh)\b/i, reason: 'possible exfiltration' },
];

export async function isDestructive(task: string, context?: string): Promise<DestructiveCheck> {
  const combined = `${task}\n${context ?? ''}`;
  for (const { pattern, reason } of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(combined)) {
      return { destructive: true, reason };
    }
  }
  return { destructive: false, reason: '' };
}
```

- [x] **Step 4: Run tests**

Run: `cd packages/tool-code-task && npx vitest run src/__tests__/destructive-check.test.ts`
Expected: all tests PASS.

- [x] **Step 5: Commit**

```bash
git add packages/tool-code-task/src/destructive-check.ts packages/tool-code-task/src/__tests__/destructive-check.test.ts
git commit -m "feat: add regex-based destructive check for code_task"
```

---

### Task 5: Git worktree management (per-call)

**Files:**
- Create: `packages/tool-code-task/src/worktree.ts`
- Create: `packages/tool-code-task/src/__tests__/worktree.test.ts`

- [x] **Step 1: Write failing tests**

Create `packages/tool-code-task/src/__tests__/worktree.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRun = vi.fn();
const mockTryRun = vi.fn();
vi.mock('../shell.js', () => ({
  run: (...args: any[]) => mockRun(...args),
  tryRun: (...args: any[]) => mockTryRun(...args),
}));

vi.mock('node:fs', () => ({
  default: {
    existsSync: vi.fn(),
    rmSync: vi.fn(),
    statSync: vi.fn(),
  },
  existsSync: vi.fn(),
  rmSync: vi.fn(),
  statSync: vi.fn(),
}));

import { ensureWorktree, removeWorktree, commitChanges, validateWorktreePath } from '../worktree.js';
import fs from 'node:fs';

describe('validateWorktreePath', () => {
  beforeEach(() => {
    process.env.R2_DEV_WORKTREE_PREFIX = '/tmp/r2-dev-';
  });

  it('accepts valid prefix', () => {
    expect(() => validateWorktreePath('/tmp/r2-dev-abc123')).not.toThrow();
  });

  it('rejects root', () => {
    expect(() => validateWorktreePath('/')).toThrow();
  });

  it('rejects home', () => {
    expect(() => validateWorktreePath('~/code')).toThrow();
  });

  it('rejects missing prefix', () => {
    expect(() => validateWorktreePath('/var/tmp/foo')).toThrow();
  });

  it('rejects path with ..', () => {
    expect(() => validateWorktreePath('/tmp/r2-dev-abc/../etc')).toThrow();
  });
});

describe('ensureWorktree', () => {
  beforeEach(() => {
    mockRun.mockReset();
    mockTryRun.mockReset();
    vi.mocked(fs.existsSync).mockReset();
    process.env.R2_DEV_WORKTREE_PREFIX = '/tmp/r2-dev-';
  });

  it('creates worktree when path does not exist', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    mockRun.mockResolvedValue('');

    await ensureWorktree('/tmp/r2-dev-abc', 'dev');

    expect(mockRun).toHaveBeenCalledWith(
      'git',
      ['worktree', 'add', '--detach', '/tmp/r2-dev-abc', 'origin/dev'],
    );
  });

  it('removes existing path before creating', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    mockTryRun.mockResolvedValue({ ok: true, stdout: '', code: 0 });
    mockRun.mockResolvedValue('');

    await ensureWorktree('/tmp/r2-dev-abc', 'dev');

    expect(mockTryRun).toHaveBeenCalledWith(
      'git',
      ['worktree', 'remove', '--force', '/tmp/r2-dev-abc'],
    );
  });
});

describe('removeWorktree', () => {
  beforeEach(() => {
    mockTryRun.mockReset();
    vi.mocked(fs.existsSync).mockReset();
    vi.mocked(fs.rmSync).mockReset();
    process.env.R2_DEV_WORKTREE_PREFIX = '/tmp/r2-dev-';
  });

  it('calls git worktree remove --force', async () => {
    mockTryRun.mockResolvedValue({ ok: true, stdout: '', code: 0 });
    vi.mocked(fs.existsSync).mockReturnValue(false);

    await removeWorktree('/tmp/r2-dev-abc');

    expect(mockTryRun).toHaveBeenCalledWith(
      'git',
      ['worktree', 'remove', '--force', '/tmp/r2-dev-abc'],
    );
  });

  it('falls back to fs.rmSync if git fails and path still exists', async () => {
    mockTryRun.mockResolvedValue({ ok: false, stdout: '', code: 1 });
    vi.mocked(fs.existsSync).mockReturnValue(true);

    await removeWorktree('/tmp/r2-dev-abc');

    expect(fs.rmSync).toHaveBeenCalledWith('/tmp/r2-dev-abc', { recursive: true, force: true });
  });

  it('rejects unsafe path', async () => {
    await expect(removeWorktree('/')).rejects.toThrow();
  });
});

describe('commitChanges', () => {
  beforeEach(() => {
    mockRun.mockReset();
    mockTryRun.mockReset();
    process.env.R2_DEV_WORKTREE_PREFIX = '/tmp/r2-dev-';
  });

  it('returns empty when nothing staged', async () => {
    mockTryRun.mockResolvedValue({ ok: true, stdout: '', code: 0 }); // diff --cached --quiet exits 0
    const hash = await commitChanges('/tmp/r2-dev-abc', 'r2: test');
    expect(hash).toBe('');
  });

  it('commits via argv form and returns hash', async () => {
    mockTryRun.mockResolvedValue({ ok: false, stdout: '', code: 1 }); // has changes
    mockRun.mockResolvedValueOnce(''); // git commit
    mockRun.mockResolvedValueOnce('abc1234deadbeef'); // git rev-parse

    const hash = await commitChanges('/tmp/r2-dev-abc', 'r2: test "quoted"');

    expect(hash).toBe('abc1234deadbeef');
    expect(mockRun).toHaveBeenCalledWith(
      'git',
      ['commit', '-m', 'r2: test "quoted"'],
      '/tmp/r2-dev-abc',
    );
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `cd packages/tool-code-task && npx vitest run src/__tests__/worktree.test.ts`
Expected: FAIL — module not found.

- [x] **Step 3: Implement worktree module**

Create `packages/tool-code-task/src/worktree.ts`:

```typescript
import fs from 'node:fs';
import { run, tryRun } from './shell.js';

export function validateWorktreePath(path: string): void {
  const prefix = process.env.R2_DEV_WORKTREE_PREFIX || '/tmp/r2-dev-';
  if (!path.startsWith(prefix)) {
    throw new Error(`Worktree path must start with ${prefix}`);
  }
  if (path.includes('..') || path.includes('~') || path === '/') {
    throw new Error('Invalid worktree path');
  }
}

export async function ensureWorktree(path: string, branch: string): Promise<void> {
  validateWorktreePath(path);

  if (fs.existsSync(path)) {
    await tryRun('git', ['worktree', 'remove', '--force', path]);
    if (fs.existsSync(path)) {
      fs.rmSync(path, { recursive: true, force: true });
    }
  }

  await run('git', ['worktree', 'add', '--detach', path, `origin/${branch}`]);
}

export async function removeWorktree(path: string): Promise<void> {
  validateWorktreePath(path);

  await tryRun('git', ['worktree', 'remove', '--force', path]);

  if (fs.existsSync(path)) {
    fs.rmSync(path, { recursive: true, force: true });
  }

  // Prune dangling worktree entries
  await tryRun('git', ['worktree', 'prune']);
}

export async function getStagedFiles(path: string): Promise<Array<{ file: string; mode: string }>> {
  validateWorktreePath(path);
  const stdout = await run('git', ['ls-files', '--stage'], path);
  // Format: "100644 <hash> 0\t<file>"
  // Only care about staged (which ls-files --stage gives us all tracked)
  // For newly added files, use diff --cached with --raw
  const { stdout: rawDiff } = await tryRun('git', ['diff', '--cached', '--raw'], path);
  return rawDiff
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      // Format: ":100644 100644 <src> <dst> M\tfilename"
      const match = line.match(/^:(\d+) (\d+) \S+ \S+ \S+\t(.+)$/);
      if (!match) return null;
      return { file: match[3], mode: match[2] }; // destination mode
    })
    .filter((x): x is { file: string; mode: string } => x !== null);
}

export async function unstageFile(path: string, file: string): Promise<void> {
  validateWorktreePath(path);
  await run('git', ['restore', '--staged', file], path);
}

export async function commitChanges(path: string, message: string): Promise<string> {
  validateWorktreePath(path);

  const diffCheck = await tryRun('git', ['diff', '--cached', '--quiet'], path);
  if (diffCheck.ok) {
    return ''; // exit 0 = no staged changes
  }

  await run('git', ['commit', '-m', message], path);
  const hash = await run('git', ['rev-parse', 'HEAD'], path);
  return hash;
}
```

- [x] **Step 4: Run tests**

Run: `cd packages/tool-code-task && npx vitest run src/__tests__/worktree.test.ts`
Expected: all tests PASS.

- [x] **Step 5: Commit**

```bash
git add packages/tool-code-task/src/worktree.ts packages/tool-code-task/src/__tests__/worktree.test.ts
git commit -m "feat: add per-call git worktree management with path validation"
```

---

### Task 6: Diff parsing

**Files:**
- Create: `packages/tool-code-task/src/diff.ts`
- Create: `packages/tool-code-task/src/__tests__/diff.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/tool-code-task/src/__tests__/diff.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { parseDiffStats, truncateDiff, summarizeDiff } from '../diff.js';

describe('parseDiffStats', () => {
  it('parses file stats from numstat', () => {
    const numstat = '45\t0\tsrc/Theme.tsx\n5\t7\tsrc/App.tsx\n';
    expect(parseDiffStats(numstat)).toEqual([
      { path: 'src/Theme.tsx', added: 45, removed: 0 },
      { path: 'src/App.tsx', added: 5, removed: 7 },
    ]);
  });

  it('returns empty array for empty input', () => {
    expect(parseDiffStats('')).toEqual([]);
  });

  it('handles binary files as zero changes', () => {
    expect(parseDiffStats('-\t-\timage.png\n')).toEqual([
      { path: 'image.png', added: 0, removed: 0 },
    ]);
  });
});

describe('truncateDiff', () => {
  it('returns full diff if shorter than maxLines', () => {
    expect(truncateDiff('line1\nline2', 50)).toBe('line1\nline2');
  });

  it('truncates and appends marker', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line${i}`);
    const result = truncateDiff(lines.join('\n'), 50);
    const resultLines = result.split('\n');
    expect(resultLines.length).toBe(51);
    expect(resultLines[50]).toContain('truncated');
  });
});

describe('summarizeDiff', () => {
  it('formats summary with counts and commit', () => {
    const summary = summarizeDiff(
      [
        { path: 'a.ts', added: 10, removed: 0 },
        { path: 'b.ts', added: 5, removed: 3 },
      ],
      'abc1234567890',
    );
    expect(summary).toContain('2 files');
    expect(summary).toContain('+15');
    expect(summary).toContain('-3');
    expect(summary).toContain('abc1234');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/tool-code-task && npx vitest run src/__tests__/diff.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement diff module**

Create `packages/tool-code-task/src/diff.ts`:

```typescript
export interface FileStats {
  path: string;
  added: number;
  removed: number;
}

export function parseDiffStats(numstat: string): FileStats[] {
  return numstat
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const parts = line.split('\t');
      if (parts.length < 3) return null;
      const [addStr, remStr, ...pathParts] = parts;
      const added = addStr === '-' ? 0 : parseInt(addStr, 10) || 0;
      const removed = remStr === '-' ? 0 : parseInt(remStr, 10) || 0;
      return { path: pathParts.join('\t'), added, removed };
    })
    .filter((x): x is FileStats => x !== null);
}

export function truncateDiff(diff: string, maxLines: number): string {
  const lines = diff.split('\n');
  if (lines.length <= maxLines) return diff;
  const kept = lines.slice(0, maxLines);
  const remaining = lines.length - maxLines;
  kept.push(`... (${remaining} more lines truncated, click "Show full diff")`);
  return kept.join('\n');
}

export function summarizeDiff(files: FileStats[], commit: string): string {
  const totalAdded = files.reduce((sum, f) => sum + f.added, 0);
  const totalRemoved = files.reduce((sum, f) => sum + f.removed, 0);
  const commitShort = commit ? commit.slice(0, 7) : 'no-commit';
  return `${files.length} files changed, +${totalAdded} -${totalRemoved}. Commit: ${commitShort}`;
}
```

- [ ] **Step 4: Run tests**

Run: `cd packages/tool-code-task && npx vitest run src/__tests__/diff.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/tool-code-task/src/diff.ts packages/tool-code-task/src/__tests__/diff.test.ts
git commit -m "feat: add diff parsing and summary helpers"
```

---

### Task 7: Claude Agent SDK wrapper

**Files:**
- Create: `packages/tool-code-task/src/agent-sdk.ts`
- Create: `packages/tool-code-task/src/__tests__/agent-sdk.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/tool-code-task/src/__tests__/agent-sdk.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (opts: any) => mockQuery(opts),
}));

import { runAgent } from '../agent-sdk.js';

describe('runAgent', () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it('emits progress for text blocks', async () => {
    async function* gen() {
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Analyzing code' }] } };
    }
    mockQuery.mockReturnValueOnce(gen());

    const progress: string[] = [];
    await runAgent({ workdir: '/tmp/r2-dev-x', task: 'test', onProgress: (m) => progress.push(m) });

    expect(progress.some((p) => p.includes('Analyzing'))).toBe(true);
  });

  it('emits progress for tool_use blocks', async () => {
    async function* gen() {
      yield { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'src/App.tsx' } }] } };
      yield { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } };
    }
    mockQuery.mockReturnValueOnce(gen());

    const progress: string[] = [];
    await runAgent({ workdir: '/tmp/r2-dev-x', task: 'test', onProgress: (m) => progress.push(m) });

    expect(progress.some((p) => p.includes('src/App.tsx'))).toBe(true);
    expect(progress.some((p) => p.toLowerCase().includes('npm test'))).toBe(true);
  });

  it('passes cwd and task to SDK', async () => {
    async function* gen() { yield { type: 'result' }; }
    mockQuery.mockReturnValueOnce(gen());

    await runAgent({ workdir: '/tmp/r2-dev-y', task: 'do thing', context: 'use X', onProgress: () => {} });

    expect(mockQuery).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining('do thing'),
      options: expect.objectContaining({ cwd: '/tmp/r2-dev-y' }),
    }));
    const prompt = mockQuery.mock.calls[0][0].prompt;
    expect(prompt).toContain('use X');
  });

  it('stops on aborted signal', async () => {
    const controller = new AbortController();
    async function* gen() {
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'first' }] } };
      controller.abort();
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'second' }] } };
    }
    mockQuery.mockReturnValueOnce(gen());

    const progress: string[] = [];
    await runAgent({
      workdir: '/tmp/r2-dev-z',
      task: 'test',
      onProgress: (m) => progress.push(m),
      signal: controller.signal,
    });

    expect(progress.some((p) => p.includes('first'))).toBe(true);
    expect(progress.some((p) => p.includes('second'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/tool-code-task && npx vitest run src/__tests__/agent-sdk.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement agent SDK wrapper**

Create `packages/tool-code-task/src/agent-sdk.ts`:

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';

export interface AgentRunParams {
  workdir: string;
  task: string;
  context?: string;
  onProgress: (message: string) => void;
  signal?: AbortSignal;
}

function buildPrompt(task: string, context?: string, cwd?: string): string {
  const parts = [`Task: ${task}`];
  if (context) parts.push(`\nContext: ${context}`);
  parts.push(`\nWork in the current directory (${cwd ?? '.'}) only. Make all changes needed to complete the task. Stage changes with git add. Do not commit — the harness will commit staged changes.`);
  return parts.join('\n');
}

function describeToolUse(name: string, input: Record<string, unknown>): string {
  if (name === 'Edit' || name === 'Write') {
    return `${name === 'Edit' ? 'Editing' : 'Writing'} ${input.file_path ?? 'file'}`;
  }
  if (name === 'Bash') {
    return `Running: ${String(input.command ?? '').slice(0, 60)}`;
  }
  if (name === 'Read') {
    return `Reading ${input.file_path ?? 'file'}`;
  }
  return `Tool: ${name}`;
}

export async function runAgent(params: AgentRunParams): Promise<void> {
  const prompt = buildPrompt(params.task, params.context, params.workdir);

  const stream = query({
    prompt,
    options: { cwd: params.workdir },
  });

  for await (const message of stream) {
    if (params.signal?.aborted) break;
    if ((message as any).type !== 'assistant') continue;

    const content = (message as any).message?.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (block.type === 'text' && typeof block.text === 'string') {
        const text = block.text.trim();
        if (text.length > 0) params.onProgress(text.slice(0, 80));
      } else if (block.type === 'tool_use') {
        params.onProgress(describeToolUse(block.name, block.input ?? {}));
      }
    }
  }
}
```

- [ ] **Step 4: Run tests**

Run: `cd packages/tool-code-task && npx vitest run src/__tests__/agent-sdk.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/tool-code-task/src/agent-sdk.ts packages/tool-code-task/src/__tests__/agent-sdk.test.ts
git commit -m "feat: add Claude Agent SDK wrapper with progress streaming"
```

---

### Task 8: Ralphex wrapper with plan review

**Files:**
- Create: `packages/tool-code-task/src/ralphex.ts`
- Create: `packages/tool-code-task/src/__tests__/ralphex.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/tool-code-task/src/__tests__/ralphex.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const mockSpawn = vi.fn();
vi.mock('node:child_process', () => ({ spawn: (...args: any[]) => mockSpawn(...args) }));

import { buildPlanContent, runRalphex } from '../ralphex.js';

function makeChild(exitCode: number, stdoutData: string[] = []) {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  setTimeout(() => {
    for (const data of stdoutData) {
      child.stdout.emit('data', Buffer.from(data + '\n'));
    }
    child.emit('exit', exitCode);
  }, 5);
  return child;
}

describe('buildPlanContent', () => {
  it('includes task and context', () => {
    const plan = buildPlanContent('add dark mode', 'use tailwind');
    expect(plan).toContain('add dark mode');
    expect(plan).toContain('use tailwind');
    expect(plan).toContain('- [ ]');
  });

  it('handles missing context', () => {
    const plan = buildPlanContent('simple task');
    expect(plan).toContain('simple task');
    expect(plan).toContain('none');
  });
});

describe('runRalphex', () => {
  beforeEach(() => {
    mockSpawn.mockReset();
  });

  it('calls requestPlanReview with draft plan', async () => {
    mockSpawn.mockReturnValue(makeChild(0));
    const mockReview = vi.fn().mockResolvedValue({ approved: false });

    await expect(runRalphex({
      workdir: os.tmpdir(),
      task: 'test task',
      onProgress: () => {},
      requestPlanReview: mockReview,
    })).rejects.toThrow(/rejected/i);

    expect(mockReview).toHaveBeenCalledWith(expect.stringContaining('test task'));
  });

  it('spawns ralphex with argv form', async () => {
    mockSpawn.mockReturnValue(makeChild(0));

    await runRalphex({
      workdir: os.tmpdir(),
      task: 'test',
      onProgress: () => {},
      requestPlanReview: async () => ({ approved: true }),
    });

    expect(mockSpawn).toHaveBeenCalledWith(
      'ralphex',
      expect.arrayContaining(['--max-iterations']),
      expect.objectContaining({ shell: false }),
    );
  });

  it('uses editedPlan when provided', async () => {
    mockSpawn.mockReturnValue(makeChild(0));
    const customPlan = '# Custom\n\n- [ ] Do thing';
    let capturedPath = '';

    mockSpawn.mockImplementation((cmd: string, args: string[]) => {
      capturedPath = args[args.length - 1];
      return makeChild(0);
    });

    await runRalphex({
      workdir: os.tmpdir(),
      task: 'test',
      onProgress: () => {},
      requestPlanReview: async () => ({ approved: true, editedPlan: customPlan }),
    });

    const written = fs.readFileSync(capturedPath, 'utf8');
    expect(written).toBe(customPlan);
  });

  it('streams stdout via onProgress', async () => {
    mockSpawn.mockReturnValue(makeChild(0, ['line 1', 'line 2']));
    const progress: string[] = [];

    await runRalphex({
      workdir: os.tmpdir(),
      task: 'test',
      onProgress: (m) => progress.push(m),
      requestPlanReview: async () => ({ approved: true }),
    });

    expect(progress).toContain('line 1');
    expect(progress).toContain('line 2');
  });

  it('throws on non-zero exit', async () => {
    mockSpawn.mockReturnValue(makeChild(1));

    await expect(runRalphex({
      workdir: os.tmpdir(),
      task: 'test',
      onProgress: () => {},
      requestPlanReview: async () => ({ approved: true }),
    })).rejects.toThrow(/exit.*1/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/tool-code-task && npx vitest run src/__tests__/ralphex.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement ralphex wrapper**

Create `packages/tool-code-task/src/ralphex.ts`:

```typescript
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { PlanReviewResponse } from '@r2/shared';

export type { PlanReviewResponse };

export interface RalphexRunParams {
  workdir: string;
  task: string;
  context?: string;
  onProgress: (message: string) => void;
  requestPlanReview: (plan: string) => Promise<PlanReviewResponse>;
  signal?: AbortSignal;
}

export function buildPlanContent(task: string, context?: string): string {
  return `# R2 Auto Task

**Goal:** ${task}

**Context:** ${context ?? 'none'}

---

## Task 1: Implement the task

- [ ] **Step 1: Analyze the codebase**

Read relevant files to understand existing patterns.

- [ ] **Step 2: Make the required changes**

Implement the task. Keep changes minimal and focused.

- [ ] **Step 3: Run tests if they exist**

Run: \`npx vitest run\` in the relevant package.

- [ ] **Step 4: Stage changes**

Run: \`git add -A\`
(Do not commit — the harness will commit staged changes.)
`;
}

export async function runRalphex(params: RalphexRunParams): Promise<void> {
  const draftPlan = buildPlanContent(params.task, params.context);

  const review = await params.requestPlanReview(draftPlan);
  if (!review.approved) {
    throw new Error('Plan rejected by user');
  }
  const finalPlan = review.editedPlan ?? draftPlan;

  // Secure temp dir (non-predictable, mode 0700)
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-task-'));
  const planPath = path.join(tmpDir, 'plan.md');
  fs.writeFileSync(planPath, finalPlan, { mode: 0o600 });

  const maxIterations = process.env.R2_RALPHEX_MAX_ITERATIONS || '20';

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('ralphex', ['--max-iterations', maxIterations, planPath], {
        cwd: params.workdir,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
      });

      const onAbort = () => child.kill('SIGTERM');
      params.signal?.addEventListener('abort', onAbort, { once: true });

      let stdoutBuffer = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBuffer += chunk.toString();
        const lines = stdoutBuffer.split('\n');
        stdoutBuffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.length > 0) params.onProgress(trimmed.slice(0, 120));
        }
      });

      child.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString().trim();
        if (text.length > 0) params.onProgress(text.slice(0, 120));
      });

      child.on('exit', (code) => {
        params.signal?.removeEventListener('abort', onAbort);
        if (code === 0) resolve();
        else reject(new Error(`ralphex exited with code ${code}`));
      });

      child.on('error', (err) => {
        params.signal?.removeEventListener('abort', onAbort);
        reject(err);
      });
    });
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}
```

- [ ] **Step 4: Run tests**

Run: `cd packages/tool-code-task && npx vitest run src/__tests__/ralphex.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/tool-code-task/src/ralphex.ts packages/tool-code-task/src/__tests__/ralphex.test.ts
git commit -m "feat: add ralphex wrapper with plan review flow"
```

---

### Task 9: code_task handler with denylist and cleanup

**Files:**
- Modify: `packages/tool-code-task/src/index.ts`
- Create: `packages/tool-code-task/src/__tests__/code-task.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/tool-code-task/src/__tests__/code-task.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockEnsureWorktree = vi.fn();
const mockRemoveWorktree = vi.fn();
const mockCommitChanges = vi.fn();
const mockGetStagedFiles = vi.fn();
const mockUnstageFile = vi.fn();
const mockRunAgent = vi.fn();
const mockRunRalphex = vi.fn();
const mockRun = vi.fn();

vi.mock('../worktree.js', () => ({
  ensureWorktree: (...a: any[]) => mockEnsureWorktree(...a),
  removeWorktree: (...a: any[]) => mockRemoveWorktree(...a),
  commitChanges: (...a: any[]) => mockCommitChanges(...a),
  getStagedFiles: (...a: any[]) => mockGetStagedFiles(...a),
  unstageFile: (...a: any[]) => mockUnstageFile(...a),
}));

vi.mock('../agent-sdk.js', () => ({ runAgent: (...a: any[]) => mockRunAgent(...a) }));
vi.mock('../ralphex.js', () => ({ runRalphex: (...a: any[]) => mockRunRalphex(...a) }));
vi.mock('../shell.js', () => ({ run: (...a: any[]) => mockRun(...a), tryRun: vi.fn() }));

vi.mock('node:fs', () => ({
  default: { statSync: vi.fn().mockReturnValue({ size: 100 }) },
  statSync: vi.fn().mockReturnValue({ size: 100 }),
}));

import { codeTaskTool } from '../index.js';

describe('codeTaskTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnsureWorktree.mockResolvedValue(undefined);
    mockRemoveWorktree.mockResolvedValue(undefined);
    mockCommitChanges.mockResolvedValue('abc1234567890');
    mockGetStagedFiles.mockResolvedValue([{ file: 'src/App.tsx', mode: '100644' }]);
    mockRunAgent.mockResolvedValue(undefined);
    mockRunRalphex.mockResolvedValue(undefined);
    mockRun.mockImplementation((cmd: string, args: string[]) => {
      if (args.includes('--numstat')) return Promise.resolve('5\t2\tsrc/App.tsx');
      return Promise.resolve('diff content');
    });
  });

  it('requires task parameter', async () => {
    const result = await codeTaskTool.handler({}, { onProgress: () => {} });
    expect(result.success).toBe(false);
    expect(result.error).toContain('task');
  });

  it('runs agent-sdk in once mode', async () => {
    const result = await codeTaskTool.handler(
      { task: 'add feature' },
      { onProgress: () => {}, meta: { callId: 'c1' } },
    );

    expect(mockRunAgent).toHaveBeenCalled();
    expect(mockRunRalphex).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect((result.data as any).mode).toBe('once');
  });

  it('runs ralphex in auto mode', async () => {
    await codeTaskTool.handler(
      { task: 'test' },
      {
        onProgress: () => {},
        meta: { autoMode: true, callId: 'c2' },
        requestPlanReview: async () => ({ approved: true }),
      },
    );
    expect(mockRunRalphex).toHaveBeenCalled();
  });

  it('fails in auto mode without requestPlanReview', async () => {
    const result = await codeTaskTool.handler(
      { task: 'test' },
      { onProgress: () => {}, meta: { autoMode: true, callId: 'c3' } },
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/plan review/i);
  });

  it('unstages .env files via denylist', async () => {
    mockGetStagedFiles.mockResolvedValue([
      { file: 'src/App.tsx', mode: '100644' },
      { file: '.env', mode: '100644' },
      { file: 'src/.env.local', mode: '100644' },
    ]);

    const result = await codeTaskTool.handler(
      { task: 'test' },
      { onProgress: () => {}, meta: { callId: 'c4' } },
    );

    expect(mockUnstageFile).toHaveBeenCalledWith(expect.any(String), '.env');
    expect(mockUnstageFile).toHaveBeenCalledWith(expect.any(String), 'src/.env.local');
    expect((result.data as any).blockedFiles).toContain('.env');
    expect((result.data as any).blockedFiles).toContain('src/.env.local');
  });

  it('removes worktree in finally on success', async () => {
    await codeTaskTool.handler(
      { task: 'test' },
      { onProgress: () => {}, meta: { callId: 'c5' } },
    );
    expect(mockRemoveWorktree).toHaveBeenCalled();
  });

  it('removes worktree in finally on agent error', async () => {
    mockRunAgent.mockRejectedValue(new Error('agent crashed'));

    const result = await codeTaskTool.handler(
      { task: 'test' },
      { onProgress: () => {}, meta: { callId: 'c6' } },
    );

    expect(result.success).toBe(false);
    expect(mockRemoveWorktree).toHaveBeenCalled();
  });

  it('uses per-call worktree paths', async () => {
    await codeTaskTool.handler(
      { task: 'a' },
      { onProgress: () => {}, meta: { callId: 'call-a' } },
    );
    await codeTaskTool.handler(
      { task: 'b' },
      { onProgress: () => {}, meta: { callId: 'call-b' } },
    );

    const firstPath = mockEnsureWorktree.mock.calls[0][0];
    const secondPath = mockEnsureWorktree.mock.calls[1][0];
    expect(firstPath).not.toBe(secondPath);
    expect(firstPath).toContain('call-a');
    expect(secondPath).toContain('call-b');
  });

  it('defines preCheck hook delegating to isDestructive', async () => {
    expect(codeTaskTool.preCheck).toBeDefined();
    const result = await codeTaskTool.preCheck!({ task: 'delete all logs' });
    expect(result.destructive).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/tool-code-task && npx vitest run src/__tests__/code-task.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement handler**

Replace `packages/tool-code-task/src/index.ts`:

```typescript
import type { ToolDefinition, ToolContext, ToolResult } from '@r2/shared';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ensureWorktree, removeWorktree, commitChanges, getStagedFiles, unstageFile } from './worktree.js';
import { runAgent } from './agent-sdk.js';
import { runRalphex } from './ralphex.js';
import { parseDiffStats, truncateDiff, summarizeDiff } from './diff.js';
import { run, tryRun } from './shell.js';
import { isDestructive } from './destructive-check.js';

export { isDestructive } from './destructive-check.js';

const DENYLIST_PATTERNS = [
  /(^|\/)\.env(\.|$)/,
  /\.(key|pem|p12|pfx|asc|gpg)$/,
  /(^|\/)id_rsa(\.|$)/,
  /(^|\/)id_ed25519(\.|$)/,
  /(^|\/)\.ssh\//,
  /(^|\/)\.aws\//,
  /(^|\/)\.kube\//,
];

const MAX_FILE_SIZE = 1024 * 1024;
const SYMLINK_MODE = '120000';

async function filterStagedFiles(workdir: string): Promise<string[]> {
  const staged = await getStagedFiles(workdir);
  const blocked: string[] = [];

  for (const { file, mode } of staged) {
    let block = false;

    if (DENYLIST_PATTERNS.some((p) => p.test(file))) {
      block = true;
    } else if (mode === SYMLINK_MODE) {
      block = true;
    } else {
      try {
        const stats = fs.statSync(path.join(workdir, file));
        if (stats.size > MAX_FILE_SIZE) block = true;
      } catch {
        // file might not exist (deletion) — allow
      }
    }

    if (block) {
      await unstageFile(workdir, file);
      blocked.push(file);
    }
  }

  return blocked;
}

export const codeTaskTool: ToolDefinition = {
  name: 'code_task',
  description: 'Execute a coding task on R2 dev branch. Use for modifications to R2 source code itself. Runs Claude Code or ralphex in an isolated git worktree.',
  permissionLevel: 'confirm',
  parameters: {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'Specific task description' },
      context: { type: 'string', description: 'Optional: files, requirements, constraints' },
    },
    required: ['task'],
  },

  preCheck: async (input) => {
    const task = typeof input.task === 'string' ? input.task : '';
    const context = typeof input.context === 'string' ? input.context : undefined;
    return isDestructive(task, context);
  },

  async handler(params: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
    const task = params.task;
    if (typeof task !== 'string' || task.trim().length === 0) {
      return { success: false, error: 'task parameter is required' };
    }
    const context = typeof params.context === 'string' ? params.context : undefined;
    const onProgress = ctx?.onProgress ?? (() => {});
    const signal = ctx?.signal;
    const callId = ctx?.meta?.callId ?? crypto.randomBytes(4).toString('hex');
    const autoMode = ctx?.meta?.autoMode === true;

    const prefix = process.env.R2_DEV_WORKTREE_PREFIX || '/tmp/r2-dev-';
    const workdir = `${prefix}${callId}`;
    const branch = process.env.R2_DEV_BRANCH || 'dev';
    const baseBranch = process.env.R2_DEV_BASE_BRANCH || 'master';
    const startTime = Date.now();

    if (autoMode && !ctx?.requestPlanReview) {
      return { success: false, error: 'Plan review callback required for auto mode' };
    }

    let worktreeCreated = false;
    try {
      onProgress('Preparing worktree...');
      await ensureWorktree(workdir, branch);
      worktreeCreated = true;

      onProgress(`Running ${autoMode ? 'ralphex' : 'agent'}...`);
      if (autoMode) {
        await runRalphex({
          workdir,
          task,
          context,
          onProgress,
          requestPlanReview: ctx!.requestPlanReview!,
          signal,
        });
      } else {
        await runAgent({ workdir, task, context, onProgress, signal });
      }

      onProgress('Filtering files...');
      const blockedFiles = await filterStagedFiles(workdir);

      onProgress('Committing...');
      const commit = await commitChanges(workdir, `r2: ${task}`);

      onProgress('Computing diff...');
      let files: ReturnType<typeof parseDiffStats> = [];
      let fullDiff = '';
      try {
        const numstat = await run('git', ['diff', '--numstat', `${baseBranch}..HEAD`], workdir);
        files = parseDiffStats(numstat);
        fullDiff = await run('git', ['diff', `${baseBranch}..HEAD`], workdir);
      } catch (err) {
        // Diff failed — don't lose the commit
        onProgress('Diff parsing failed, continuing with commit hash only');
      }

      const summary = summarizeDiff(files, commit || 'no-commit');
      const shortDiff = truncateDiff(fullDiff, 50);

      return {
        success: true,
        data: {
          summary,
          files,
          shortDiff,
          fullDiff,
          commit,
          mode: autoMode ? 'ralphex' : 'once',
          durationMs: Date.now() - startTime,
          blockedFiles,
        },
        display: {
          type: 'code',
          content: shortDiff,
        },
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error in code_task',
      };
    } finally {
      if (worktreeCreated) {
        try { await removeWorktree(workdir); } catch {}
      }
    }
  },
};

export default codeTaskTool;
```

- [ ] **Step 4: Run tests**

Run: `cd packages/tool-code-task && npx vitest run src/__tests__/code-task.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/tool-code-task/src/index.ts packages/tool-code-task/src/__tests__/code-task.test.ts
git commit -m "feat: implement code_task handler with denylist and per-call worktree"
```

---

### Task 10: Plan review route and pending map

**Files:**
- Create: `packages/server/src/routes/plan-review.ts`
- Create: `packages/server/src/routes/plan-review.test.ts`
- Modify: `packages/server/src/index.ts`
- Modify: `packages/server/src/routes/chat.ts`

- [ ] **Step 1: Write failing tests for plan-review route**

Create `packages/server/src/routes/plan-review.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createPlanReviewRouter, type PendingPlanReviews } from './plan-review.js';

describe('POST /api/plan-review', () => {
  let app: express.Express;
  let pending: PendingPlanReviews;

  beforeEach(() => {
    pending = new Map();
    app = express();
    app.use(express.json());
    app.use('/api', createPlanReviewRouter(pending));
  });

  it('rejects missing callId', async () => {
    const res = await request(app).post('/api/plan-review').send({ approved: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/callId/);
  });

  it('rejects missing approved', async () => {
    const res = await request(app).post('/api/plan-review').send({ callId: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/approved/);
  });

  it('returns 404 for unknown callId', async () => {
    const res = await request(app).post('/api/plan-review').send({ callId: 'x', approved: true });
    expect(res.status).toBe(404);
  });

  it('resolves pending and removes from map', async () => {
    let received: any = null;
    pending.set('c1', (r) => { received = r; });

    const res = await request(app).post('/api/plan-review').send({
      callId: 'c1',
      approved: true,
      editedPlan: '# Plan',
    });

    expect(res.status).toBe(200);
    expect(received).toEqual({ approved: true, editedPlan: '# Plan' });
    expect(pending.has('c1')).toBe(false);
  });

  it('handles approved=false', async () => {
    let received: any = null;
    pending.set('c2', (r) => { received = r; });

    await request(app).post('/api/plan-review').send({ callId: 'c2', approved: false });

    expect(received).toEqual({ approved: false, editedPlan: undefined });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/server && npx vitest run src/routes/plan-review.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create plan-review route**

Create `packages/server/src/routes/plan-review.ts`:

```typescript
import { Router } from 'express';
import type { Request, Response } from 'express';
import type { PlanReviewResponse } from '@r2/shared';

export type { PlanReviewResponse };
export type PendingPlanReviews = Map<string, (response: PlanReviewResponse) => void>;

export function createPlanReviewRouter(pendingPlanReviews: PendingPlanReviews): Router {
  const router = Router();

  router.post('/plan-review', (req: Request, res: Response) => {
    const { callId, approved, editedPlan } = req.body;

    if (!callId || typeof callId !== 'string') {
      res.status(400).json({ error: 'callId (string) required' });
      return;
    }
    if (typeof approved !== 'boolean') {
      res.status(400).json({ error: 'approved (boolean) required' });
      return;
    }

    const resolve = pendingPlanReviews.get(callId);
    if (!resolve) {
      res.status(404).json({ error: `Pending plan review "${callId}" not found` });
      return;
    }

    pendingPlanReviews.delete(callId);
    resolve({
      approved,
      editedPlan: typeof editedPlan === 'string' ? editedPlan : undefined,
    });
    res.json({ ok: true });
  });

  return router;
}
```

- [ ] **Step 4: Wire pendingPlanReviews in index.ts**

In `packages/server/src/index.ts`, add import near other route imports:

```typescript
import { createPlanReviewRouter, type PendingPlanReviews } from './routes/plan-review.js';
```

After `const pendingConfirms: PendingConfirms = new Map();` add:

```typescript
const pendingPlanReviews: PendingPlanReviews = new Map();
```

Update `createChatRouter` call to pass `pendingPlanReviews`:

```typescript
const chatRouter = createChatRouter({
  runLoop: ({ messages, onEvent, signal, pendingConfirms: pc, pendingPlanReviews: ppr, piiProxy: pp }) =>
    runToolLoop({ messages, client, registry, onEvent, signal, pendingConfirms: pc, pendingPlanReviews: ppr, piiProxy: pp }),
  pendingConfirms,
  pendingPlanReviews,
  piiProxy,
});
```

Register route after other `/api` routes:

```typescript
app.use('/api', createPlanReviewRouter(pendingPlanReviews));
```

- [ ] **Step 5: Update chat.ts to forward pendingPlanReviews**

In `packages/server/src/routes/chat.ts`, add import:

```typescript
import type { PendingPlanReviews } from './plan-review.js';
```

Update `ChatRouterDeps`:

```typescript
interface ChatRouterDeps {
  runLoop: (params: {
    messages: MessageParam[];
    onEvent: (event: SSEEvent) => void;
    signal?: AbortSignal;
    pendingConfirms: PendingConfirms;
    pendingPlanReviews: PendingPlanReviews;
    piiProxy: PiiProxy;
  }) => Promise<void>;
  pendingConfirms: PendingConfirms;
  pendingPlanReviews: PendingPlanReviews;
  piiProxy: PiiProxy;
}
```

Destructure in router factory:

```typescript
export function createChatRouter({ runLoop, pendingConfirms, pendingPlanReviews, piiProxy }: ChatRouterDeps): Router {
```

Pass to `runLoop` call inside handler:

```typescript
      await runLoop({
        messages: addTimestamps(messages),
        signal: abortController.signal,
        pendingConfirms,
        pendingPlanReviews,
        piiProxy,
        onEvent: (event: SSEEvent) => {
          // ... existing accumulation logic preserved ...
          if (!res.writableEnded && !res.destroyed) {
            res.write(`data: ${JSON.stringify(event)}\n\n`);
          }
        },
      });
```

- [ ] **Step 6: Run tests and typecheck**

Run: `cd packages/server && npx vitest run src/routes/plan-review.test.ts && npx tsc --noEmit -p packages/server/tsconfig.json`
Expected: all tests pass, no type errors.

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/routes/plan-review.ts packages/server/src/routes/plan-review.test.ts packages/server/src/index.ts packages/server/src/routes/chat.ts
git commit -m "feat: add POST /api/plan-review route and pendingPlanReviews map"
```

---

### Task 11: Tool-loop integration (preCheck, autoMode, plan review, progress ctx)

**Files:**
- Modify: `packages/server/src/ai/tool-loop.ts`

- [ ] **Step 1: Add imports and extended ToolLoopParams**

In `packages/server/src/ai/tool-loop.ts`, at the top after existing imports:

```typescript
import type { PendingPlanReviews } from '../routes/plan-review.js';
import type { PlanReviewResponse, ToolContext } from '@r2/shared';
```

Update `ToolLoopParams` interface:

```typescript
interface ToolLoopParams {
  messages: MessageParam[];
  client: ClaudeClient;
  registry: ToolRegistry;
  onEvent: (event: SSEEvent) => void;
  signal?: AbortSignal;
  pendingConfirms?: PendingConfirms;
  pendingPlanReviews?: PendingPlanReviews;
  piiProxy: PiiProxy;
}
```

Update `runToolLoop` destructure to include `pendingPlanReviews = new Map()`:

```typescript
export async function runToolLoop({
  messages,
  client,
  registry,
  onEvent,
  signal,
  pendingConfirms = new Map(),
  pendingPlanReviews = new Map(),
  piiProxy,
}: ToolLoopParams): Promise<void> {
```

- [ ] **Step 2: Add helper functions**

Add these helpers after `requestConfirmation`:

```typescript
function createPlanReviewRequester(
  callId: string,
  task: string,
  onEvent: (event: SSEEvent) => void,
  pendingPlanReviews: PendingPlanReviews,
  signal?: AbortSignal,
): (plan: string) => Promise<PlanReviewResponse> {
  return (plan: string) => new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ approved: false });
      return;
    }
    const onAbort = () => {
      pendingPlanReviews.delete(callId);
      resolve({ approved: false });
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    pendingPlanReviews.set(callId, (response) => {
      signal?.removeEventListener('abort', onAbort);
      resolve(response);
    });
    onEvent({ type: 'tool_plan_review', id: callId, task, plan });
  });
}

function buildToolContext(
  blockId: string,
  task: string,
  autoMode: boolean,
  onEvent: (event: SSEEvent) => void,
  pendingPlanReviews: PendingPlanReviews,
  signal?: AbortSignal,
): ToolContext {
  return {
    onProgress: (message) => onEvent({ type: 'tool_progress', id: blockId, message }),
    requestPlanReview: createPlanReviewRequester(blockId, task, onEvent, pendingPlanReviews, signal),
    signal,
    meta: { autoMode, callId: blockId },
  };
}
```

Update `requestConfirmation` signature to accept `destructiveWarning`:

```typescript
async function requestConfirmation(
  callId: string,
  toolCall: ToolCall,
  level: 'confirm' | 'forbidden',
  onEvent: (event: SSEEvent) => void,
  pendingConfirms: PendingConfirms,
  signal?: AbortSignal,
  destructiveWarning?: { reason: string },
): Promise<ConfirmResponse> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ allowed: false, remember: false });
      return;
    }
    const onAbort = () => {
      pendingConfirms.delete(callId);
      resolve({ allowed: false, remember: false });
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    pendingConfirms.set(callId, (response) => {
      signal?.removeEventListener('abort', onAbort);
      resolve(response);
    });
    onEvent({ type: 'tool_confirm_request', toolCall, level, destructiveWarning });
  });
}
```

- [ ] **Step 3: Update confirm/forbidden branch with preCheck + autoMode**

Find the `else if (toolDef.permissionLevel === 'confirm' || toolDef.permissionLevel === 'forbidden')` block and replace its body:

```typescript
      } else if (toolDef.permissionLevel === 'confirm' || toolDef.permissionLevel === 'forbidden') {
        let allowed: boolean | null = null;
        let autoMode = false;
        let destructiveWarning: { reason: string } | undefined;

        // Run preCheck if defined (generic hook, not tool-specific)
        if (toolDef.preCheck) {
          try {
            const check = await toolDef.preCheck(deanonInput);
            if (check.destructive) {
              destructiveWarning = { reason: check.reason };
              allowed = null; // Force confirmation even if saved rule
            }
          } catch (err) {
            console.error('preCheck failed:', err instanceof Error ? err.message : err);
          }
        }

        // Check saved permission rule (only if not destructive)
        if (allowed === null && toolDef.permissionLevel === 'confirm' && !destructiveWarning) {
          try {
            const rule = getPermissionRule(block.name);
            if (rule) {
              allowed = rule.allowed;
              if (rule.allowed) autoMode = true;
            }
          } catch (err) {
            console.error('Failed to read permission rule:', err instanceof Error ? err.message : err);
          }
        }

        if (allowed === null) {
          const confirmResponse = await requestConfirmation(
            block.id,
            toolCall,
            toolDef.permissionLevel,
            onEvent,
            pendingConfirms,
            signal,
            destructiveWarning,
          );
          allowed = confirmResponse.allowed;

          if (confirmResponse.remember && toolDef.permissionLevel === 'confirm' && !destructiveWarning) {
            try {
              savePermissionRule(block.name, confirmResponse.allowed);
            } catch (err) {
              console.error('Failed to save permission rule:', err instanceof Error ? err.message : err);
            }
          }
        }

        if (allowed) {
          try {
            const task = typeof deanonInput.task === 'string' ? deanonInput.task : '';
            const ctx = buildToolContext(block.id, task, autoMode, onEvent, pendingPlanReviews, signal);
            result = await toolDef.handler(deanonInput, ctx);
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
          const task = typeof deanonInput.task === 'string' ? deanonInput.task : '';
          const ctx = buildToolContext(block.id, task, false, onEvent, pendingPlanReviews, signal);
          result = await toolDef.handler(deanonInput, ctx);
        } catch (err) {
          result = {
            success: false,
            error: err instanceof Error ? err.message : 'Unknown error',
          };
        }
      }
```

- [ ] **Step 4: Write tool-loop tests for new behavior**

Append to `packages/server/src/ai/__tests__/tool-loop.test.ts`:

```typescript
describe('Agentic Tool Loop — preCheck and autoMode', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-precheck-'));
    initDb(path.join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('fires preCheck hook and forces confirmation when destructive', async () => {
    const client = mockClaudeClient([
      {
        content: [{ type: 'tool_use', id: 'call_dest', name: 'danger_tool', input: { task: 'delete stuff' } }],
        stop_reason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' },
    ]);

    const handler = vi.fn(async () => ({ success: true, data: 'x' }));
    const toolDefs = [{
      name: 'danger_tool',
      description: 'Dangerous',
      permissionLevel: 'confirm' as const,
      parameters: { type: 'object' as const, properties: {}, required: [] },
      preCheck: async () => ({ destructive: true, reason: 'test destructive' }),
      handler,
    }];

    const registry: any = { register: vi.fn(), get: (n: string) => toolDefs.find((t) => t.name === n), getAll: () => toolDefs };

    const events: SSEEvent[] = [];
    const pendingConfirms = new Map();
    const onEvent = (e: SSEEvent) => {
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
      messages: [{ role: 'user', content: 'do it' }],
      client,
      registry,
      onEvent,
      pendingConfirms,
      piiProxy: { anonymize: async (t: string) => ({ text: t, entities: [] }), deanonymize: async (t: string) => t } as any,
    });

    const confirmEvent = events.find((e) => e.type === 'tool_confirm_request');
    expect(confirmEvent).toBeDefined();
    if (confirmEvent?.type === 'tool_confirm_request') {
      expect(confirmEvent.destructiveWarning).toEqual({ reason: 'test destructive' });
    }
    expect(handler).toHaveBeenCalled();
  });

  it('autoMode=true when saved rule exists and not destructive', async () => {
    const { savePermissionRule } = await import('../../db.js');
    savePermissionRule('auto_tool', true);

    const client = mockClaudeClient([
      {
        content: [{ type: 'tool_use', id: 'call_auto', name: 'auto_tool', input: { task: 'safe task' } }],
        stop_reason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' },
    ]);

    let receivedCtx: any = null;
    const toolDefs = [{
      name: 'auto_tool',
      description: 'Auto',
      permissionLevel: 'confirm' as const,
      parameters: { type: 'object' as const, properties: {}, required: [] },
      preCheck: async () => ({ destructive: false, reason: '' }),
      handler: vi.fn(async (_p: any, ctx: any) => { receivedCtx = ctx; return { success: true, data: 'x' }; }),
    }];

    const registry: any = { register: vi.fn(), get: (n: string) => toolDefs.find((t) => t.name === n), getAll: () => toolDefs };

    await runToolLoop({
      messages: [{ role: 'user', content: 'do it' }],
      client,
      registry,
      onEvent: () => {},
      piiProxy: { anonymize: async (t: string) => ({ text: t, entities: [] }), deanonymize: async (t: string) => t } as any,
    });

    expect(receivedCtx?.meta?.autoMode).toBe(true);
  });

  it('saved rule does NOT apply when destructive', async () => {
    const { savePermissionRule } = await import('../../db.js');
    savePermissionRule('danger_tool', true);

    const client = mockClaudeClient([
      {
        content: [{ type: 'tool_use', id: 'call_x', name: 'danger_tool', input: { task: 'bad thing' } }],
        stop_reason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' },
    ]);

    const toolDefs = [{
      name: 'danger_tool',
      description: 'Dangerous',
      permissionLevel: 'confirm' as const,
      parameters: { type: 'object' as const, properties: {}, required: [] },
      preCheck: async () => ({ destructive: true, reason: 'danger' }),
      handler: vi.fn(async () => ({ success: true, data: 'x' })),
    }];

    const registry: any = { register: vi.fn(), get: (n: string) => toolDefs.find((t) => t.name === n), getAll: () => toolDefs };

    const events: SSEEvent[] = [];
    const pendingConfirms = new Map();

    await runToolLoop({
      messages: [{ role: 'user', content: 'do it' }],
      client,
      registry,
      onEvent: (e) => {
        events.push(e);
        if (e.type === 'tool_confirm_request') {
          const resolve = pendingConfirms.get(e.toolCall.id);
          if (resolve) { pendingConfirms.delete(e.toolCall.id); resolve({ allowed: true, remember: false }); }
        }
      },
      pendingConfirms,
      piiProxy: { anonymize: async (t: string) => ({ text: t, entities: [] }), deanonymize: async (t: string) => t } as any,
    });

    // Must have shown confirm card despite saved rule
    expect(events.some((e) => e.type === 'tool_confirm_request')).toBe(true);
  });
});
```

- [ ] **Step 5: Add @r2/tool-code-task to server package**

Edit `packages/server/package.json` to add dependency:

```json
  "dependencies": {
    "@anthropic-ai/sdk": "^0.39.0",
    "@r2/shared": "*",
    "@r2/tool-code-task": "*",
    "express": "^4.21.0",
    ...
  }
```

Run `npm install`.

- [ ] **Step 6: Run all tests**

Run: `cd packages/server && npx vitest run`
Expected: all tests pass (existing + new).

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/ai/tool-loop.ts packages/server/src/ai/__tests__/tool-loop.test.ts packages/server/package.json package.json package-lock.json
git commit -m "feat: integrate preCheck hook, autoMode, and plan review into tool-loop"
```

---

### Task 12: Client — PermissionCard with 3 buttons + destructive warning

**Files:**
- Modify: `packages/client/src/components/PermissionCard.tsx`
- Modify: `packages/client/src/hooks/useChat.ts`
- Modify: `packages/client/src/components/MessageBubble.tsx`

- [ ] **Step 1: Update PendingConfirm type in useChat**

In `packages/client/src/hooks/useChat.ts`:

```typescript
export interface PendingConfirm {
  callId: string;
  level: 'confirm' | 'forbidden';
  destructiveWarning?: { reason: string };
}
```

In `tool_confirm_request` case handler, include `destructiveWarning`:

```typescript
          case 'tool_confirm_request':
            setPendingConfirms((prev) => {
              const next = new Map(prev);
              next.set(event.toolCall.id, {
                callId: event.toolCall.id,
                level: event.level,
                destructiveWarning: event.destructiveWarning,
              });
              return next;
            });
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
                  piiEntities,
                },
              ];
            });
            break;
```

- [ ] **Step 2: Update PermissionCard with 3 buttons and destructive banner**

Replace `packages/client/src/components/PermissionCard.tsx`:

```tsx
import { useState, useEffect } from 'react';
import type { ToolCall } from '@r2/shared';

interface Props {
  toolCall: ToolCall;
  level: 'confirm' | 'forbidden';
  destructiveWarning?: { reason: string };
  onRespond: (callId: string, allowed: boolean, remember: boolean) => Promise<boolean>;
}

export function PermissionCard({ toolCall, level, destructiveWarning, onRespond }: Props) {
  const [decision, setDecision] = useState<'allowed' | 'denied' | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [remember, setRemember] = useState(false);
  const [pulse, setPulse] = useState(false);
  const responded = decision !== null;
  const isCodeTask = toolCall.name === 'code_task';
  const isForbidden = level === 'forbidden' || Boolean(destructiveWarning);

  useEffect(() => {
    if (responded) return;
    const timer = setTimeout(() => setPulse(true), 60_000);
    return () => clearTimeout(timer);
  }, [responded]);

  const handleRespond = async (allowed: boolean, rememberOverride?: boolean) => {
    setSubmitting(true);
    try {
      const shouldRemember = rememberOverride ?? remember;
      const ok = await onRespond(toolCall.id, allowed, shouldRemember);
      if (ok) setDecision(allowed ? 'allowed' : 'denied');
    } finally {
      setSubmitting(false);
    }
  };

  const cardStyle: React.CSSProperties = {
    background: isForbidden ? '#FEF2F2' : '#f8f8f8',
    border: isForbidden ? '2px solid #DC2626' : '1px solid #e5e5e5',
    borderRadius: 14,
    padding: 16,
    marginBottom: 6,
    maxWidth: '80%',
    fontSize: 13,
    opacity: responded ? 0.7 : submitting ? 0.85 : 1,
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
            {isForbidden ? '\u{1F534}' : '\u26A0'}
          </div>
          <div style={{ fontWeight: 600, fontSize: 14 }}>
            {toolCall.name} — {isForbidden ? 'Dangerous action' : 'Confirmation'}
          </div>
        </div>

        {destructiveWarning && (
          <div style={{
            background: '#FEE2E2', border: '1px solid #FCA5A5',
            borderRadius: 6, padding: 8, marginBottom: 10,
            fontSize: 12, color: '#991B1B',
          }}>
            <strong>⚠ Destructive:</strong> {destructiveWarning.reason}
          </div>
        )}

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
            {decision === 'allowed' ? '\u2713 Allowed' : '\u2717 Denied'}
          </div>
        ) : isCodeTask ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <button
              onClick={() => handleRespond(true, false)}
              disabled={submitting}
              style={{
                padding: 8, borderRadius: 8, border: 'none',
                background: '#2A5A8A', color: '#fff', fontSize: 13,
                cursor: submitting ? 'wait' : 'pointer', opacity: submitting ? 0.6 : 1,
              }}
            >
              Allow once
            </button>
            <button
              onClick={() => handleRespond(true, true)}
              disabled={submitting || Boolean(destructiveWarning)}
              title={destructiveWarning ? 'Cannot remember destructive actions' : ''}
              style={{
                padding: 8, borderRadius: 8, border: 'none',
                background: '#10B981', color: '#fff', fontSize: 13,
                cursor: submitting || destructiveWarning ? 'not-allowed' : 'pointer',
                opacity: submitting || destructiveWarning ? 0.5 : 1,
              }}
            >
              ⭐ Allow always (auto mode with ralphex)
            </button>
            <button
              onClick={() => handleRespond(false)}
              disabled={submitting}
              style={{
                padding: 8, borderRadius: 8,
                border: '1px solid #ddd', background: '#fff',
                color: '#666', fontSize: 13,
                cursor: submitting ? 'wait' : 'pointer', opacity: submitting ? 0.6 : 1,
              }}
            >
              Deny
            </button>
          </div>
        ) : (
          <>
            {!isForbidden && (
              <label style={{
                display: 'flex', alignItems: 'center', gap: 6,
                marginBottom: 10, fontSize: 12, color: '#666', cursor: 'pointer',
              }}>
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(e) => setRemember(e.target.checked)}
                />
                Remember
              </label>
            )}
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={() => handleRespond(true)}
                disabled={submitting}
                style={{
                  flex: 1, padding: 8, borderRadius: 8, border: 'none',
                  background: '#2A5A8A', color: '#fff', fontSize: 13,
                  cursor: submitting ? 'wait' : 'pointer', opacity: submitting ? 0.6 : 1,
                }}
              >
                Allow
              </button>
              <button
                onClick={() => handleRespond(false)}
                disabled={submitting}
                style={{
                  flex: 1, padding: 8, borderRadius: 8,
                  border: '1px solid #ddd', background: '#fff',
                  color: '#666', fontSize: 13,
                  cursor: submitting ? 'wait' : 'pointer', opacity: submitting ? 0.6 : 1,
                }}
              >
                Deny
              </button>
            </div>
          </>
        )}
      </div>
    </>
  );
}
```

- [ ] **Step 3: Pass destructiveWarning in MessageBubble**

In `packages/client/src/components/MessageBubble.tsx`, update the PermissionCard render:

```tsx
      {message.toolCalls?.map((tc) => {
        const pending = pendingConfirms.get(tc.id);
        if (pending) {
          return (
            <PermissionCard
              key={tc.id}
              toolCall={tc}
              level={pending.level}
              destructiveWarning={pending.destructiveWarning}
              onRespond={onRespond}
            />
          );
        }
        return <ToolCallCard key={tc.id} toolCall={tc} />;
      })}
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit -p packages/client/tsconfig.json`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/components/PermissionCard.tsx packages/client/src/hooks/useChat.ts packages/client/src/components/MessageBubble.tsx
git commit -m "feat: add 3-button PermissionCard for code_task with destructive warning"
```

---

### Task 13: Client — PlanReviewCard + useChat plan review handlers

**Files:**
- Create: `packages/client/src/components/PlanReviewCard.tsx`
- Modify: `packages/client/src/hooks/useChat.ts`
- Modify: `packages/client/src/components/MessageBubble.tsx`

- [ ] **Step 1: Create PlanReviewCard component**

Create `packages/client/src/components/PlanReviewCard.tsx`:

```tsx
import { useState } from 'react';

interface Props {
  callId: string;
  task: string;
  plan: string;
  onRespond: (callId: string, approved: boolean, editedPlan?: string) => Promise<boolean>;
}

export function PlanReviewCard({ callId, task, plan, onRespond }: Props) {
  const [editedPlan, setEditedPlan] = useState(plan);
  const [submitting, setSubmitting] = useState(false);
  const [decision, setDecision] = useState<'approved' | 'rejected' | null>(null);

  const handle = async (approved: boolean) => {
    setSubmitting(true);
    try {
      const ok = await onRespond(callId, approved, approved ? editedPlan : undefined);
      if (ok) setDecision(approved ? 'approved' : 'rejected');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={{
      background: '#f8f8f8',
      border: '1px solid #e5e5e5',
      borderRadius: 14,
      padding: 16,
      marginBottom: 6,
      maxWidth: '80%',
      fontSize: 13,
      opacity: decision ? 0.7 : submitting ? 0.85 : 1,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <div style={{
          width: 28, height: 28, borderRadius: '50%',
          background: '#10B981', color: '#fff',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 14,
        }}>📋</div>
        <div style={{ fontWeight: 600 }}>Review plan before running</div>
      </div>

      <div style={{ fontSize: 12, color: '#666', marginBottom: 10 }}>
        <strong>Task:</strong> {task}
      </div>

      <textarea
        value={editedPlan}
        onChange={(e) => setEditedPlan(e.target.value)}
        disabled={decision !== null || submitting}
        rows={15}
        style={{
          width: '100%',
          fontFamily: 'SF Mono, Menlo, monospace',
          fontSize: 11,
          padding: 10,
          border: '1px solid #e5e5e5',
          borderRadius: 8,
          marginBottom: 10,
          resize: 'vertical',
          boxSizing: 'border-box',
        }}
      />

      {decision ? (
        <div style={{
          fontWeight: 600,
          color: decision === 'approved' ? '#059669' : '#DC2626',
        }}>
          {decision === 'approved' ? '✓ Plan approved, running...' : '✗ Plan rejected'}
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={() => handle(true)}
            disabled={submitting}
            style={{
              flex: 1, padding: 10, borderRadius: 8, border: 'none',
              background: '#2A5A8A', color: '#fff', fontSize: 13,
              cursor: submitting ? 'wait' : 'pointer',
            }}
          >
            Run plan
          </button>
          <button
            onClick={() => handle(false)}
            disabled={submitting}
            style={{
              flex: 1, padding: 10, borderRadius: 8,
              border: '1px solid #ddd', background: '#fff',
              color: '#666', fontSize: 13,
              cursor: submitting ? 'wait' : 'pointer',
            }}
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Add pendingPlanReviews + respondToPlanReview to useChat**

In `packages/client/src/hooks/useChat.ts`:

Add new interface and state:

```typescript
export interface PendingPlanReview {
  callId: string;
  task: string;
  plan: string;
}
```

Add to component state (near other useState):

```typescript
  const [pendingPlanReviews, setPendingPlanReviews] = useState<Map<string, PendingPlanReview>>(new Map());
```

Add to event switch (after `tool_confirm_request` case):

```typescript
          case 'tool_plan_review':
            setPendingPlanReviews((prev) => {
              const next = new Map(prev);
              next.set(event.id, { callId: event.id, task: event.task, plan: event.plan });
              return next;
            });
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
                  piiEntities,
                },
              ];
            });
            break;

          case 'tool_progress': {
            const tc = toolCalls.find((t) => t.id === event.id);
            if (tc) tc.progress = event.message;
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
                  piiEntities,
                },
              ];
            });
            break;
          }
```

Add new callback after `respondToConfirm`:

```typescript
  const respondToPlanReview = useCallback(async (callId: string, approved: boolean, editedPlan?: string): Promise<boolean> => {
    try {
      const res = await fetch('/api/plan-review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callId, approved, editedPlan }),
      });
      if (!res.ok) {
        console.error('Plan review response failed:', res.status, await res.text());
        return false;
      }
      setPendingPlanReviews((prev) => {
        const next = new Map(prev);
        next.delete(callId);
        return next;
      });
      return true;
    } catch (err) {
      console.error('Failed to send plan review response:', err);
      return false;
    }
  }, []);
```

Update `stop()` to clear plan reviews:

```typescript
  const stop = useCallback(() => {
    connectionRef.current?.abort();
    connectionRef.current = null;
    setPendingConfirms(new Map());
    setPendingPlanReviews(new Map());
    setLoading(false);
    sendingRef.current = false;
  }, []);
```

Update return to include new state + callback:

```typescript
  return {
    messages, loading, error, send, stop,
    pendingConfirms, respondToConfirm,
    pendingPlanReviews, respondToPlanReview,
    historyLoaded,
  };
```

- [ ] **Step 3: Render PlanReviewCard in MessageBubble**

In `packages/client/src/components/MessageBubble.tsx`, add import:

```typescript
import { PlanReviewCard } from './PlanReviewCard';
import type { PendingConfirm, PendingPlanReview } from '../hooks/useChat';
```

Update `Props`:

```typescript
interface Props {
  message: Message;
  pendingConfirms: Map<string, PendingConfirm>;
  pendingPlanReviews: Map<string, PendingPlanReview>;
  onRespond: (callId: string, allowed: boolean, remember: boolean) => Promise<boolean>;
  onRespondPlanReview: (callId: string, approved: boolean, editedPlan?: string) => Promise<boolean>;
}
```

Update toolCalls render to check plan review first:

```tsx
      {message.toolCalls?.map((tc) => {
        const planReview = pendingPlanReviews.get(tc.id);
        if (planReview) {
          return (
            <PlanReviewCard
              key={tc.id}
              callId={planReview.callId}
              task={planReview.task}
              plan={planReview.plan}
              onRespond={onRespondPlanReview}
            />
          );
        }
        const pending = pendingConfirms.get(tc.id);
        if (pending) {
          return (
            <PermissionCard
              key={tc.id}
              toolCall={tc}
              level={pending.level}
              destructiveWarning={pending.destructiveWarning}
              onRespond={onRespond}
            />
          );
        }
        return <ToolCallCard key={tc.id} toolCall={tc} />;
      })}
```

- [ ] **Step 4: Update Chat.tsx to pass new props**

In `packages/client/src/components/Chat.tsx` (or wherever MessageBubble is used), pass new props:

```tsx
const { messages, loading, error, send, stop, pendingConfirms, respondToConfirm, pendingPlanReviews, respondToPlanReview, historyLoaded } = useChat();

// In the map where MessageBubble is rendered:
<MessageBubble
  key={message.id}
  message={message}
  pendingConfirms={pendingConfirms}
  pendingPlanReviews={pendingPlanReviews}
  onRespond={respondToConfirm}
  onRespondPlanReview={respondToPlanReview}
/>
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit -p packages/client/tsconfig.json`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/client/src/components/PlanReviewCard.tsx packages/client/src/hooks/useChat.ts packages/client/src/components/MessageBubble.tsx packages/client/src/components/Chat.tsx
git commit -m "feat: add PlanReviewCard and plan review flow in client"
```

---

### Task 14: Client — ToolCallCard for code_task (progress + diff display)

**Files:**
- Modify: `packages/client/src/components/ToolCallCard.tsx`

- [ ] **Step 1: Read existing ToolCallCard to preserve other tool branches**

Run: `cat packages/client/src/components/ToolCallCard.tsx`

Note the existing structure — the new code must preserve non-code_task rendering.

- [ ] **Step 2: Extend ToolCallCard with code_task specialization**

Replace `packages/client/src/components/ToolCallCard.tsx`:

```tsx
import { useState } from 'react';
import type { ToolCall } from '@r2/shared';

interface Props {
  toolCall: ToolCall;
}

interface CodeTaskData {
  summary?: string;
  files?: Array<{ path: string; added: number; removed: number }>;
  shortDiff?: string;
  fullDiff?: string;
  commit?: string;
  mode?: 'once' | 'ralphex';
  durationMs?: number;
  blockedFiles?: string[];
}

export function ToolCallCard({ toolCall }: Props) {
  if (toolCall.name === 'code_task') {
    return <CodeTaskCard toolCall={toolCall} />;
  }

  // Generic rendering for other tools
  const { result } = toolCall;
  const statusIcon = toolCall.status === 'running' ? '⏵' : toolCall.status === 'done' ? '✓' : '✗';
  const statusColor = toolCall.status === 'running' ? '#888' : toolCall.status === 'done' ? '#059669' : '#DC2626';

  return (
    <div style={{
      background: '#f8f8f8', border: '1px solid #e5e5e5', borderRadius: 10,
      padding: 10, marginBottom: 6, maxWidth: '80%', fontSize: 12,
    }}>
      <div style={{ fontWeight: 600, color: statusColor, marginBottom: 4 }}>
        {statusIcon} {toolCall.name}
      </div>
      {result?.display?.content && (
        <div style={{ fontFamily: 'monospace', fontSize: 11, whiteSpace: 'pre-wrap', color: '#444' }}>
          {result.display.content.slice(0, 400)}
        </div>
      )}
      {result?.error && (
        <div style={{ color: '#DC2626', fontSize: 11 }}>{result.error}</div>
      )}
    </div>
  );
}

function CodeTaskCard({ toolCall }: { toolCall: ToolCall }) {
  const [showFullDiff, setShowFullDiff] = useState(false);
  const data = (toolCall.result?.data ?? {}) as CodeTaskData;
  const task = typeof toolCall.input.task === 'string' ? toolCall.input.task : '';

  if (toolCall.status === 'running') {
    return (
      <div style={{
        background: '#f8f8f8', border: '1px solid #e5e5e5', borderRadius: 10,
        padding: 12, marginBottom: 6, maxWidth: '80%', fontSize: 13,
      }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>🛠 code_task</div>
        <div style={{ color: '#666', fontSize: 12, marginBottom: 8 }}>
          Task: "{task}"
        </div>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6,
          color: '#888', fontSize: 12, fontStyle: 'italic',
        }}>
          <span className="r2-pulse-dot">⏵</span>
          {toolCall.progress ?? 'Starting...'}
        </div>
        <style>{`
          @keyframes r2-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
          .r2-pulse-dot { animation: r2-pulse 1.2s ease-in-out infinite; }
        `}</style>
      </div>
    );
  }

  if (toolCall.status === 'error' || !toolCall.result?.success) {
    return (
      <div style={{
        background: '#FEF2F2', border: '1px solid #FCA5A5', borderRadius: 10,
        padding: 12, marginBottom: 6, maxWidth: '80%', fontSize: 13,
      }}>
        <div style={{ fontWeight: 600, color: '#991B1B', marginBottom: 4 }}>
          ✗ code_task failed
        </div>
        <div style={{ fontSize: 12, color: '#991B1B' }}>
          {toolCall.result?.error ?? 'Unknown error'}
        </div>
      </div>
    );
  }

  const durationSec = data.durationMs ? Math.round(data.durationMs / 1000) : 0;
  const mins = Math.floor(durationSec / 60);
  const secs = durationSec % 60;
  const timeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;

  return (
    <div style={{
      background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 10,
      padding: 12, marginBottom: 6, maxWidth: '80%', fontSize: 13,
    }}>
      <div style={{ fontWeight: 600, color: '#065f46', marginBottom: 4 }}>
        ✓ code_task ({timeStr})
      </div>
      {task && (
        <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>
          Task: "{task}"
        </div>
      )}
      {data.commit && (
        <div style={{ fontSize: 11, color: '#888', fontFamily: 'monospace', marginBottom: 8 }}>
          Commit: {data.commit.slice(0, 7)} ({data.mode ?? 'once'})
        </div>
      )}
      {data.files && data.files.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
            📁 {data.files.length} files changed
          </div>
          <ul style={{ margin: 0, paddingLeft: 20, fontSize: 11, color: '#444' }}>
            {data.files.map((f) => (
              <li key={f.path}>
                <span style={{ fontFamily: 'monospace' }}>{f.path}</span>{' '}
                <span style={{ color: '#059669' }}>+{f.added}</span>{' '}
                <span style={{ color: '#DC2626' }}>-{f.removed}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {data.blockedFiles && data.blockedFiles.length > 0 && (
        <div style={{
          background: '#fef3c7', border: '1px solid #fcd34d',
          borderRadius: 6, padding: 8, marginBottom: 8,
          fontSize: 11, color: '#92400e',
        }}>
          <strong>⚠ {data.blockedFiles.length} files blocked by denylist:</strong>{' '}
          {data.blockedFiles.join(', ')}
        </div>
      )}
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
            <pre style={{
              background: '#1e293b', color: '#e2e8f0',
              padding: 10, borderRadius: 6, fontSize: 11,
              overflowX: 'auto', maxHeight: 400, margin: 0,
            }}>
              <code>{data.fullDiff ?? data.shortDiff}</code>
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit -p packages/client/tsconfig.json`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/client/src/components/ToolCallCard.tsx
git commit -m "feat: add code_task UI with progress, diff display, and blocked files warning"
```

---

### Task 15: Env variables and final integration

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Add new env variables**

Append to `.env.example`:

```bash
# Phase 3C: Code task
R2_DEV_WORKTREE_PREFIX=/tmp/r2-dev-
R2_DEV_BRANCH=dev
R2_DEV_BASE_BRANCH=master
R2_RALPHEX_MAX_ITERATIONS=20
```

- [ ] **Step 2: Verify dev branch exists**

Run: `git rev-parse --verify origin/dev 2>&1 || echo "MISSING"`
If missing, run: `git branch dev master && git push -u origin dev`

- [ ] **Step 3: Verify tool auto-discovery**

Run: `npm run dev:server` in one terminal and check output
Expected: `Tool discovered: code_task (tool-code-task)` in startup logs.
Stop with Ctrl+C after verification.

- [ ] **Step 4: Full typecheck**

Run: `npx tsc --noEmit -p packages/shared/tsconfig.json && npx tsc --noEmit -p packages/server/tsconfig.json && npx tsc --noEmit -p packages/client/tsconfig.json && npx tsc --noEmit -p packages/tool-code-task/tsconfig.json`
Expected: no type errors.

- [ ] **Step 5: Run all tests**

Run: `npm test --workspaces --if-present`
Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add .env.example
git commit -m "feat: add Phase 3C env vars"
```

- [ ] **Step 7: Final commit**

```bash
git add -A
git commit -m "chore: Phase 3C — git-in-the-loop complete" --allow-empty
```
