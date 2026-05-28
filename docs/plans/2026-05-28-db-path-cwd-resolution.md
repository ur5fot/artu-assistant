# DB / EVALS path: resolve relative to project root, not cwd

## Overview

**Bug:** `DB_PATH` and `EVALS_PATH` in `.env` are typed as relative paths
(`./data/r2.db`, `./data/evals.json`). The code uses them with no
`import.meta.url`-based resolution, so the actual path on disk depends
on `process.cwd()`:

- `npm run dev` (cwd = `packages/server/`) → `packages/server/data/r2.db`
- `npm start` (cwd = repo root) → `data/r2.db`

Result: two parallel databases drift apart depending on how the worker
is launched. This caused today's incident where iter 5 tests against a
synthetic urgent row never fired because the row was inserted into the
`packages/server/data/r2.db` while the server was reading from
`data/r2.db`.

**Goal:** make both `DB_PATH` and `EVALS_PATH` resolve relative to the
project root (via `import.meta.url` walk) when they are relative; keep
absolute paths absolute; preserve env-override behaviour.

**Why this matters beyond the symptom:**
- AGENTS.md "Уроки из ревью" already prescribes this:
  > **DB path:** SQLite файл должен resolve'иться от `import.meta.url`,
  > не от `cwd()`. Хранить в `data/r2.db` относительно корня проекта.
- The same bug class likely lives in any future relative-path env var;
  centralising a small helper now prevents repeats.
- The on-disk drift is **silent** — no error, no log, the user just
  ends up with two databases. Worst kind of bug.

**Out of scope:**
- Data migration between the two existing databases. That's a separate
  operational task (manual decision: pick one, drop the other; or merge
  schemas). This plan only stops further drift.
- Other relative env vars not touched today (e.g. `R2_FILES_ROOT`,
  `R2_DEV_WORKTREE_PREFIX`). They have different semantics and aren't
  used for persistent state — fix only if a similar drift is observed.

## Context (from discovery)

**Full audit of cwd-relative resolution sites (grep, complete):**

| File | Line | Pattern | Action |
|---|---|---|---|
| `packages/server/src/db.ts` | 24 | `process.env.DB_PATH` used verbatim | **Fix** |
| `packages/server/src/evals/store.ts` | 14 | `process.env.EVALS_PATH \|\| path.resolve(process.cwd(), …)` | **Fix** |
| `packages/server/src/routes/merge.ts` | 35 | `process.env.R2_GIT_REPO_PATH \|\| process.cwd()` | **Keep** — git operation, cwd is intentional |

No other `process.cwd()` or `*_PATH` env consumers were found. The fix
scope is exactly two files plus the new helper.

**Current state of buggy code:**

`packages/server/src/db.ts:22-24`:
```ts
const thisDir = path.dirname(fileURLToPath(import.meta.url));
const defaultDbPath = path.resolve(thisDir, '..', '..', '..', 'data', 'r2.db');
const resolvedPath = dbPath ?? (process.env.DB_PATH || defaultDbPath);
```
The `defaultDbPath` correctly walks up from `db.ts` to repo root —
but `process.env.DB_PATH`, when set, is used **verbatim**, so the
relative-path bug fires.

`packages/server/src/evals/store.ts:14`:
```ts
return process.env.EVALS_PATH || path.resolve(process.cwd(), 'data', 'evals.json');
```
Worse: even the fallback uses `process.cwd()`. Both paths drift.

**Pattern to introduce:**
A pure helper `resolveProjectPath(envValue, defaultRelativeParts, opts)`
in `packages/server/src/path-utils.ts` (new file). **`projectRoot` is
injected** via `opts.projectRoot` for testability; production callers
use a module-level constant derived from `import.meta.url`. This avoids
fragile `vi.spyOn(process, 'cwd')` patterns in tests.

Semantics:
- `envValue` absolute → return `envValue` unchanged
- `envValue` relative (incl. `./` and `../`) → `path.resolve(projectRoot, envValue)`
- `envValue` undefined/empty → `path.resolve(projectRoot, ...defaultRelativeParts)`

`..` in env paths is allowed and behaves like `path.resolve` (joined,
normalized) — useful for "DB on another volume" cases. Documented as
intentional.

## Development Approach

- **Testing approach**: **TDD** (tests first, then implementation).
- Complete each task fully before moving to the next.
- Tests must pass before next task.
- Maintain backward compatibility on absolute env values (must keep working).

## Testing Strategy

- vitest only.
- Tests run with various `process.cwd()` (`vi.spyOn(process, 'cwd')`)
  and various env values; assert resolved path is the same regardless
  of cwd when env path is relative.
- Tests for absolute env paths: assert they pass through untouched.
- No real DB / file writes — pure path math.

## Progress Tracking

- Mark completed items with `[x]` immediately when done.
- Add newly discovered tasks with ➕ prefix.
- Document blockers with ⚠️ prefix.

## Implementation Steps

### Task 1: `path-utils.ts` — `resolveProjectPath` helper (DI for testability)

- [x] create `packages/server/src/path-utils.ts` exporting:
  - `resolveProjectPath(envValue: string | undefined, defaultRelativeParts: string[], opts?: { projectRoot?: string }): string`
  - `getProjectRoot(): string` — module-level cached default, derived
    from `import.meta.url` walking 3 hops up (`packages/server/src/` →
    repo root). Add inline comment: `// DO NOT MOVE THIS FILE — path
    walk assumes packages/server/src/ depth.`
- [x] semantics (pure function — no `process.cwd` reads, no `process.env`
  reads inside the helper):
  - `projectRoot = opts.projectRoot ?? getProjectRoot()`
  - `envValue === undefined || envValue === ''` →
    `path.resolve(projectRoot, ...defaultRelativeParts)`
  - `path.isAbsolute(envValue)` → return `envValue` unchanged
  - else (relative, incl. `./`, `../`, plain names) →
    `path.resolve(projectRoot, envValue)`
- [x] write tests in
  `packages/server/src/__tests__/path-utils.test.ts` — **inject
  `projectRoot` via opts in every test**; no `process.cwd` mocking:
  - `projectRoot='/proj', envValue='./data/x.db'` → `/proj/data/x.db`
  - `projectRoot='/proj', envValue='data/x.db'` → `/proj/data/x.db`
  - `projectRoot='/proj', envValue='../sibling/x.db'` → `/sibling/x.db`
    (normalized — documents `..` is allowed)
  - `projectRoot='/proj', envValue='/abs/x.db'` → `/abs/x.db` (passthrough)
  - `projectRoot='/proj', envValue=undefined, default=['data','x.db']`
    → `/proj/data/x.db`
  - `projectRoot='/proj', envValue='', default=['data','x.db']`
    → `/proj/data/x.db` (empty string treated as undefined)
  - `getProjectRoot()` returns an absolute path ending in `R2-D2`
    (sanity check that the 3-hop walk lands on the repo root in the
    actual build)
- [x] run `npm -w @r2/server test -- path-utils.test` — must pass
  before task 2

### Task 2: `db.ts` — use `resolveProjectPath`

- [ ] in `packages/server/src/db.ts`, replace lines 22-24 with:
  ```ts
  const resolvedPath = dbPath ?? resolveProjectPath(
    process.env.DB_PATH,
    ['data', 'r2.db'],
  );
  ```
- [ ] remove the now-unused `thisDir` and `defaultDbPath` lines
- [ ] verify existing `__tests__/db.test.ts` still passes (no
  behavioural change for absolute env paths or for unset env, given the
  default still resolves to `<root>/data/r2.db`)
- [ ] add a regression test in `db.test.ts` that does NOT mock
  `process.cwd`: call `initDb` with explicit `dbPath` arg pointing at a
  tmp file; verify it lands at the tmp path regardless of what
  `DB_PATH` env says. Separate unit test using `resolveProjectPath`
  directly with two different `projectRoot` injections confirms the
  cwd-independence property — no `vi.spyOn(process, 'cwd')` needed.
- [ ] run `npm -w @r2/server test -- db.test` — must pass before task 3

### Task 3: `evals/store.ts` — use `resolveProjectPath`

- [ ] in `packages/server/src/evals/store.ts`, replace line 14 with:
  ```ts
  return resolveProjectPath(process.env.EVALS_PATH, ['data', 'evals.json']);
  ```
- [ ] write tests (or extend existing) verifying:
  - cwd-independence: same resolved path regardless of `process.cwd`
  - absolute `EVALS_PATH` passes through
  - unset `EVALS_PATH` → repo-root `data/evals.json`
- [ ] run `npm -w @r2/server test -- evals` — must pass before task 4

### Task 4: Acceptance + docs

- [ ] run full server test suite (`npm -w @r2/server test`) — all green
- [ ] run TypeScript build (`npm -w @r2/server run build`) — no errors
- [ ] update `AGENTS.md` "Уроки из ревью" section: add one line under
  the existing DB path advice noting that `resolveProjectPath` from
  `path-utils.ts` is the canonical helper for any new relative-path env
  var (so the next person doesn't reinvent the same bug)
- [ ] update `.env.example` — add comment above each relative path:
  ```
  # Relative paths resolve from the project root (not process.cwd) —
  # safe to start the server from any directory.
  DB_PATH=./data/r2.db
  ...
  EVALS_PATH=./data/evals.json
  ```
- [ ] note in Post-Completion that the existing
  `packages/server/data/r2.db` / `data/r2.db` split was already
  resolved manually (operator merged before running this plan); the
  code fix only prevents future drift.

## Technical Details

### `resolveProjectPath` signature

```ts
export function resolveProjectPath(
  envValue: string | undefined,
  defaultRelativeParts: string[],
): string;
```

### Project root derivation

The file lives at `packages/server/src/path-utils.ts`. Three dirname
hops give the repo root:

```
packages/server/src/path-utils.ts
        ↑           ↑          ↑
      hop 3       hop 2     hop 1
```

So:
```ts
const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..', '..', '..');
```

### Backward compatibility — `DB_PATH`

| `DB_PATH`            | cwd                  | Before          | After                                  |
|----------------------|----------------------|-----------------|----------------------------------------|
| unset                | repo root            | repo/data/r2.db | repo/data/r2.db (unchanged)            |
| unset                | packages/server      | repo/data/r2.db | repo/data/r2.db (unchanged)            |
| `./data/r2.db`       | repo root            | repo/data/r2.db | repo/data/r2.db (unchanged)            |
| `./data/r2.db`       | packages/server      | packages/server/data/r2.db **(bug)** | repo/data/r2.db **(fix)** |
| `/abs/path/r2.db`    | any                  | /abs/path/r2.db | /abs/path/r2.db (unchanged)            |

Only the buggy row changes behaviour for `DB_PATH`.

### Backward compatibility — `EVALS_PATH`

Worse before than `DB_PATH`: even unset was cwd-dependent.

| `EVALS_PATH`         | cwd                  | Before                            | After                          |
|----------------------|----------------------|-----------------------------------|--------------------------------|
| unset                | repo root            | repo/data/evals.json              | repo/data/evals.json (unchanged) |
| unset                | packages/server      | packages/server/data/evals.json **(silent drift)** | repo/data/evals.json **(fix)** |
| `./data/evals.json`  | repo root            | repo/data/evals.json              | repo/data/evals.json (unchanged) |
| `./data/evals.json`  | packages/server      | packages/server/data/evals.json **(bug)** | repo/data/evals.json **(fix)** |
| `/abs/path.json`     | any                  | /abs/path.json                    | /abs/path.json (unchanged)     |

**Two buggy rows fixed for `EVALS_PATH`** — note that unset env was
also broken (used `process.cwd()` as the resolve base). If an
`evals.json` exists under `packages/server/data/` from prior dev runs,
the operator must manually move it to root before relying on the new
behaviour (same migration step performed for `r2.db`).

## Post-Completion

*No checkboxes — needs operator decision.*

**Manual cleanup after this plan ships:**

- Two `r2.db` files now exist on disk:
  - `packages/server/data/r2.db` (used by historical `npm run dev` sessions)
  - `data/r2.db` (used by recent `npm start` sessions)
- This code fix points all future starts at `data/r2.db`. The other
  file becomes orphan stale data.
- Decide one of:
  1. **Drop the older root one** (`data/r2.db`) — `mv` the
     `packages/server/data/r2.db` over it, since the dev DB has more
     history.
  2. **Drop the dev one** (`packages/server/data/r2.db`) — keep the
     supervisor-mode database; you lose chat history from yesterday +
     prior memory.
  3. **Merge schemas** — only worth it if both have valuable rows
     (e.g. one has chat history, the other has new email_sent_log
     entries). Requires manual SQL.
- Same decision applies to `evals.json` (likely much less critical).

Recommended order: back both up, choose, commit deletion.
