# Git-in-the-loop (code_task tool) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `code_task` tool that lets R2 modify its own code through chat — runs Claude Agent SDK (or ralphex in auto mode) in an isolated git worktree on dev branch.

**Architecture:** New `@r2/tool-code-task` package with a single tool. Handler checks destructive keywords via Haiku, ensures git worktree at `/tmp/r2-dev`, runs Claude Agent SDK or ralphex, commits, returns diff. Tool-loop passes a `ctx` with `onProgress` callback for SSE streaming. PermissionCard gets 3 buttons (once/always/deny) for `code_task`.

**Tech Stack:** `@anthropic-ai/claude-agent-sdk`, `@anthropic-ai/sdk` (for Haiku), Node.js child_process, Vitest

---

### Task 1: Scaffold `@r2/tool-code-task` package

**Files:**
- Create: `packages/tool-code-task/package.json`
- Create: `packages/tool-code-task/tsconfig.json`
- Create: `packages/tool-code-task/src/index.ts` (placeholder)

- [ ] **Step 1: Create package.json**

Create `packages/tool-code-task/package.json`:

```json
{
  "name": "@r2/tool-code-task",
  "version": "0.1.0",
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "dependencies": {
    "@r2/shared": "*",
    "@anthropic-ai/sdk": "^0.80.0",
    "@anthropic-ai/claude-agent-sdk": "^0.2.98"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "vitest": "^3.1.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

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

- [ ] **Step 3: Create placeholder entry point**

Create `packages/tool-code-task/src/index.ts`:

```typescript
import type { ToolResult } from '@r2/shared';

export const codeTaskTool = {
  name: 'code_task',
  description: 'placeholder',
  permissionLevel: 'confirm' as const,
  parameters: {
    type: 'object' as const,
    properties: {},
    required: [] as string[],
  },
  async handler(_params: Record<string, unknown>): Promise<ToolResult> {
    return { success: false, error: 'not implemented' };
  },
};

export default codeTaskTool;
```

- [ ] **Step 4: Install dependencies**

Run: `npm install`
Expected: workspace resolves, no errors.

- [ ] **Step 5: Verify typecheck**

Run: `npx tsc --noEmit -p packages/tool-code-task/tsconfig.json`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/tool-code-task/ package.json package-lock.json
git commit -m "feat: scaffold @r2/tool-code-task package"
```

---

### Task 2: Destructive check via Haiku

**Files:**
- Create: `packages/tool-code-task/src/destructive-check.ts`
- Create: `packages/tool-code-task/src/destructive-check.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/tool-code-task/src/destructive-check.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isDestructive } from './destructive-check.js';

const mockCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  })),
}));

describe('isDestructive', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  it('parses destructive=true response', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"destructive": true, "reason": "deletes data"}' }],
    });

    const result = await isDestructive('delete all logs');
    expect(result).toEqual({ destructive: true, reason: 'deletes data' });
  });

  it('parses destructive=false response', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"destructive": false, "reason": "safe edit"}' }],
    });

    const result = await isDestructive('add console.log');
    expect(result).toEqual({ destructive: false, reason: 'safe edit' });
  });

  it('handles context parameter', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"destructive": false, "reason": "ok"}' }],
    });

    await isDestructive('change theme', 'modify src/App.tsx');
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
      messages: [expect.objectContaining({
        content: expect.stringContaining('modify src/App.tsx'),
      })],
    }));
  });

  it('fails open on API error', async () => {
    mockCreate.mockRejectedValueOnce(new Error('API down'));
    const result = await isDestructive('delete files');
    expect(result).toEqual({ destructive: false, reason: 'check failed' });
  });

  it('fails open on invalid JSON', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'not json' }],
    });

    const result = await isDestructive('do stuff');
    expect(result).toEqual({ destructive: false, reason: 'check failed' });
  });

  it('uses haiku model', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"destructive": false, "reason": "ok"}' }],
    });

    await isDestructive('test task');
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
      model: 'claude-haiku-4-5-20251001',
    }));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/tool-code-task && npx vitest run src/destructive-check.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement destructive check**

Create `packages/tool-code-task/src/destructive-check.ts`:

```typescript
import Anthropic from '@anthropic-ai/sdk';

export interface DestructiveCheck {
  destructive: boolean;
  reason: string;
}

const SYSTEM_PROMPT = `You analyze coding tasks for safety. A task is DESTRUCTIVE or SENSITIVE if it:
- Deletes data (files, DB rows, tables)
- Removes or downgrades dependencies (package.json)
- Modifies authentication, secrets, or security code
- Changes database schema or migrations
- Modifies CI/CD, deployment, or git configuration
- Disables tests or safety checks
- Touches .env files

Reply ONLY with valid JSON: {"destructive": boolean, "reason": "short explanation"}`;

export async function isDestructive(task: string, context?: string): Promise<DestructiveCheck> {
  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const model = process.env.CLAUDE_HAIKU_MODEL || 'claude-haiku-4-5-20251001';

    const response = await client.messages.create({
      model,
      max_tokens: 256,
      system: SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: `Task: ${task}\n\nContext: ${context ?? 'none'}`,
      }],
    });

    const textBlock = response.content.find((b) => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      return { destructive: false, reason: 'check failed' };
    }

    const parsed = JSON.parse(textBlock.text);
    if (typeof parsed.destructive !== 'boolean' || typeof parsed.reason !== 'string') {
      return { destructive: false, reason: 'check failed' };
    }

    return { destructive: parsed.destructive, reason: parsed.reason };
  } catch {
    return { destructive: false, reason: 'check failed' };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/tool-code-task && npx vitest run src/destructive-check.test.ts`
Expected: all 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/tool-code-task/src/destructive-check.ts packages/tool-code-task/src/destructive-check.test.ts
git commit -m "feat: add Haiku-based destructive check for code_task"
```

---

### Task 3: Git worktree management

**Files:**
- Create: `packages/tool-code-task/src/worktree.ts`
- Create: `packages/tool-code-task/src/worktree.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/tool-code-task/src/worktree.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ensureWorktree, syncWorktree, commitChanges } from './worktree.js';

const mockExec = vi.fn();
vi.mock('node:child_process', () => ({
  exec: (cmd: string, opts: any, cb: any) => {
    const callback = typeof opts === 'function' ? opts : cb;
    mockExec(cmd, opts);
    callback(null, { stdout: mockExec.mock.results[mockExec.mock.results.length - 1].value ?? '', stderr: '' });
  },
}));

describe('worktree', () => {
  beforeEach(() => {
    mockExec.mockReset();
  });

  describe('ensureWorktree', () => {
    it('creates worktree when path does not exist', async () => {
      mockExec.mockReturnValueOnce(''); // git worktree list (empty)
      mockExec.mockReturnValueOnce(''); // git worktree add

      await ensureWorktree('/tmp/r2-dev', 'dev');

      expect(mockExec).toHaveBeenCalledWith(expect.stringContaining('git worktree list'), expect.anything());
      expect(mockExec).toHaveBeenCalledWith(expect.stringContaining('git worktree add'), expect.anything());
    });

    it('skips creation when worktree already exists at path', async () => {
      mockExec.mockReturnValueOnce('worktree /tmp/r2-dev\nHEAD abc123\nbranch refs/heads/dev\n');

      await ensureWorktree('/tmp/r2-dev', 'dev');

      expect(mockExec).toHaveBeenCalledTimes(1); // only the list check
    });

    it('checks out correct branch if worktree exists on wrong branch', async () => {
      mockExec.mockReturnValueOnce('worktree /tmp/r2-dev\nHEAD abc123\nbranch refs/heads/wrong\n');
      mockExec.mockReturnValueOnce(''); // checkout

      await ensureWorktree('/tmp/r2-dev', 'dev');

      expect(mockExec).toHaveBeenCalledWith(expect.stringContaining('git checkout dev'), expect.anything());
    });
  });

  describe('syncWorktree', () => {
    it('fetches and hard-resets to origin branch', async () => {
      mockExec.mockReturnValue('');

      await syncWorktree('/tmp/r2-dev', 'dev');

      expect(mockExec).toHaveBeenCalledWith(expect.stringContaining('git fetch origin dev'), expect.anything());
      expect(mockExec).toHaveBeenCalledWith(expect.stringContaining('git reset --hard origin/dev'), expect.anything());
    });
  });

  describe('commitChanges', () => {
    it('stages all and commits with given message', async () => {
      mockExec.mockReturnValueOnce(''); // git add
      mockExec.mockImplementationOnce(() => { throw Object.assign(new Error('has changes'), { code: 1 }); }); // git diff --cached --quiet (non-zero = changes)
      mockExec.mockReturnValueOnce(''); // git commit
      mockExec.mockReturnValueOnce('abc1234def\n'); // git rev-parse HEAD

      const hash = await commitChanges('/tmp/r2-dev', 'r2: test');

      expect(hash).toBe('abc1234def');
      expect(mockExec).toHaveBeenCalledWith(expect.stringContaining('git add -A'), expect.anything());
      expect(mockExec).toHaveBeenCalledWith(expect.stringContaining('git commit -m'), expect.anything());
    });

    it('returns empty string when no staged changes', async () => {
      mockExec.mockReturnValueOnce(''); // git add
      mockExec.mockReturnValueOnce(''); // git diff --cached --quiet (zero = no changes)

      const hash = await commitChanges('/tmp/r2-dev', 'r2: nothing');

      expect(hash).toBe('');
      expect(mockExec).not.toHaveBeenCalledWith(expect.stringContaining('git commit'), expect.anything());
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/tool-code-task && npx vitest run src/worktree.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement worktree module**

Create `packages/tool-code-task/src/worktree.ts`:

```typescript
import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execCb);

interface ExecOptions {
  cwd?: string;
}

async function run(cmd: string, opts?: ExecOptions): Promise<string> {
  const { stdout } = await exec(cmd, opts);
  return stdout.toString().trim();
}

async function tryRun(cmd: string, opts?: ExecOptions): Promise<{ ok: boolean; stdout: string }> {
  try {
    const stdout = await run(cmd, opts);
    return { ok: true, stdout };
  } catch {
    return { ok: false, stdout: '' };
  }
}

export async function ensureWorktree(path: string, branch: string): Promise<void> {
  const list = await run('git worktree list --porcelain');
  const lines = list.split('\n');

  // Parse porcelain output: look for matching "worktree <path>"
  let foundPath = false;
  let foundBranch: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === `worktree ${path}`) {
      foundPath = true;
      // Scan next few lines for "branch refs/heads/<name>"
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        const m = lines[j].match(/^branch refs\/heads\/(.+)$/);
        if (m) {
          foundBranch = m[1];
          break;
        }
      }
      break;
    }
  }

  if (!foundPath) {
    await run(`git worktree add -B ${branch} ${path} origin/${branch}`);
    return;
  }

  if (foundBranch !== branch) {
    await run(`git checkout ${branch}`, { cwd: path });
  }
}

export async function syncWorktree(path: string, branch: string): Promise<void> {
  await run(`git fetch origin ${branch}`, { cwd: path });
  await run(`git reset --hard origin/${branch}`, { cwd: path });
}

export async function commitChanges(path: string, message: string): Promise<string> {
  await run('git add -A', { cwd: path });
  const staged = await tryRun('git diff --cached --quiet', { cwd: path });
  if (staged.ok) {
    // zero exit means no staged changes
    return '';
  }
  // Escape single quotes in message for shell
  const escaped = message.replace(/'/g, `'\\''`);
  await run(`git commit -m '${escaped}'`, { cwd: path });
  const hash = await run('git rev-parse HEAD', { cwd: path });
  return hash;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/tool-code-task && npx vitest run src/worktree.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/tool-code-task/src/worktree.ts packages/tool-code-task/src/worktree.test.ts
git commit -m "feat: add git worktree management for code_task"
```

---

### Task 4: Diff parsing

**Files:**
- Create: `packages/tool-code-task/src/diff.ts`
- Create: `packages/tool-code-task/src/diff.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/tool-code-task/src/diff.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { parseDiffStats, truncateDiff, summarizeDiff } from './diff.js';

describe('parseDiffStats', () => {
  it('parses file stats from git diff --numstat output', () => {
    const numstat = '45\t0\tsrc/Theme.tsx\n5\t7\tsrc/App.tsx\n8\t0\tsrc/styles.css\n';
    const files = parseDiffStats(numstat);

    expect(files).toEqual([
      { path: 'src/Theme.tsx', added: 45, removed: 0 },
      { path: 'src/App.tsx', added: 5, removed: 7 },
      { path: 'src/styles.css', added: 8, removed: 0 },
    ]);
  });

  it('returns empty array for empty input', () => {
    expect(parseDiffStats('')).toEqual([]);
  });

  it('handles binary files (- -) as zero changes', () => {
    const numstat = '-\t-\timage.png\n5\t2\tsrc/App.tsx\n';
    const files = parseDiffStats(numstat);
    expect(files).toEqual([
      { path: 'image.png', added: 0, removed: 0 },
      { path: 'src/App.tsx', added: 5, removed: 2 },
    ]);
  });
});

describe('truncateDiff', () => {
  it('returns full diff if shorter than maxLines', () => {
    const diff = 'line1\nline2\nline3';
    expect(truncateDiff(diff, 50)).toBe(diff);
  });

  it('truncates to maxLines and appends marker', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line${i}`);
    const diff = lines.join('\n');
    const result = truncateDiff(diff, 50);

    const resultLines = result.split('\n');
    expect(resultLines.length).toBe(51); // 50 lines + marker
    expect(resultLines[50]).toContain('truncated');
  });
});

describe('summarizeDiff', () => {
  it('generates summary with file counts', () => {
    const files = [
      { path: 'a.ts', added: 10, removed: 0 },
      { path: 'b.ts', added: 5, removed: 3 },
      { path: 'c.ts', added: 0, removed: 20 },
    ];
    const summary = summarizeDiff(files, 'abc1234');
    expect(summary).toContain('3 files');
    expect(summary).toContain('+15');
    expect(summary).toContain('-23');
    expect(summary).toContain('abc1234');
  });

  it('handles empty file list', () => {
    const summary = summarizeDiff([], 'abc1234');
    expect(summary).toContain('0 files');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/tool-code-task && npx vitest run src/diff.test.ts`
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
      const [addStr, remStr, ...pathParts] = line.split('\t');
      const added = addStr === '-' ? 0 : parseInt(addStr, 10) || 0;
      const removed = remStr === '-' ? 0 : parseInt(remStr, 10) || 0;
      return { path: pathParts.join('\t'), added, removed };
    });
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
  return `${files.length} files changed, +${totalAdded} -${totalRemoved}. Commit: ${commit.slice(0, 7)}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/tool-code-task && npx vitest run src/diff.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/tool-code-task/src/diff.ts packages/tool-code-task/src/diff.test.ts
git commit -m "feat: add diff parsing and summary helpers"
```

---

### Task 5: Claude Agent SDK wrapper

**Files:**
- Create: `packages/tool-code-task/src/agent-sdk.ts`
- Create: `packages/tool-code-task/src/agent-sdk.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/tool-code-task/src/agent-sdk.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runAgent } from './agent-sdk.js';

const mockQuery = vi.fn();
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (opts: any) => mockQuery(opts),
}));

describe('runAgent', () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it('emits progress for text blocks', async () => {
    async function* gen() {
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Analyzing the codebase to understand structure' }] } };
    }
    mockQuery.mockReturnValueOnce(gen());

    const progress: string[] = [];
    await runAgent({
      workdir: '/tmp/r2-dev',
      task: 'test',
      onProgress: (m) => progress.push(m),
    });

    expect(progress).toContain(expect.stringContaining('Analyzing') as any);
    expect(progress.length).toBeGreaterThan(0);
  });

  it('emits progress for tool_use blocks', async () => {
    async function* gen() {
      yield { type: 'assistant', message: { content: [
        { type: 'tool_use', name: 'Edit', input: { file_path: 'src/App.tsx' } },
      ] } };
      yield { type: 'assistant', message: { content: [
        { type: 'tool_use', name: 'Write', input: { file_path: 'src/new.ts' } },
      ] } };
      yield { type: 'assistant', message: { content: [
        { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
      ] } };
    }
    mockQuery.mockReturnValueOnce(gen());

    const progress: string[] = [];
    await runAgent({
      workdir: '/tmp/r2-dev',
      task: 'test',
      onProgress: (m) => progress.push(m),
    });

    expect(progress.some(p => p.includes('src/App.tsx'))).toBe(true);
    expect(progress.some(p => p.includes('src/new.ts'))).toBe(true);
    expect(progress.some(p => p.toLowerCase().includes('npm test'))).toBe(true);
  });

  it('passes task and context to SDK prompt', async () => {
    async function* gen() { yield { type: 'result', subtype: 'success' }; }
    mockQuery.mockReturnValueOnce(gen());

    await runAgent({
      workdir: '/tmp/r2-dev',
      task: 'add dark mode',
      context: 'use tailwind',
      onProgress: () => {},
    });

    expect(mockQuery).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining('add dark mode'),
    }));
    const call = mockQuery.mock.calls[0][0];
    expect(call.prompt).toContain('use tailwind');
  });

  it('passes cwd to SDK options', async () => {
    async function* gen() { yield { type: 'result', subtype: 'success' }; }
    mockQuery.mockReturnValueOnce(gen());

    await runAgent({
      workdir: '/tmp/r2-dev',
      task: 'test',
      onProgress: () => {},
    });

    expect(mockQuery).toHaveBeenCalledWith(expect.objectContaining({
      options: expect.objectContaining({ cwd: '/tmp/r2-dev' }),
    }));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/tool-code-task && npx vitest run src/agent-sdk.test.ts`
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

function buildPrompt(task: string, context?: string): string {
  const parts = [`Task: ${task}`];
  if (context) parts.push(`\nContext: ${context}`);
  parts.push('\nWork directly in the current directory. Make all changes needed to complete the task. Commit when done via Bash if not already committed.');
  return parts.join('\n');
}

function describeToolUse(name: string, input: Record<string, unknown>): string {
  if (name === 'Edit' || name === 'Write') {
    const filePath = (input.file_path as string) || 'file';
    return `${name === 'Edit' ? 'Editing' : 'Writing'} ${filePath}`;
  }
  if (name === 'Bash') {
    const cmd = ((input.command as string) || '').slice(0, 60);
    return `Running: ${cmd}`;
  }
  if (name === 'Read') {
    const filePath = (input.file_path as string) || 'file';
    return `Reading ${filePath}`;
  }
  return `Tool: ${name}`;
}

export async function runAgent(params: AgentRunParams): Promise<void> {
  const prompt = buildPrompt(params.task, params.context);

  const stream = query({
    prompt,
    options: {
      cwd: params.workdir,
      abortController: params.signal ? { signal: params.signal } as any : undefined,
    },
  });

  for await (const message of stream) {
    if (params.signal?.aborted) break;

    if (message.type !== 'assistant') continue;
    const content = (message as any).message?.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (block.type === 'text' && typeof block.text === 'string') {
        const text = block.text.trim();
        if (text.length > 0) {
          params.onProgress(text.slice(0, 80));
        }
      } else if (block.type === 'tool_use') {
        params.onProgress(describeToolUse(block.name, block.input ?? {}));
      }
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/tool-code-task && npx vitest run src/agent-sdk.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/tool-code-task/src/agent-sdk.ts packages/tool-code-task/src/agent-sdk.test.ts
git commit -m "feat: add Claude Agent SDK wrapper with progress streaming"
```

---

### Task 6: Ralphex wrapper (auto mode)

**Files:**
- Create: `packages/tool-code-task/src/ralphex.ts`
- Create: `packages/tool-code-task/src/ralphex.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/tool-code-task/src/ralphex.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runRalphex, buildPlanContent } from './ralphex.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('buildPlanContent', () => {
  it('includes task and context', () => {
    const plan = buildPlanContent('add dark mode', 'use tailwind');
    expect(plan).toContain('add dark mode');
    expect(plan).toContain('use tailwind');
    expect(plan).toContain('- [ ]'); // checkbox syntax
  });

  it('handles missing context', () => {
    const plan = buildPlanContent('simple task');
    expect(plan).toContain('simple task');
    expect(plan).toContain('none');
  });
});

describe('runRalphex', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralphex-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('throws when ralphex CLI exits non-zero', async () => {
    const mockSpawn = vi.fn().mockReturnValue({
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: (event: string, cb: (code: number) => void) => {
        if (event === 'exit') setTimeout(() => cb(1), 10);
      },
      kill: vi.fn(),
    });

    vi.doMock('node:child_process', () => ({ spawn: mockSpawn }));
    const { runRalphex: fn } = await import('./ralphex.js');

    await expect(fn({
      workdir: tmpDir,
      task: 'test',
      onProgress: () => {},
    })).rejects.toThrow();

    vi.doUnmock('node:child_process');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/tool-code-task && npx vitest run src/ralphex.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement ralphex wrapper**

Create `packages/tool-code-task/src/ralphex.ts`:

```typescript
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export interface RalphexRunParams {
  workdir: string;
  task: string;
  context?: string;
  onProgress: (message: string) => void;
  signal?: AbortSignal;
}

export function buildPlanContent(task: string, context?: string): string {
  return `# R2 Auto Task

**Goal:** ${task}

**Context:** ${context ?? 'none'}

---

## Task 1: Implement the task

- [ ] **Step 1: Analyze the codebase and the task**

Read relevant files to understand existing patterns.

- [ ] **Step 2: Make the required changes**

Implement the task. Keep changes minimal and focused.

- [ ] **Step 3: Run tests if any exist**

Run: \`npm test\` or \`npx vitest run\`
Expected: all existing tests still pass.

- [ ] **Step 4: Commit**

\`\`\`bash
git add -A && git commit -m "r2: ${task.replace(/"/g, '\\"')}"
\`\`\`
`;
}

export async function runRalphex(params: RalphexRunParams): Promise<void> {
  const planId = crypto.randomBytes(4).toString('hex');
  const planPath = path.join(os.tmpdir(), `r2-task-${planId}.md`);
  fs.writeFileSync(planPath, buildPlanContent(params.task, params.context));

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('ralphex', ['--max-iterations', '20', planPath], {
        cwd: params.workdir,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const onAbort = () => child.kill('SIGTERM');
      params.signal?.addEventListener('abort', onAbort, { once: true });

      let buffer = '';
      child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.length > 0) {
            params.onProgress(trimmed.slice(0, 120));
          }
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
    try { fs.unlinkSync(planPath); } catch {}
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/tool-code-task && npx vitest run src/ralphex.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/tool-code-task/src/ralphex.ts packages/tool-code-task/src/ralphex.test.ts
git commit -m "feat: add ralphex wrapper for auto mode"
```

---

### Task 7: Add ToolContext with onProgress to tool-loop

**Files:**
- Modify: `packages/server/src/tools/base.ts`
- Modify: `packages/shared/src/types.ts`
- Modify: `packages/server/src/ai/tool-loop.ts`

- [ ] **Step 1: Add tool_progress SSE event type**

In `packages/shared/src/types.ts`, update the SSEEvent union to add `tool_progress`:

```typescript
export type SSEEvent =
  | { type: 'text_delta'; content: string }
  | { type: 'tool_call_start'; toolCall: ToolCall }
  | { type: 'tool_progress'; id: string; message: string }
  | { type: 'tool_call_result'; id: string; result: ToolResult }
  | { type: 'tool_confirm_request'; toolCall: ToolCall; level: 'confirm' | 'forbidden'; destructiveWarning?: { reason: string } }
  | { type: 'pii_masked'; entities: Array<{ type: string; original: string }> }
  | { type: 'done' }
  | { type: 'error'; message: string };
```

- [ ] **Step 2: Add ToolContext to base.ts**

In `packages/server/src/tools/base.ts`, replace the file contents with:

```typescript
import type { ToolResult } from '@r2/shared';

export interface ToolContext {
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
  meta?: { autoMode?: boolean };
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
}

export function toClaudeTool(tool: ToolDefinition) {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  };
}
```

- [ ] **Step 3: Pass ctx to handler calls in tool-loop.ts**

In `packages/server/src/ai/tool-loop.ts`, find the two places where `toolDef.handler(...)` is called.

Replace the `auto` path (around line 190-195 where handler runs without confirm):

```typescript
      } else {
        try {
          const progressCtx = {
            onProgress: (message: string) => onEvent({ type: 'tool_progress', id: block.id, message }),
            signal,
          };
          result = await toolDef.handler(deanonInput, progressCtx);
        } catch (err) {
          result = {
            success: false,
            error: err instanceof Error ? err.message : 'Unknown error',
          };
        }
      }
```

Replace the `confirm`/`forbidden` allowed path (around line 175-182):

```typescript
        if (allowed) {
          try {
            const progressCtx = {
              onProgress: (message: string) => onEvent({ type: 'tool_progress', id: block.id, message }),
              signal,
            };
            result = await toolDef.handler(deanonInput, progressCtx);
          } catch (err) {
            result = {
              success: false,
              error: err instanceof Error ? err.message : 'Unknown error',
            };
          }
        } else {
          result = { success: false, error: 'Action denied by user' };
        }
```

- [ ] **Step 4: Run typecheck**

Run: `npx tsc --noEmit -p packages/shared/tsconfig.json && npx tsc --noEmit -p packages/server/tsconfig.json`
Expected: no errors.

- [ ] **Step 5: Run existing tests**

Run: `cd packages/server && npx vitest run`
Expected: all existing tests PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/types.ts packages/server/src/tools/base.ts packages/server/src/ai/tool-loop.ts
git commit -m "feat: add ToolContext with onProgress and tool_progress SSE event"
```

---

### Task 8: Destructive warning in tool-loop for code_task

**Files:**
- Modify: `packages/server/src/ai/tool-loop.ts`

- [ ] **Step 1: Add destructive check for code_task before permission check**

In `packages/server/src/ai/tool-loop.ts`, update the `confirm`/`forbidden` branch to run destructive check first.

Add import at top of tool-loop.ts (after existing imports):

```typescript
import { isDestructive } from '@r2/tool-code-task';
```

Then add a barrel export in `packages/tool-code-task/src/index.ts` — ensure it re-exports `isDestructive`:

```typescript
export { isDestructive } from './destructive-check.js';
export type { DestructiveCheck } from './destructive-check.js';
```

(Add these to the existing index.ts — it already exists from Task 1.)

Also add `@r2/tool-code-task` to `packages/server/package.json` dependencies:

```json
"dependencies": {
  ...
  "@r2/tool-code-task": "*",
  ...
}
```

Then run `npm install`.

In the handler block where `toolDef.permissionLevel === 'confirm' || toolDef.permissionLevel === 'forbidden'`, replace the permission logic with:

```typescript
      } else if (toolDef.permissionLevel === 'confirm' || toolDef.permissionLevel === 'forbidden') {
        let allowed: boolean | null = null;
        let autoMode = false;
        let destructiveWarning: { reason: string } | undefined;

        // Special handling for code_task: destructive check via Haiku
        if (block.name === 'code_task') {
          try {
            const check = await isDestructive(
              deanonInput.task as string,
              deanonInput.context as string | undefined,
            );
            if (check.destructive) {
              destructiveWarning = { reason: check.reason };
              // Force confirmation even if saved rule exists
              allowed = null;
            }
          } catch (err) {
            console.error('Destructive check failed:', err instanceof Error ? err.message : err);
          }
        }

        // Check saved permission rule (only for 'confirm' level and only if not destructive)
        if (allowed === null && toolDef.permissionLevel === 'confirm' && !destructiveWarning) {
          try {
            const rule = getPermissionRule(block.name);
            if (rule) {
              allowed = rule.allowed;
              // For code_task with saved rule -> use auto mode (ralphex)
              if (block.name === 'code_task' && rule.allowed) autoMode = true;
            }
          } catch (err) {
            console.error('Failed to read permission rule:', err instanceof Error ? err.message : err);
          }
        }

        if (allowed === null) {
          // Ask user for confirmation
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
            const progressCtx = {
              onProgress: (message: string) => onEvent({ type: 'tool_progress', id: block.id, message }),
              signal,
              meta: { autoMode },
            };
            result = await toolDef.handler(deanonInput, progressCtx);
          } catch (err) {
            result = {
              success: false,
              error: err instanceof Error ? err.message : 'Unknown error',
            };
          }
        } else {
          result = { success: false, error: 'Action denied by user' };
        }
      }
```

- [ ] **Step 2: Update requestConfirmation signature to accept destructiveWarning**

In `packages/server/src/ai/tool-loop.ts`, find the `requestConfirmation` function near the top of the file. Update its signature and body:

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

- [ ] **Step 3: Run typecheck**

Run: `npx tsc --noEmit -p packages/server/tsconfig.json`
Expected: no errors.

- [ ] **Step 4: Run existing tool-loop tests**

Run: `cd packages/server && npx vitest run src/ai/__tests__/tool-loop.test.ts`
Expected: all existing tests PASS (destructiveWarning is optional).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/ai/tool-loop.ts
git commit -m "feat: add destructive check for code_task in tool-loop"
```

---

### Task 9: code_task handler — orchestration

**Files:**
- Modify: `packages/tool-code-task/src/index.ts`
- Create: `packages/tool-code-task/src/code-task.test.ts`

- [ ] **Step 1: Write failing integration test**

Create `packages/tool-code-task/src/code-task.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./worktree.js', () => ({
  ensureWorktree: vi.fn().mockResolvedValue(undefined),
  syncWorktree: vi.fn().mockResolvedValue(undefined),
  commitChanges: vi.fn().mockResolvedValue('abc1234567890'),
}));

vi.mock('./agent-sdk.js', () => ({
  runAgent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./ralphex.js', () => ({
  runRalphex: vi.fn().mockResolvedValue(undefined),
  buildPlanContent: vi.fn(),
}));

const mockExec = vi.fn();
vi.mock('node:child_process', () => ({
  exec: (cmd: string, opts: any, cb: any) => {
    const callback = typeof opts === 'function' ? opts : cb;
    const result = mockExec(cmd, opts);
    callback(null, { stdout: result ?? '', stderr: '' });
  },
}));

vi.mock('./destructive-check.js', () => ({
  isDestructive: vi.fn().mockResolvedValue({ destructive: false, reason: '' }),
}));

import { codeTaskTool } from './index.js';
import * as agent from './agent-sdk.js';
import * as ralphex from './ralphex.js';

describe('codeTaskTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExec.mockReturnValue('');
  });

  it('requires task parameter', async () => {
    const result = await codeTaskTool.handler({}, { onProgress: () => {} });
    expect(result.success).toBe(false);
    expect(result.error).toContain('task');
  });

  it('runs agent-sdk in once mode (default)', async () => {
    mockExec.mockImplementation((cmd: string) => {
      if (cmd.includes('numstat')) return '5\t2\tsrc/App.tsx\n';
      if (cmd.includes('diff master')) return 'diff --git...';
      return '';
    });

    const result = await codeTaskTool.handler(
      { task: 'add feature' },
      { onProgress: () => {} },
    );

    expect(agent.runAgent).toHaveBeenCalled();
    expect(ralphex.runRalphex).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
  });

  it('runs ralphex in auto mode when ctx.meta.autoMode is true', async () => {
    mockExec.mockImplementation((cmd: string) => {
      if (cmd.includes('numstat')) return '5\t2\tsrc/App.tsx\n';
      return '';
    });

    await codeTaskTool.handler(
      { task: 'test' },
      { onProgress: () => {}, meta: { autoMode: true } },
    );

    expect(ralphex.runRalphex).toHaveBeenCalled();
  });

  it('returns summary, files, diffs and commit', async () => {
    mockExec.mockImplementation((cmd: string) => {
      if (cmd.includes('numstat')) return '5\t2\tsrc/App.tsx\n';
      if (cmd.includes('diff master')) return 'diff content here';
      return '';
    });

    const result = await codeTaskTool.handler(
      { task: 'test' },
      { onProgress: () => {} },
    );

    expect(result.data).toMatchObject({
      summary: expect.stringContaining('1 files'),
      files: [{ path: 'src/App.tsx', added: 5, removed: 2 }],
      shortDiff: 'diff content here',
      fullDiff: 'diff content here',
      commit: 'abc1234567890',
    });
    expect(result.display).toEqual({
      type: 'code',
      content: 'diff content here',
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/tool-code-task && npx vitest run src/code-task.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement handler**

Replace `packages/tool-code-task/src/index.ts`:

```typescript
import type { ToolResult } from '@r2/shared';
import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import { ensureWorktree, syncWorktree, commitChanges } from './worktree.js';
import { runAgent } from './agent-sdk.js';
import { runRalphex } from './ralphex.js';
import { parseDiffStats, truncateDiff, summarizeDiff } from './diff.js';

const exec = promisify(execCb);

interface ToolContext {
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
  meta?: { autoMode?: boolean };
}

async function runGit(cmd: string, cwd: string): Promise<string> {
  const { stdout } = await exec(cmd, { cwd });
  return stdout.toString();
}

export const codeTaskTool = {
  name: 'code_task',
  description: 'Execute a coding task on R2 dev branch. Use for any modification to R2 code itself (bugfix, feature, refactor). Works in isolated git worktree.',
  permissionLevel: 'confirm' as const,
  parameters: {
    type: 'object' as const,
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
    required: ['task'] as string[],
  },

  async handler(params: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
    const task = params.task;
    if (typeof task !== 'string' || task.trim().length === 0) {
      return { success: false, error: 'task parameter is required' };
    }
    const context = typeof params.context === 'string' ? params.context : undefined;
    const onProgress = ctx?.onProgress ?? (() => {});
    const signal = ctx?.signal;

    const workdir = process.env.R2_DEV_WORKTREE || '/tmp/r2-dev';
    const branch = process.env.R2_DEV_BRANCH || 'dev';
    const startTime = Date.now();

    try {
      onProgress('Preparing worktree...');
      await ensureWorktree(workdir, branch);
      await syncWorktree(workdir, branch);

      // Mode is determined by tool-loop based on saved permission rule
      const mode: 'once' | 'ralphex' = ctx?.meta?.autoMode ? 'ralphex' : 'once';

      onProgress(`Running ${mode === 'ralphex' ? 'ralphex' : 'agent'}...`);

      if (mode === 'ralphex') {
        await runRalphex({ workdir, task, context, onProgress, signal });
      } else {
        await runAgent({ workdir, task, context, onProgress, signal });
      }

      onProgress('Computing diff...');
      const numstat = await runGit('git diff --numstat master..HEAD', workdir);
      const files = parseDiffStats(numstat);

      const fullDiff = await runGit('git diff master..HEAD', workdir);
      const shortDiff = truncateDiff(fullDiff, 50);

      let commit = '';
      if (mode === 'once') {
        // Agent SDK may not have committed — do it here
        commit = await commitChanges(workdir, `r2: ${task}`);
      } else {
        // Ralphex already committed
        const { stdout } = await exec('git rev-parse HEAD', { cwd: workdir });
        commit = stdout.toString().trim();
      }

      const summary = summarizeDiff(files, commit || 'no-commit');

      return {
        success: true,
        data: {
          summary,
          files,
          shortDiff,
          fullDiff,
          commit,
          mode,
          durationMs: Date.now() - startTime,
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
    }
  },
};

export default codeTaskTool;
```

- [ ] **Step 4: Run tests**

Run: `cd packages/tool-code-task && npx vitest run src/code-task.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/tool-code-task/src/index.ts packages/tool-code-task/src/code-task.test.ts
git commit -m "feat: implement code_task handler with once/ralphex modes"
```

---

### Task 10: Client — 3-button PermissionCard for code_task

**Files:**
- Modify: `packages/client/src/components/PermissionCard.tsx`
- Modify: `packages/client/src/hooks/useChat.ts`

- [ ] **Step 1: Update PermissionCard to support 3 buttons and destructive warning**

Replace `packages/client/src/components/PermissionCard.tsx` with:

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
              ⭐ Allow always
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

- [ ] **Step 2: Update useChat to pass destructiveWarning through PendingConfirm**

In `packages/client/src/hooks/useChat.ts`:

Change the `PendingConfirm` interface (around line 5) to include `destructiveWarning`:

```typescript
export interface PendingConfirm {
  callId: string;
  level: 'confirm' | 'forbidden';
  destructiveWarning?: { reason: string };
}
```

In the `tool_confirm_request` case (around line 107), update to include `destructiveWarning`:

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

- [ ] **Step 3: Update MessageBubble to pass destructiveWarning to PermissionCard**

In `packages/client/src/components/MessageBubble.tsx`, find the `PermissionCard` render (around line 59-67). Update it:

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

- [ ] **Step 4: Run client typecheck**

Run: `npx tsc --noEmit -p packages/client/tsconfig.json`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/components/PermissionCard.tsx packages/client/src/hooks/useChat.ts packages/client/src/components/MessageBubble.tsx
git commit -m "feat: add 3-button PermissionCard for code_task with destructive warning"
```

---

### Task 11: Client — ToolCallCard for code_task (progress + diff display)

**Files:**
- Modify: `packages/client/src/components/ToolCallCard.tsx`
- Modify: `packages/client/src/hooks/useChat.ts`
- Modify: `packages/shared/src/types.ts`

- [ ] **Step 1: Add progress field to ToolCall type**

In `packages/shared/src/types.ts`, update ToolCall:

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

- [ ] **Step 2: Handle tool_progress in useChat**

In `packages/client/src/hooks/useChat.ts`, add a new case in the event switch (after `tool_call_result`, before `tool_confirm_request`):

```typescript
          case 'tool_progress': {
            const tc = toolCalls.find((t) => t.id === event.id);
            if (tc) {
              tc.progress = event.message;
            }
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

- [ ] **Step 3: Update ToolCallCard to render code_task specially**

Read the current ToolCallCard.tsx to preserve existing behavior:

Run: `cat packages/client/src/components/ToolCallCard.tsx`

Replace `packages/client/src/components/ToolCallCard.tsx` with:

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
}

export function ToolCallCard({ toolCall }: Props) {
  const [showFullDiff, setShowFullDiff] = useState(false);

  if (toolCall.name === 'code_task') {
    return <CodeTaskCard toolCall={toolCall} showFullDiff={showFullDiff} setShowFullDiff={setShowFullDiff} />;
  }

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

function CodeTaskCard({ toolCall, showFullDiff, setShowFullDiff }: {
  toolCall: ToolCall;
  showFullDiff: boolean;
  setShowFullDiff: (v: boolean) => void;
}) {
  const data = (toolCall.result?.data ?? {}) as CodeTaskData;
  const task = toolCall.input.task as string | undefined;

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
          Commit: {data.commit.slice(0, 7)} ({data.mode})
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
                <span style={{ fontFamily: 'monospace' }}>{f.path}</span>
                {' '}
                <span style={{ color: '#059669' }}>+{f.added}</span>
                {' '}
                <span style={{ color: '#DC2626' }}>-{f.removed}</span>
              </li>
            ))}
          </ul>
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
              overflowX: 'auto', maxHeight: 400,
              margin: 0,
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

- [ ] **Step 4: Run client typecheck**

Run: `npx tsc --noEmit -p packages/shared/tsconfig.json && npx tsc --noEmit -p packages/client/tsconfig.json`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types.ts packages/client/src/hooks/useChat.ts packages/client/src/components/ToolCallCard.tsx
git commit -m "feat: add code_task UI with progress streaming and diff display"
```

---

### Task 12: Env variables and final integration

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Add new env variables**

Append to `.env.example`:

```bash
# Phase 3C: Code task
R2_DEV_WORKTREE=/tmp/r2-dev
R2_DEV_BRANCH=dev
CLAUDE_HAIKU_MODEL=claude-haiku-4-5-20251001
```

- [ ] **Step 2: Verify tool is auto-discovered**

Run: `npm run dev:server` (in one terminal) and check output
Expected: `Tool discovered: code_task (tool-code-task)` appears in startup logs.

Stop the server (Ctrl+C) after verification.

- [ ] **Step 3: Full typecheck across all packages**

Run: `npx tsc --noEmit -p packages/shared/tsconfig.json && npx tsc --noEmit -p packages/server/tsconfig.json && npx tsc --noEmit -p packages/client/tsconfig.json && npx tsc --noEmit -p packages/tool-code-task/tsconfig.json`
Expected: no type errors.

- [ ] **Step 4: Run all tests across all packages**

Run: `npm test --workspaces --if-present`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add .env.example
git commit -m "feat: add Phase 3C env vars (worktree, dev branch, haiku model)"
```

- [ ] **Step 6: Final commit**

```bash
git add -A
git commit -m "chore: Phase 3C — git-in-the-loop (code_task) complete" --allow-empty
```
