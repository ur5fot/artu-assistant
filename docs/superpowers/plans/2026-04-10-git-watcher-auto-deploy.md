# Git Watcher + Auto-Deploy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the self-modifying R2 cycle — supervisor polls master for new commits and auto-restarts worker; new `code_deploy` tool lets user merge dev→master through chat.

**Architecture:** Git watcher module in supervisor (polling loop, shell via execFile). Merge endpoint in worker uses existing shell helpers from `@r2/tool-code-task`. New `@r2/tool-code-deploy` package with a single tool that calls the merge endpoint over HTTP.

**Tech Stack:** Node.js execFile argv-form, Express, Vitest, supertest

---

### Task 1: Shell helper in supervisor package

**Files:**
- Create: `packages/supervisor/src/shell.ts`
- Create: `packages/supervisor/src/shell.test.ts`

Rationale: supervisor cannot import `@r2/tool-code-task` (would create cycle via server → tool-code-task → supervisor once Task 8 lands). Duplicate the minimal helper locally.

- [x] **Step 1: Write failing tests**

Create `packages/supervisor/src/shell.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockExecFile = vi.fn();
vi.mock('node:child_process', () => ({
  execFile: (cmd: string, args: string[], opts: any, cb: any) => {
    const callback = typeof opts === 'function' ? opts : cb;
    const result = mockExecFile(cmd, args, opts);
    if (result instanceof Error) {
      callback(result);
    } else {
      callback(null, { stdout: result ?? '', stderr: '' });
    }
  },
}));

import { run, tryRun } from './shell.js';

describe('supervisor shell helpers', () => {
  beforeEach(() => {
    mockExecFile.mockReset();
  });

  it('run uses argv form with shell: false', async () => {
    mockExecFile.mockReturnValueOnce('hash\n');
    const result = await run('git', ['rev-parse', 'HEAD']);
    expect(result).toBe('hash');
    expect(mockExecFile).toHaveBeenCalledWith(
      'git',
      ['rev-parse', 'HEAD'],
      expect.objectContaining({ shell: false }),
    );
  });

  it('run passes cwd', async () => {
    mockExecFile.mockReturnValueOnce('');
    await run('git', ['status'], '/repo');
    expect(mockExecFile).toHaveBeenCalledWith(
      'git',
      ['status'],
      expect.objectContaining({ cwd: '/repo', shell: false }),
    );
  });

  it('tryRun returns ok=true on success', async () => {
    mockExecFile.mockReturnValueOnce('data');
    const result = await tryRun('git', ['show']);
    expect(result).toEqual({ ok: true, stdout: 'data', code: 0 });
  });

  it('tryRun returns ok=false on error', async () => {
    mockExecFile.mockReturnValueOnce(Object.assign(new Error('boom'), { code: 2 }));
    const result = await tryRun('git', ['show']);
    expect(result.ok).toBe(false);
    expect(result.code).toBe(2);
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `cd packages/supervisor && npx vitest run src/shell.test.ts`
Expected: FAIL — module not found.

- [x] **Step 3: Create shell helper**

Create `packages/supervisor/src/shell.ts`:

```typescript
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const MAX_BUFFER = 8 * 1024 * 1024;

export async function run(cmd: string, args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileP(cmd, args, { cwd, shell: false, maxBuffer: MAX_BUFFER });
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

Run: `cd packages/supervisor && npx vitest run src/shell.test.ts`
Expected: all 4 tests PASS.

- [x] **Step 5: Commit**

```bash
git add packages/supervisor/src/shell.ts packages/supervisor/src/shell.test.ts
git commit -m "feat: add shell helper to supervisor package"
```

---

### Task 2: Git watcher module

**Files:**
- Create: `packages/supervisor/src/git-watcher.ts`
- Create: `packages/supervisor/src/git-watcher.test.ts`

- [x] **Step 1: Write failing tests**

Create `packages/supervisor/src/git-watcher.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockRun = vi.fn();
vi.mock('./shell.js', () => ({
  run: (...args: any[]) => mockRun(...args),
  tryRun: vi.fn(),
}));

import { startGitWatcher } from './git-watcher.js';

describe('startGitWatcher', () => {
  beforeEach(() => {
    mockRun.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads initial hash on start', async () => {
    mockRun.mockResolvedValueOnce('initial-hash');
    const onNewCommit = vi.fn();

    const stop = startGitWatcher({
      repoPath: '/repo',
      branch: 'master',
      intervalMs: 1000,
      onNewCommit,
    });

    await vi.runOnlyPendingTimersAsync();
    expect(mockRun).toHaveBeenCalledWith('git', ['rev-parse', 'origin/master'], '/repo');
    expect(onNewCommit).not.toHaveBeenCalled();
    stop();
  });

  it('fires onNewCommit when hash changes', async () => {
    mockRun
      .mockResolvedValueOnce('hash-a') // initial rev-parse
      .mockResolvedValueOnce('')       // fetch
      .mockResolvedValueOnce('hash-b') // rev-parse after fetch
      .mockResolvedValueOnce('');      // pull

    const onNewCommit = vi.fn();

    const stop = startGitWatcher({
      repoPath: '/repo',
      branch: 'master',
      intervalMs: 1000,
      onNewCommit,
    });

    await vi.runOnlyPendingTimersAsync();
    await vi.advanceTimersByTimeAsync(1000);

    expect(onNewCommit).toHaveBeenCalledWith('hash-b');
    stop();
  });

  it('does not fire onNewCommit when hash is unchanged', async () => {
    mockRun
      .mockResolvedValueOnce('hash-a')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('hash-a');

    const onNewCommit = vi.fn();

    const stop = startGitWatcher({
      repoPath: '/repo',
      branch: 'master',
      intervalMs: 1000,
      onNewCommit,
    });

    await vi.runOnlyPendingTimersAsync();
    await vi.advanceTimersByTimeAsync(1000);

    expect(onNewCommit).not.toHaveBeenCalled();
    stop();
  });

  it('continues polling after an error', async () => {
    mockRun
      .mockResolvedValueOnce('hash-a')
      .mockRejectedValueOnce(new Error('network blip'))
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('hash-a');

    const onNewCommit = vi.fn();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const stop = startGitWatcher({
      repoPath: '/repo',
      branch: 'master',
      intervalMs: 1000,
      onNewCommit,
    });

    await vi.runOnlyPendingTimersAsync();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);

    expect(errorSpy).toHaveBeenCalled();
    stop();
    errorSpy.mockRestore();
  });

  it('cleanup function stops polling', async () => {
    mockRun.mockResolvedValue('hash-a');
    const onNewCommit = vi.fn();

    const stop = startGitWatcher({
      repoPath: '/repo',
      branch: 'master',
      intervalMs: 1000,
      onNewCommit,
    });

    await vi.runOnlyPendingTimersAsync();
    stop();
    mockRun.mockClear();
    await vi.advanceTimersByTimeAsync(5000);

    expect(mockRun).not.toHaveBeenCalled();
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `cd packages/supervisor && npx vitest run src/git-watcher.test.ts`
Expected: FAIL — module not found.

- [x] **Step 3: Implement git watcher**

Create `packages/supervisor/src/git-watcher.ts`:

```typescript
import { run } from './shell.js';

export interface GitWatcherParams {
  repoPath: string;
  branch: string;
  intervalMs: number;
  onNewCommit: (hash: string) => void;
}

export function startGitWatcher(params: GitWatcherParams): () => void {
  let storedHash: string | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  const initialize = async () => {
    try {
      storedHash = await run('git', ['rev-parse', `origin/${params.branch}`], params.repoPath);
    } catch (err) {
      console.error('[git-watcher] Failed to read initial hash:', err instanceof Error ? err.message : err);
    }
  };

  const poll = async () => {
    if (stopped) return;
    try {
      await run('git', ['fetch', 'origin', params.branch, '--quiet'], params.repoPath);
      const newHash = await run('git', ['rev-parse', `origin/${params.branch}`], params.repoPath);

      if (storedHash && newHash !== storedHash) {
        await run('git', ['pull', 'origin', params.branch, '--ff-only'], params.repoPath);
        storedHash = newHash;
        params.onNewCommit(newHash);
      } else if (!storedHash) {
        storedHash = newHash;
      }
    } catch (err) {
      console.error('[git-watcher] Poll error:', err instanceof Error ? err.message : err);
    }
  };

  initialize();
  timer = setInterval(poll, params.intervalMs);

  return () => {
    stopped = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}
```

- [x] **Step 4: Run tests**

Run: `cd packages/supervisor && npx vitest run src/git-watcher.test.ts`
Expected: all tests PASS.

- [x] **Step 5: Commit**

```bash
git add packages/supervisor/src/git-watcher.ts packages/supervisor/src/git-watcher.test.ts
git commit -m "feat: add git watcher with polling loop"
```

---

### Task 3: Wire git watcher into supervisor

**Files:**
- Modify: `packages/supervisor/src/index.ts`

- [x] **Step 1: Add git watcher to supervisor entry**

In `packages/supervisor/src/index.ts`, add import:

```typescript
import { startGitWatcher } from './git-watcher.js';
```

Add config after existing env reads (around line 11):

```typescript
const GIT_POLL_INTERVAL = parseInt(process.env.R2_GIT_POLL_INTERVAL || '60000', 10);
const GIT_WATCH_BRANCH = process.env.R2_GIT_WATCH_BRANCH || 'master';
const GIT_REPO_PATH = process.env.R2_GIT_REPO_PATH || path.resolve(__dirname, '..', '..', '..');
```

Add watcher startup after `manager.start()` at the bottom of the file:

```typescript
let stopWatcher: (() => void) | null = null;
if (GIT_POLL_INTERVAL > 0) {
  stopWatcher = startGitWatcher({
    repoPath: GIT_REPO_PATH,
    branch: GIT_WATCH_BRANCH,
    intervalMs: GIT_POLL_INTERVAL,
    onNewCommit: (hash) => {
      console.log(`[supervisor] New commit on ${GIT_WATCH_BRANCH}: ${hash.slice(0, 7)} — restarting worker`);
      manager.restart();
    },
  });
  console.log(`[supervisor] Git watcher polling ${GIT_WATCH_BRANCH} every ${GIT_POLL_INTERVAL}ms`);
}
```

Update the shutdown function to stop the watcher:

```typescript
function shutdown(signal: string) {
  console.log(`[supervisor] Received ${signal}, shutting down...`);
  stopWatcher?.();
  manager.stop();
  wsServer.close();
  setTimeout(() => process.exit(0), SHUTDOWN_TIMEOUT + 1000).unref();
}
```

- [x] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p packages/supervisor/tsconfig.json`
Expected: no errors.

- [x] **Step 3: Run existing supervisor tests**

Run: `cd packages/supervisor && npx vitest run`
Expected: all existing tests PASS.

- [x] **Step 4: Commit**

```bash
git add packages/supervisor/src/index.ts
git commit -m "feat: wire git watcher into supervisor"
```

---

### Task 4: Merge endpoint in worker

**Files:**
- Create: `packages/server/src/routes/merge.ts`
- Create: `packages/server/src/routes/merge.test.ts`
- Modify: `packages/server/src/index.ts`

- [x] **Step 1: Write failing tests**

Create `packages/server/src/routes/merge.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const mockRun = vi.fn();
const mockTryRun = vi.fn();

vi.mock('@r2/tool-code-task', () => ({
  run: (...args: any[]) => mockRun(...args),
  tryRun: (...args: any[]) => mockTryRun(...args),
}));

import { createMergeRouter } from './merge.js';

describe('POST /api/merge', () => {
  let app: express.Express;

  beforeEach(() => {
    mockRun.mockReset();
    mockTryRun.mockReset();
    app = express();
    app.use(express.json());
    app.use('/api', createMergeRouter());
  });

  it('happy path: merges dev into master and pushes', async () => {
    mockRun
      .mockResolvedValueOnce('') // fetch origin
      .mockResolvedValueOnce('') // checkout master
      .mockResolvedValueOnce(''); // pull origin master
    mockTryRun.mockResolvedValueOnce({ ok: true, stdout: '', code: 0 }); // merge
    mockRun
      .mockResolvedValueOnce('') // push
      .mockResolvedValueOnce('abc1234deadbeef') // rev-parse HEAD
      .mockResolvedValueOnce(' 5 files changed, 30 insertions(+)'); // shortstat

    const res = await request(app).post('/api/merge').send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      commit: 'abc1234deadbeef',
      filesChanged: 5,
      message: expect.stringContaining('abc1234'),
    });
  });

  it('returns 409 on merge conflict', async () => {
    mockRun
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('');
    mockTryRun.mockResolvedValueOnce({ ok: false, stdout: '', code: 1 }); // merge fails
    mockTryRun.mockResolvedValueOnce({ ok: false, stdout: 'src/a.ts\nsrc/b.ts', code: 0 }); // diff --name-only --diff-filter=U
    mockTryRun.mockResolvedValueOnce({ ok: true, stdout: '', code: 0 }); // merge --abort

    const res = await request(app).post('/api/merge').send({});

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/conflict/);
    expect(res.body.conflicts).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('returns 500 when push fails', async () => {
    mockRun
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('');
    mockTryRun.mockResolvedValueOnce({ ok: true, stdout: '', code: 0 });
    mockRun.mockRejectedValueOnce(new Error('push rejected'));

    const res = await request(app).post('/api/merge').send({});

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/push/i);
  });

  it('returns 500 when fetch fails', async () => {
    mockRun.mockRejectedValueOnce(new Error('network'));

    const res = await request(app).post('/api/merge').send({});

    expect(res.status).toBe(500);
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `cd packages/server && npx vitest run src/routes/merge.test.ts`
Expected: FAIL — module not found.

- [x] **Step 3: Export run/tryRun from @r2/tool-code-task**

In `packages/tool-code-task/src/index.ts`, add re-export at the top of the file (after existing exports):

```typescript
export { run, tryRun } from './shell.js';
```

- [x] **Step 4: Implement merge route**

Create `packages/server/src/routes/merge.ts`:

```typescript
import { Router } from 'express';
import type { Request, Response } from 'express';
import { run, tryRun } from '@r2/tool-code-task';

export function createMergeRouter(): Router {
  const router = Router();

  router.post('/merge', async (_req: Request, res: Response) => {
    const cwd = process.env.R2_GIT_REPO_PATH || process.cwd();
    const devBranch = process.env.R2_DEV_BRANCH || 'dev';
    const masterBranch = process.env.R2_GIT_WATCH_BRANCH || 'master';

    try {
      await run('git', ['fetch', 'origin'], cwd);
      await run('git', ['checkout', masterBranch], cwd);
      await run('git', ['pull', 'origin', masterBranch, '--ff-only'], cwd);

      const timestamp = new Date().toISOString();
      const mergeResult = await tryRun(
        'git',
        ['merge', '--no-ff', devBranch, '-m', `deploy: ${timestamp}`],
        cwd,
      );

      if (!mergeResult.ok) {
        const conflictResult = await tryRun(
          'git',
          ['diff', '--name-only', '--diff-filter=U'],
          cwd,
        );
        const conflicts = conflictResult.stdout.split('\n').filter(Boolean);
        await tryRun('git', ['merge', '--abort'], cwd);

        if (conflicts.length > 0) {
          res.status(409).json({ error: 'merge conflicts', conflicts });
          return;
        }
        res.status(500).json({ error: 'merge failed without conflicts' });
        return;
      }

      try {
        await run('git', ['push', 'origin', masterBranch], cwd);
      } catch (err) {
        res.status(500).json({
          error: err instanceof Error ? `push failed: ${err.message}` : 'push failed',
        });
        return;
      }

      const commit = await run('git', ['rev-parse', 'HEAD'], cwd);
      const shortstat = await run('git', ['diff', '--shortstat', 'HEAD~1..HEAD'], cwd);
      const filesChangedMatch = shortstat.match(/(\d+) files? changed/);
      const filesChanged = filesChangedMatch ? parseInt(filesChangedMatch[1], 10) : 0;

      res.json({
        ok: true,
        commit,
        filesChanged,
        message: `Deployed ${commit.slice(0, 7)} (${filesChanged} files)`,
      });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'merge failed',
      });
    }
  });

  return router;
}
```

- [x] **Step 5: Register route in server index**

In `packages/server/src/index.ts`, add import:

```typescript
import { createMergeRouter } from './routes/merge.js';
```

Register after other `/api` routes (near createPiiRouter):

```typescript
app.use('/api', createMergeRouter());
```

- [x] **Step 6: Run tests**

Run: `cd packages/server && npx vitest run src/routes/merge.test.ts`
Expected: all tests PASS.

- [x] **Step 7: Typecheck**

Run: `npx tsc --noEmit -p packages/server/tsconfig.json`
Expected: no errors.

- [x] **Step 8: Commit**

```bash
git add packages/tool-code-task/src/index.ts packages/server/src/routes/merge.ts packages/server/src/routes/merge.test.ts packages/server/src/index.ts
git commit -m "feat: add POST /api/merge endpoint with conflict handling"
```

---

### Task 5: Scaffold @r2/tool-code-deploy package

**Files:**
- Create: `packages/tool-code-deploy/package.json`
- Create: `packages/tool-code-deploy/tsconfig.json`
- Create: `packages/tool-code-deploy/src/index.ts` (placeholder)

- [x] **Step 1: Create package.json**

Create `packages/tool-code-deploy/package.json`:

```json
{
  "name": "@r2/tool-code-deploy",
  "version": "0.1.0",
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@r2/shared": "*"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "vitest": "^3.1.0"
  }
}
```

- [x] **Step 2: Create tsconfig.json**

Create `packages/tool-code-deploy/tsconfig.json`:

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

- [x] **Step 3: Placeholder entry point**

Create `packages/tool-code-deploy/src/index.ts`:

```typescript
import type { ToolDefinition, ToolResult } from '@r2/shared';

export const codeDeployTool: ToolDefinition = {
  name: 'code_deploy',
  description: 'placeholder',
  permissionLevel: 'confirm',
  parameters: { type: 'object', properties: {}, required: [] },
  async handler(): Promise<ToolResult> {
    return { success: false, error: 'not implemented' };
  },
};

export default codeDeployTool;
```

- [x] **Step 4: Install and typecheck**

Run: `npm install && npx tsc --noEmit -p packages/tool-code-deploy/tsconfig.json`
Expected: workspace resolves, no errors.

- [x] **Step 5: Commit**

```bash
git add packages/tool-code-deploy/ package.json package-lock.json
git commit -m "feat: scaffold @r2/tool-code-deploy package"
```

---

### Task 6: code_deploy tool implementation

**Files:**
- Modify: `packages/tool-code-deploy/src/index.ts`
- Create: `packages/tool-code-deploy/src/__tests__/code-deploy.test.ts`

- [x] **Step 1: Write failing tests**

Create `packages/tool-code-deploy/src/__tests__/code-deploy.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { codeDeployTool } from '../index.js';

describe('codeDeployTool', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    process.env.PORT = '3001';
  });

  it('preCheck always returns destructive', async () => {
    expect(codeDeployTool.preCheck).toBeDefined();
    const result = await codeDeployTool.preCheck!({});
    expect(result.destructive).toBe(true);
    expect(result.reason).toMatch(/master/i);
  });

  it('calls POST /api/merge on configured port', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, commit: 'abc1234567', filesChanged: 5, message: 'Deployed abc1234' }),
    });

    const result = await codeDeployTool.handler({}, { onProgress: () => {} });

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3001/api/merge',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(result.success).toBe(true);
    expect((result.data as any).commit).toBe('abc1234567');
    expect((result.data as any).filesChanged).toBe(5);
  });

  it('returns failure with conflicts list on 409', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({ error: 'merge conflicts', conflicts: ['src/a.ts', 'src/b.ts'] }),
    });

    const result = await codeDeployTool.handler({}, { onProgress: () => {} });

    expect(result.success).toBe(false);
    expect(result.error).toContain('src/a.ts');
    expect(result.error).toContain('src/b.ts');
  });

  it('returns failure on 500', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ error: 'push rejected' }),
    });

    const result = await codeDeployTool.handler({}, { onProgress: () => {} });

    expect(result.success).toBe(false);
    expect(result.error).toContain('push rejected');
  });

  it('returns failure on network error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const result = await codeDeployTool.handler({}, { onProgress: () => {} });

    expect(result.success).toBe(false);
    expect(result.error).toContain('ECONNREFUSED');
  });

  it('emits progress messages', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, commit: 'abc1234', filesChanged: 1, message: 'ok' }),
    });

    const progress: string[] = [];
    await codeDeployTool.handler({}, { onProgress: (m) => progress.push(m) });

    expect(progress.length).toBeGreaterThan(0);
    expect(progress.some((p) => p.toLowerCase().includes('merg'))).toBe(true);
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `cd packages/tool-code-deploy && npx vitest run`
Expected: FAIL.

- [x] **Step 3: Implement code_deploy tool**

Replace `packages/tool-code-deploy/src/index.ts`:

```typescript
import type { ToolDefinition, ToolResult, ToolContext } from '@r2/shared';

export const codeDeployTool: ToolDefinition = {
  name: 'code_deploy',
  description: 'Deploy changes from dev branch to master. Merges dev into master and pushes. Use after code_task is complete and user has reviewed the changes. Always requires confirmation.',
  permissionLevel: 'confirm',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },

  preCheck: async () => ({
    destructive: true,
    reason: 'deploys to production master branch',
  }),

  async handler(_params: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
    const onProgress = ctx?.onProgress ?? (() => {});
    const port = process.env.PORT || '3001';

    onProgress('Merging dev into master...');

    try {
      const res = await fetch(`http://localhost:${port}/api/merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      let data: any = {};
      try {
        data = await res.json();
      } catch {
        // ignore JSON parse errors; data stays empty
      }

      if (res.status === 409) {
        const conflicts = Array.isArray(data.conflicts) ? data.conflicts : [];
        return {
          success: false,
          error: `Merge conflicts in: ${conflicts.join(', ') || 'unknown files'}`,
        };
      }

      if (!res.ok) {
        return {
          success: false,
          error: data.error || `Merge failed with status ${res.status}`,
        };
      }

      onProgress(`Deployed ${String(data.commit || '').slice(0, 7)}`);

      return {
        success: true,
        data: {
          commit: data.commit,
          filesChanged: data.filesChanged,
          summary: data.message,
        },
        display: {
          type: 'text',
          content: `✓ ${data.message}\n\nSupervisor will restart the worker within 60 seconds.`,
        },
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'deploy request failed',
      };
    }
  },
};

export default codeDeployTool;
```

- [x] **Step 4: Run tests**

Run: `cd packages/tool-code-deploy && npx vitest run`
Expected: all tests PASS.

- [x] **Step 5: Commit**

```bash
git add packages/tool-code-deploy/src/index.ts packages/tool-code-deploy/src/__tests__/code-deploy.test.ts
git commit -m "feat: implement code_deploy tool"
```

---

### Task 7: Env variables and final integration

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Add env vars**

Append to `.env.example`:

```bash
# Phase 3D: Git watcher + auto-deploy
R2_GIT_POLL_INTERVAL=60000       # ms; 0 = disable watcher
R2_GIT_WATCH_BRANCH=master       # branch to watch for external changes
R2_GIT_REPO_PATH=                # optional, defaults to project root
```

- [ ] **Step 2: Verify tool auto-discovery**

Run: `npm run dev:server` in one terminal, check logs
Expected: `Tool discovered: code_deploy (tool-code-deploy)` in startup logs.
Stop with Ctrl+C.

- [ ] **Step 3: Full typecheck**

Run: `npx tsc --noEmit -p packages/shared/tsconfig.json && npx tsc --noEmit -p packages/server/tsconfig.json && npx tsc --noEmit -p packages/client/tsconfig.json && npx tsc --noEmit -p packages/supervisor/tsconfig.json && npx tsc --noEmit -p packages/tool-code-task/tsconfig.json && npx tsc --noEmit -p packages/tool-code-deploy/tsconfig.json`
Expected: no type errors.

- [ ] **Step 4: Run all tests**

Run: `npm test --workspaces --if-present`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add .env.example
git commit -m "feat: add Phase 3D env vars"
```

- [ ] **Step 6: Final commit**

```bash
git add -A
git commit -m "chore: Phase 3D — git watcher + auto-deploy complete" --allow-empty
```
