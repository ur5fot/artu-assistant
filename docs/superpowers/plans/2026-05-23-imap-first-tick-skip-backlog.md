# IMAP poller: skip historical backlog on first tick

## Overview

When a new IMAP account is added (or `email_account_state` is wiped),
`last_seen_uid` is `0`. The poller does `SEARCH UID 1:*` which returns the
entire inbox history (Gmail user observed had 9416 messages from UID 1 to
22532). Each tick processes 50 messages oldest-first — at one tick per
5 minutes that's ~15 hours just to reach present-day mail. During that
crawl, **real new arrivals are invisible** because they sit at high UIDs
behind a multi-thousand-row backlog. The user-visible symptom: bot sees
emails from 2020 and claims "почта пуста за весь год" because the recent
window filter (`received_at >= now - 720h`) hides them, while no new
arrivals can be processed until backlog is drained.

This plan changes first-tick behavior: when `last_seen_uid === 0`, probe
the inbox's current `max(uid)`, persist it as `last_seen_uid`, and process
zero rows that tick. From the **next** tick onward, only emails newly
delivered to the inbox (UID > old max) are fetched and scored. The
historical backlog is intentionally skipped — surfacing 9416 old emails
adds no value and floods the digest with marketing/notifications from
years ago.

## Context (from discovery)

**Files involved:**
- [packages/server/src/emails/imap-client.ts](../../packages/server/src/emails/imap-client.ts) — `fetchNewMessages` uses `search({ uid: '${sinceUid+1}:*' })`. Need a new sibling fn `getMaxUid(account)` that returns the current max UID without fetching bodies.
- [packages/server/src/emails/multi-account-poller.ts](../../packages/server/src/emails/multi-account-poller.ts) — `runPollTick` reads `sinceUid` from store and calls fetcher. Need to branch on `sinceUid === 0` to call the probe and short-circuit the tick.
- [packages/server/src/emails/store.ts](../../packages/server/src/emails/store.ts) — `updateLastSeenUid(accountId, uid, now)` exists; reusable as-is.
- [packages/server/src/emails/__tests__/multi-account-poller.test.ts](../../packages/server/src/emails/__tests__/multi-account-poller.test.ts) — existing tests for normal flow; add cases for first-tick.
- [packages/server/src/emails/__tests__/imap-client.test.ts](../../packages/server/src/emails/__tests__/imap-client.test.ts) — add tests for `getMaxUid`.

**Patterns found:**
- `withClient` helper in imap-client handles connect/logout — reuse for the probe
- `MessageFetcher` type in poller is the indirection point; mirror it with `MaxUidProbe`
- `setAccountError` is the project's existing way to record IMAP failures — reuse on probe failure

**Dependencies identified:**
- None new — uses existing `imapflow` `client.search`

**Symptoms observed (justifies this work):**
- Real-world test today: 9416-message inbox, poller crawled UID 1 → 2266 in 1.5h, all from 2020. User saw "почта пуста" for current mail despite an active inbox.

## Development Approach

- **Testing approach**: Regular (code first, tests per task)
- Complete each task fully before next
- Small focused changes
- **Every task includes new/updated tests**
- All tests pass before next task — no exceptions
- Update this plan if scope shifts

## Testing Strategy

- **Unit tests** required per task
- No e2e: poller is server-internal
- Mock imapflow `search` to return controlled UID arrays
- Mock store to inspect `updateLastSeenUid` / `setAccountError` calls

## Progress Tracking

- Mark items `[x]` immediately on completion
- ➕ for newly discovered tasks
- ⚠️ for blockers

## What Goes Where

- **Implementation Steps** (`[ ]`): code, tests in this repo
- **Post-Completion** (informational): no manual DB cleanup needed for current accounts (already handled); future accounts will work correctly on first connect

## Implementation Steps

### Task 1: Add `getMaxUid` to imap-client

- [x] add `export async function getMaxUid(account: ImapAccount): Promise<number>` in `imap-client.ts`
  - uses existing `withClient` helper
  - calls `client.search({ all: true }, { uid: true })` to get every UID
  - returns `Math.max(...uids)` if any, or `0` for an empty inbox
  - **important**: take the max BEFORE returning so any email arriving between this call and the next poll tick is guaranteed to have UID > returned value (IMAP UIDs are monotonically increasing per mailbox)
- [x] write tests in `imap-client.test.ts`:
  - empty inbox (search returns `[]`) → returns 0
  - inbox with messages → returns max UID
  - non-contiguous UIDs (e.g., `[1, 5, 22532, 1000]`) → returns the actual max, not array length
  - imapflow error during search → throws (caller responsible for catching)
- [x] run server tests — must pass before Task 2

### Task 2: First-tick skip in `runPollTick`

- [x] in `multi-account-poller.ts`, add a new param to `TickParams` and `StartParams`: `maxUidProbe: MaxUidProbe` where `type MaxUidProbe = (account: ImapAccount) => Promise<number>`
- [x] in `runPollTick`, after reading `sinceUid`, branch:
  - if `sinceUid === 0`: call `maxUidProbe(acc)`, call `store.updateLastSeenUid(acc.id, maxUid, now)`, log `[emails] first tick for ${acc.id}: skipping backlog, last_seen_uid set to ${maxUid}`, continue to next account (no fetcher call, no scoring, no inserts)
  - else: existing path unchanged
- [x] wrap the probe in the existing try/catch — on failure call `setAccountError` and skip the account (matches current error handling for fetcher failures). Next tick will retry the probe.
- [x] update [packages/server/src/index.ts](../../packages/server/src/index.ts) where `startEmailPoller` is called: pass `maxUidProbe: getMaxUid` (imported from `./emails/imap-client.js`)
- [x] write tests in `multi-account-poller.test.ts`:
  - first tick with `sinceUid=0` and non-empty inbox → `updateLastSeenUid(acc, maxUid, now)` called with returned max, `insertPending` NOT called, fetcher NOT called
  - first tick with `sinceUid=0` and empty inbox (probe returns 0) → `updateLastSeenUid(acc, 0, now)` called; next tick will retry the same probe (no infinite loop concern because `0` stays `0` until real messages arrive)
  - non-first tick (`sinceUid=2266`) → probe NOT called, fetcher called as before
  - probe throws → `setAccountError` called with probe's error message, no `updateLastSeenUid`, no fetcher call
  - multiple accounts mixed: account A `sinceUid=0` (probes), account B `sinceUid=100` (fetches) — both handled independently in one tick
- [x] run server tests — must pass before Task 3

### Task 3: Wire and verify

- [ ] confirm `index.ts` call site passes `maxUidProbe: getMaxUid` — `npx tsc --noEmit -p packages/server/tsconfig.json` must pass
- [ ] verify acceptance criteria from Overview:
  - new account with `sinceUid=0` and 9000+ message inbox → first tick takes < 5s, sets `last_seen_uid` to current max, no rows inserted
  - subsequent ticks behave identically to before (only new arrivals processed)
  - error paths preserved (account marked errored on probe failure, not silent)
- [ ] run full test suite from repo root: `npm test` — all tests must pass
- [ ] verify no orphan `[ ]` items left in the plan

### Task 4: [Final] Update documentation

- [ ] add a short note in [README.md](../../README.md) under the "Emails" section:
  > New IMAP accounts skip historical backlog on first connect — only emails arriving **after** the account is configured are processed. Existing accounts are unaffected.
- [ ] add JSDoc to `getMaxUid` explaining why this exists (link to first-tick semantics in poller)

## Technical Details

**Probe contract:**
```ts
type MaxUidProbe = (account: ImapAccount) => Promise<number>;
```
Returns the highest UID currently in the account's INBOX, or `0` if empty.
Caller advances `last_seen_uid` to this value before the next tick.

**First-tick flow:**
```
poll tick
  ├─ for each account
  │   ├─ sinceUid = store.getLastSeenUid(acc.id)
  │   ├─ if sinceUid === 0:
  │   │   ├─ maxUid = await maxUidProbe(acc)
  │   │   ├─ store.updateLastSeenUid(acc.id, maxUid, now)
  │   │   └─ continue  (skip fetching this tick)
  │   └─ else: existing fetch+score+insert path
```

**Race condition note:**
Between the `search ALL` call and the moment `updateLastSeenUid` returns,
new emails could arrive in the inbox. Those new arrivals receive UIDs >
the returned max (IMAP guarantees monotonic UID assignment per mailbox).
On the next tick `sinceUid` = old max, the `search uid: ${old}+1:*` query
catches them. **No lost messages.**

**Why not start from `maxUid + 1` immediately and try to fetch the same tick:**
Skipping the tick keeps the branch trivial. Doing both in one tick would
require a probe + fetch round-trip on a fresh account; the first
real-mail tick happens 5 minutes later, which is fine for the use case
(account just got added; user isn't expecting instant results).

## Post-Completion

**Manual verification:**
- After deploy, manually test by:
  1. Adding a second IMAP account in `IMAP_ACCOUNTS` (or temporarily clearing
     `email_account_state` for `imap1` to simulate fresh connect)
  2. Watching server logs for `[emails] first tick for <id>: skipping backlog, last_seen_uid set to <N>`
  3. Confirming `email_pending` stays empty until a real new email arrives
- Send yourself a test email after first tick — should appear in `emails_list` within one poll cycle

**External system updates:**
- None — feature is internal to R2

**Behavioral change for new users:**
- Anyone adding R2 to a new mailbox will only see mail from the moment of
  setup forward. Documented in README.
