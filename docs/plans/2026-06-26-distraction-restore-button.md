# Distraction pullback — restore button (Digital Observer iter-2)

## Overview

Add a one-tap **restore** button to the `distractionPullback` nudge. When R2 pings
«вернись к работе», the button focuses the work app the user was distracted from
and, if that surface was a browser tab, opens its URL via macOS `open`.

This is the first **real action** of the Digital Observer (until now: observe +
nudge only). It builds inside the live pullback flow — not the deprecated
`contextSwitch` restore-on-return path.

Design spec: `docs/superpowers/specs/2026-06-26-distraction-restore-button-design.md`.

## Context (from discovery)

- Files/components involved:
  - `packages/server/src/observers/window-history-store.ts` — add
    `findDominantWorkSurfaceBefore`.
  - `packages/server/src/observers/window-restore.ts` — **new** macOS `open`
    executor (sibling of `window-snapshot.ts`).
  - `packages/server/src/cognition/handlers/distractionPullback.ts` — compute
    restore target in `run()`, thread `restoreEnabled` flag.
  - `packages/server/src/channels/discord/embeds.ts` —
    `buildDistractionNudge` gains optional `restoreTarget` → restore button.
  - `packages/server/src/channels/discord/interactions.ts` — `restore` branch in
    `handleDistractFeedback`; new `InteractionDeps` fields.
  - `packages/server/src/channels/discord/bot.ts` — pass new deps through.
  - `packages/server/src/index.ts` — env flag wiring (`DISTRACTION_RESTORE_ENABLED`),
    pass executor + lookback into bot deps (~line 1056 distraction block, ~1212
    bot deps).
- Related patterns found:
  - osascript/`open` wrapper pattern: `observers/window-snapshot.ts`
    (`execFile`, injectable timeout/exec, silent-fail).
  - button customId shape `distract:<action>:<app>:<runStart>` parsed by
    `parseAppDwell` (`interactions.ts:529`); overflow-guard in `buildDistractionNudge`.
  - ephemeral ack reply mirrors `handleWindowShowTitles` / existing distract buttons.
  - env flag pattern `WINDOW_LOGGER_ENABLED` / `DISTRACTION_ENABLED` +
    `envInt(...)` (`index.ts:732, 1059, 1070`).
- Dependencies identified: `distractionPullback` handler already holds `store` +
  `workLookbackMin`; interactions already receives `windowHistoryStore`.

## Development Approach

- **Testing approach**: Regular (code, then tests in the same task) — matches the
  existing server test suite (vitest, `*.test.ts` colocated).
- Complete each task fully before the next; small focused changes.
- **CRITICAL: every task includes new/updated tests** (success + error/edge).
- **CRITICAL: all tests pass before starting the next task.**
- Keep backward compatibility: flag default off → nudge behaves exactly as today.
- Update this plan file if scope shifts.

## Testing Strategy

- **Unit tests**: required per task (vitest). No e2e harness in this package —
  Discord interaction logic tested via the existing `interactions`/`embeds` unit
  patterns with stubbed interaction objects.

## Progress Tracking

- Mark completed items `[x]` immediately.
- `➕` for newly discovered tasks, `⚠️` for blockers.

## What Goes Where

- Implementation Steps (checkboxes): code, tests, docs in this repo.
- Post-Completion (no checkboxes): manual macOS verification, env activation.

## Implementation Steps

### Task 1: Store — `findDominantWorkSurfaceBefore`
- [x] add `WorkSurface` type `{ app: string; url?: string }` and method
      `findDominantWorkSurfaceBefore(beforeTs, lookbackMs, excludeApp): WorkSurface | null`
      to `observers/window-history-store.ts`
- [x] SQL: rows with `started_at >= beforeTs - lookbackMs AND started_at < beforeTs
      AND app_name != excludeApp`, group by `(app_name, url)`, weight =
      `SUM(last_seen_at - started_at)`, `ORDER BY weight DESC LIMIT 1`; `NULL`
      url → result without `url`
- [x] write tests: picks max-duration surface; excludes distraction app; NULL url
      → no `url` field; empty/all-excluded → `null`
- [x] write tests: tie/boundary (`started_at == beforeTs` excluded, `== beforeTs -
      lookbackMs` included)
- [x] run tests — must pass before Task 2

### Task 2: Executor — `observers/window-restore.ts`
- [x] create module exporting
      `restoreWorkSurface(target: { app: string; url?: string }, opts?: { exec?, timeoutMs? }): Promise<{ ok: boolean; reason?: string }>`
- [x] url present → `execFile('open', ['-a', app, 'https://' + url])`; absent →
      `execFile('open', ['-a', app])`; args passed as array (no shell), injectable
      `exec` defaulting to real `execFile`
- [x] non-zero exit / timeout → resolve `{ ok: false, reason }` (never throw)
- [x] write tests: correct `open` args for url vs no-url; app name with
      spaces/special chars stays one argument; exec failure → `{ ok:false }`
- [x] run tests — must pass before Task 3

### Task 3: Nudge button — `buildDistractionNudge` + handler target compute
- [x] extend `DistractionNudgeEvent` with optional `restoreTarget?: { app: string; url?: string }`
      in `channels/discord/embeds.ts`
- [x] when `restoreTarget` present, append button
      `customId = distract:restore:<distractionApp>:<runStart>`, label
      `↩️ Вернуть: <workApp>` (truncate label), with the same overflow-guard as
      other buttons (drop if customId > limit)
- [x] in `distractionPullback.ts`: add `restoreEnabled?: boolean` to
      `DistractionHandlerDeps`; in `run()` after `shouldPing`, when `restoreEnabled`
      call `store.findDominantWorkSurfaceBefore(candidate.runStart,
      workLookbackMin*60_000, candidate.app)` and pass result as `restoreTarget`
- [x] write tests (embeds): button present with target / absent without;
      customId shape; overflow drops button but keeps text + other buttons
- [x] write tests (handler): target computed & threaded when `restoreEnabled`;
      omitted when flag off or surface `null` (stub `store`/`judge`)
- [x] run tests — must pass before Task 4

### Task 4: Interaction — `restore` branch + deps wiring
- [x] add to `InteractionDeps` (`interactions.ts`): `restoreExecutor?` (the
      `restoreWorkSurface` fn) and `distractionWorkLookbackMin?` (default-fallback
      like `distractionSnoozeMin`); `windowHistoryStore` already present
- [x] in `handleDistractFeedback`, `action === 'restore'`: `parseAppDwell(rawId)`
      → `{ app, runStart }`; re-derive target via
      `windowHistoryStore.findDominantWorkSurfaceBefore(runStart, lookbackMs, app)`
- [x] target found → `await restoreExecutor(target)`; `ok` → ephemeral
      `↩️ Открыл <app>` / `↩️ Открыл <app> · <url>`; `ok:false` → ephemeral
      `Не смог открыть <app>.`; target null → ephemeral
      `Не нашёл рабочий контекст для восстановления.`
- [x] guard: missing `windowHistoryStore`/`restoreExecutor` → ephemeral graceful
      message (mirror existing «not configured» replies)
- [x] thread new deps through `bot.ts` `BotDeps` → `routeInteraction`
- [x] write tests: restore branch calls executor with re-derived target; the
      three ephemeral outcomes (ok / exec-fail / no-target); unconfigured deps path
- [x] run tests — must pass before Task 5

### Task 5: Env flag wiring — `DISTRACTION_RESTORE_ENABLED`
- [x] `index.ts` distraction block (~1056): read
      `restoreEnabled = process.env.DISTRACTION_RESTORE_ENABLED === 'true'` and pass
      into `createDistractionHandler({ ..., restoreEnabled })`
- [x] pass `restoreExecutor: restoreWorkSurface` and
      `distractionWorkLookbackMin` (same `DISTRACTION_WORK_LOOKBACK_MIN` value, default 120)
      into bot deps (~1212)
- [x] log gate state alongside existing `[distraction]` lines
      (`restore=${restoreEnabled}`)
- [x] write/extend tests covering the wiring if a startup/integration test exists;
      otherwise assert via handler/interaction unit tests already added (no index.ts
      startup test exists → covered by handler/interaction unit tests from Tasks 3-4)
- [x] run tests — must pass before Task 6

### Task 6: Verify acceptance criteria
- [x] flag on + work surface → nudge carries `↩️ Вернуть: <app>` button (covered by embeds.distraction + distractionPullback unit tests; live macOS verify skipped — not automatable)
- [x] tap focuses work app (+ opens URL if browser), ephemeral ack, original
      nudge untouched (manual macOS/Discord test — skipped, not automatable; behaviour covered by interactions.distraction + window-restore unit tests)
- [x] no work surface → no button; nudge unchanged (covered by handler/embeds unit tests)
- [x] flag off → no button, no `restore` branch effect; pullback unchanged (covered by distractionPullback unit tests)
- [x] all error paths (no target, `open` fail, unconfigured) → ephemeral, no throw,
      other buttons intact (covered by interactions.distraction + window-restore unit tests)
- [x] run full server test suite; run linter — zero issues (1921 tests passed / 128 files; `tsc --noEmit` exit 0)
- [x] verify coverage on new modules (window-restore, window-history-store, embeds.distraction, interactions.distraction, distractionPullback all have restore-specific tests)

### Task 7: Documentation
- [x] document `DISTRACTION_RESTORE_ENABLED` in `AGENTS.md` env section + the
      restore-button behaviour in the Digital Observer / distraction section of
      `README.md` (also added flag to `.env.example` distraction block)

## Technical Details

- `WorkSurface = { app: string; url?: string }`.
- Restore action uses macOS `open` only — no AppleScript — so app/URL from the DB
  are passed as exec arguments (no shell/AppleScript injection). URL stored is
  host+path (query/fragment already stripped); reconstructed as `https://<host/path>`.
- customId reuses `distract:` domain so the existing `routeButton` → `handleDistractFeedback`
  routing applies; rawId is `<distractionApp>:<runStart>` (defensive re-derive of the
  work surface at click time, in the codebase's «re-detect at run» style).

## Post-Completion

**Manual verification (macOS, flag on):**
- Trigger a real pullback nudge, confirm the restore button appears, tap it, and
  verify the work app gets focused and the browser tab opens.
- Confirm non-browser work app (e.g. VS Code) focuses with no URL.

**External / activation:**
- Set `DISTRACTION_RESTORE_ENABLED=true` in the runtime `.env` on the macOS host
  (ships dark by default). Requires `DISTRACTION_ENABLED=true` + `WINDOW_LOGGER_ENABLED=true`
  already on to have data and nudges.
