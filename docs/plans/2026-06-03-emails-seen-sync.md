# Emails: auto-clear awaiting queue when read/archived in Gmail (\Seen sync)

## Overview
R2's "непрочитанное" / awaiting queue is its internal `email_pending` state — it does **not**
reflect whether the user already read (or archived) the email in Gmail. So an email the user
read days ago keeps showing as "1 непрочитанное" on every "проверь почту" until it is
urgent-pinged, digest-delivered, or manually dismissed. The GitHub email (importance 3, never
urgent/digest) nagged for days until manually dismissed.

Fix: on each poll tick, re-check the IMAP `\Seen` flag for awaiting emails and **auto-dismiss**
(reuse `markDelivered`) any that the user has **read OR moved out of INBOX** (archived/deleted).
This makes R2's queue track what the user has actually handled in Gmail — zero manual input,
matching the project vision.

Decision (confirmed with owner): "handled in Gmail" = `\Seen` **OR** the message has left INBOX
(absent from a successful flag fetch). Read-but-not-actioned mail also clears (the owner's explicit
expectation — e.g. reading the GitHub email clears it from the queue even if the permission isn't
approved; the honest "do it manually" reply already covers the external action).

## Context (from discovery)
- `packages/server/src/emails/multi-account-poller.ts` — `runPollTick` iterates accounts; already
  has a feedback re-poll (`resolveFeedback`, lines ~115-192) that fetches `\Seen`/`\Answered` via
  `feedback.flagFetcher` — but **only for urgent-pinged rows** and only to learn sender scoring
  (`finalize` → 'read'/'ignored'); it never clears the awaiting queue. The new sync is a separate,
  analogous pass over the **awaiting** (non-pinged) rows that calls `markDelivered` instead.
- `packages/server/src/emails/imap-client.ts` — `fetchFlagsForUids(account, uids)` returns
  `{uid, seen, answered}[]` or `null` (hard fetch failure). Already wired at
  `packages/server/src/index.ts:797` (`flagFetcher`).
- `packages/server/src/emails/store.ts` — has `markDelivered(ids, now)` (sets `delivered_at`,
  removes from awaiting) and `fetchPendingUndelivered(limit)` (awaiting predicate, **not** per
  account). Need a per-account awaiting fetch that returns rows with `message_uid`.
- Awaiting predicate (must match exactly): `delivered_at IS NULL AND (urgent_pinged_at IS NULL OR
  urgent_pinged_at < 0)`.
- Re-poll safety pattern to copy from `resolveFeedback`: if `flagFetcher` returns `null` (hard
  failure) → bail, change nothing. A UID **absent** from a **successful** (non-null) fetch = left
  INBOX (archived/deleted/moved). A UID present with `seen:true` = read.

## Development Approach
- **Testing approach**: TDD — write failing poller/store tests first, then implement.
- Additive: new store method + new poll-tick pass; reuses existing `flagFetcher` + `markDelivered`.
- Out of scope (YAGNI): recording sender feedback ('read') for these auto-cleared rows (feedback
  loop stays urgent-only); changing the manual `emails_dismiss` tool; any schema change; a new
  config flag (sync is always-on, runs within the existing poll interval).

## Testing Strategy
- Store unit test: per-account awaiting fetch returns only awaiting rows for that account, with uid.
- Poller unit tests (mock `flagFetcher` + store):
  - awaiting row `seen:true` → `markDelivered` called → leaves awaiting.
  - awaiting row absent from a successful fetch (left INBOX) → `markDelivered` called.
  - awaiting row present, `seen:false` → NOT dismissed.
  - `flagFetcher` returns `null` → nothing dismissed (safe bail).
  - urgent-pinged / already-delivered rows are not in scope and untouched.

## Progress Tracking
- Mark `[x]` immediately. ➕ new tasks, ⚠️ blockers.

## Implementation Steps

### Task 1: Per-account awaiting fetch in the store
- [x] add `fetchAwaitingForAccount(accountId: string, limit: number): EmailPendingRow[]` to the
      store (and its `StoreLike` interface in `store.ts`): same awaiting predicate, `WHERE account_id=?`,
      ordered by `received_at`, `LIMIT ?`. Returns rows incl. `id` and `message_uid`.
- [x] write store tests (returns only this account's awaiting rows; excludes delivered/urgent-pinged)
- [x] run `npm test` — must pass before next task

### Task 2: Seen-sync pass in the poll tick
- [x] add `syncSeenStatus(account, params)` in `multi-account-poller.ts`: fetch
      `fetchAwaitingForAccount(account.id, cap)`; if none → return; call `flagFetcher(account, uids)`;
      if `null` → return (safe bail); build a uid→flag map; for each awaiting row compute
      `handled = flag?.seen === true || (flags !== null && !flagMap.has(uid))` (read OR left INBOX);
      collect handled ids and call `store.markDelivered(ids, now)` once.
- [x] wire `syncSeenStatus` into `runPollTick` per account (use the existing `flagFetcher` + `store`
      from tick params; add to params/ wiring in `index.ts` if needed). Guard: only run when a
      `flagFetcher` is available. (Added top-level `flagFetcher?` to TickParams — always-on, not gated
      on EMAIL_FEEDBACK_ENABLED; runs in both the no-new-mail and normal branches.)
- [x] write poller tests for the 5 cases in Testing Strategy (plus account-isolation, no-fetcher,
      throwing-fetch, and same-tick-with-new-mail cases)
- [x] run `npm test` — must pass before next task

### Task 3: Verify acceptance & build
- [ ] verify: an awaiting email marked `\Seen` (or archived) in Gmail is gone from awaiting after a
      poll tick; "проверь почту" then shows it no longer / "всё разобрано"
- [ ] run full suite (`npm test`) — all green
- [ ] run `npm run build` (tsc) in `packages/server` — no type errors
- [ ] confirm additive only (feedback loop, emails_dismiss tool, schema unchanged)

## Technical Details
- `handled = seen OR left-INBOX`, gated on a successful fetch (`flags !== null`). On `null` bail.
- Reuses `markDelivered` (sets `delivered_at`) → row leaves `awaiting`/`awaiting_count` but stays in
  `email_pending` for period queries (same semantic as manual dismiss).
- Runs every poll tick (`EMAIL_POLL_INTERVAL_MS`, default 5 min) → queue reflects Gmail within ~5 min.
- Cap awaiting fetch (e.g. 50) so a huge backlog can't blow up one tick's flag fetch.

## Post-Completion
*Manual / external — no checkboxes*

**Deploy** (per flow): ralphex on `dev`; `dev`→`master` + `git push origin master`; **stay on
`master`** (git-watcher restarts only when HEAD==master); supervisor auto-restarts.

**Manual verification (Discord):**
- "Проверь почту" surfaces an email → open/read it in Gmail (or archive it) → wait one poll tick →
  "Проверь почту" again → it's gone from the queue without manual "разобрал".
