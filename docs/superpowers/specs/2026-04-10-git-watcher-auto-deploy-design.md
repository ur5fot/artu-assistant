# Phase 3D: Git watcher + auto-deploy

## Цель

Закрыть цикл self-modifying R2. После того как R2 сделал изменения в dev через `code_task` (Phase 3C), юзер говорит "деплой" → R2 мержит dev→master → supervisor видит новый коммит → рестартует worker → чат продолжается с обновлённым R2. Плюс external commits (push с другой машины) подхватываются автоматически.

## Архитектура

Два независимых компонента:

1. **Git watcher в supervisor** — polling раз в 60 сек, при новом коммите в origin/master делает `git pull` и рестартует worker
2. **Merge endpoint + code_deploy tool** — worker exposes `POST /api/merge`, новый tool `code_deploy` его вызывает через чат

```
Chat-driven deploy:
  User: "деплой"
  Chat Claude → tool code_deploy (permissionLevel: confirm, preCheck → destructive)
  PermissionCard: 3 кнопки (Once/Always/Deny) + destructive warning
  User: Allow once
  Tool handler → fetch POST http://localhost:PORT/api/merge
  Server merge route:
    git fetch → checkout master → pull → merge dev --no-ff → push
    If conflict → abort, return 409
  Tool returns summary
  ↓ (supervisor polling, within 60s)
  Supervisor git watcher: git fetch → hash changed → git pull → workerManager.restart()
  Worker restarts → supervisor broadcasts worker_starting → worker_ready over WS
  Client sees "R2 is restarting..." → reconnects → chat continues

External deploy (push from other machine):
  git push origin master (from laptop)
  ↓ (supervisor polling, within 60s)
  Supervisor git watcher picks up new hash
  Same restart flow as above
```

## Git watcher (supervisor)

### Module `packages/supervisor/src/git-watcher.ts`

```typescript
interface GitWatcherParams {
  repoPath: string;
  branch: string;
  intervalMs: number;
  onNewCommit: (hash: string) => void;
}

export function startGitWatcher(params: GitWatcherParams): () => void;
```

### Implementation

1. **Initial hash** — on start, read `git rev-parse origin/${branch}` as baseline
2. **Poll loop** — every `intervalMs`:
   - `git fetch origin ${branch} --quiet`
   - `git rev-parse origin/${branch}` → new hash
   - If hash !== stored:
     - `git pull origin ${branch} --ff-only`
     - Call `onNewCommit(newHash)`
     - Update stored hash
3. **Error handling** — log errors but continue polling (network blips, transient failures should not kill watcher)
4. **Cleanup** — return function that calls `clearInterval`

### Shell execution

Use `execFile` argv-form via a local helper (copy of `shell.ts` from `@r2/tool-code-task` — supervisor cannot import tool-code-task to avoid circular deps through server). Consider extracting to `@r2/shared` as a utility later.

### Integration in `supervisor/src/index.ts`

After `manager.start()`:

```typescript
const pollInterval = parseInt(process.env.R2_GIT_POLL_INTERVAL || '60000', 10);
const watchBranch = process.env.R2_GIT_WATCH_BRANCH || 'master';
const repoPath = process.env.R2_GIT_REPO_PATH || process.cwd();

let stopWatcher: (() => void) | null = null;
if (pollInterval > 0) {
  stopWatcher = startGitWatcher({
    repoPath,
    branch: watchBranch,
    intervalMs: pollInterval,
    onNewCommit: (hash) => {
      console.log(`[supervisor] New commit detected on ${watchBranch}: ${hash.slice(0, 7)}`);
      manager.restart();
    },
  });
  console.log(`[supervisor] Git watcher polling ${watchBranch} every ${pollInterval}ms`);
}
```

Cleanup in SIGTERM/SIGINT:

```typescript
process.on('SIGTERM', () => {
  stopWatcher?.();
  manager.stop();
  wsServer.close();
  process.exit(0);
});
```

## Merge endpoint (worker)

### Route `packages/server/src/routes/merge.ts`

```typescript
POST /api/merge
Request body: {}
Response 200: { ok: true, commit: string, filesChanged: number, message: string }
Response 409: { error: 'merge conflicts', conflicts: string[] }
Response 500: { error: string }
```

### Flow

Uses `execFile` argv-form (never shell strings). Copies minimal `run`/`tryRun` helpers from tool-code-task or imports via `@r2/tool-code-task` package (server already depends on it from Phase 3C).

```typescript
async function mergeHandler(_req, res) {
  const cwd = process.env.R2_GIT_REPO_PATH || process.cwd();
  const devBranch = process.env.R2_DEV_BRANCH || 'dev';
  const masterBranch = process.env.R2_GIT_WATCH_BRANCH || 'master';

  try {
    await run('git', ['fetch', 'origin'], cwd);
    await run('git', ['checkout', masterBranch], cwd);
    await run('git', ['pull', 'origin', masterBranch, '--ff-only'], cwd);

    const timestamp = new Date().toISOString();
    const mergeResult = await tryRun('git', ['merge', '--no-ff', devBranch, '-m', `deploy: ${timestamp}`], cwd);

    if (!mergeResult.ok) {
      // Detect conflicts
      const statusResult = await tryRun('git', ['diff', '--name-only', '--diff-filter=U'], cwd);
      const conflicts = statusResult.stdout.split('\n').filter(Boolean);

      await tryRun('git', ['merge', '--abort'], cwd);

      if (conflicts.length > 0) {
        res.status(409).json({ error: 'merge conflicts', conflicts });
        return;
      }
      res.status(500).json({ error: 'merge failed without conflicts' });
      return;
    }

    await run('git', ['push', 'origin', masterBranch], cwd);

    const commit = await run('git', ['rev-parse', 'HEAD'], cwd);
    const filesChangedStr = await run('git', ['diff', '--shortstat', 'HEAD~1..HEAD'], cwd);
    const filesChanged = parseInt((filesChangedStr.match(/(\d+) files? changed/)?.[1]) || '0', 10);

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
}
```

### Registration in `server/src/index.ts`

```typescript
import { createMergeRouter } from './routes/merge.js';
...
app.use('/api', createMergeRouter());
```

## code_deploy tool

### Package `packages/tool-code-deploy/`

Structure mirrors `tool-code-task`:

```
packages/tool-code-deploy/
├── src/
│   ├── index.ts
│   └── __tests__/
│       └── code-deploy.test.ts
├── package.json
└── tsconfig.json
```

### Tool definition

```typescript
import type { ToolDefinition, ToolResult, ToolContext } from '@r2/shared';

const codeDeployTool: ToolDefinition = {
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
  async handler(_params, ctx): Promise<ToolResult> {
    const onProgress = ctx?.onProgress ?? (() => {});
    const port = process.env.PORT || 3001;

    onProgress('Merging dev into master...');

    try {
      const res = await fetch(`http://localhost:${port}/api/merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      const data = await res.json();

      if (res.status === 409) {
        return {
          success: false,
          error: `Merge conflicts in: ${(data.conflicts || []).join(', ')}`,
        };
      }

      if (!res.ok) {
        return {
          success: false,
          error: data.error || `Merge failed with status ${res.status}`,
        };
      }

      onProgress(`Deployed ${data.commit.slice(0, 7)}`);

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

`preCheck` always returns destructive — deploy always shows the destructive warning + disables "Allow always".

## Environment variables

```bash
# Phase 3D
R2_GIT_POLL_INTERVAL=60000       # ms; 0 = disable watcher
R2_GIT_WATCH_BRANCH=master       # branch to watch
R2_GIT_REPO_PATH=                # optional, defaults to process.cwd()
```

`R2_DEV_BRANCH` already exists from Phase 3C.

## Testing

### Unit tests (Vitest)

**`packages/supervisor/src/git-watcher.test.ts`**:
- Watcher polls at configured interval
- `onNewCommit` fires when hash changes
- `onNewCommit` does NOT fire when hash unchanged
- Errors in git commands are caught and do not stop polling
- Cleanup function clears the interval

**`packages/server/src/routes/merge.test.ts`** (supertest):
- Happy path: fetch → checkout → pull → merge → push → 200 with commit hash
- Merge conflict: returns 409 with conflicts list, calls `merge --abort`
- Push failure: returns 500
- Fetch failure: returns 500

**`packages/tool-code-deploy/src/__tests__/code-deploy.test.ts`**:
- Handler calls `POST /api/merge` on configured port
- Returns success with commit hash and summary
- Returns failure on 409 with conflict list in error
- Returns failure on network error
- `preCheck` always returns destructive

### Manual / E2E

- Make a small edit via `code_task` on dev → say "деплой" in chat → PermissionCard with 3 buttons + destructive warning → Allow once → merge succeeds → supervisor restarts worker within 60s → chat continues with new R2
- Push a commit to master from laptop → wait 60s → supervisor picks up → worker restarts
- Create conflict: edit same file on dev and master → `code_deploy` → error card shows conflicts list → master unchanged

## What's NOT included

- Pre-merge eval checks (Phase 3E)
- Rollback command (Phase 3E)
- Deploy status card in chat / deployment history (Phase 3F)
- Staging branches
- Multi-environment deployment
- Signed commit verification
- Smart conflict auto-resolve via Claude
- Deploy notifications (email, Slack, etc.)
