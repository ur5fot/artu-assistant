# Email Send Hold Zone — Pain #1, Iteration 3

## Overview

Third slice of "Pain #1 — Email triage" from the strategic roadmap
([2026-05-27-toward-ideal-r2.md](../superpowers/plans/2026-05-27-toward-ideal-r2.md)).

**Goal:** when user clicks **Send** on the draft-reply ephemeral, the email
does NOT go to SMTP immediately. It's queued for 30 seconds; the ephemeral
updates to a static label showing an **absolute send time**
(`"✉️ Will send at HH:MM:SS"`) with a single `Cancel send` button. If user
clicks Cancel within the window → drop, no SMTP. If the timer fires → SMTP
send, ephemeral updates to `"✅ Sent"`. Setting
`EMAIL_SEND_HOLD_SECONDS=0` bypasses the hold entirely (instant send,
matches pre-iter-3 behaviour) — gives a one-env-edit kill switch.

**Why this slice:**
- Closes the trust gap that blocks proactive delegation. Without an undo,
  every Send is psychologically expensive. 30s hold + 1-click cancel
  makes Send routine.
- Builds the first **undoable action wrapper** in the codebase — the
  pattern from this iteration is what the strategic plan expects to
  extract for future "action with undo" features (HA, file ops, etc.).
- Small surface: one new button, one new timer, one env var, one
  mini-audit table.

**Out of scope (later iterations):**
- Live countdown in the ephemeral (5s polling edits) — static absolute
  time only.
- Configurable hold per-draft from chat ("send this one in 5 min") —
  fixed global default for now.
- "Send anyway" / "Restart draft" buttons after Cancel — user re-triggers
  from urgent embed (iter 3.5).
- Auto-retry on transient SMTP failure (iter 3.5).
- Persistent queue across server restarts — pending sends are lost on
  restart (matches existing "drafts lost on restart" semantics).
- Implicit feedback / threshold tuning (iter 4).
- `/why` + explicit "shut up" rules (iter 5).

**Key design decisions baked into this plan:**
- **Per-draft `setTimeout`** — one timer per pending send, handle stored
  on the draft state. Cancel = `clearTimeout` + drop. No global scheduler.
- **Static absolute-time label** — `"Will send at 10:00:30"`. No live
  countdown. Simpler, no Discord rate-limit risk, fewer tests; absolute
  time gives the user clarity about the deadline without polling edits.
- **State extension** instead of new Map — add `holdTimer` and
  `holdSendAt` fields to existing `DraftState`. Keeps lifecycle in one
  place.
- **`EMAIL_SEND_HOLD_SECONDS=0` is allowed** and means "bypass hold,
  send immediately" (restores pre-iter-3 sync behaviour). One-env-edit
  rollback if the feature misbehaves.
- **Pre-check Discord 15-min ephemeral window** — if remaining ephemeral
  lifetime < hold + 60s buffer, refuse Send with "Draft session
  expiring, click Draft reply again" rather than risk a stale ephemeral
  no one can update later.
- **Mini audit table `email_sent_log`** — one row per send/cancel/error
  with timestamp. Cheap (~30 LOC). Lets us answer "how often does the
  user actually Cancel?" with one SQL query during observation period.
- **Restart loses pending sends** — intentional. 30s window means the
  edge case is rare. SIGTERM during hold is **explicitly accepted as a
  known edge case** (see Failure Modes below) — no graceful disarmHold
  cleanup for MVP.

## Context (from discovery)

**Existing patterns to reuse:**
- One-shot `setTimeout` with handle storage: `bot.ts:371, 447` (Discord
  coalesce timer).
- `Map<string, State>` for pending work: `draft-reply-service.ts`
  (already in place — extend it).
- Per-handler `editReply` chain: `interactions.ts:622-685` (current
  `email_draft:send` already edits ephemeral after work).
- Env var parsing: `index.ts:65-72` (`envInt`) used at line 583.
- Fake-timer tests: `heartbeat.test.ts:12-62`
  (`vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync`).
- Button routing in `interactions.ts:81-292`. `email_draft` domain
  already exists; add `cancelSend` action.
- SQLite migration via PRAGMA table_info check — pattern from
  `db.ts` (iter 1 added `urgent_pinged_at` column the same way).

**Files involved:**

*Extended:*
- `packages/server/src/services/draft-reply-service.ts` — extend
  `DraftState` with optional `holdTimer: NodeJS.Timeout | null` and
  `holdSendAt: number | null`. Add methods `armHold`, `disarmHold`,
  `getHoldTimer`.
- `packages/server/src/db.ts` — create new `email_sent_log` table.
- `packages/server/src/channels/discord/interactions.ts` — refactor
  `handleEmailDraftSend` (lines 622-685): bypass branch when
  `holdSeconds=0`; pre-check 15-min ephemeral expiry; else arm timer +
  edit to "Will send at …". Add `handleEmailDraftCancelSend`. Add
  private `executeQueuedSend(pendingId, deps)` helper invoked by the
  timeout.
- `packages/server/src/index.ts` — parse `EMAIL_SEND_HOLD_SECONDS` env
  (default 30, range **0-300**) and pass via deps. Create
  `emailSentLog` repo, pass via deps.
- `packages/server/src/channels/discord/bot.ts` — accept
  `emailSendHoldSeconds` and `emailSentLog` in deps, thread to handlers.
- `.env.example` — document `EMAIL_SEND_HOLD_SECONDS` with bypass note.

*New:*
- `packages/server/src/emails/sent-log.ts` — repo with `record(action,
  draftMeta)` insert + `countLastDays(action, days)` helper for
  observation-period queries.
- Tests mirroring each new module.

**Dependencies:** no new npm packages.

## Development Approach

- **Testing approach**: **TDD** (tests first, then implementation).
- Complete each task fully before moving to the next.
- Tests are a required deliverable of every task, not optional.
- All tests must pass before starting the next task.
- Update this plan if implementation deviates from scope (➕ for new
  sub-tasks, ⚠️ for blockers).
- Run scoped: `npm -w @r2/server test -- <pattern>`.
- Maintain backward compatibility on `DraftState` (new fields are
  optional / nullable).

## Testing Strategy

- vitest only.
- `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync(ms)` for timer
  flows (pattern from `heartbeat.test.ts`).
- `vi.useRealTimers()` in `afterEach` to avoid leaking fake timers.
- Mocked `smtpClient.sendReply` (`vi.fn()`).
- Mocked Discord `ButtonInteraction` — same patterns as existing
  `interactions.draft.test.ts`.
- In-memory SQLite (`initDb(':memory:')`) for sent-log tests.
- No integration tests against real Gmail.

## Progress Tracking

- Mark completed items with `[x]` immediately when done.
- Add newly discovered tasks with ➕ prefix.
- Document blockers with ⚠️ prefix.
- Update this plan if scope changes mid-implementation.

## What Goes Where

- **Implementation Steps** (`[ ]` checkboxes): all code, tests, env
  doc, audit table.
- **Post-Completion** (no checkboxes): manual verification, observation
  queries.

## Implementation Steps

### Task 1: Extend `DraftState` with hold fields + service methods

- [x] in `packages/server/src/services/draft-reply-service.ts`, add to
  `DraftState`: `holdTimer: NodeJS.Timeout | null` (default null on
  `put`) and `holdSendAt: number | null` (default null on `put`)
- [x] add `armHold(pendingId, timer, sendAt)`: stores both fields. If
  state row missing → silent no-op (caller is responsible). If a
  previous timer exists → `clearTimeout` on it first (defensive)
- [x] add `disarmHold(pendingId)`: clears timer if set, nulls both
  fields. Idempotent on missing state
- [x] extend `drop(pendingId)` to also `clearTimeout` on `holdTimer`
  before removing the entry (prevents zombie timer on dropped draft)
- [x] write tests in
  `packages/server/src/services/__tests__/draft-reply-service.test.ts`:
  - `armHold` sets both fields
  - `armHold` twice clears the previous timer (verify with fake timers
    + spy on the first callback)
  - `armHold` on missing state row is silent no-op
  - `disarmHold` clears timer + nulls fields
  - `disarmHold` on entry with null timer is no-op
  - `drop` after `armHold` clears the timer (no fire after drop)
- [x] run `npm -w @r2/server test -- draft-reply-service.test` — must
  pass before task 2

### Task 2: `email_sent_log` table + repo

- [x] in `packages/server/src/db.ts`, add `CREATE TABLE IF NOT EXISTS
  email_sent_log (id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT
  NOT NULL CHECK(action IN ('sent','cancelled','error')), draft_id
  TEXT NOT NULL, to_addr TEXT NOT NULL, subject TEXT NOT NULL,
  error_message TEXT, created_at INTEGER NOT NULL)`
- [x] add `CREATE INDEX IF NOT EXISTS idx_email_sent_log_action_at ON
  email_sent_log(action, created_at DESC)`
- [x] create `packages/server/src/emails/sent-log.ts` with
  `createEmailSentLog({ db })` returning `{ record(entry), countLastDays(action,
  days) }`
- [x] `record({action, draftId, to, subject, errorMessage?})` inserts
  with `Date.now()` for `created_at`
- [x] `countLastDays(action, days)` returns count where `created_at >
  (now - days*86400000)`
- [x] write tests in `packages/server/src/emails/__tests__/sent-log.test.ts`:
  - `record` inserts a row with all fields, `created_at` set
  - `record` rejects invalid action (CHECK constraint throws)
  - `countLastDays` returns 0 on empty table
  - `countLastDays('sent', 7)` counts only sent rows in last 7 days
  - `countLastDays` does not double-count old rows
- [x] write migration test in
  `packages/server/src/__tests__/db.test.ts`: `email_sent_log` table
  exists after `initDb`; re-running `initDb` is idempotent
- [x] run `npm -w @r2/server test -- sent-log.test db.test` — must pass
  before task 3

### Task 3: Env var + deps wiring

- [x] in `packages/server/src/index.ts`, near existing email env parsing
  (~line 583), parse
  `EMAIL_SEND_HOLD_SECONDS = envInt(process.env.EMAIL_SEND_HOLD_SECONDS, 30, 0, 300)`
  — note **min 0** (bypass mode), max 300 (5 min, comfortable under
  Discord's 15-min ephemeral window)
- [x] construct `emailSentLog = createEmailSentLog({ db })`
- [x] thread both `emailSendHoldSeconds` and `emailSentLog` into bot
  deps where the Discord bot is constructed
- [x] in `packages/server/src/channels/discord/bot.ts`, accept
  `emailSendHoldSeconds: number` and `emailSentLog: EmailSentLog` in
  the deps type, pass to interaction handlers
- [x] in `.env.example`, after `EMAIL_QUIET_HOUR_START`, add:
  ```
  # Hold zone for outgoing email drafts in seconds (0-300, default 30).
  # 0 = bypass hold and send immediately (kill switch — restores
  # pre-iter-3 behaviour without code changes). 300 = 5 min max, kept
  # under Discord's 15-min ephemeral webhook window.
  EMAIL_SEND_HOLD_SECONDS=30
  ```
- [x] write test in
  `packages/server/src/__tests__/env-config.test.ts` (or extend
  existing): default 30, 0 allowed (returns 0), negative → fallback 30,
  > 300 → fallback 30. Note: `envInt` extracted from `index.ts` into
  new `packages/server/src/env-utils.ts` so it's importable by tests
  without booting the server.
- [x] run `npm -w @r2/server test -- env-config` — must pass before
  task 4

### Task 4: Refactor `handleEmailDraftSend` — bypass, pre-check, arm timer

- [x] in `packages/server/src/channels/discord/interactions.ts`, modify
  the `email_draft:send` handler (`handleEmailDraftSend` around
  lines 622-685):
  - keep `deferUpdate()` at the start
  - look up state via `draftReplyService.get(pendingId)`; if missing →
    existing "expired" editReply path
  - **bypass branch**: if `emailSendHoldSeconds === 0` → call
    `smtpClient.sendReply` synchronously (current behaviour), record
    `emailSentLog.record({action: 'sent', ...})` on success or
    `{action: 'error', errorMessage}` on fail, drop state, edit
    ephemeral as today. Return.
  - **hold branch** (`emailSendHoldSeconds > 0`):
    - **pre-check 15-min ephemeral expiry**: compute
      `ephemeralExpiresAt = interaction.createdTimestamp + 15*60*1000`.
      If `Date.now() + emailSendHoldSeconds*1000 + 60_000 >
      ephemeralExpiresAt` → editReply
      `"⚠️ Сессия черновика истекает. Нажми Draft reply ещё раз."`,
      drop state, return.
    - compute `sendAt = Date.now() + emailSendHoldSeconds*1000`
    - arm `timer = setTimeout(() => executeQueuedSend(pendingId,
      interaction, deps), emailSendHoldSeconds*1000)`
    - `draftReplyService.armHold(pendingId, timer, sendAt)`
    - format `label = "✉️ Will send at " + formatTime(sendAt)` where
      `formatTime` is local HH:MM:SS (use `toLocaleTimeString('uk-UA',
      {hour:'2-digit', minute:'2-digit', second:'2-digit'})`)
    - `editReply` to show `label` and a single `Cancel send` button
      (`email_draft:cancelSend:${pendingId}`)
- [x] extract a private helper `async function
  executeQueuedSend(pendingId, interaction, deps)`:
  - look up state; if missing or `holdTimer` is null (cancelled
    between fire and execution) → silent return
  - `disarmHold` first (so the state knows we're past the cancel
    window)
  - call `smtpClient.sendReply(...)` with the same params used before
  - on success: drop state, `emailSentLog.record({action: 'sent', ...})`,
    edit ephemeral via `interaction.webhook.editMessage('@original',
    {...})` to `"✅ Sent"` with no buttons. Wrap edit in try/catch with
    logger.warn — if the 15-min webhook window has expired during hold
    (rare given pre-check, but theoretically possible), log it and move
    on; SMTP already succeeded.
  - on SMTP failure: drop state, `emailSentLog.record({action: 'error',
    errorMessage: err.message, ...})`, try edit ephemeral to clamped
    error string (reuse `clampReplyContent`), no buttons. Same
    try/catch on the edit.
- [x] write tests in `interactions.draft.test.ts` with fake timers
  (note: vitest does NOT fake `Date.now()` by default —
  `vi.useFakeTimers({toFake:['Date','setTimeout','clearTimeout']})` is
  needed to control absolute timestamps):
  - **bypass**: with `emailSendHoldSeconds=0`, Send calls SMTP
    synchronously, records `sent`, edits to "Sent" (no Cancel button)
  - **hold path**: Send with hold=30 arms timer, records nothing yet,
    edits to "Will send at HH:MM:SS" + Cancel button
  - **15-min pre-check**: simulate `interaction.createdTimestamp = now -
    14*60*1000` (only 1 min of ephemeral life left), hold=30 → editReply
    "истекает", no timer armed, no SMTP, state dropped
  - **timer expiry success**: advance fake timers by 30s → SMTP called
    once, `emailSentLog.record('sent')` called once, edits to "Sent"
  - **timer expiry SMTP failure**: SMTP mock rejects, advance timers
    → `emailSentLog.record('error', errorMessage)` called once, edits
    to clamped error string
  - **edit-after-expire**: when `interaction.webhook.editMessage`
    rejects (simulated expired webhook), SMTP still completes,
    `record('sent')` still called, no thrown error
  - missing state on Send → existing "expired" path preserved
- [x] run `npm -w @r2/server test -- interactions.draft` — must pass
  before task 5

### Task 5: New `Cancel send` button handler

- [ ] in `interactions.ts`, add new action `cancelSend` under the
  `email_draft` domain (follow `start` / `send` / `edit` / `cancel`
  patterns at lines 81-292)
- [ ] implement `handleEmailDraftCancelSend(ixn, deps, pendingId)`:
  - `deferUpdate()`
  - look up state; if missing or `holdTimer` is null → editReply
    `"⚠️ Слишком поздно — уже отправлено."` and return
  - `disarmHold(pendingId)` then `drop(pendingId)`
  - `emailSentLog.record({action: 'cancelled', draftId: pendingId,
    to: state.to, subject: state.subject})`
  - editReply to `"🚫 Cancelled"` with no buttons
- [ ] route the new action in the interaction dispatcher (where `send`
  / `edit` / `cancel` get routed)
- [ ] write tests in `interactions.draft.test.ts`:
  - Cancel clears the timer (SMTP never called even after
    `advanceTimersByTimeAsync(60_000)`)
  - Cancel records `cancelled` in `emailSentLog`
  - Cancel edits ephemeral to "Cancelled"
  - Cancel after timer already fired shows "Слишком поздно",
    no extra `record` call
  - Cancel with missing state shows "Слишком поздно"
- [ ] run `npm -w @r2/server test -- interactions.draft` — must pass
  before task 6

### Task 6: Integration test — full round-trip

- [ ] write integration test in
  `packages/server/src/__tests__/email-send-hold.integration.test.ts`:
  - boot minimal deps with mocked `smtpClient`, real
    `draftReplyService`, real `emailSentLog` (in-memory DB), fake
    Discord interaction
  - **hold success path**: seed draft state → simulate Send → assert
    ephemeral shows "Will send at …" + Cancel button + SMTP not called
    + no `email_sent_log` row yet. Advance fake timers by 30_100ms →
    assert SMTP called once + ephemeral edited to "Sent" + one
    `email_sent_log` row with action='sent'.
  - **cancel path**: Send → Cancel → advance timers far past 30s →
    assert SMTP never called + ephemeral "Cancelled" + one
    `email_sent_log` row with action='cancelled'.
  - **bypass path**: with `emailSendHoldSeconds=0`, Send → assert SMTP
    called immediately (no timer wait) + one `email_sent_log` row
    `action='sent'`.
  - **15-min pre-check**: seed interaction with
    `createdTimestamp = now - 14*60*1000`, Send with hold=30 → no
    timer armed, no SMTP, ephemeral shows "истекает", state dropped.
- [ ] run `npm -w @r2/server test -- email-send-hold.integration` —
  must pass before task 7

### Task 7: Acceptance + docs

- [ ] run full server test suite (`npm -w @r2/server test`) — all green
- [ ] run TypeScript build (`npm -w @r2/server run build`) — no errors
- [ ] verify backward compatibility: existing `email_draft` tests
  still pass (Send, Edit, Cancel of draft body, modal — all
  unchanged)
- [ ] update `AGENTS.md` Discord embeds section with the Send hold
  flow: Send → "Will send at HH:MM:SS" + Cancel-send button →
  Cancel/expire → "Sent" / "Cancelled"
- [ ] update `README.md` "Email watcher" section: extend the line about
  Draft reply with
  `"… → 30s Cancel-send hold (configurable via EMAIL_SEND_HOLD_SECONDS, 0 disables)"`

## Technical Details

### Why `EMAIL_SEND_HOLD_SECONDS=0` is allowed

Rollback through code requires a release cycle. Rollback through env
takes seconds (edit `.env` + supervisor restart picks it up). The
bypass path is functionally identical to pre-iter-3 behaviour, so if
the hold misbehaves in production the user has a true one-line escape.

### 15-min ephemeral expiry pre-check

Discord webhook tokens for ephemeral messages expire 15 minutes after
the originating interaction. If the user starts a Draft reply at
10:00, edits for 14 minutes, then Sends at 10:14, the timer would fire
at 10:14:30 and `editMessage('@original', ...)` would throw because
the token is expired.

Pre-check: `interaction.createdTimestamp + 15*60*1000 - Date.now() <
holdSeconds*1000 + 60_000` (60s buffer for clock skew + SMTP latency).
If true, refuse Send with a clear message; user clicks Draft reply on
the original urgent embed to get a fresh interaction.

This catches the issue at click time rather than failing silently 30s
later.

### Format of "Will send at HH:MM:SS"

`formatTime(ms)` = `new Date(ms).toLocaleTimeString('uk-UA', {hour:
'2-digit', minute: '2-digit', second: '2-digit'})`. Examples:
`"08:14:32"`, `"22:00:05"`. Locale stays Ukrainian (matches user) but
the output is identical to ISO `HH:MM:SS` shape for any 24-hour
locale; if it ever surfaces as 12-hour, switch to a manual format.

### Audit table schema

```sql
CREATE TABLE email_sent_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL CHECK(action IN ('sent','cancelled','error')),
  draft_id TEXT NOT NULL,
  to_addr TEXT NOT NULL,
  subject TEXT NOT NULL,
  error_message TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_email_sent_log_action_at ON email_sent_log(action, created_at DESC);
```

One row per terminal outcome (`sent` / `cancelled` / `error`). Lets
observation period answer questions with cheap SQL:

```sql
-- Cancel rate over last 14 days
SELECT
  100.0 * SUM(action='cancelled') / NULLIF(COUNT(*), 0) AS cancel_rate_pct
FROM email_sent_log
WHERE created_at > (strftime('%s','now') - 14*86400) * 1000;

-- Counts per day per action (last 14 days)
SELECT date(created_at/1000,'unixepoch') AS day, action, COUNT(*)
FROM email_sent_log
WHERE created_at > (strftime('%s','now') - 14*86400) * 1000
GROUP BY day, action ORDER BY day DESC, action;
```

### Failure modes (explicit list)

1. **SIGTERM during hold — known edge case, accepted.** The worker
   process gets SIGTERM (supervisor restart, manual stop, OS signal).
   Pending `setTimeout` handles are lost. If the timer hadn't fired
   yet, the email is silently dropped. The user sees a stale "Will
   send at …" ephemeral with no resolution. **No graceful disarmHold
   handler for MVP** — adding one means walking the
   `draftReplyService` map on SIGTERM and editing every pending
   ephemeral, which adds 20-30 lines + complexity for an edge case
   that hits maybe once a month. If a user reports it in field
   evidence, add then. Documented in `AGENTS.md`.

2. **SMTP fails after hold expires** — `email_sent_log` records
   `action='error'`, ephemeral updated to clamped error, state
   dropped. User has to click Draft reply on the original urgent
   embed to retry (loses Edit'ed body). Auto-retry deferred to iter
   3.5.

3. **Ephemeral expired (15 min after start)** — should be caught by
   pre-check at Send time. If somehow not (clock skew, deep buffer
   miss), the `editMessage` in `executeQueuedSend` throws; we
   try/catch with logger.warn. SMTP still completes; only the
   ephemeral update is lost. User has to check Sent folder to confirm
   delivery.

4. **Double Send click** — `deferUpdate` + `editReply` removes the
   Send button atomically from Discord's UI. Even if a second click
   slipped through (extreme race), `armHold`'s defensive
   `clearTimeout` on the previous timer prevents two SMTP calls
   firing from the same draft. The second arm wins; the first timer
   never executes.

### Why no live countdown

Discord rate-limits message edits to 5 per 5 seconds per channel. Six
edits in 30s is within the limit, but each is a network round trip,
each adds test surface, and each is a chance for rate-limit edge
cases. Absolute time (`"Will send at 10:00:30"`) gives the user a
concrete deadline without any updates after the initial edit. If
field evidence shows users miss a ticking countdown, add in iter 3.5.

### Env var `EMAIL_SEND_HOLD_SECONDS` bounds

- Lower bound **0**: bypass mode (instant send). Kill switch.
- Upper bound 300 (5 min): keeps comfortably under Discord's 15-min
  ephemeral window with margin for the 60s pre-check buffer.
- Default 30: matches the strategic plan and Gmail's "Undo Send"
  range.

## Post-Completion

*No checkboxes — humans living with the feature.*

**Manual verification:**
- Trigger an urgent ping → Draft reply → review → Send.
  Verify ephemeral shows "Will send at HH:MM:SS" + Cancel button.
- Click Cancel within 30s. Verify ephemeral → "Cancelled" + Gmail
  Sent folder shows no new message.
- Trigger another draft, Send, wait 30s without clicking. Verify
  ephemeral → "Sent" + Gmail Sent folder shows the message.
- Open `.env`, set `EMAIL_SEND_HOLD_SECONDS=0`, restart, repeat — Send
  should now be instant, ephemeral skips "Will send at …" and goes
  straight to "Sent" or error.

**Observation queries** (run after a week of normal use):
```sql
-- Did the user ever Cancel?
SELECT action, COUNT(*) FROM email_sent_log
WHERE created_at > (strftime('%s','now') - 7*86400) * 1000
GROUP BY action;

-- Cancel-to-sent ratio (decide if hold is earning its keep)
SELECT
  ROUND(100.0 * SUM(action='cancelled') / NULLIF(COUNT(*), 0), 1)
    AS cancel_pct
FROM email_sent_log
WHERE created_at > (strftime('%s','now') - 14*86400) * 1000;
```

**Decision rules after observation period:**
- **Cancel rate > 10%** → hold is earning its keep, keep at 30s, no
  changes.
- **Cancel rate 1-10%** → hold provides psychological insurance only
  (rarely used but reduces friction). Keep, deprioritize iter 3.5
  improvements.
- **Cancel rate 0%** in 14 days of normal traffic → user never needed
  the undo. Either drop the feature (set default to 0, mark for
  removal) or shorten to 10s. Decide based on subjective comfort.
- **SMTP errors during hold expiry** → iter 3.5 adds auto-retry +
  restore Send button.
- **User complains about losing edits after Cancel** → iter 3.5 adds
  "Send anyway" / "Restart draft" buttons after Cancel.
