# Email `/why` + Shut up — Pain #1, Iteration 5

## Overview

Fifth slice of "Pain #1 — Email triage" from the strategic roadmap
([2026-05-27-toward-ideal-r2.md](../superpowers/plans/2026-05-27-toward-ideal-r2.md)).

**Goal:** add transparency + manual control on top of the urgent flow.

Two surfaces:

1. **`🙈 Shut up` buttons** on the `emailUrgent` embed (alongside
   `Draft reply`):
   - `🙈 Sender` → ephemeral with four TTL buttons (1d / 7d / 30d / forever) → on
     click, store a suppression rule keyed on the email's `from_addr`.
   - `🙈 Subject` → modal with the current subject pre-filled (editable to a
     substring) + a days field → submit stores a rule keyed on the subject
     substring. Default days = 7.
   
   When the next email arrives that matches an active rule, `emailUrgent`
   skips the ping. Rules auto-expire after their TTL (except `forever`).

2. **`/why` slash command** showing why the current top-of-mind urgent
   email got the urgent treatment:
   - Default: pulls the most recent `email_pending` row with non-null
     `urgent_pinged_at` (i.e. last urgent ping).
   - Optional arg `id:<n>` to inspect a specific row.
   - Shows: scorer-derived `importance`, recent history from the same
     sender (last 7 days: pings sent, drafts opened, sends, cancellations,
     errors — from `email_sent_log` + `email_pending`), active suppression
     rule if any.

**Why this slice:**
- Closes the observability gap for Pain #1 — user can ask "why this?" and
  get a structured answer instead of guessing.
- Explicit per-sender / per-pattern control reduces noise without waiting
  for iter 4's implicit feedback machinery.
- Stored suppression rules + history view become the substrate iter 4 will
  learn from — explicit signal first, implicit signal later.

**Out of scope (deferred):**
- `/triage stats` (week summary of pings / cancels / errors / suppression
  hits) — iter 5.5.
- Implicit feedback / threshold tuning (iter 4).
- Scorer prompt changes — we keep importance scoring as-is; `/why` shows
  only fields the scorer already provides.
- Suppression by sender domain (`@domain` wildcard) — iter 5.5 if needed.
- Editing rule TTL after creation (must delete + recreate via `/suppressions` for now).
- Per-row scorer-reasoning text — current scorer returns only `importance`
  number; reasoning text would be a separate scorer-prompt change with the
  same risk/reward analysis we did in iter 1.

**Key design decisions baked into this plan:**
- **One new table** `email_suppression_rules` (sender pattern OR subject
  substring) with TTL. Existing `email_pending` and `email_sent_log`
  untouched.
- **TTL UI through Discord buttons** for sender (no modal — ephemeral with
  4 quick-pick buttons). **Modal only for subject** (because we need a text
  input to edit the substring). Different paths because Discord modals
  don't support radio buttons.
- **`forever` is stored as NULL `expires_at`**, not a sentinel. SQL is
  cleaner: `WHERE expires_at IS NULL OR expires_at > now`.
- **Subject match: case-insensitive `LIKE %substring%`**. No regex.
  Substring match is enough for "Order shipped", "Account alert", "Your
  invoice". Regex would be overkill + a parsing/validation problem.
- **Trigger gate**: `emailUrgent.trigger()` calls a new
  `findActiveSuppressionMatch(sender, subject, now)` before
  `findUnpingedUrgent`. If a rule matches the candidate row, the row is
  marked `urgent_pinged_at = -1` (sentinel for "suppressed by rule") and
  the trigger returns false. This:
  - Keeps the row out of further urgent attempts (no re-trigger loop).
  - Still allows the digest path to surface it later (digest doesn't filter
    on `urgent_pinged_at`).
  - Makes `/why` able to show "this row was suppressed by rule X" by
    detecting `urgent_pinged_at = -1`.
- **`/why` reads only**, doesn't change DB state. Idempotent.

## Context (from discovery)

Files involved (existing patterns to reuse):

**Existing:**
- `packages/server/src/emails/store.ts` — `findUnpingedUrgent`,
  `markUrgentPinged` (iter 1). Add new methods for suppression rules.
- `packages/server/src/emails/sent-log.ts` — `record`, `countLastDays`
  (iter 3). Add `findLastN(sender, days)` or `listBySender(sender, since)`
  for history view in `/why`.
- `packages/server/src/cognition/handlers/emailUrgent.ts` — extend
  trigger to check active suppression rule before standard logic. Mark
  matched rows with sentinel `urgent_pinged_at = -1`.
- `packages/server/src/channels/discord/embeds.ts` —
  `buildUrgentEmailEmbed` adds two new buttons (`🙈 Sender`, `🙈 Subject`)
  to the existing action row. (Discord allows up to 5 buttons per row;
  current row has `Draft reply` only.)
- `packages/server/src/channels/discord/interactions.ts` — new
  `email_suppress` domain with actions `sender_start`, `sender_set_ttl`,
  `subject_start_modal`, `subject_submit`. Modal handler for subject.
- `packages/server/src/channels/discord/slash-commands.ts` —
  register new `/why` command with optional `id` integer arg.
- `packages/server/src/channels/discord/bot.ts` — wire new
  `emailSuppressionStore` into deps.
- `packages/server/src/db.ts` — new table + migration.
- `packages/server/src/index.ts` — construct store, pass deps.

**Patterns reused:**
- DB migration via `PRAGMA table_info` and `CREATE TABLE IF NOT EXISTS` —
  same as iter 1 (`urgent_pinged_at`) and iter 3 (`email_sent_log`).
- Button routing with `domain:action:params` — same as
  `email_draft:start:${id}`, `email_draft:cancelSend:${id}`.
- Modal pattern — same as iter 2 (`memconfirm_modal`) and iter 2 Edit
  draft modal.
- Ephemeral with quick-pick buttons — same shape as iter 2's draft Send /
  Edit / Cancel.
- Slash command registration — same as `/status`, `/reminders`,
  `/memory`.
- Service object pattern — same as `draftReplyService` (iter 2) and
  `emailSentLog` (iter 3).

Dependencies: no new npm packages.

## Development Approach

- **Testing approach**: **TDD** (tests first, then implementation).
- Complete each task fully before moving to the next.
- Tests are a required deliverable of every task.
- All tests must pass before starting next.
- Update this plan if implementation deviates (➕ for new sub-tasks,
  ⚠️ for blockers).
- Run scoped: `npm -w @r2/server test -- <pattern>`.

## Testing Strategy

- vitest only.
- In-memory SQLite (`initDb(':memory:')`) for store / repo / migration
  tests.
- Mocked Discord `ButtonInteraction`, `ModalSubmitInteraction`,
  `ChatInputCommandInteraction` — same patterns as
  `interactions.draft.test.ts` and existing slash-command tests.
- Fake timers (`vi.useFakeTimers`) for TTL-expiry tests.
- No integration tests against real Gmail.

## Progress Tracking

- Mark completed items with `[x]` immediately when done.
- Add newly discovered tasks with ➕ prefix.
- Document blockers with ⚠️ prefix.
- Update plan if scope changes mid-implementation.

## What Goes Where

- **Implementation Steps** (`[ ]` checkboxes): code, tests, docs.
- **Post-Completion** (no checkboxes): manual verification, observation
  queries.

## Implementation Steps

### Task 1: DB migration — `email_suppression_rules` table

- [x] in `packages/server/src/db.ts`, add idempotent CREATE TABLE inside
  `initDb`:
  ```sql
  CREATE TABLE IF NOT EXISTS email_suppression_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_type TEXT NOT NULL CHECK(rule_type IN ('sender', 'subject')),
    pattern TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    created_via TEXT NOT NULL DEFAULT 'discord_button'
  );
  ```
- [x] add `CREATE INDEX IF NOT EXISTS idx_email_suppression_rules_type_pattern
  ON email_suppression_rules(rule_type, pattern)`
- [x] add `CREATE INDEX IF NOT EXISTS idx_email_suppression_rules_expires
  ON email_suppression_rules(expires_at)` (for periodic cleanup if needed
  later — out of scope for this iter, but free with the index)
- [x] write tests in `packages/server/src/__tests__/db.test.ts`:
  - table exists after `initDb` (via `PRAGMA table_info`)
  - both indices exist (via `sqlite_master`)
  - running `initDb` twice is idempotent (no error)
- [x] run `npm -w @r2/server test -- db.test` — must pass before task 2

### Task 2: Suppression store + match logic

- [x] create `packages/server/src/emails/suppression-store.ts` exporting
  `createEmailSuppressionStore({ db })` returning:
  - `insertRule({rule_type, pattern, ttl_days | null}): InsertedRule`
    where `ttl_days = null` → `expires_at = null`, else `expires_at =
    now + ttl_days*86400000`. Returns the inserted row id + computed
    `expires_at`.
  - `findActiveMatch(sender, subject, now): Rule | null` — returns the
    most recently-created active rule that matches (sender match by exact
    equality with the `pattern`; subject match by case-insensitive
    `LIKE '%' || pattern || '%'`). Active = `expires_at IS NULL OR
    expires_at > now`. Returns null when no match.
  - `listActive(now): Rule[]` — for future `/suppressions` command and
    `/why` display.
  - `deleteRule(id): boolean` — for future explicit removal.
- [x] write tests in
  `packages/server/src/emails/__tests__/suppression-store.test.ts`:
  - `insertRule(sender)` writes row with computed `expires_at`
  - `insertRule(sender, ttl_days=null)` writes row with NULL `expires_at`
  - `findActiveMatch` returns null on empty table
  - `findActiveMatch` matches by exact sender
  - `findActiveMatch` matches by case-insensitive subject substring
  - `findActiveMatch` skips expired rules (advance fake timer past
    `expires_at`)
  - `findActiveMatch` keeps `forever` rules active indefinitely
  - `findActiveMatch` prefers most recent rule when multiple match
  - `listActive` excludes expired
  - `deleteRule` returns true on hit, false on miss
- [x] run `npm -w @r2/server test -- suppression-store.test` — must
  pass before task 3

### Task 3: `emailUrgent` trigger gate + sentinel marking

- [x] in `packages/server/src/cognition/handlers/emailUrgent.ts`,
  modify `trigger`:
  - same quiet-hours check first
  - call `store.findUnpingedUrgent()` to get the candidate row
  - if `row === null` → return false (same as now)
  - call `suppressionStore.findActiveMatch(row.from_addr, row.subject, ctx.firedAt)`
  - if a rule matches → call `store.markUrgentPinged(row.id, -1)` (use
    sentinel `-1` to mean "suppressed by rule") and return false. This
    keeps the row out of subsequent urgent attempts and lets `/why`
    detect suppression.
  - if no rule matches → return true (handler runs, sends embed as
    before)
- [x] update `store.markUrgentPinged` to allow `-1` as well as positive
  epoch ms (just store the value as-is; no validation change needed,
  but document in code comment why `-1` is a valid input)
- [x] add deps `suppressionStore` to the `createEmailUrgentHandler`
  factory signature
- [x] write tests in
  `packages/server/src/cognition/__tests__/handlers/emailUrgent.test.ts`:
  - existing tests still pass (no suppression registered → behavior
    unchanged)
  - with a matching sender rule → trigger returns false, row's
    `urgent_pinged_at` is now `-1`, no SMTP / embed
  - with a matching subject rule → same as sender
  - with a non-matching rule + matching row → trigger returns true (rule
    for different sender doesn't suppress)
  - with an expired rule (created earlier, TTL past) → trigger returns
    true (expired rules don't suppress)
- [x] run `npm -w @r2/server test -- emailUrgent.test
  suppression-store.test` — must pass before task 4

### Task 4: Embed buttons + `email_suppress` button routing (sender path)

- [x] in `packages/server/src/channels/discord/embeds.ts`, extend
  `buildUrgentEmailEmbed(row)` to add two new secondary buttons after
  the existing primary `Draft reply`:
  - `🙈 Sender` with custom id `email_suppress:sender_start:${row.id}`
  - `🙈 Subject` with custom id
    `email_suppress:subject_start:${row.id}`
  (still under the 5-button-per-row Discord limit)
- [x] in `packages/server/src/channels/discord/interactions.ts`, add
  routing for `email_suppress` domain with action handlers:
  - `sender_start`: read the row from `emailStore` by id; if row missing
    → ephemeral "Письмо больше недоступно" and return; otherwise post
    ephemeral with 4 buttons "1d / 7d / 30d / forever" custom ids
    `email_suppress:sender_set_ttl:${row.id}:1`, `…:7`, `…:30`,
    `…:0` (0 = forever).
  - `sender_set_ttl`: parse the row id and ttl from custom id; read the
    row to get `from_addr`; call
    `suppressionStore.insertRule({rule_type:'sender', pattern: from_addr,
    ttl_days: ttl===0 ? null : ttl})`; edit ephemeral to "🙈 Заглушён
    `${from_addr}` до `${expires_label}`" (use `formatExpiry` helper or
    "навсегда" if NULL). No buttons after.
- [x] write tests in
  `packages/server/src/channels/discord/__tests__/interactions.suppress.test.ts`
  (new file):
  - `sender_start` with missing row → "недоступно" message
  - `sender_start` with valid row → ephemeral with 4 TTL buttons,
    custom ids correct
  - `sender_set_ttl` with `7` → `insertRule` called with `ttl_days=7` and
    `pattern=row.from_addr`; ephemeral edited to confirmation
  - `sender_set_ttl` with `0` → `insertRule` called with `ttl_days=null`
    (forever); ephemeral shows "навсегда"
- [x] run `npm -w @r2/server test -- interactions.suppress.test` — must
  pass before task 5

### Task 5: Subject path — modal flow

- [x] in `interactions.ts`, add handler `subject_start_modal`:
  - read row; if missing → "недоступно" and return
  - present a Discord modal with custom id
    `email_suppress:subject_submit:${row.id}` and two text inputs:
    - `substring` (default value = current subject, max length 200,
      label "Шаблон для блокировки (substring)")
    - `days` (default `"7"`, max length 3, label "Дней (0 = forever)")
- [x] add handler `subject_submit` (modal submit):
  - parse `substring` (trim, lowercase comparison is done at match
    time; but store as the user entered it). If empty → editReply "Пустой
    шаблон не сохраняется" and return.
  - parse `days` as int; if not a valid 0-365 int → editReply "Введите
    число от 0 до 365" and return.
  - call `insertRule({rule_type:'subject', pattern: substring,
    ttl_days: days===0 ? null : days})`
  - editReply "🙈 Заглушены письма с темой `«${substring}»` до
    `${expires_label}`"
- [x] write tests in `interactions.suppress.test.ts`:
  - `subject_start_modal` builds modal with correct prefill
  - `subject_submit` with valid input → rule inserted; confirmation
    ephemeral
  - `subject_submit` with empty substring → no insert; error message
  - `subject_submit` with non-numeric days → no insert; error message
  - `subject_submit` with `days=0` → `ttl_days=null`; "навсегда" in
    message
- [x] run `npm -w @r2/server test -- interactions.suppress.test` —
  must pass before task 6

### Task 6: `/why` slash command

- [x] in
  `packages/server/src/channels/discord/slash-commands.ts`,
  register a new `/why` command (alongside `/clear`, `/status`,
  `/reminders`, etc.) with an optional integer arg `id` (the
  `email_pending.id` to inspect).
- [x] new method on `emailSentLog` if missing:
  `listBySender(sender, sinceMs): EmailSentLogRow[]` (or
  `countBySender(sender, sinceMs, action)`). Test as part of this task.
- [x] new method on `emailStore`: `getById(id): EmailPendingRow | null`
  (if not already present) and `findMostRecentUrgent(): EmailPendingRow |
  null` (most recent row with `urgent_pinged_at` not null and != -1, i.e.
  successfully pinged). Tests as part of this task.
- [x] handler in
  `packages/server/src/channels/discord/command-service.ts` or wherever
  slash commands route through:
  - if arg `id` provided → `emailStore.getById(id)`. If null → reply
    "Письмо с id=`${id}` не найдено."
  - else → `emailStore.findMostRecentUrgent()`. If null → reply
    "Недавних urgent писем нет."
  - if row's `urgent_pinged_at === -1` → row was suppressed; reply
    explains which rule matched (find via `suppressionStore.listActive`
    + match check).
  - else (normal urgent):
    - Read row + history:
      - `from`, `subject` (truncated to ~100), `importance` (always 5 in
        current scorer — show literally so future scale changes are
        visible)
      - `received_at` — "получено `${HH:MM DD.MM}`"
      - `urgent_pinged_at` if positive — "ping `${HH:MM}`"
      - history from same sender (last 7 days):
        `emailStore.countPendingFromSender(from_addr, sinceMs)` —
        new method, tests as part of this task; **count distinct
        `email_pending` rows**, irrespective of action
      - `email_sent_log.countLastDays('sent' | 'cancelled' | 'error',
        7)` filtered by sender — use new
        `emailSentLog.countBySender(sender, days, action)` or
        equivalent
      - active suppression rule that *would* match this row going forward
        (call `suppressionStore.findActiveMatch(from, subject, now)` —
        same call the trigger uses)
    - format a single embed:
      ```
      🔍 Why this is urgent
      From: ${from}
      Subject: ${subject_truncated}
      Importance: 5/5 — received ${HH:MM DD.MM} — pinged ${HH:MM}
      
      Прошлые 7 дней с этого отправителя:
        пингов: N — отправлено: K — отменено: M — ошибок: E
      
      Активное правило заглушения: <text or "—">
      ```
    - reply ephemerally (only the user sees it).
- [x] write tests in
  `packages/server/src/channels/discord/__tests__/command-service.why.test.ts`
  (new file):
  - `/why` (no arg) with no urgent rows → "Недавних urgent писем нет"
  - `/why` (no arg) with one normal urgent → embed shows row + 0-count
    history
  - `/why id:N` with non-existent id → "не найдено"
  - `/why id:N` with suppressed row (urgent_pinged_at = -1) → embed
    explains suppression rule
  - `/why id:N` with row + 3 prior pings + 1 sent + 1 cancelled in 7
    days → counts in embed
  - `/why id:N` with row + active matching sender rule → "Активное
    правило" line shows pattern + expiry
- [x] run `npm -w @r2/server test -- command-service.why.test` — must
  pass before task 7

### Task 7: Wire into `index.ts` + bot.ts

- [x] in `packages/server/src/index.ts`, construct
  `emailSuppressionStore = createEmailSuppressionStore({db})` and pass
  it into:
  - `createEmailUrgentHandler({store, suppressionStore, tz, quietStart})`
  - bot deps (so interaction handlers and slash command can use it)
- [x] in `bot.ts`, accept `emailSuppressionStore: EmailSuppressionStore`
  in deps type, thread to interaction handlers + slash command service
- [x] register the new slash command on bot startup (next to existing
  `/clear`, `/status`, `/reminders`, etc.)
- [x] write integration test in
  `packages/server/src/__tests__/email-suppress-flow.integration.test.ts`:
  - seed two `email_pending` rows from same sender, both importance=5,
    `urgent_pinged_at=NULL`
  - simulate `sender_set_ttl:row1.id:7` interaction → rule inserted
  - run `emailUrgent.trigger()` for next tick → trigger returns false
    (second row would have matched but was suppressed by rule)
  - assert second row's `urgent_pinged_at` is now -1
  - run `/why id:row2.id` → embed shows "Suppressed by rule" message
- [x] run `npm -w @r2/server test -- email-suppress-flow.integration` —
  must pass before task 8

### Task 8: Acceptance + docs

- [x] run full server test suite (`npm -w @r2/server test`) — all green
- [x] run TypeScript build (`npm -w @r2/server run build`) — no errors
- [x] verify backward compatibility: existing `emailUrgent` /
  `email_draft` / `email_sent_log` tests still pass
- [x] update `AGENTS.md` Discord section: document `/why` slash command
  and `🙈 Sender` / `🙈 Subject` buttons
- [x] update `README.md` "Email watcher" section: add a one-line note
  about transparency + suppression

## Technical Details

### `email_suppression_rules` schema

| column        | type    | nullable | default              | meaning                                  |
|---------------|---------|----------|----------------------|------------------------------------------|
| `id`          | INTEGER | NO       | autoincrement        | row id                                   |
| `rule_type`   | TEXT    | NO       | —                    | `'sender'` or `'subject'`                |
| `pattern`     | TEXT    | NO       | —                    | from_addr (sender) or substring (subject)|
| `created_at`  | INTEGER | NO       | —                    | epoch ms                                 |
| `expires_at`  | INTEGER | YES      | NULL                 | NULL = forever; else epoch ms            |
| `created_via` | TEXT    | NO       | `'discord_button'`   | provenance for future analysis           |

### Active match query

```sql
SELECT * FROM email_suppression_rules
WHERE (rule_type = 'sender' AND pattern = ?)                     -- sender exact
   OR (rule_type = 'subject' AND ? LIKE '%' || lower(pattern) || '%')  -- subject substring (case-insensitive)
   AND (expires_at IS NULL OR expires_at > ?)
ORDER BY id DESC LIMIT 1;
```

Both sides of subject `LIKE` are lower-cased in the query (`lower(? subject_input)` vs `lower(pattern)`) for case insensitivity. Sender match is exact case-sensitive (most senders are lower-case anyway).

### Why a sentinel `urgent_pinged_at = -1`

- Row stays out of `findUnpingedUrgent`'s candidate set (the query
  filters `urgent_pinged_at IS NULL` — `-1` is not null, so excluded).
- Row stays available for the digest path (digest doesn't filter on this
  column).
- `/why` distinguishes "normal urgent ping" from "suppressed before
  ping" by checking the sentinel.
- No new column needed; the value space (`NULL` / positive epoch ms /
  `-1`) is enough.

### Button layout for the urgent embed

Current: `[Draft reply]`
After iter 5: `[Draft reply] [🙈 Sender] [🙈 Subject]`

Three primary/secondary buttons in one row — under the 5-per-row limit.

### TTL format

- 4 quick-pick buttons for sender: `1d / 7d / 30d / forever`
- Modal for subject: `days` text input, accepts 0-365 (0 = forever)
- `0` in either UI maps to `expires_at = NULL`

### `/why` embed example

```
🔍 Why this is urgent
From: alerts@bank.com
Subject: Large transaction notice
Importance: 5/5 — received 14:32 28.05 — pinged 14:33

Прошлые 7 дней с этого отправителя:
  пингов: 3 — отправлено: 1 — отменено: 0 — ошибок: 0

Активное правило заглушения: —
```

### Failure modes

- **Row deleted between embed and button click** — `sender_start` /
  `subject_start` handler checks; if row missing → friendly "недоступно"
  message. No DB writes.
- **Modal submit with invalid days** — handler validates 0-365, error
  ephemeral, no insert. User can re-trigger.
- **Suppression rule + new email arriving from same sender** — caught by
  trigger gate, row marked `-1`, no embed. Working as designed.
- **Rule expires while pending email sits in queue** — at next tick,
  `findActiveMatch` returns null, `findUnpingedUrgent` returns the row
  (because its `urgent_pinged_at` is `-1`, **not** NULL). Wait —
  **this is a bug if we don't fix `findUnpingedUrgent`**: a row marked
  `-1` then becomes stuck even after its rule expired. **Acceptable for
  MVP** because (a) the user can re-trigger Draft reply by sending a
  new email; (b) old urgent emails after their rule expires are usually
  stale anyway. **Document as known limitation.** Iter 5.5 may add a
  cleanup job that scans `email_pending` for `urgent_pinged_at = -1`
  rows whose suppressing rule has expired and resets them to NULL.
- **`/why` for the most recent urgent when none exists** — friendly
  empty-state message, no crash.
- **`/why` invoked by non-whitelisted user** — slash command is already
  gated by Discord's whitelist at registration time, so this doesn't
  happen in practice; if it does, the bot just doesn't respond.

## Post-Completion

*No checkboxes — humans living with the feature.*

**Manual verification:**
- Trigger an urgent email, click `🙈 Sender`, choose `7d`. Verify
  ephemeral confirms.
- Insert a synthetic email from same sender (via SQL) — verify trigger
  fires, finds no candidate (or marks `-1`).
- Wait for next tick → verify no Discord embed for that sender.
- Run `/why` — verify embed shows the past urgent + history + active
  rule.
- Trigger urgent email, click `🙈 Subject`, modify substring in modal,
  pick `1d`. Verify rule inserted with subject substring + 1-day TTL.
- Run `/why id:<n>` for a suppressed row → verify the embed explains
  which rule blocked it.

**Observation queries:**
```sql
-- How often is each rule actually hitting?
SELECT rule_type, pattern,
  (SELECT COUNT(*) FROM email_pending p
   WHERE p.urgent_pinged_at = -1
     AND ( (s.rule_type='sender' AND p.from_addr = s.pattern)
        OR (s.rule_type='subject' AND lower(p.subject) LIKE '%' || lower(s.pattern) || '%') )
  ) AS hits,
  datetime(created_at/1000, 'unixepoch', 'localtime') AS created
FROM email_suppression_rules s
WHERE expires_at IS NULL OR expires_at > strftime('%s','now')*1000
ORDER BY hits DESC;

-- Currently active rules
SELECT id, rule_type, pattern,
  CASE WHEN expires_at IS NULL THEN 'forever'
       ELSE datetime(expires_at/1000,'unixepoch','localtime')
  END AS expires
FROM email_suppression_rules
WHERE expires_at IS NULL OR expires_at > strftime('%s','now')*1000
ORDER BY id DESC;
```

**Decision rules after 1-2 weeks of use:**
- If many rules become `forever` after first 7-day cycle → confirms TTL
  value; iter 5.5 might add easier "extend by Nd" button on `/why`
  embed.
- If almost no rules created → users find no senders annoying enough; OK
  to leave as-is.
- If `forever` dominates → consider `/suppressions list` + `/suppressions
  remove <id>` for explicit removal (iter 5.5).
- If `/why` not used → low-value; can stay, no cost when idle.
