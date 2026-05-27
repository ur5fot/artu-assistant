# Email Urgent Triage — Pain #1, Iteration 1

## Overview

First slice of "Pain #1 — Email triage" from the strategic roadmap
([2026-05-27-toward-ideal-r2.md](../superpowers/plans/2026-05-27-toward-ideal-r2.md)).

**Goal:** when an incoming email scores `importance=5` (the existing scorer's
top tier), R2 pings the user in Discord **immediately** instead of waiting
for the digest batch, suppressed during quiet hours.

**Why this slice first:**
- Smallest end-to-end shippable piece. No SMTP, no draft generation, no
  hold zone yet (those are iterations 2-3).
- Reuses the existing scorer pipeline as-is — zero LLM prompt changes,
  zero risk of regression on the digest path.
- Two weeks of urgent-ping traffic gives real data on ping frequency and
  false positive rate before adding more machinery.

**Why "importance=5" alone, not "importance=5 AND action_needed":**
The first draft of this plan added an `action_needed` boolean to the
scorer output. On review that's premature — at scale 1-5, a "5" already
means "very important, must act." If after two weeks the urgent ping rate
is too noisy, we add `action_needed` then. If it's too quiet, we expand
the scale or lower the threshold. Decide from data, not in advance.

## Context (from discovery)

Files involved:
- `packages/server/src/emails/scorer.ts` — **no change**. Already returns
  `{uid, importance: 1-5}`.
- `packages/server/src/emails/store.ts` — add two new methods
  (`findUnpingedUrgent`, `markUrgentPinged`).
- `packages/server/src/db.ts` — add one column to `email_pending` plus a
  partial index, idempotent via `PRAGMA table_info` check.
- `packages/server/src/cognition/handlers/emailUrgent.ts` — new file,
  pattern copied from `emailDigest.ts`.
- `packages/server/src/cognition/handlers/emailDigest.helpers.ts` — reuse
  `inQuietHours()` directly.
- `packages/server/src/index.ts` — register handler alongside `emailDigest`
  (~line 642), gated on `EMAIL_URGENT_ENABLED` env flag AND `discordEnabled`.
- `packages/server/src/channels/discord/bot.ts:1020` — already handles
  `cognition_publish`, no change.

Patterns to copy:
- LLM scorer mock from `packages/server/src/emails/__tests__/scorer.test.ts`
  (not used here, but for reference).
- Cognition handler test pattern from
  `packages/server/src/cognition/__tests__/handlers/emailDigest.test.ts`.
- In-memory DB (`initDb(':memory:')`) per test.

## Development Approach

- **Testing approach**: **TDD** (tests first, then implementation).
- Complete each task fully before moving to the next.
- Tests are a required deliverable of every task, not optional.
- All tests must pass before starting the next task.
- Update this plan if implementation deviates from scope.
- Run scoped: `npm -w @r2/server test -- <pattern>`.

## Testing Strategy

- vitest only (project convention).
- `initDb(':memory:')` per test for DB-touching code.
- Mocked `EmailStore` for handler unit tests; real in-memory store for
  integration tests.
- No real IMAP, no real LLM in any test.
- Mock clock (`vi.useFakeTimers()`) for quiet-hours and tick scheduling.

## Progress Tracking

- Mark completed items with `[x]` immediately when done.
- Add newly discovered tasks with ➕ prefix.
- Document blockers with ⚠️ prefix.
- Update this plan if scope changes mid-implementation.

## What Goes Where

- **Implementation Steps** (`[ ]` checkboxes): code, tests, migrations,
  wiring, observability queries in comments — anything in-repo.
- **Post-Completion** (no checkboxes): two-week observation, manual
  tuning calls — needs a human living with the feature.

## Implementation Steps

### Task 1: DB migration — add `urgent_pinged_at` to `email_pending`

- [x] in `packages/server/src/db.ts`, after the existing `CREATE TABLE IF
  NOT EXISTS email_pending`, query `PRAGMA table_info(email_pending)` and
  add `urgent_pinged_at INTEGER` only if absent (avoids try/catch on
  duplicate column)
- [x] add `CREATE INDEX IF NOT EXISTS idx_email_pending_urgent_unpinged
  ON email_pending(importance, urgent_pinged_at) WHERE urgent_pinged_at IS NULL`
- [x] write tests in `packages/server/src/__tests__/db.test.ts`:
  - column `urgent_pinged_at` exists after `initDb` (via `PRAGMA table_info`)
  - running `initDb` twice on same file is idempotent (no error)
  - index `idx_email_pending_urgent_unpinged` exists (via `sqlite_master`)
- [x] run `npm -w @r2/server test -- db.test` — must pass before task 2

### Task 2: Store methods — `findUnpingedUrgent`, `markUrgentPinged`

- [ ] in `packages/server/src/emails/store.ts`, extend the `EmailStore`
  interface with two new methods:
  - `findUnpingedUrgent(): EmailPendingRow | null` — returns the oldest
    row with `importance=5 AND urgent_pinged_at IS NULL`, ordered by
    `received_at ASC`
  - `markUrgentPinged(id: number, now: number): void` — sets
    `urgent_pinged_at = ?` for the row
- [ ] implement both in the `createEmailStore` factory
- [ ] write tests in `packages/server/src/emails/__tests__/store.test.ts`:
  - `findUnpingedUrgent` returns `null` when no rows match
  - returns the oldest matching row when multiple exist (verify ordering)
  - skips rows with `importance < 5`
  - skips rows already pinged (`urgent_pinged_at` not null)
  - `markUrgentPinged` sets the timestamp correctly
  - `markUrgentPinged` on missing id is a silent no-op (or throws clearly
    — pick one, document in code)
- [ ] run `npm -w @r2/server test -- store.test` — must pass before task 3

### Task 3: New cognition handler — `emailUrgent`

- [ ] create `packages/server/src/cognition/handlers/emailUrgent.ts`
  exporting `createEmailUrgentHandler({ store, tz, quietStart })` → `Handler`
- [ ] `name: 'emailUrgent'`
- [ ] `trigger(state, ctx)`:
  - return `false` if `inQuietHours(new Date(ctx.firedAt), tz, quietStart)`
  - return `store.findUnpingedUrgent() !== null`
- [ ] `run(ctx)`:
  - fetch row via `store.findUnpingedUrgent()` — if null, return
    `{ skip: true, reason: 'no unpinged urgent row' }` (handles tiny race
    where row got marked between trigger and run — defensive but cheap)
  - format `content` as a single line: `"🚨 ${from}\n${subject}\n${snippet}"`
    (truncate snippet to 200 chars)
  - return `{ publish: true, content, onPublished: () => store.markUrgentPinged(row.id, Date.now()) }`
- [ ] add observability comment block at top of file with three SQL
  queries to be run manually during observation period (count of pinged
  rows, false-positive candidate emails ranked by importance + open
  timestamp gap, urgent-rate per day)
- [ ] write tests in
  `packages/server/src/cognition/__tests__/handlers/emailUrgent.test.ts`:
  - `trigger` returns false when no unpinged urgent rows exist
  - `trigger` returns true when one exists outside quiet hours
  - `trigger` returns false when in quiet hours (mock clock at 23:00,
    quietStart=22) even if a row exists
  - `run` returns `skip` when no urgent rows
  - `run` formats content with from/subject/snippet correctly
  - `run` truncates snippet > 200 chars with ellipsis
  - `run.onPublished` calls `markUrgentPinged` with the row id
  - second `run` after `onPublished` returns `skip` (row is now pinged)
- [ ] run `npm -w @r2/server test -- emailUrgent.test` — must pass before task 4

### Task 4: Wire handler into `index.ts` with feature flag

- [ ] in `packages/server/src/index.ts`, near the existing `emailDigest`
  registration (~line 642), register `emailUrgent` only when:
  - `emailEnabled` is true
  - `process.env.EMAIL_URGENT_ENABLED === 'true'`
  - `discordEnabled` is true (the boolean already derived from
    `DISCORD_BOT_TOKEN` presence — required because without Discord,
    `onPublished` never fires and the handler would retry the same row
    forever)
- [ ] log `[emails] urgent handler registered` on register, log
  `[emails] urgent handler disabled (flag=$FLAG, discord=$D)` on skip,
  for clarity on boot
- [ ] in `.env.example`, add commented entry:
  `# EMAIL_URGENT_ENABLED=true  # immediate Discord ping for importance=5 emails`
- [ ] write integration test in
  `packages/server/src/__tests__/cognition-wiring.test.ts` (new file):
  - boot a minimal cognition service with the urgent handler registered
  - seed DB with one row at `importance=5, urgent_pinged_at=NULL`
  - fire one cognition tick (synchronous via `dispatcher.tick()` or similar)
  - verify a `cognition_publish` event was emitted on the bus
  - verify the row's `urgent_pinged_at` is now set
- [ ] run `npm -w @r2/server test -- cognition-wiring` — must pass before task 5

### Task 5: Acceptance + docs

- [ ] run full server test suite (`npm -w @r2/server test`) — all green
- [ ] run TypeScript build (`npm -w @r2/server run build`) — no errors
- [ ] verify backward compatibility: existing `emailDigest` tests still
  pass; existing `email_pending` rows without `urgent_pinged_at` still
  work (default NULL, handler treats them as eligible if importance=5 —
  this is intentional, see "Backfill semantics" below)
- [ ] update `AGENTS.md` cognition layer section with a one-line entry on
  `emailUrgent` (mirroring the `emailDigest` description style)
- [ ] update `README.md` "Email watcher" section with a one-line note:
  "Urgent emails (importance=5) ping immediately when `EMAIL_URGENT_ENABLED=true`"

## Technical Details

### New column on `email_pending`

| column            | type    | nullable | default | meaning                                    |
|-------------------|---------|----------|---------|--------------------------------------------|
| `urgent_pinged_at`| INTEGER | YES      | NULL    | epoch ms when urgent ping was published    |

That's the only schema change.

### Trigger condition

```
trigger = (
  NOT inQuietHours(now, tz, quietStart)
  AND store.findUnpingedUrgent() !== null
)
```

One urgent row published per cognition tick (~60 s). If three urgent
emails land at once, the user gets three pings over three minutes.
Intentional for MVP — no batching logic, easy to reason about.

### Backfill semantics for existing rows

Pre-existing `email_pending` rows have `urgent_pinged_at = NULL` after
migration. If any of them have `importance=5`, they'll be eligible for
urgent ping on the first tick after the flag is flipped on. **This is
intentional** — it gives a one-time catch-up of historical importance=5
emails the first time you enable urgent mode. To avoid this, manually
backfill: `UPDATE email_pending SET urgent_pinged_at = strftime('%s','now')*1000 WHERE importance = 5`
before flipping the flag.

### Night catch-up — already works for free

Quiet hours suppress the trigger, but `urgent_pinged_at` doesn't get set
during suppression. When quiet hours end, the next tick finds the
night's unpinged urgent rows and starts publishing them one-per-tick.
No special "morning catch-up" code needed — this is just the trigger
logic running normally.

### Why a feature flag

Without `EMAIL_URGENT_ENABLED=true` (default off), nothing about email
behavior changes. Turn it on to start receiving urgent pings. If the
ping rate is wrong (too noisy or too quiet), turn it off in one env
edit + restart, no rollback needed.

### Why the handler also gates on `discordEnabled`

If Discord isn't configured, `cognition_publish` events have no listener
that calls `onPublished`. `urgent_pinged_at` stays NULL forever, and
every tick re-triggers on the same row. Registering only when Discord is
live prevents this dead-loop.

### Observability queries (for the comment block in `emailUrgent.ts`)

```sql
-- Urgent pings published in the last 7 days
SELECT COUNT(*) FROM email_pending
WHERE urgent_pinged_at IS NOT NULL
  AND urgent_pinged_at > (strftime('%s','now') - 7*86400) * 1000;

-- Urgent pings per day (last 14 days)
SELECT date(urgent_pinged_at / 1000, 'unixepoch') AS day, COUNT(*)
FROM email_pending
WHERE urgent_pinged_at IS NOT NULL
GROUP BY day ORDER BY day DESC LIMIT 14;

-- Candidates for false positives: pinged but user didn't open inbox soon
-- (placeholder — actual signal requires iter 4's implicit feedback work;
-- until then, manual review)
SELECT id, from_addr, subject, urgent_pinged_at
FROM email_pending
WHERE urgent_pinged_at IS NOT NULL
ORDER BY urgent_pinged_at DESC LIMIT 20;
```

## Post-Completion

*No checkboxes — humans living with the feature.*

**Two-week observation period:**

Track only what's measurable in iteration 1 (the other strategic metrics —
draft usage, time-to-reply — need iter 2+):

- **Urgent ping rate per day.** If > 5/day, scale 1-5 with threshold=5
  is too loose for this inbox. Tighten by adding `action_needed` in
  iter 2 or by adjusting the scorer prompt.
- **False positive rate (manual judgment).** Look at the last 20 urgent
  pings, ask yourself: would I have wanted this ping at this time? If
  > 25% no → same fix as above.

If observation is satisfying:
- Proceed to iter 2 (draft reply + SMTP).

If observation reveals a problem:
- Decide between `action_needed`, prompt tweak, or threshold change.
- Update this plan retro-style with the chosen fix, ship as iter 1.5.

**Manual operations:**
- Flip `EMAIL_URGENT_ENABLED=true` in `.env` after first install.
- Optionally backfill historical importance=5 rows to avoid one-time
  catch-up burst (see "Backfill semantics" above).
- After two weeks: open SQLite, run the observability queries from the
  comment block in `emailUrgent.ts`, write a one-paragraph retro.
