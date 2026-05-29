# Tab Restore — Pain #2, Iteration 1 (observation only)

## Overview

First slice of **Pain #2 — Tab restore on context switch** from the
strategic roadmap
([2026-05-27-toward-ideal-r2.md](../superpowers/plans/2026-05-27-toward-ideal-r2.md)).
**This is the first OS-level integration in R2** — Digital Observer
infra that EPIC 1 will build on.

**Goal:** R2 polls macOS for the foreground app + window title every
30s, stores in SQLite, detects "context switches" with a simple
heuristic, and proactively pings Discord with a `🔁 Restore context?`
embed showing **only a summary** (app name + duration). A
`Show titles` button reveals the title list as an ephemeral message
(privacy-by-default — see Design decisions).

**What this iteration validates: detection.** Not infrastructure for
iter 2's restore. iter 2 will need entirely new data sources (Chrome
tab list via AppleScript, editor workspace state, terminal cwd) that
iter 1 does not collect. iter 1's job is to confirm the detection
heuristic fires at the right moments on real personal traffic before
investing in fragile restore-side integrations.

**Why this slice:**
- Builds the Digital Observer poller + history store that EPIC 1 needs.
- Validates the heuristic on real personal traffic before any
  external side effects.
- Low risk — observation + notification only. No app launches, no file
  writes outside R2's own DB.

**Out of scope (later iterations):**
- Actual restore (open URLs in Chrome, files in editor, set cwd in
  terminal) — iter 2.
- Tracking all open windows / browser tab list / editor state — iter 2.
- Cross-platform — macOS only.
- Per-app categorisation (work / messaging / browsing) — iter 1.5 or
  iter 3 if observation shows need.
- App blacklist (`WINDOW_LOGGER_IGNORE_APPS`) — iter 1.5 if Music/Slack/
  idle apps dominate "long sessions".
- Screen-lock awareness — iter 1.5 if false positives from "Chrome
  focused while laptop slept" prove common.
- `/observations status` slash command for live tuning — iter 1.5.

**Key design decisions:**

- **`osascript` via existing `execFile` wrapper, not `active-win`.**
  AppleScript is Apple-maintained, has zero dep risk, and reuses the
  proven `tool-code-task/src/shell.ts` shell wrapper. 30s polling makes
  the ~100ms latency irrelevant (0.7% CPU sustained). No node-gyp
  rebuild on Node upgrade, no native ABI breakage on macOS upgrade.
- **Active foreground window only, not all windows.** What the user
  _focuses_ is what they're using. Background tabs come in iter 2.
- **Coalesce identical consecutive samples in DB.** Same app+title for
  5 minutes = 1 row with `started_at`, `last_seen_at`, `sample_count`.
  ~100x compression vs naive per-sample inserts.
- **Privacy-by-default in the Discord embed.** Embed shows only:
  `Was on Chrome ~45 min`. Titles list (potentially containing PDF
  filenames, DM partner names, calendar entries, banking URLs) hides
  behind a `Show titles` button → ephemeral message visible only to
  the user. Default-safe for shoulder surfers.
- **Context-switch detection — pure heuristic, three knobs.**
  `LONG_SESSION_MIN` (default 30), `SWITCH_GAP_MIN` (default 5),
  `STABLE_NEW_MIN` (default 5). All thresholds are env-configurable
  so observation period can tune without code change.
- **8-hour dedupe per away-app** via `context_pings` table — at most
  one ping per workday about returning to the same X.
- **Timeout wrapper around `osascript` call** (5s). If the subprocess
  hangs (Apple Events queue stuck, permission prompt blocking), the
  poller skips that tick and retries 30s later. Worst case: 1 missed
  sample.
- **Feature flag `WINDOW_LOGGER_ENABLED=false` (default off)** AND
  `process.platform === 'darwin'` gate AND `discordBot !== null` gate.
  Linux/Docker users silently see nothing.

## Known limitations (documented up front)

- **Screen-lock false positive.** macOS reports the last focused app
  as "active" even when the screen is locked. Sleeping laptop with
  Chrome in front for 4 hours looks identical to "deep work on Chrome
  for 4 hours". User returning will get a useless "Restore Chrome?"
  ping. iter 1.5 will add a screen-lock detector if this proves
  frequent.
- **Read-from-app-in-window false positive.** Reading docs in browser
  for 5 minutes can trigger "Restore coding?" if the previous coding
  session was long. Threshold tuning via env vars covers this in
  practice.
- **Permission grant friction.** AppleScript needs Automation
  permission for System Events.app. macOS prompts on first call; user
  may need to manually toggle in System Settings → Privacy & Security
  → Automation. Documented in Post-Completion.

## Context (from discovery)

**Existing patterns to reuse:**

- **Poller** — `packages/server/src/emails/multi-account-poller.ts:99-123`.
  Self-scheduling `setTimeout` recursion + `stopped` flag.
- **Cognition handler** — `packages/server/src/cognition/types.ts:72-76`
  `Handler { name, trigger, run }`. Registration in `index.ts` gated
  on feature flag + `discordBot`.
- **DB migration** — `db.ts` `initDb()` owns all schema. Idempotent
  `CREATE IF NOT EXISTS`.
- **Factory pattern** — `emails/sent-log.ts:28-65` shape: exported
  interface + `createX({db}): X`.
- **Env var parsing** — `index.ts:285-294` `envInt(env, default, min, max)`.
- **Embed builder** — `discord/embeds.ts:225-270` plain
  `{embed: EmbedData, components: ComponentData[]}`; `bot.ts` converts
  at boundary.
- **External-process invocation** —
  `packages/tool-code-task/src/shell.ts:1-28` `run(cmd, args)` via
  `execFile`. We add a timeout option for the osascript path.

**No new external dependencies.**

**Files involved:**

*New:*
- `packages/server/src/observers/window-snapshot.ts` — osascript
  invocation + parsing + timeout wrapper.
- `packages/server/src/observers/window-logger.ts` — 30s poller
  consuming the snapshot provider.
- `packages/server/src/observers/window-history-store.ts` — store
  factory + session queries.
- `packages/server/src/observers/context-switch-detector.ts` — pure
  detection function + `ContextPingStore` (one file — they're tightly
  coupled and small).
- `packages/server/src/cognition/handlers/contextSwitch.ts` — handler
  consuming detector, emits embed.
- All tests mirroring each module.

*Modified:*
- `packages/server/src/channels/discord/embeds.ts` — add
  `buildWindowRestoreEmbed(event)` (no titles by default).
- `packages/server/src/channels/discord/interactions.ts` — new
  `window:show:${session_id}` button handler — fetches titles, sends
  ephemeral.
- `packages/server/src/db.ts` — add `window_history` +
  `context_pings` tables.
- `packages/server/src/index.ts` — env parsing, conditional poller +
  handler registration.
- `.env.example` — document new vars + permission note.
- `README.md` — Digital Observer section.
- `AGENTS.md` — `contextSwitch` under Cognition layer.

## Development Approach

- **Testing approach**: **TDD** (tests first, then implementation).
- Complete each task fully before moving to next.
- Tests are a required deliverable.
- All tests must pass before next task.
- ➕ for new sub-tasks, ⚠️ for blockers.
- Run scoped: `npm -w @r2/server test -- <pattern>`.

## Testing Strategy

- vitest only.
- The osascript subprocess is abstracted behind
  `WindowSnapshotProvider`; tests mock the provider, no real
  AppleScript invocation in tests.
- In-memory SQLite for store tests.
- Fake timers for poller + cognition handler timing.
- Mocked Discord interactions for embed + ephemeral flow.
- **No live macOS tests.** Real osascript verification happens in
  Post-Completion manual checks.

## Progress Tracking

- Mark completed `[x]` immediately when done.
- ➕ for new sub-tasks, ⚠️ for blockers.

## What Goes Where

- **Implementation Steps** (`[ ]`): code, tests, docs.
- **Post-Completion** (no checkboxes): one-time macOS permission
  grant, manual verification, observation queries, tuning notes.

## Implementation Steps

### Task 1: DB migration — `window_history` + `context_pings`

- [ ] in `packages/server/src/db.ts`, inside `initDb()`, add idempotent
  `CREATE TABLE IF NOT EXISTS window_history`:
  ```sql
  CREATE TABLE IF NOT EXISTS window_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    app_name TEXT NOT NULL,
    window_title TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    sample_count INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_window_history_last_seen
    ON window_history(last_seen_at DESC);
  CREATE INDEX IF NOT EXISTS idx_window_history_app_last_seen
    ON window_history(app_name, last_seen_at DESC);
  ```
  **No `bundle_id` column** — not used by detector or embed; add when
  iter 2 needs it.
- [ ] add idempotent `context_pings`:
  ```sql
  CREATE TABLE IF NOT EXISTS context_pings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    away_app TEXT NOT NULL,
    pinged_at INTEGER NOT NULL,
    away_session_started_at INTEGER NOT NULL,
    away_session_ended_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_context_pings_app_at
    ON context_pings(away_app, pinged_at DESC);
  ```
- [ ] write tests in `__tests__/db.test.ts`: both tables exist after
  `initDb`; all three indexes exist; idempotent re-run no errors.
- [ ] run `npm -w @r2/server test -- db.test` — must pass before task 2

### Task 2: `WindowHistoryStore` — coalescing insert + session queries

- [ ] create `packages/server/src/observers/window-history-store.ts`
  exporting `WindowHistoryRow`, `WindowSession`, `WindowHistoryStore`,
  `createWindowHistoryStore({db})`
- [ ] methods:
  - `recordSample({app_name, window_title, sampled_at})`: if last row
    matches app+title → UPDATE `last_seen_at` + increment
    `sample_count`. Else INSERT.
  - `findCurrentSession(now): WindowSession | null` — most recent row.
  - `findRecentRows(since: number, limit?): WindowSession[]` — rows
    where `last_seen_at >= since`, ordered most-recent-first. Detector
    uses this to walk back through history.
  - `listTitlesInSession(app, from, to): {title, last_seen_at}[]` —
    distinct titles for that app in the window, for the ephemeral
    detail view.
  - `purgeOlderThan(cutoff)` — DELETE old rows (for future retention).
- [ ] write tests in
  `observers/__tests__/window-history-store.test.ts`:
  - empty DB: `recordSample` INSERTs
  - same app+title as last row UPDATEs (verify `sample_count` +1, no
    new row)
  - different title same app: new row
  - different app: new row
  - `findCurrentSession` returns latest row
  - `findRecentRows` ordering + filter by `since`
  - `listTitlesInSession` returns distinct titles ordered by
    last_seen_at
  - `purgeOlderThan` deletes right rows
- [ ] run `npm -w @r2/server test -- window-history-store.test` — must
  pass before task 3

### Task 3: `WindowSnapshotProvider` — osascript invocation + timeout

- [ ] create `packages/server/src/observers/window-snapshot.ts`
  exporting:
  - interface `WindowSnapshotProvider { getActive(): Promise<{app_name: string; window_title: string} | null> }`
  - `createOsascriptProvider({timeoutMs = 5000}): WindowSnapshotProvider`
    — uses `execFile('osascript', ['-e', SCRIPT], {timeout, killSignal:
    'SIGKILL'})` directly (we can reuse the `shell.run` helper from
    `tool-code-task` if it accepts a `timeout` option; otherwise inline
    `promisify(execFile)`). On timeout, `execFile` throws an Error with
    `.killed === true` → caller treats as null.
  - AppleScript constant `SCRIPT`:
    ```
    tell application "System Events"
      set frontApp to name of first process whose frontmost is true
      set frontTitle to ""
      try
        tell process frontApp
          set frontTitle to name of front window
        end try
      end try
      return frontApp & "|||" & frontTitle
    end tell
    ```
  - Parse stdout: trim → split on `|||` (exactly 2 parts) → trim each
    → if `app_name` empty return null; if `window_title` empty use
    empty string (no front window — desktop focused etc).
- [ ] handle these error cases by returning `null` (and letting caller
  log via `onError`):
  - process timed out (`error.killed === true`)
  - non-zero exit code (permission denied — AppleScript "User canceled"
    or "Not authorised to send Apple events to ...")
  - stdout missing `|||`
- [ ] write tests in
  `observers/__tests__/window-snapshot.test.ts` — **all mock
  `execFile` via vitest's module mock**:
  - successful stdout `"Chrome|||Inbox - Gmail\n"` → parsed object
  - stdout `"Finder|||\n"` (empty title) → object with empty title
  - stdout `"|||\n"` (empty app) → null
  - timeout error → null
  - non-zero exit → null
  - missing delimiter → null
- [ ] run `npm -w @r2/server test -- window-snapshot.test` — must pass
  before task 4

### Task 4: `window-logger.ts` poller

- [ ] create `packages/server/src/observers/window-logger.ts`:
  `startWindowLogger({store, provider, intervalMs, onError}) → () => void`
- [ ] self-scheduling `setTimeout` loop mirroring
  `multi-account-poller.ts:99-123`. Each tick: `await provider.getActive()`.
  If non-null call `store.recordSample({...snap, sampled_at: Date.now()})`.
  On thrown error from provider → `onError(err)`, do not call store.
- [ ] `stopped` flag halts further ticks; return fn sets stopped + clears
  pending timer.
- [ ] write tests in
  `observers/__tests__/window-logger.test.ts` with fake timers + mocked
  provider + real in-memory store:
  - one tick with `{Chrome, Gmail}` snapshot → store has one row
  - two ticks identical → store has one row, `sample_count=2`
  - tick with null from provider → no row inserted
  - tick where provider throws → `onError` called, no row, next tick
    still fires
  - calling stop fn before timer fires → no more ticks
- [ ] run `npm -w @r2/server test -- window-logger.test` — must pass
  before task 5

### Task 5: Detector + `ContextPingStore` (combined)

- [ ] create `packages/server/src/observers/context-switch-detector.ts`
  exporting:
  - `ContextPingRow`, `ContextPingStore`, `createContextPingStore({db})`
    with methods:
    - `recordPing({away_app, away_session_started_at, away_session_ended_at, pinged_at})`
    - `findRecentPing(away_app, since: number): ContextPingRow | null`
  - interface `SwitchEvent { away_app, away_session_started_at,
    away_session_ended_at, current_app }`
  - pure function `detectContextSwitch({now, store, pingStore,
    longSessionMin, switchGapMin, stableNewMin, dedupeWindowH}):
    SwitchEvent | null`
- [ ] algorithm (deterministic, no LLM):
  1. `current = store.findCurrentSession(now)`. If null OR
     `(now - current.started_at) < stableNewMin*60000` → null
     (current session not stable yet).
  2. Walk `store.findRecentRows(now - 8*3600000, 200)` backwards from
     `current.started_at`. Find longest contiguous run of rows whose
     `app_name !== current.app_name`, ending immediately before
     current.started_at.
  3. If that run's total duration (last.last_seen_at - first.started_at)
     < `longSessionMin*60000` → null.
  4. Gap = `current.started_at - run.last.last_seen_at`. If gap >
     `switchGapMin*60000` → null (cold return, treat as separate
     session — don't ping).
     (Different from sketch — the gap is the time the system saw nothing
     focused; large gap = sleep/lock; ignore.)
  5. `pingStore.findRecentPing(run.app, now - dedupeWindowH*3600000)`
     non-null → null (already pinged).
  6. Return `{away_app: run.app, away_session_started_at:
     run.first.started_at, away_session_ended_at:
     run.last.last_seen_at, current_app: current.app_name}`.
- [ ] write tests in
  `observers/__tests__/context-switch-detector.test.ts` using seeded
  in-memory store. Cases:
  - empty history → null
  - current under stableNewMin → null
  - was on iTerm 1h → switched to Chrome 10min → switched back to iTerm
    6min → SwitchEvent for `away_app=Chrome`
  - same but quick alt-tabs (gap small) → check switchGap logic
  - same but previous Chrome was only 20 min → null
  - large gap between Chrome and iTerm return (> switchGap) → null (sleep
    scenario; documented as known limitation, not a feature)
  - pingStore already has recent ping for Chrome → null
  - pingStore ping older than dedupeWindow → SwitchEvent
- [ ] write tests for `ContextPingStore` methods (record + findRecent
  with various time windows).
- [ ] run `npm -w @r2/server test -- context-switch-detector.test` —
  must pass before task 6

### Task 6: Handler + embed + interaction wiring

- [ ] create `packages/server/src/cognition/handlers/contextSwitch.ts`
  exporting `createContextSwitchHandler({store, pingStore,
  longSessionMin, switchGapMin, stableNewMin, dedupeWindowH})` →
  `Handler`
- [ ] handler:
  - `name: 'contextSwitch'`
  - `trigger(state)`: call detector, return non-null event → true.
  - `run()`: re-detect (defensive); skip if gone. Else compute
    duration = `(away_session_ended_at - away_session_started_at)/60000`;
    build `embed + components` via `buildWindowRestoreEmbed(event,
    durationMin)`; return `{publish: true, content: '🔁 You're back at
    ${current_app} after ~${duration}min on ${away_app}', embed,
    components, onPublished: () => pingStore.recordPing({...event,
    pinged_at: Date.now()})}`
- [ ] in `discord/embeds.ts`, add `buildWindowRestoreEmbed(event,
  durationMin)` returning plain shape:
  - embed:
    - title `🔁 Restore context?`
    - fields:
      - `Was on` → `event.away_app`
      - `For` → `~${durationMin}min`
      - `Now on` → `event.current_app`
  - **No titles in embed by default** (privacy). User must click
    button.
  - one primary button `Show titles` with customId
    `window:show:${away_app}:${away_session_started_at}:${away_session_ended_at}`
- [ ] in `interactions.ts`, add `window:show:` routing:
  - parse the three params from customId
  - call `store.listTitlesInSession(app, from, to)`, cap top 15
  - editReply ephemeral with formatted list (truncate each title to
    80 chars, joined with newlines)
- [ ] tests in
  `cognition/__tests__/handlers/contextSwitch.test.ts`:
  - `trigger` returns detector result truthiness
  - `run` skip path
  - `run` publish path: embed shape correct, button customId encodes
    params, content string correct
  - `onPublished` calls `pingStore.recordPing` with right shape
- [ ] tests in `discord/__tests__/embeds.window.test.ts`:
  - `buildWindowRestoreEmbed` field shapes
  - no `Top windows` / `Titles` field exists in default embed (privacy
    regression test — ensures titles never sneak into default embed)
- [ ] tests in `discord/__tests__/interactions.window.test.ts` for
  `window:show:` handler:
  - parses params correctly
  - calls `store.listTitlesInSession` with right args
  - editReply has ephemeral flag
  - titles truncated to 80 chars
  - empty list → friendly empty-state message
- [ ] run `npm -w @r2/server test -- contextSwitch.test
  embeds.window.test interactions.window.test` — must pass before
  task 7

### Task 7: Wire into `index.ts` + integration test

- [ ] in `index.ts`, parse env:
  - `WINDOW_LOGGER_ENABLED` (`=== 'true'`, default false)
  - `WINDOW_LOGGER_INTERVAL_MS` (`envInt(env, 30000, 5000, 300000)`)
  - `CONTEXT_SWITCH_LONG_SESSION_MIN` (`envInt(env, 30, 10, 240)`)
  - `CONTEXT_SWITCH_GAP_MIN` (`envInt(env, 5, 1, 60)`)
  - `CONTEXT_SWITCH_STABLE_NEW_MIN` (`envInt(env, 5, 1, 60)`)
  - `CONTEXT_SWITCH_DEDUPE_WINDOW_H` (`envInt(env, 8, 1, 168)`)
- [ ] gate registration on:
  - `WINDOW_LOGGER_ENABLED === 'true'`
  - `process.platform === 'darwin'`
  - `discordBot !== null`
- [ ] when all gates pass:
  - `windowStore = createWindowHistoryStore({db})`
  - `pingStore = createContextPingStore({db})`
  - `provider = createOsascriptProvider({timeoutMs: 5000})`
  - `stopWindowLogger = startWindowLogger({store: windowStore,
    provider, intervalMs: WINDOW_LOGGER_INTERVAL_MS,
    onError: (e) => console.error('[window-logger]', e.message)})`
  - `cognitionService.register(createContextSwitchHandler({store:
    windowStore, pingStore, longSessionMin, switchGapMin,
    stableNewMin, dedupeWindowH}))`
- [ ] hook `stopWindowLogger` into existing SIGTERM/SIGINT shutdown
  alongside other pollers.
- [ ] boot log: `[window-logger] started (interval=30s)` or
  `[window-logger] disabled (flag=${flag}, darwin=${isDarwin},
  discord=${D})`
- [ ] in `.env.example`, after `EMAIL_SEND_HOLD_SECONDS`:
  ```
  # ---- Digital Observer — macOS only (Pain #2 iter 1) ----
  # Polls foreground app+title every 30s via osascript, stores in
  # SQLite. macOS Automation permission required first run (System
  # Settings → Privacy & Security → Automation → R2 → System Events).
  # Disabled by default.
  WINDOW_LOGGER_ENABLED=false
  WINDOW_LOGGER_INTERVAL_MS=30000
  # Context-switch detection thresholds
  CONTEXT_SWITCH_LONG_SESSION_MIN=30   # "was working" threshold
  CONTEXT_SWITCH_GAP_MIN=5             # away that long = real switch
  CONTEXT_SWITCH_STABLE_NEW_MIN=5      # confirm return before pinging
  CONTEXT_SWITCH_DEDUPE_WINDOW_H=8     # don't re-ping for N hours
  ```
- [ ] integration test in
  `__tests__/window-logger.integration.test.ts`:
  - boot minimal deps with in-memory DB + mocked provider + spy on
    cognition bus
  - simulate snapshots: iTerm × 70 samples (35 min), Chrome × 12
    samples (6 min), iTerm × 11 samples (5.5 min), advance fake
    timers across all
  - assert exactly one `cognition_publish` was emitted with
    `handler='contextSwitch'`
  - assert the embed's `Was on` field is `Chrome`
  - assert `context_pings` has exactly one row after publish
- [ ] run `npm -w @r2/server test -- window-logger.integration` — must
  pass before task 8

### Task 8: Acceptance + docs

- [ ] full server test suite — all green
- [ ] TypeScript build — no errors
- [ ] verify backward compat: with `WINDOW_LOGGER_ENABLED=false`
  (default), zero new behavior; no logs, no DB writes, no DB rows
- [ ] update `AGENTS.md` Cognition layer section: one-line entry for
  `contextSwitch` handler (mirror `emailUrgent` style)
- [ ] update `README.md` with a new "Digital Observer (Pain #2)"
  subsection: what it does, macOS-only, Automation permission grant
  step, how to enable (`WINDOW_LOGGER_ENABLED=true`), known limitations
  (screen-lock false positive, etc.)

## Technical Details

### AppleScript output format

`"Chrome|||Inbox - dim@example.com - Gmail"` — split on `|||`, trim
each side. Empty title means desktop / no focused window — we record
the app with empty title.

The `|||` delimiter is unlikely to appear inside an app name or window
title; if it does (paranoid), `split('|||')` returns >2 parts and
parser rejects → null sample. Acceptable.

### Why timeout 5s

osascript normally returns in 50-200ms. 5s leaves headroom for slow
Apple Events queues. A permission prompt blocks the call indefinitely
on first run — timeout ensures we don't wedge the poller while the
user reads the prompt. Worst case: 1 missed 30s sample. Negligible.

### Why no titles in default embed

Discord clients display embeds even when read by others over your
shoulder. Window titles include sensitive context: `"Bank statement
Q4.pdf - Preview"`, `"DM with @CEO - Slack"`, `"Calendar - Therapy
appt - Chrome"`. Default = summary only (`Was on Chrome ~45 min`).
`Show titles` button → ephemeral message visible only to the user.
Cost: one extra click. Benefit: safe-by-default.

### `started_at` / `last_seen_at` coalescing

Naive: ~3K rows/day. Coalesced: typically <100 rows/day (most users
stay in the same window for minutes at a time). After 1 year:
~36K rows. SQLite handles this trivially. No retention cleanup needed
for iter 1; if growth surprises, add a nightly purge tick.

### Detector edge cases

| Scenario | Detector response | Notes |
|---|---|---|
| Was on Chrome 30 min, still on Chrome | null | current.app === run.app, no switch |
| Was on Chrome 30 min, switched to iTerm 1 min ago | null | stableNewMin not met |
| Was on Chrome 30 min, switched to iTerm 6 min ago | SwitchEvent | the intended trigger |
| Was on Chrome 20 min, switched to iTerm 6 min ago | null | longSessionMin not met |
| Was on Chrome 30 min, gap 2h (sleep), now iTerm 6 min | null | gap > switchGapMin — sleep scenario, documented as accepted edge case |
| 5 minute browse interrupted by 30s Slack peek | depends on switchGapMin | tunable |

### Privacy considerations summary

- Window titles never appear in the default Discord embed.
- Titles ARE stored in SQLite (we need them for the "Show titles"
  feature and for future iter 2 reconstruction).
- Titles ARE sent to Discord, but only via ephemeral messages (visible
  only to the user, auto-dismissed by Discord after 15 min).
- Localhost-only R2; the SQLite DB is on the user's own disk.

## Post-Completion

*No checkboxes — needs human + macOS.*

**One-time setup:**

1. `WINDOW_LOGGER_ENABLED=true` in `.env`. Restart supervisor.
2. On first 30s tick, macOS prompts: "R2 (or its node binary) wants to
   send events to System Events". Click **Allow**.
3. If no prompt appears (sometimes macOS skips for tsx-spawned
   processes), manually grant in System Settings → Privacy & Security
   → Automation → find R2 / node → enable System Events.
4. Verify: `sqlite3 data/r2.db "SELECT app_name, window_title,
   sample_count FROM window_history ORDER BY id DESC LIMIT 5"` — should
   show recent samples.

**Two-week observation:**

- Were context-switch pings useful, embarrassing, or wrong?
- Threshold tuning candidates (env vars to tweak):
  - `CONTEXT_SWITCH_LONG_SESSION_MIN` — too few pings → lower to 20.
    Too many → raise to 45.
  - `CONTEXT_SWITCH_STABLE_NEW_MIN` — pings firing while you're still
    deciding what to do next → raise to 10.
  - `CONTEXT_SWITCH_DEDUPE_WINDOW_H` — want repeated pings → lower.

**Observation queries:**

```sql
-- Total samples last 24h + coalescing ratio (sanity check)
SELECT COUNT(*) AS distinct_sessions,
       SUM(sample_count) AS total_polls,
       ROUND(1.0 * SUM(sample_count) / COUNT(*), 1) AS avg_coalesce
FROM window_history
WHERE last_seen_at > (strftime('%s','now') - 86400) * 1000;

-- Top apps by focus time today (sample_count * 30s)
SELECT app_name,
       ROUND(SUM(sample_count) * 30.0 / 60, 1) AS focus_min
FROM window_history
WHERE last_seen_at > (strftime('%s','now') - 86400) * 1000
GROUP BY app_name ORDER BY focus_min DESC LIMIT 10;

-- Pings last 7 days
SELECT away_app, COUNT(*) AS n_pings,
       MAX(datetime(pinged_at/1000, 'unixepoch', 'localtime')) AS last
FROM context_pings
WHERE pinged_at > (strftime('%s','now') - 7*86400) * 1000
GROUP BY away_app ORDER BY n_pings DESC;
```

**Iter 2 trigger:**

If ≥30% of pings get the `Show titles` button click → user finds the
detection useful → iter 2 builds real restore (Chrome tab list via
AppleScript, editor state, terminal cwd).

If <30% → tune thresholds (iter 1.5) or admit the heuristic needs
deeper signals (active input vs idle) before building restore is
worth it.

**iter 1.5 candidates** (if observation reveals patterns):

- App blacklist via `WINDOW_LOGGER_IGNORE_APPS=Music,Slack,Telegram`.
- Screen-lock detector to suppress sleep-period "long sessions".
- `/observations status` slash command for live tuning.
