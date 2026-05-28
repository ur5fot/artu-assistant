# Email Draft Reply — Pain #1, Iteration 2

## Overview

Second slice of "Pain #1 — Email triage" from the strategic roadmap
([2026-05-27-toward-ideal-r2.md](../superpowers/plans/2026-05-27-toward-ideal-r2.md)).

**Goal:** when an `emailUrgent` ping appears in Discord, the embed has a
**"Draft reply"** button. Click → R2 fetches the full email thread via
IMAP (using `References` / `In-Reply-To` headers), generates a context-aware
draft via Claude, posts an ephemeral Discord message with the draft and
**Send / Edit / Cancel** buttons. Send goes via SMTP using the same Gmail
app password already configured for IMAP.

**Why this slice:**
- One-click drafts are the highest-leverage extension of iter 1 — the
  user already sees urgent emails; now they can respond with one tap.
- Reuses iter 1's `emailUrgent` handler — no new triggering logic.
- SMTP send unlocks future iterations: hold-zone (iter 3), auto-reply
  for specific senders (later), morning catch-up reply (later).

**Out of scope (later iterations):**
- 30-second send hold zone with cancel (iter 3)
- Implicit feedback / threshold tuning (iter 4)
- `/why` + explicit "shut up" rules (iter 5)
- Draft reply on `emailDigest` entries (only urgent embed gets the button)
- HTML body composition (plain text only)
- Attachments in reply

**Key design decisions baked into this plan:**
- **Full thread context** — fetch all related messages via References /
  In-Reply-To. Heavier than single-message but matches user's choice
  for higher draft quality.
- **HandlerResult extension** — extend the cognition `HandlerResult`
  union to include optional `embed` + `components`. emailUrgent stays a
  regular handler; bot.ts dispatches plain text vs embed based on shape.
- **Pending draft state** — in-memory `Map<interactionId, DraftState>`
  service mirroring the `memory-confirm-service` pattern. Drafts are
  lost on restart — intentional (force user to redo, not persist
  half-written replies).
- **Nodemailer** as SMTP client (de-facto standard, well-tested).
- **Claude one-shot** (no tool loop) for draft generation — single
  `anthropic.messages.create()` call.
- **Reply language** follows the language of the email being replied to
  (LLM auto-detects from thread).

## Context (from discovery)

Files involved (new + extended):

**New:**
- `packages/server/src/emails/smtp-client.ts` — `sendReply({account, to, subject, body, inReplyTo, references})`.
- `packages/server/src/emails/thread-fetcher.ts` — fetch full thread by walking References/In-Reply-To headers.
- `packages/server/src/services/draft-reply-service.ts` — pending draft state Map, mirroring `memory-confirm-service`.
- `packages/server/src/cognition/handlers/__tests__/emailUrgent.embed.test.ts` — new test file for embed shape.
- Tests mirroring each new module.

**Extended:**
- `packages/server/src/emails/imap-client.ts` — add `fetchHeaders(uid)` returning `Message-ID`, `References`, `In-Reply-To`. Possibly extend `fetchFullBody` to return same.
- `packages/server/src/cognition/types.ts` — extend `HandlerResult` (publish branch) with optional `embed?: EmbedBuilder | EmbedData` and `components?: ActionRowBuilder<ButtonBuilder>[]`.
- `packages/server/src/cognition/handlers/emailUrgent.ts` — return `embed` + `components` instead of (or alongside) plain `content`. Encodes urgent email row id in the button's customId so the handler can find it.
- `packages/server/src/channels/discord/bot.ts:1025` — `cognition_publish` listener checks for embed/components, sends as rich message; falls back to plain text.
- `packages/server/src/channels/discord/embeds.ts` — new builders `buildUrgentEmailEmbed(row)` and `buildDraftReplyEmbed(state)`.
- `packages/server/src/channels/discord/interactions.ts` — new button domain `email_draft` with actions `start`, `send`, `edit`, `cancel`. Modal handler for edit.
- `packages/server/src/index.ts` — wire `draftReplyService`, pass into bot deps.
- `packages/server/package.json` — add `nodemailer` dependency + `@types/nodemailer`.
- `.env.example` — document SMTP reuse of IMAP app password (no new env, just clarify).

Patterns to copy:
- Button + embed builders: `embeds.ts:15-56` (reminder buttons), `embeds.ts:66-106` (permission state machine).
- Button routing: `interactions.ts:81-292`. Domain prefix in customId, `splitCustomId` parser.
- Modal: `interactions.ts:241-268` (memory-confirm Edit modal).
- Pending state: `memory-confirm-service.ts` + `pendingMemoryConfirms` Map.
- Ephemeral reply: `interactions.ts:86-89` (`MessageFlags.Ephemeral`).
- Claude one-shot: `morningBrief.ai.ts:52-147`.
- Mocking nodemailer in tests: standard `vi.fn()` + `nodemailer.createTransport` stub.

Dependencies:
- New npm: `nodemailer` + `@types/nodemailer`. No other additions.
- Reuse: existing PII proxy (don't strip — outbound draft should be raw; but the **prompt** sent to Claude for drafting goes through PII proxy if `MEMORY_TEXT_PROVIDER=claude` and `MEMORY_ALLOW_REMOTE_PII` isn't set — same rule as memory).

## Development Approach

- **Testing approach**: **TDD** (tests first, then implementation).
- Complete each task fully before moving to the next.
- Tests are a required deliverable of every task, not optional.
- All tests must pass before starting the next task.
- Update this plan if implementation deviates from scope (➕ for new sub-tasks, ⚠️ for blockers).
- Run scoped: `npm -w @r2/server test -- <pattern>`.

## Testing Strategy

- vitest only.
- `initDb(':memory:')` per test for DB-touching code.
- `imapflow` mocked via object stub for thread-fetching tests (no real IMAP).
- `nodemailer.createTransport` mocked via `vi.fn()` returning a stub
  with `sendMail` — verify call args, never network.
- Anthropic SDK mocked the same way as in `morningBrief.ai.test.ts`.
- Discord client mocked (no `discord.js` connect). The bot already has
  test patterns for this.
- No integration tests against real Gmail.

## Progress Tracking

- Mark completed items with `[x]` immediately when done.
- Add newly discovered tasks with ➕ prefix.
- Document blockers with ⚠️ prefix.
- Update this plan if scope changes mid-implementation.

## What Goes Where

- **Implementation Steps** (`[ ]` checkboxes): code, tests, docs.
- **Post-Completion** (no checkboxes): manual verification with a real
  Gmail account, observation period notes.

## Implementation Steps

### Task 1: SMTP client module (`smtp-client.ts`)

- [x] add `nodemailer` + `@types/nodemailer` to `packages/server/package.json`
- [x] create `packages/server/src/emails/smtp-client.ts` exporting
  `sendReply(params)` where params: `{account: ImapAccount, to: string,
  subject: string, body: string, inReplyTo: string | null, references:
  string[]}`. Uses `nodemailer.createTransport({host, port: 465, secure:
  true, auth: {user, pass}})` derived from the IMAP account (Gmail SMTP
  uses same app password). Sends with `From: account.user`, proper
  `Subject` (auto-prepend "Re: " if not present), `In-Reply-To` and
  `References` headers (CRLF-separated, max ~10 last refs per RFC 5322).
- [x] inject `transport` factory for testability (default
  `nodemailer.createTransport`, can be swapped in tests).
- [x] write tests in `packages/server/src/emails/__tests__/smtp-client.test.ts`:
  - sendMail called with expected `from`, `to`, `subject` (Re: prepend
    when absent, kept when present)
  - `In-Reply-To` header set when provided; absent when null
  - `References` joined per RFC 5322; truncated to last 10 if longer
  - returns delivery info on success
  - throws (and bubbles) on `sendMail` rejection (don't swallow — caller
    handles)
- [x] run `npm -w @r2/server test -- smtp-client.test` — must pass before task 2

### Task 2: IMAP thread fetcher (`thread-fetcher.ts`)

- [x] in `packages/server/src/emails/imap-client.ts`, add
  `fetchHeaders(account, uid): Promise<{messageId: string | null, inReplyTo: string | null, references: string[]}>` using imapflow's
  `headers: true` fetch option; parse the three headers (case-insensitive,
  values may be wrapped). References can be space- or newline-separated;
  preserve order, dedupe.
- [x] also expose `fetchByMessageId(account, messageId): Promise<NewMessage | null>` — IMAP search by `HEADER Message-ID <id>`.
- [x] create `packages/server/src/emails/thread-fetcher.ts` exporting
  `fetchThread(account, uid): Promise<NewMessage[]>` which:
  1. fetches current message headers (`fetchHeaders(uid)`)
  2. for each id in `References` (in order, ascending), calls
     `fetchByMessageId` and collects results
  3. appends the current message
  4. returns oldest-first array; missing refs are silently skipped
     (refs may point to messages outside INBOX, e.g. in Sent)
  5. hard cap: max 20 messages in thread (defensive — most threads
     are < 10; protects against pathological cases)
- [x] write tests in
  `packages/server/src/emails/__tests__/thread-fetcher.test.ts`:
  - single message (no References) → array of 1
  - 3-message thread → array of 3 in order
  - missing reference (search returns null) → silently skipped, no throw
  - cap at 20 (synthetic test with 30 refs → returns 20)
  - dedupe (same id appearing in References and current) → no duplicates
- [x] write tests for `fetchHeaders` parsing (mocked imapflow returning
  raw header strings) — success + missing fields + wrapped values
- [x] run `npm -w @r2/server test -- thread-fetcher.test imap-client.test` — must pass before task 3

### Task 3: HandlerResult extension + emailUrgent returns embed + bot dispatches

- [x] in `packages/server/src/cognition/types.ts`, extend the
  `publish: true` branch of `HandlerResult` with optional fields:
  `embed?: EmbedData` (plain object shape, not the builder, to keep
  cognition layer free of discord.js — bot.ts builds the actual
  `EmbedBuilder` from this data), `components?: ComponentData[]` where
  `ComponentData = {type: 'row', buttons: ButtonData[]}`. ButtonData =
  `{customId: string, label: string, style: 'primary'|'secondary'|'danger'|'success', emoji?: string}`.
- [x] in `packages/server/src/channels/discord/embeds.ts`, add
  `buildUrgentEmailEmbed(row: EmailPendingRow)` returning `{embed,
  components}` (plain data) — title `🚨 Urgent email`, fields with from /
  subject / snippet, one component row with single button `Draft reply`
  (style: primary, customId: `email_draft:start:${row.id}`).
- [x] update `packages/server/src/cognition/handlers/emailUrgent.ts` to
  return `{publish: true, content: '', embed, components, onPublished}`
  using `buildUrgentEmailEmbed(row)`. Keep `content: ''` for the
  fallback path; bot.ts prefers embed when present.
- [x] update `packages/server/src/channels/discord/bot.ts:1025`
  `cognition_publish` listener: if event has `embed` field, build an
  `EmbedBuilder` from data and `ActionRowBuilder<ButtonBuilder>` from
  `components`, send via `dm.send({embeds:[built], components:[row]})`.
  Otherwise fall back to existing plain-text send.
- [x] write tests:
  - `buildUrgentEmailEmbed` shape: correct title, fields, button
    customId encoding (`emailUrgent.embed.test.ts`)
  - emailUrgent handler returns expected `embed` + `components` shape
    when row exists (update existing `emailUrgent.test.ts`)
  - bot.ts cognition_publish: text-only fallback still works (regression
    test); embed branch sends with embeds/components fields when present
    (new test or extend existing `cognition_publish` test if it exists)
- [x] run `npm -w @r2/server test -- emailUrgent cognition bot` — must pass before task 4

### Task 4: Draft reply flow — button click → ephemeral with draft

- [x] create `packages/server/src/services/draft-reply-service.ts`
  exporting:
  - `DraftState = {pendingId: string, originalUid: number, accountId: string, to: string, subject: string, inReplyTo: string | null, references: string[], body: string}`
  - `createDraftReplyService({pendingDrafts: Map<string, DraftState>})`
    returning `{put(state), get(id), drop(id), has(id)}`
- [x] in `packages/server/src/channels/discord/interactions.ts`, add new
  domain `email_draft` to `routeButton()` dispatcher. Action `start:${rowId}`:
  1. acknowledge interaction with `deferReply({ephemeral: true})` (gives 15 min to respond)
  2. load email pending row by id; if missing → reply ephemeral "пропало"
  3. call `imapClient.fetchHeaders(account, row.message_uid)` → get refs
  4. call `threadFetcher.fetchThread(account, row.message_uid)` → full thread oldest-first
  5. build Claude prompt: system = "You are R2's email draft writer. Compose a concise, natural reply matching the language of the thread. Plain text only. No greeting boilerplate, no signature." + user content = serialized thread (one `From: ... | Subject: ... | Body: ...` per message, separated by `---`) + current message highlighted
  6. call `anthropic.messages.create({model, max_tokens: 1024, system, messages: [{role:'user', content: prompt}]})` (use existing PII proxy if `MEMORY_ALLOW_REMOTE_PII` is required and unset — error in that case)
  7. extract text; if empty → ephemeral "не удалось сгенерировать черновик"
  8. compute `pendingId = nanoid()` (or `randomUUID()`), build DraftState
     with `to = parseFromAddress(row.from_addr)`, `subject = row.subject`,
     `body = generated text`, `inReplyTo = headers.messageId`,
     `references = [...headers.references, headers.messageId].filter(Boolean)`
  9. `draftReplyService.put(state)`
  10. edit the deferred reply: `editReply({content: '✏️ Черновик:\n\n' + body, components: [row with Send/Edit/Cancel buttons]})` where customIds are `email_draft:send:${pendingId}`, `email_draft:edit:${pendingId}`, `email_draft:cancel:${pendingId}`
- [x] inject deps: `interactions.ts` already has a deps record; add
  `draftReplyService`, `emailStore`, `imapClient`, `threadFetcher`,
  `anthropic`, and `imapAccounts` (id → account map for SMTP send later)
- [x] write tests in
  `packages/server/src/channels/discord/__tests__/interactions.draft.test.ts`:
  - happy path: button click → row loaded → thread fetched (mocked) →
    Claude returns draft → ephemeral edit with Send/Edit/Cancel buttons
  - row not found → ephemeral "пропало", no Claude call
  - thread fetch fails → ephemeral "не удалось загрузить тред"
  - Claude returns empty → ephemeral "не удалось сгенерировать"
  - draftReplyService.put called with expected state
- [x] run `npm -w @r2/server test -- interactions.draft` — must pass before task 5

### Task 5: Send / Edit (modal) / Cancel handlers

- [x] in `interactions.ts`, add handlers for `email_draft:send:${id}`,
  `email_draft:edit:${id}`, `email_draft:cancel:${id}`, and modal submit
  `email_draft_modal:${id}`.
- [x] **send**:
  1. `deferUpdate()` to ack
  2. `state = draftReplyService.get(id)`; if missing → editReply "истёк"
  3. resolve `account` from `state.accountId` via `imapAccounts.get(id)`
  4. call `smtpClient.sendReply({account, to, subject, body, inReplyTo, references})`
  5. on success → editReply `'✅ Отправлено'`, components: [] (clear buttons)
  6. `draftReplyService.drop(id)`
  7. on SMTP failure → editReply `'❌ Не отправилось: ${e.message}'`, keep buttons (allow retry)
- [x] **cancel**:
  1. `deferUpdate()`
  2. `draftReplyService.drop(id)` (silent no-op if missing)
  3. editReply `'❌ Отменено'`, components: []
- [x] **edit**:
  1. show ModalBuilder (no defer — modal must be the first ack)
  2. TextInputBuilder with `setValue(state.body)`, max 4000 chars
     (Discord modal limit)
  3. custom_id `email_draft_modal:${id}`
- [x] **modal submit `email_draft_modal:${id}`**:
  1. extract new body from modal input
  2. `draftReplyService.put({...state, body: newBody})`
  3. `editReply` the original ephemeral with new body + buttons preserved
     (implementation note: used ModalSubmitInteraction#update() — for
     component-triggered modals it edits the originating message, so the
     stored messageId isn't strictly needed for this path. Field is still
     populated as designed in case a fallback edit path is needed later.)
- [x] add `messageId` field to `DraftState` (set after editReply in task 4)
- [x] write tests:
  - send happy path: SMTP called with correct headers/body, drop called
  - send when state missing → editReply "истёк", no SMTP call
  - send when SMTP rejects → editReply with error, state NOT dropped
    (retry possible)
  - cancel → drop called, content `'❌ Отменено'`
  - edit → modal shown with prefilled body
  - modal submit → state body updated, editReply shows new body
- [x] run `npm -w @r2/server test -- interactions.draft` — must pass before task 6

### Task 6: Wire + acceptance + docs

- [ ] in `packages/server/src/index.ts`, instantiate `draftReplyService`
  near other services, pass into Discord bot deps along with
  `imapAccounts` map, `threadFetcher` (or `fetchThread` function),
  `smtpClient` (factory or instance), `anthropic`, `emailStore`,
  `imapClient`
- [ ] verify backward compat: `emailDigest` still publishes plain text
  (no embed); pre-existing handlers (morningBrief, pulseHandler) still
  work via plain-text path
- [ ] run full test suite (`npm -w @r2/server test`) — all green
- [ ] run TypeScript build (`npm -w @r2/server run build`) — no errors
- [ ] update `AGENTS.md`:
  - add `email_draft` button domain to the interactions list
  - add `draftReplyService` to the services list
  - add SMTP capability to the email section (one paragraph)
- [ ] update `README.md` "Email watcher" section: one paragraph on
  draft-reply flow (button → Claude → SMTP), note that no new env vars
  are required (SMTP reuses IMAP app password)

## Technical Details

### SMTP transport

```ts
nodemailer.createTransport({
  host: 'smtp.gmail.com',  // derived from account.host with imap→smtp swap
  port: 465,
  secure: true,
  auth: { user: account.user, pass: account.password },
});
```

For Gmail, IMAP host `imap.gmail.com` maps to SMTP `smtp.gmail.com`.
For iCloud, `imap.mail.me.com` → `smtp.mail.me.com`. Helper:
`smtpHostFor(imapHost: string): string` — simple replace of `imap` prefix
with `smtp`. Document this in code comment.

### Reply header construction

Per RFC 5322 §3.6.4:
- `In-Reply-To`: just the parent `Message-ID`
- `References`: chain of all ancestor `Message-ID`s, oldest-first, ending
  with `In-Reply-To`. Max ~10 to keep header reasonable (some servers
  truncate at 998 chars/line).

If we don't have `Message-ID` of the urgent email (header fetch failed
or absent), still send — just without those headers. Reply lands as a
new thread; acceptable degradation.

### Pending draft state lifetime

- In-memory `Map`, no persistence.
- Server restart → all pending drafts lost.
- No explicit TTL (Discord ephemeral messages auto-expire after 15 min
  if not edited; after that, button clicks return interaction-failed
  and we surface "истёк" via the state lookup).
- ➕ Future: optional persistence if drafts get long enough to be
  worth saving across restarts (iter 2.5).

### Component shape in cognition layer

To avoid leaking `discord.js` types into the cognition layer, the
handler returns plain data:

```ts
type ComponentData = {
  type: 'row';
  buttons: Array<{
    customId: string;
    label: string;
    style: 'primary' | 'secondary' | 'success' | 'danger';
    emoji?: string;
  }>;
};
```

bot.ts converts to `ActionRowBuilder<ButtonBuilder>` at the boundary.

### Why no 30-second hold zone yet

Iter 3. Currently, **Send is final** — once SMTP accepts, the email is
out. To minimize regret risk in this iteration:
- Edit modal allows tweaking before send.
- Cancel button disposes the draft entirely.
- Send confirmation message includes a clear "Отправлено" so the user
  knows it actually left.

## Post-Completion

*No checkboxes — manual + observation.*

**Manual verification (with a real Gmail account):**

1. Trigger an urgent email (forward yourself something marked
   `importance=5` by the scorer).
2. Click "Draft reply" on the Discord ping.
3. Verify ephemeral message appears with a sensible draft.
4. Click Edit, modify, submit modal — verify body updates in place.
5. Click Send — verify reply lands in the original sender's inbox AND
   appears in your Gmail Sent folder, threaded under the original.
6. Repeat with a Cancel — verify draft disposed, no email sent.

**Edge cases to live-test:**
- Reply to security alert from `no-reply@accounts.google.com` (the iter 1
  false positive batch) — SMTP send to a no-reply address should fail
  gracefully with the error displayed.
- Reply in a thread with > 5 prior messages — verify Claude uses thread
  context sensibly (not just last message).
- Reply in Russian to a Russian email — verify language matches.

**Observation metrics for iter 2:**
- Draft button click rate (vs urgent ping rate) — what % of urgent pings
  the user actually wants to act on?
- Draft acceptance rate (send / (send + edit + cancel)) — how good are
  raw drafts?
- Edit rate — high edit means draft quality needs work (prompt tweak).
- Send-to-cancel ratio — high cancel means false positives in urgent
  scorer are surfacing here.

These feed into iter 4 (implicit feedback) and into iter 1.5 if the
scorer needs tightening.

**External:** none — uses existing Gmail app password.
