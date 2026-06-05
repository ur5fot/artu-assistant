# Activity analysis: give the agent access to Digital Observer data

## Overview
Asked "проанализируй мою работу за компом", R2 replied "У меня нет доступа к твоему компьютеру …
физически недоступно". That's a **false capability denial**: the Digital Observer (`window-logger`,
`WINDOW_LOGGER_ENABLED=true`) already records `window_history` (apps, window titles, and now tab URLs),
plus `distraction_evals` and `context_pings`. The data exists — but the **chat agent has no tool** to
read it (its tools are file/web/email/reminder/weather/memory only), so it honestly said "can't."

Fix: add an `activity_summary` agent tool that returns a structured summary of computer activity over
a period, and a prompt rule so "проанализируй работу / чем я занимался / экранное время" routes to it
(and the agent stops denying it has the data). The agent composes the human-readable analysis from the
tool's structured output.

## Context (from discovery)
- Agent tools live in `packages/tool-*/src/index.ts` as `createTool(deps): ToolDefinition[]`,
  registered in `packages/server/src/index.ts` (mirror `tool-emails` / `tool-weather`). No activity tool exists.
- `packages/server/src/observers/window-history-store.ts` — `WindowHistoryStore` with `findRecentRows(since,
  limit)`, `listTitlesInSession`, `recentUrlsSince(sinceMs, limit)`. Rows: `app_name, window_title,
  started_at, last_seen_at, sample_count, url`. Session duration ≈ `last_seen_at - started_at`.
- `packages/server/src/observers/distraction-eval-store.ts` — `DistractionEvalStore` (distraction events).
- `context_pings` table — away-session pings (context switches).
- Poll interval `WINDOW_LOGGER_INTERVAL_MS` (30s) — time estimates are sampling-based (approximate).
- Prompt: `getSystemPrompt()` in `packages/server/src/ai/prompts.ts` (the `EMAIL_RULES` block is the
  pattern for a routing rule; add an `ACTIVITY_RULES` block, shared into both prompts).
- PII: tool results may carry window titles / sites. The owner explicitly wants their work analyzed
  and owns the data (local DB); keep the summary aggregate (per-app time, top N sites/titles) rather
  than dumping raw history, and let the existing PII proxy scrub as it does for other tools.

## Development Approach
- **Testing approach**: TDD — failing store-summary + tool tests first.
- Additive: new tool package + one store method + one prompt block + registration. No schema change.
- Read-only tool (no mutation). Aggregate output; approximate time (sampling) stated honestly.
- Out of scope: charts/exports; cross-day trends/history beyond the requested window; changing the
  observer itself.

## Testing Strategy
- Store `summarizeActivity(sinceMs, now)`: per-app totals (ms, sessions) from rows in window; total
  active span; context-switch count; respects the window bound; empty window → empty summary.
- Tool `activity_summary`: maps the summary to JSON (apps sorted by time + share%, top sites, top
  titles, switches, distractions, span); clamps `since_hours`; disabled/no-data → honest empty result.
- Prompt: both prompts contain the activity-routing rule (mentions `activity_summary`, forbids "нет
  доступа"/"физически недоступно").

## Progress Tracking
- Mark `[x]` immediately. ➕ new tasks, ⚠️ blockers.

## Implementation Steps

### Task 1: Activity summary in the store
- [ ] `window-history-store.ts`: add `summarizeActivity(sinceMs: number, now: number)` →
      `{ from, to, activeMs, apps: {app, ms, sessions}[], switches, topTitles: {app,title,ms}[] }`
      aggregated from rows where `last_seen_at >= sinceMs` (per-app Σ(last_seen_at-started_at), session
      count, app-switch count from ordering). Reuse `recentUrlsSince` for top sites in the tool.
- [ ] add `DistractionEvalStore` read for recent distraction events in window (count + apps).
- [ ] write store tests (per-app totals, switches, window bound, empty)
- [ ] run `npm test` — must pass before next task

### Task 2: `tool-activity` package (`activity_summary`)
- [ ] new `packages/tool-activity/src/index.ts`: `createTool({ windowHistoryStore, distractionEvalStore })`
      → `activity_summary` tool. Param `since_hours` (default 24, clamp 1..720). Returns JSON:
      `{ since_hours, active_minutes, apps:[{app, minutes, share_pct, sessions}], top_sites:[{host,
      minutes|visits}], top_titles:[{app, title, minutes}], context_switches, distractions:{count, apps} }`.
- [ ] description (RU): «Сводка активности за компьютером (приложения, сайты, заголовки окон, время,
      переключения, отвлечения) за период. Используй для "проанализируй работу за компом", "чем я
      занимался", "экранное время".» permissionLevel 'auto', provider 'all'.
- [ ] register in `index.ts` (conditional on window logger / observer enabled), mirroring email tools.
- [ ] write tool tests (shape, clamp, empty/disabled)
- [ ] run `npm test` — must pass before next task

### Task 3: Prompt routing (stop the false "нет доступа")
- [ ] add a shared `ACTIVITY_RULES` const in `prompts.ts`, injected into `getSystemPrompt()` and
      `getLocalSystemPrompt()`: "проанализируй работу / чем занимался / экранное время / сколько сидел
      в X → виклич activity_summary. У тебя Є дані Digital Observer (активність/застосунки/час) —
      НЕ кажи 'немає доступу'/'фізично недоступно'. Якщо даних за період нема — скажи 'спостереження
      порожнє за цей період', а не 'не маю доступу'."
- [ ] prompt test: both prompts mention `activity_summary` + the no-denial rule
- [ ] run `npm test` — must pass before next task

### Task 4: Verify acceptance & build
- [ ] verify: "проанализируй работу за компом" → agent calls `activity_summary` and produces a
      breakdown (apps/time/switches/distractions), not a denial.
- [ ] run full suite (`npm test`) — all green
- [ ] run `npm run build` (tsc) in `packages/server` (+ build new package) — no type errors
- [ ] confirm additive + read-only; no schema/observer change

## Technical Details
- Time per app = Σ(last_seen_at − started_at) over the app's rows in window (sampling-approx; state so
  in the tool description/output, e.g. `approx: true`). Share% = app ms / active ms.
- Context switches = count of adjacent app changes in time-ordered rows.
- Tool is read-only; the agent turns the JSON into the narrative analysis.

## Post-Completion
*Informational only*

**Deploy** (per flow): ralphex on `dev`; `dev`→`master` + `git push origin master`; **stay on
`master`**; supervisor auto-restarts.

**Manual verification (Discord):** "проанализируй мою работу за компом" → expect a real breakdown
(top apps by time, sites, context switches, distractions for the period) instead of "нет доступа".
Note: data is sampling-based (30s) and only as deep as the observer's history.
