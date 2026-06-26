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
- [ ] add `WorkSurface` type `{ app: string; url?: string }` and method
      `findDominantWorkSurfaceBefore(beforeTs, lookbackMs, excludeApp): WorkSurface | null`
      to `observers/window-history-store.ts`
- [ ] SQL: rows with `started_at >= beforeTs - lookbackMs AND started_at < beforeTs
      AND app_name != excludeApp`, group by `(app_name, url)`, weight =
      `SUM(last_seen_at - started_at)`, `ORDER BY weight DESC LIMIT 1`; `NULL`
      url → result without `url`
- [ ] write tests: picks max-duration surface; excludes distraction app; NULL url
      → no `url` field; empty/all-excluded → `null`
- [ ] write tests: tie/boundary (`started_at == beforeTs` excluded, `== beforeTs -
      lookbackMs` included)
- [ ] run tests — must pass before Task 2

### Task 2: Executor — `observers/window-restore.ts`
- [ ] create module exporting
      `restoreWorkSurface(target: { app: string; url?: string }, opts?: { exec?, timeoutMs? }): Promise<{ ok: boolean; reason?: string }>`
- [ ] url present → `execFile('open', ['-a', app, 'https://' + url])`; absent →
      `execFile('open', ['-a', app])`; args passed as array (no shell), injectable
      `exec` defaulting to real `execFile`
- [ ] non-zero exit / timeout → resolve `{ ok: false, reason }` (never throw)
- [ ] write tests: correct `open` args for url vs no-url; app name with
      spaces/special chars stays one argument; exec failure → `{ ok:false }`
- [ ] run tests — must pass before Task 3

### Task 3: Nudge button — `buildDistractionNudge` + handler target compute
- [ ] extend `DistractionNudgeEvent` with optional `restoreTarget?: { app: string; url?: string }`
      in `channels/discord/embeds.ts`
- [ ] when `restoreTarget` present, append button
      `customId = distract:restore:<distractionApp>:<runStart>`, label
      `↩️ Вернуть: <workApp>` (truncate label), with the same overflow-guard as
      other buttons (drop if customId > limit)
- [ ] in `distractionPullback.ts`: add `restoreEnabled?: boolean` to
      `DistractionHandlerDeps`; in `run()` after `shouldPing`, when `restoreEnabled`
      call `store.findDominantWorkSurfaceBefore(candidate.runStart,
      workLookbackMin*60_000, candidate.app)` and pass result as `restoreTarget`
- [ ] write tests (embeds): button present with target / absent without;
      customId shape; overflow drops button but keeps text + other buttons
- [ ] write tests (handler): target computed & threaded when `restoreEnabled`;
      omitted when flag off or surface `null` (stub `store`/`judge`)
- [ ] run tests — must pass before Task 4

### Task 4: Interaction — `restore` branch + deps wiring
- [ ] add to `InteractionDeps` (`interactions.ts`): `restoreExecutor?` (the
      `restoreWorkSurface` fn) and `distractionWorkLookbackMin?` (default-fallback
      like `distractionSnoozeMin`); `windowHistoryStore` already present
- [ ] in `handleDistractFeedback`, `action === 'restore'`: `parseAppDwell(rawId)`
      → `{ app, runStart }`; re-derive target via
      `windowHistoryStore.findDominantWorkSurfaceBefore(runStart, lookbackMs, app)`
- [ ] target found → `await restoreExecutor(target)`; `ok` → ephemeral
      `↩️ Открыл <app>` / `↩️ Открыл <app> · <url>`; `ok:false` → ephemeral
      `Не смог открыть <app>.`; target null → ephemeral
      `Не нашёл рабочий контекст для восстановления.`
- [ ] guard: missing `windowHistoryStore`/`restoreExecutor` → ephemeral graceful
      message (mirror existing «not configured» replies)
- [ ] thread new deps through `bot.ts` `BotDeps` → `routeInteraction`
- [ ] write tests: restore branch calls executor with re-derived target; the
      three ephemeral outcomes (ok / exec-fail / no-target); unconfigured deps path
- [ ] run tests — must pass before Task 5

### Task 5: Env flag wiring — `DISTRACTION_RESTORE_ENABLED`
- [ ] `index.ts` distraction block (~1056): read
      `restoreEnabled = process.env.DISTRACTION_RESTORE_ENABLED === 'true'` and pass
      into `createDistractionHandler({ ..., restoreEnabled })`
- [ ] pass `restoreExecutor: restoreWorkSurface` and
      `distractionWorkLookbackMin` (same `DISTRACTION_WORK_LOOKBACK_MIN` value, default 120)
      into bot deps (~1212)
- [ ] log gate state alongside existing `[distraction]` lines
      (`restore=${restoreEnabled}`)
- [ ] write/extend tests covering the wiring if a startup/integration test exists;
      otherwise assert via handler/interaction unit tests already added
- [ ] run tests — must pass before Task 6

### Task 6: Verify acceptance criteria
- [ ] flag on + work surface → nudge carries `↩️ Вернуть: <app>` button
- [ ] tap focuses work app (+ opens URL if browser), ephemeral ack, original
      nudge untouched
- [ ] no work surface → no button; nudge unchanged
- [ ] flag off → no button, no `restore` branch effect; pullback unchanged
- [ ] all error paths (no target, `open` fail, unconfigured) → ephemeral, no throw,
      other buttons intact
- [ ] run full server test suite; run linter — zero issues
- [ ] verify coverage on new modules

### Task 7: Documentation
- [ ] document `DISTRACTION_RESTORE_ENABLED` in `AGENTS.md` env section + the
      restore-button behaviour in the Digital Observer / distraction section of
      `README.md`

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
