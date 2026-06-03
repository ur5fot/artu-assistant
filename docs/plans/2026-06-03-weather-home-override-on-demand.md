# Weather: honor home override in on-demand `weather` tool

## Overview
The on-demand `weather` tool ignores the `WEATHER_LAT/LON` override when the LLM
passes the user's home city as `location`. Open-Meteo can't geocode the user's
village (Калиновка / Златополь, Kharkiv oblast), so the tool errors and R2
silently substitutes a different city (Харьков, ~60 km away). The morning brief
and proactive alerts already honor the override (they use the "no location"
path); only the on-demand tool drifts.

**Fix (approach A):** make the override authoritative for the home location in
the tool too. When the requested `location` matches the user's home city, use
the resolved home coordinates (override) instead of geocoding the name. Keep
geocoding for genuinely different cities, and never fall back to another city
silently — return an explicit error so R2 can't invent one.

**Benefit:** "скажи погоду" returns the real home forecast (Златополь) regardless
of whether the LLM sends `location` or not, with zero change for other-city
queries.

## Context (from discovery)
- Files/components involved:
  - `packages/tool-weather/src/index.ts` — tool handler. Branches: `rawLocation`
    present → `weatherClient.geocode(rawLocation)` + `fetchForecast`; empty →
    `resolveUserCoords()` (honors override). Description at lines ~56-60.
  - `packages/tool-weather/src/types.ts` — `ResolveUserCoordsFn = () => Promise<Coords|null>`
    already returns `{city, lat, lon}`, so the home city name is available to the tool.
  - `packages/tool-weather/src/__tests__/index.test.ts` — vitest, 7 tests. The
    test "geocodes the location and forecasts there" currently asserts
    `geocode` is called with `'Калиновка'` — this encodes the bug and must change.
  - `packages/server/src/index.ts` (~588-667) — wires `weatherClientForTool`
    (geocode any city worldwide) and `resolveUserCoordsForTool` (override-aware).
    No change expected unless the home-match helper needs the city surfaced
    differently (it does not — `resolveUserCoords()` returns it).
  - `packages/server/src/weather/coords.ts` — `resolveCoords`: override wins.
- Related patterns found: override precedence already implemented in
  `resolveCoords`; tool already has an explicit-error path when geocode returns null.
- Dependencies identified: none new. Pure logic + description + tests.

## Development Approach
- **Testing approach**: TDD (tests first) — small surface, pure functions.
- Complete each task fully before moving to the next.
- **Every task includes new/updated tests.** All tests pass before next task.
- Keep backward compatibility for other-city queries and the no-location path.
- Run `pnpm --filter @r2/tool-weather test` and `... typecheck` after changes;
  keep server suite (1544) green.

## Testing Strategy
- **Unit tests** (vitest) in `packages/tool-weather/src/__tests__/index.test.ts`:
  - home-city `location` (e.g. `'Калиновка'`, mixed case, with/without oblast
    suffix) → uses resolved home coords, `geocode` NOT called.
  - different known city (`'Киев'`) → `geocode` called, its coords used,
    home resolver NOT used for coords.
  - unknown city → explicit `{success:false, error}` (no fallback, no other city).
  - no-location path unchanged (still resolves user coords).
  - home matching is null-safe when `resolveUserCoords` is null → falls back to
    geocoding the name (legacy behavior).
- No e2e tests in this package.

## Progress Tracking
- Mark completed items `[x]` immediately. ➕ for new tasks, ⚠️ for blockers.
- Keep this file in sync with actual work.

## What Goes Where
- **Implementation Steps**: tool logic, helper, description, tests.
- **Post-Completion**: manual Discord check, deploy via dev→master, restart.

## Implementation Steps

### Task 1: Add a home-city matcher helper
- [x] in `packages/tool-weather/src/index.ts`, add a pure helper
      `isSamePlace(input: string, homeCity: string): boolean`
- [x] normalize both sides: trim, lowercase, take the segment before the first
      comma (so `'Калиновка'` matches `'Калиновка, Харьковская область, Украина'`)
- [x] return false on empty/invalid input (no accidental home-match on `''`)
- [x] keep it conservative: exact normalized equality of the first segment only
      (do NOT substring-match, so `'Киев'` never matches home)
- [x] write tests for `isSamePlace`: exact, case-insensitive, oblast-suffixed,
      whitespace, non-match, empty → all covered
- [x] run tool-weather tests — must pass before next task

### Task 2: Short-circuit home location to override coords in the handler
- [ ] in the `rawLocation` branch, before geocoding: if `resolveUserCoords` is
      wired, call it and, when the returned `coords.city` `isSamePlace` as
      `rawLocation`, use those coords (override) via `forecastResult(..., coords.city, forecast)`
- [ ] otherwise geocode `rawLocation` as today; on null geocode keep the existing
      explicit error (`Не нашёл город «…»`) — confirm there is NO silent fallback
- [ ] ensure the no-location path is unchanged
- [ ] update the existing test "geocodes the location and forecasts there" to use
      a non-home city (e.g. `'Киев'`) so it still asserts the geocode path
- [ ] add test: home-city `location` → home/override coords, `geocode` NOT called
- [ ] add test: unknown city → explicit error, no other-city substitution
- [ ] add test: `resolveUserCoords: null` + home-looking `location` → geocode path (legacy)
- [ ] run tool-weather tests — must pass before next task

### Task 3: Tighten the tool description
- [ ] in the tool `description` (and `command.params[location].description`),
      state: omit `location` for the user's own/home weather; pass `location`
      ONLY for a DIFFERENT city than home
- [ ] verify no behavioral code depends on the old wording
- [ ] no new test needed (string only); run tool-weather tests to confirm green

### Task 4: Verify acceptance criteria
- [ ] home query (`'Калиновка'` / no-arg) → override coords (Златополь 49.37646, 36.21848)
- [ ] other-city query still geocodes and forecasts correctly
- [ ] unknown city → explicit error, never another city
- [ ] `pnpm --filter @r2/tool-weather test` green (was 7, now more)
- [ ] `pnpm --filter @r2/tool-weather typecheck` clean
- [ ] full server test suite (1544) still green; root typecheck clean

### Task 5: Docs
- [ ] update README / AGENTS weather section to note that home-city `location`
      resolves to the override coordinates (not geocoded)

*Note: ralphex automatically moves completed plans to `docs/plans/completed/`*

## Technical Details
- `isSamePlace` compares only the first comma-segment, normalized
  (`trim().toLowerCase().split(',')[0].trim()`), exact-equality — conservative by
  design to avoid matching unrelated cities.
- The home short-circuit reuses `resolveUserCoords()` which already returns the
  override coords plus the stored city name; no new wiring in `server/index.ts`.
- Other-city and no-location behavior is preserved; the only changed assertion is
  the former `geocode('Калиновка')` test, which encoded the bug.

## Post-Completion
*Items requiring manual intervention or external systems — informational only*

**Deploy (per project flow):**
- sync `dev` ← `master`, run ralphex on `dev`, then `dev` → `master` + `git push origin master`; supervisor polls `origin/master` and auto-restarts the worker.

**Manual verification:**
- In Discord, ask «скажи погоду» and confirm the numbers match Златополь
  (49.37646, 36.21848), not Харьков.
- Ask «погода в Киеве» and confirm a real Kyiv forecast (other-city path intact).
