# Email implicit feedback (silence-as-data) — Pain #1, iter 4

## Overview

Make R2 **learn from how the user reacts to urgent-email pings** and stop
pinging about senders the user keeps ignoring.

Today the urgent threshold is static (`importance = 5`, hardcoded) and the
only feedback is the explicit 🙈 Sender/Subject button. R2 has no idea
whether a ping was useful. This adds the **implicit** signal the roadmap
([toward-ideal-r2.md](../superpowers/plans/2026-05-27-toward-ideal-r2.md)
Pain #1 #5) calls the "genuinely new part":

- **Observe** per pinged email whether the user **replied** (`\Answered`),
  **read but ignored** (`\Seen`, no reply within window), or **never opened**
  it (`\Seen` absent after N hours) — read from IMAP flags.
- **Aggregate** outcomes per sender into a score.
- **Act (downgrade-only):** when a sender's recent pings are mostly ignored,
  auto-demote that sender's future urgent pings to the digest (a soft,
  TTL'd, auto-generated suppression rule). If the user later replies to that
  sender, the auto-suppression is cleared (trust re-earned).
- **Explain:** `/why` shows the feedback signals and any active
  auto-suppression.

**Scope (YAGNI, approach A):** downgrade-only, sender-level. The **boost**
direction (lowering the threshold so trusted importance=4 senders ping as
urgent) and subject-pattern scoring are explicitly **deferred** to a later
iter. No change to the digest logic itself.

**Why this slice:** it directly attacks ping fatigue (R2 learns to shut up),
reuses the existing suppression machinery for the action, and only adds
signal collection + a scorer. Low risk — worst case an auto-suppression
demotes one sender to digest for its TTL, fully visible via `/why` and
self-healing on reply.

## Context (from discovery)

- **Signals not collected today.** Poller fetches only `uid > last_seen_uid`
  and never reads flags; `imap-client.ts` `fetchNewMessages`
  ([imap-client.ts:117](../../packages/server/src/emails/imap-client.ts))
  requests `{envelope, internalDate, bodyStructure}` + body parts only —
  **no `\Seen`/`\Answered`**.
- **Static surfacing.** Urgent = `importance = 5` in SQL
  ([store.ts:132](../../packages/server/src/emails/store.ts)); input cutoff
  `>= 4` ([multi-account-poller.ts:20](../../packages/server/src/emails/multi-account-poller.ts)).
- **Reusable primitives:**
  - `email_suppression_rules` (db.ts:270) + `EmailSuppressionStore`
    (`insertRule`, `findActiveMatch`, `listActive`, `deleteRule`,
    [suppression-store.ts:26](../../packages/server/src/emails/suppression-store.ts))
    — has `created_via` and `expires_at` (TTL). The urgent handler already
    checks `findActiveMatch` before publishing
    ([emailUrgent.ts:54](../../packages/server/src/cognition/handlers/emailUrgent.ts))
    and marks `urgent_pinged_at = -1` (demote to digest) on a match. **An
    auto-rule flows through this path for free.**
  - `email_sent_log` (`record`, `countBySender`,
    [sent-log.ts:28](../../packages/server/src/emails/sent-log.ts)) — knows
    replies sent via R2.
  - `cognition_handler_runs.published_at` (db.ts:192) — when a ping actually
    went out (start of the "ignored" timer).
  - `email_pending.urgent_pinged_at` (>0 = pinged epoch) — the per-email ping
    timestamp.
  - Existing stub `store.countPendingFromSender()` under an "Implicit
    feedback" comment ([store.ts](../../packages/server/src/emails/store.ts)).
- **Marker:** `emailUrgent.ts:28` — "until iter 4's implicit feedback work
  lands". This is iter 4.
- **IMAP lib:** `imapflow`. Flags come back as a `Set` on `fetch` when
  `{flags: true}` is requested; fetch by explicit UID list is supported.
- **Tests:** vitest + in-memory sqlite (`initDb(':memory:')`), mocked
  fetcher/scorer. See
  [multi-account-poller.test.ts](../../packages/server/src/emails/__tests__/multi-account-poller.test.ts)
  and [store.test.ts](../../packages/server/src/emails/__tests__/store.test.ts).

## Development Approach

- **Testing approach: TDD** (tests first), as enforced by ralphex and the
  rest of the codebase.
- Complete each task fully (code + tests passing) before the next.
- **Every task includes new/updated tests** (success + error/edge cases) as
  separate checklist items.
- **All tests pass before starting the next task.** Run
  `npm -w @r2/server test` (or scoped `-- <pattern>`).
- Maintain backward compatibility: feature gated `EMAIL_FEEDBACK_ENABLED`
  (default off) → zero behaviour change when disabled.
- Keep changes small and mirror existing patterns (factory store, idempotent
  migration, cognition handler / poll-tick hook).

## Testing Strategy

- **Unit tests** required per task: flag parsing, feedback store CRUD,
  outcome state machine, scorer, auto-suppression rules.
- **Integration test** (Task 8): full path ping → flags re-polled → outcome
  finalized → score → auto-suppress → next email from that sender demoted to
  digest; and reply → auto-rule cleared.
- No UI/e2e in this server package; Discord is exercised via handler/`/why`
  unit tests.

## Progress Tracking

- Mark `[x]` immediately when done.
- ➕ for newly discovered tasks, ⚠️ for blockers.
- Update this file if scope changes.

## What Goes Where

- **Implementation Steps** (`[ ]`): all code, tests, docs in this repo.
- **Post-Completion** (no checkboxes): manual two-week observation + tuning,
  enabling the flag in `.env`.

## Implementation Steps

### Task 1: `email_feedback` table + migration
- [x] in `db.ts` `initDb()`, add idempotent `CREATE TABLE IF NOT EXISTS
      email_feedback` (pending_id PK → email_pending.id, pinged_at, seen_at,
      answered_at, resolved_at, outcome TEXT CHECK in
      ('replied','read','ignored'), created_at)
- [x] add index `idx_email_feedback_unresolved` on `(resolved_at)` /
      `(outcome)` for the "find unresolved" query
- [x] write tests in `db.test.ts`: table + columns + index exist after
      `initDb`, and re-running `initDb` is idempotent
- [x] run `npm -w @r2/server test -- db.test` — must pass before task 2

### Task 2: IMAP flag fetch in `imap-client.ts`
- [x] add `fetchFlagsForUids(account, uids: number[], opts?): Promise<
      Array<{ uid: number; seen: boolean; answered: boolean }>>` using
      imapflow `fetch` with `{ uid: true, flags: true }` over the explicit
      UID list (chunked if large)
- [x] derive `seen`/`answered` from the flags `Set` (`\Seen`, `\Answered`);
      handle connection/timeout errors by returning partial/empty (never
      throw into the poll loop), mirroring existing error handling
- [x] write tests with a mocked imapflow client: flags present → correct
      booleans; empty UID list → no fetch; fetch error → empty array (logged)
- [x] run `npm -w @r2/server test -- imap-client` — must pass before task 3

### Task 3: Feedback store (`feedback-store.ts`)
- [x] create `emails/feedback-store.ts` with `createEmailFeedbackStore({db})`
      exposing: `recordPinged(pendingId, pingedAt)`,
      `findUnresolved(now, maxAgeMs, limit)` (pinged, `resolved_at` null,
      within age window), `updateFlags(pendingId, {seenAt?, answeredAt?})`,
      `finalize(pendingId, outcome, now)`,
      `recentOutcomesBySender(sender, sinceMs, now)` (joins email_pending on
      from_addr → counts by outcome)
- [x] use prepared statements + the existing factory/typing style
- [x] write tests: record + find unresolved (age window boundary),
      updateFlags, finalize, recentOutcomesBySender aggregation (success +
      empty)
- [x] run `npm -w @r2/server test -- feedback-store` — must pass before task 4

### Task 4: Create a feedback row when an email is urgent-pinged
- [ ] in `emailUrgent.ts`, on successful publish (where `markUrgentPinged`
      runs with a positive epoch), also call
      `feedbackStore.recordPinged(rowId, now)` — only when feedback enabled;
      suppression sentinel (`-1`) path must NOT create a feedback row
- [ ] thread `feedbackStore` through the handler deps (optional dep → no-op
      when absent, like other optional stores)
- [ ] write tests: publish → feedback row created with `pinged_at`;
      suppressed (`-1`) → no feedback row; disabled/absent store → no-op
- [ ] run `npm -w @r2/server test -- emailUrgent` — must pass before task 5

### Task 5: Outcome resolution — re-poll flags + state machine
- [ ] add a resolution step (extend the per-account poll tick in
      `multi-account-poller.ts`, reusing the live IMAP connection): after
      fetching new messages, gather `findUnresolved` UIDs for that account,
      call `fetchFlagsForUids`, and `updateFlags`
- [ ] finalize outcome: `\Answered` → `replied`; else once `now - pinged_at
      >= ignoreHours`: `read` if `seen_at` set, else `ignored`
- [ ] guard: cap how many UIDs re-polled per tick; skip accounts with no
      unresolved rows (no extra IMAP work)
- [ ] write tests (mocked fetcher, fake timers): replied path, read path
      (seen, no answer, window elapsed), ignored path (never seen, window
      elapsed), still-pending (within window → stays unresolved)
- [ ] run `npm -w @r2/server test -- multi-account-poller` — must pass before
      task 6

### Task 6: Scorer + auto-suppression (downgrade-only)
- [ ] create `emails/feedback-scorer.ts` `evaluateSender(sender, store,
      suppressionStore, cfg, now)`: from `recentOutcomesBySender`, if the
      sender's negative outcomes (`ignored` + `read`-without-reply) reach
      `suppressAfter` within the lookback AND no active rule exists → insert
      an auto suppression rule (`rule_type='sender'`,
      `created_via='auto_feedback'`, `expires_at = now + suppressTtlDays`)
- [ ] on a `replied` outcome for a sender: delete any active
      `created_via='auto_feedback'` rule for that sender (trust re-earned);
      never touch manual (`discord_button`) rules
- [ ] call `evaluateSender` from the resolution step (Task 5) whenever an
      outcome is finalized; gated on feedback enabled
- [ ] write tests: negative streak → auto-rule created (correct TTL +
      created_via); reply → auto-rule cleared, manual rule untouched; below
      threshold → no rule; existing active rule → no duplicate
- [ ] run `npm -w @r2/server test -- feedback-scorer` — must pass before
      task 7

### Task 7: `/why` transparency
- [ ] extend `command-service.ts` `whyEmailUrgent()` result with feedback
      signals for the sender: counts of replied/read/ignored in lookback +
      whether an active `auto_feedback` suppression exists (and its expiry)
- [ ] surface these in the `/why` Discord reply
      (`interactions.ts`/`slash-commands.ts`)
- [ ] write tests: `/why` for a sender with mixed outcomes shows correct
      counts; shows active auto-suppression; no feedback → graceful empty
- [ ] run `npm -w @r2/server test -- why` — must pass before task 8

### Task 8: Wire into `index.ts` + env vars + integration test
- [ ] in `index.ts`, construct `feedbackStore`, pass it to the urgent
      handler and the poll tick; register only when `EMAIL_FEEDBACK_ENABLED`
      === 'true' AND `EMAIL_ENABLED` (default off → nothing changes)
- [ ] add env vars via `envInt`/bool: `EMAIL_FEEDBACK_ENABLED`,
      `EMAIL_FEEDBACK_IGNORE_HOURS` (default 24, range 1–168),
      `EMAIL_FEEDBACK_SUPPRESS_AFTER` (default 3, range 1–20),
      `EMAIL_FEEDBACK_SUPPRESS_TTL_DAYS` (default 7, range 1–90),
      `EMAIL_FEEDBACK_MAX_REPOLL` (default 50, range 1–500)
- [ ] document the block in `.env.example`
- [ ] write integration test
      (`__tests__/email-feedback.integration.test.ts`): mocked provider +
      in-memory DB — ping → flags re-polled → ignored×N → auto-suppress →
      next email from sender demoted (`urgent_pinged_at=-1`, lands in digest);
      separate case: reply → auto-rule cleared
- [ ] run `npm -w @r2/server test -- email-feedback.integration` — must pass
      before task 9

### Task 9: Acceptance + docs
- [ ] run full server suite — all green
- [ ] verify backward-compat: `EMAIL_FEEDBACK_ENABLED` unset → no feedback
      rows, no auto-rules, urgent behaviour unchanged
- [ ] run `tsc` build clean + linter
- [ ] update `AGENTS.md` (email feedback handler/flow) and `README.md`
      (Pain #1 implicit-feedback subsection: what it does, IMAP-flag basis,
      config vars, downgrade-only scope, how to enable)

## Technical Details

- **Outcome state machine** (per pinged email): `pending` → `replied`
  (`\Answered` seen) | `read` (`\Seen`, no answer, `ignoreHours` elapsed) |
  `ignored` (no `\Seen`, `ignoreHours` elapsed). Terminal once `resolved_at`
  set.
- **Score → action:** count negative (`ignored`+`read`) outcomes per sender
  over the suppress lookback; `>= suppressAfter` ⇒ auto `sender` suppression
  (TTL `suppressTtlDays`, `created_via='auto_feedback'`). A `replied` outcome
  removes active auto rules for the sender.
- **Reuse:** auto-rules live in `email_suppression_rules`; demotion is
  automatic via the existing `findActiveMatch` check in `emailUrgent.ts`
  (urgent → `-1` → falls into digest). No new demotion path.
- **`created_via`** distinguishes `auto_feedback` from `discord_button` so
  auto rules can be cleared/explained without touching manual ones.
- **IMAP cost:** re-poll only unresolved, capped at `EMAIL_FEEDBACK_MAX_REPOLL`
  UIDs/account/tick, reusing the poll tick's open connection.

## Post-Completion

*No checkboxes — manual / observational.*

**Enable:**
- Set `EMAIL_FEEDBACK_ENABLED=true` in `.env`, restart supervisor. (Defaults
  for the other knobs are sane; tune later.)

**Two-week observation:**
- Are auto-suppressions firing on the right senders? Check
  `SELECT * FROM email_suppression_rules WHERE created_via='auto_feedback'`.
- Any sender wrongly silenced? `/why` should explain it; reply once to clear.
- Tuning candidates: `EMAIL_FEEDBACK_SUPPRESS_AFTER` (too aggressive → raise),
  `EMAIL_FEEDBACK_IGNORE_HOURS` (false "ignored" when you read late → raise),
  `EMAIL_FEEDBACK_SUPPRESS_TTL_DAYS`.
- Retro per roadmap: did ping fatigue drop? If yes → consider the deferred
  **boost** direction (iter 5) and subject-pattern scoring. If
  auto-suppression misfires → diagnose before extending.
