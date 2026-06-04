# Cognition: re-deliver undelivered proactive pushes when Discord reconnects

## Overview
Proactive cognition pushes (morningBrief, emailDigest, distractionPullback, …) are sent to the
owner via Discord DM. If the DM send **fails** (e.g. a transient network/DNS outage — Discord
unreachable), the run is left with `published_at = NULL` and there is **no retry**. Handlers are
once-per-day / cooldown-gated, so the push is **lost forever** and the owner never sees it.

Real incident (2026-06-04 08:39): morningBrief generated a full brief (`outcome='publish'`) but the
DM failed — logs show `getaddrinfo ENOTFOUND discord.com` (Discord + Gmail both down for ~3 min).
Network recovered ~08:47, discord.js auto-reconnected, but the brief was never re-sent. `published_at`
stayed NULL; owner got nothing.

Fix: persist the publish payload, and when the Discord client (re)connects, **flush** any
recently-undelivered publish runs — re-send them and mark published. Idempotent (only
`published_at IS NULL`), bounded by a freshness window (don't deliver a stale brief).

## Context (from discovery)
- `packages/server/src/cognition/queue.ts:79-97` — records the run via `store.recordHandlerRun(result)`
  (returns `runId`), stashes `result.onPublished` in an in-memory `pendingPublishedCallbacks` map,
  and emits a transient `cognition_publish` event `{runId, content, embed, components}`.
- `packages/server/src/cognition/store.ts:68-94` — `recordHandlerRun` persists
  `(handler_name, fired_at, duration_ms, outcome, content, reason)` — **embed/components are NOT
  persisted**. `markPublished(runId, at)` sets `published_at`. The `result` object passed in already
  contains `embed`/`components` (the event reads them), so they ARE available at record time.
- `packages/server/src/channels/discord/bot.ts:1139-1201` — the `cognition_publish` listener:
  `client.users.fetch(id) → createDM() → dm.send(...)` then `markPublished(runId, now)` on success;
  on throw it only `console.error`s → `published_at` stays NULL (no retry). THIS is where pushes are lost.
- `bot.ts:276` `client.on('clientReady')` (startup pre-cache of DM channels). `bot.ts:302`
  `client.on('shardDisconnect', …)` exists; discord.js emits `shardReady`/`shardResume` on reconnect.
- `cognitionService.markPublished` → `store.markPublished` + `queue.firePublished(runId)` (fires the
  in-memory onPublished callback if still present; harmless no-op if gone after a restart).

## Development Approach
- **Testing approach**: TDD — failing store + bot/flush tests first, then implement.
- Backward-compatible: additive column (NULL default), shared send helper preserves the existing
  live-publish behavior exactly.
- Idempotency is the safety net: every delivery path gates on `published_at IS NULL` and calls
  `markPublished` on success, so no double-send.
- Out of scope (YAGNI): a generic timed retry queue (reconnect + freshness window covers the real
  failure mode); changing handler scheduling; persisting onPublished callbacks across restarts (the
  callbacks that matter — e.g. emailDigest marking mail delivered — are idempotent, and survive the
  common in-process reconnect).

## Testing Strategy
- Store: `findUndeliveredPublishes(sinceMs)` returns only `outcome='publish' AND published_at IS NULL
  AND fired_at >= sinceMs`; payload round-trips (content+embed+components).
- Bot/flush (mock client + store):
  - undelivered recent run on reconnect → re-sent via the shared helper + `markPublished` called.
  - stale run (older than window) → NOT delivered.
  - already-published run → skipped.
  - re-send throws → stays `published_at NULL` (eligible next reconnect), no crash.
  - live `cognition_publish` path still works (shared helper) — regression guard.

## Progress Tracking
- Mark `[x]` immediately. ➕ new tasks, ⚠️ blockers.

## Implementation Steps

### Task 1: Persist publish payload + undelivered query (store + migration)
- [x] migration in `packages/server/src/db.ts`: `ALTER TABLE cognition_handler_runs ADD COLUMN
      publish_payload TEXT` (guarded/idempotent like other migrations; NULL default = backward-safe).
- [x] in `store.recordHandlerRun` (`cognition/store.ts`): when `outcome='publish'`, also persist
      `publish_payload = JSON.stringify({ content, embed, components })` from `result`.
- [x] add `findUndeliveredPublishes(sinceMs: number): { runId: number; payload: PublishPayload }[]`:
      `WHERE outcome='publish' AND published_at IS NULL AND fired_at >= ?`, parse `publish_payload`
      (fallback to `{content}` when the column is NULL for pre-migration rows). Add to the store interface.
- [x] write store tests (round-trip payload; query filters by published_at/outcome/sinceMs)
- [x] run `npm test` — must pass before next task

### Task 2: Flush undelivered on Discord (re)connect (bot)
- [ ] extract the DM-send body of the `cognition_publish` listener (`bot.ts:1152-1192`) into a reusable
      `deliverCognitionPush(event)` helper (fetch→createDM→send embed/components/text; on success
      `markPublished(runId, now)`; on failure log + leave unpublished). Use it for the live listener.
- [ ] add `flushUndeliveredPushes()`: `runs = store.findUndeliveredPublishes(Date.now() - REDELIVER_MAX_AGE_MS)`;
      for each, build the event from the persisted payload and call `deliverCognitionPush`. Guard against
      concurrent runs (a simple in-flight boolean) so overlapping shard events don't double-flush.
- [ ] hook `flushUndeliveredPushes` on `client.on('shardReady')` and `client.on('shardResume')`, and
      once after the `clientReady` pre-cache. (Covers transient reconnect AND restart-after-outage.)
- [ ] add `REDELIVER_MAX_AGE_MS` env (default 6h) wired where other email/cognition envs are read.
- [ ] write bot/flush tests for the 5 cases in Testing Strategy (mock client + store + service)
- [ ] run `npm test` — must pass before next task

### Task 3: Verify acceptance & build
- [ ] verify: a publish run with `published_at NULL` within the window is delivered + marked on a
      simulated reconnect; stale/already-published runs are not; live publish path unchanged.
- [ ] run full suite (`npm test`) — all green
- [ ] run `npm run build` (tsc) in `packages/server` — no type errors
- [ ] confirm backward-safe (NULL column for old rows handled; no double-send)

## Technical Details
- Idempotency: only `published_at IS NULL` rows are flushed; `markPublished` (sets `published_at`) is
  the single gate shared by live + retry paths → at-most-once delivery.
- Freshness: `REDELIVER_MAX_AGE_MS` (default 6h) prevents delivering a stale brief; older undelivered
  runs simply fall out of the query (no cleanup needed).
- onPublished: re-delivery calls `markPublished` → `firePublished` fires the in-memory callback if
  present (common in-process reconnect); absent after a restart it's a harmless no-op, and the
  callbacks that matter (emailDigest → markDelivered) are idempotent.

## Post-Completion
*Manual / external — no checkboxes*

**Deploy** (per flow): ralphex on `dev`; `dev`→`master` + `git push origin master`; **stay on
`master`**; supervisor auto-restarts.

**Manual verification:** simulate offline — generate a proactive push while Discord can't be reached
(or inspect a real undelivered run), then restore connectivity / reconnect → the push arrives in DM
and `published_at` gets set. (The 2026-06-04 08:39 brief is the reference case.)
