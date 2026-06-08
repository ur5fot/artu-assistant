# Email Digest: Readability (HTML→text) + Inline Actions

## Overview

Two problems with the Discord email digest, fixed together:

1. **HTML leaks into previews.** When an email has no `text/plain` part, the snippet is built from the raw `text/html` body. `toSnippet`/`toBody` only collapse whitespace — tags are never stripped — so `<!DOCTYPE HTML ...>`, `<html lang=...>`, etc. show up in the digest. The same raw HTML is also fed to the LLM importance scorer, which can skew scoring.
2. **No actions in the digest.** The digest is plain text with no controls. Action infrastructure already exists but is wired only to urgent (importance=5) emails: draft reply (`email_draft:*`) and suppress sender/subject (`email_suppress:*`). The digest can't act on its emails.

**Solution.** Centralize an HTML→text pass at the single decode chokepoint (`decodePickedText`), which fixes the snippet, the scorer, `emails_get`, and the new "full text" action at once. Add a Discord string select-menu under the digest list: picking an email opens an **ephemeral** action card with four buttons — Разобрать / Ответить / Заглушить / Полный текст — reusing the existing `email_draft` and `email_suppress` handlers and adding two new ones (dismiss, full text).

**Benefits:** readable digest + readable scoring input + readable full-body view, and the digest becomes actionable without changing its compact one-message format.

## Context (from discovery)

Stack: TypeScript/Node monorepo, discord.js 14.26, vitest, better-sqlite3.

Files/components involved:
- `packages/server/src/emails/mime-decode.ts` — `pickTextPart` returns `PickedPart` which **already carries `.type`** (`text/plain` | `text/html`). `decodeBodyPart` does encoding/charset decode.
- `packages/server/src/emails/imap-client.ts` — **single decode chokepoint** `decodePickedText(buf, picked)` (line 48) is used by all three body paths: `fetchNewMessages` (snippet, line 218), `fetchByMessageId` (draft thread, line 404), `fetchFullBody` (full body, line 438). `toSnippet` (line 55), `toBody` (line 63).
- `packages/server/src/emails/__tests__/imap-client.test.ts` — existing test (~line 170-195) currently **asserts `<p>` survives in the snippet**; must flip to expect clean text.
- `packages/server/src/emails/scorer.ts` — consumes `row.snippet`; benefits automatically once snippet is clean.
- `packages/server/src/cognition/types.ts` — `HandlerResult` already supports `components?: ComponentData[]`. `ComponentData` is currently button-rows only (line 16-19); needs a select-menu variant.
- `packages/server/src/channels/discord/bot.ts` — `buildComponentsFromData` (~line 187) converts `ComponentData[]` → discord.js builders; `deliverCognitionPush` (~line 1143) already sends **plain-text content + components** (used today by morning brief / distractionPullback), so the digest's select-menu rides the existing path.
- `packages/server/src/cognition/handlers/emailDigest.ts` — handler `run` returns `{ publish, content, onPublished }`; add `components`.
- `packages/server/src/cognition/handlers/emailDigest.helpers.ts` — `formatDigest` returns `{ text, includedIds }`; add a menu builder.
- `packages/server/src/channels/discord/interactions.ts` — `routeInteraction` (line 153) dispatches `isButton`/`isModalSubmit`/`isChatInputCommand` only — **no `isStringSelectMenu` branch**. `splitCustomId` (line 183) parses `domain:action:rawId`. `routeButton` (line 201) is the domain switch. Handler templates: `handleEmailDraftStart` (line 708), `handleSuppressSenderStart` (line 1451). Lookup via `deps.emailStore.findByPendingId(id)`.
- `packages/server/src/emails/store.ts` — `findByPendingId` (line 283), `markDelivered` (line 275, idempotent: only nulls→now). Awaiting predicate: `delivered_at IS NULL AND (urgent_pinged_at IS NULL OR urgent_pinged_at < 0)`.
- `packages/tool-emails/src/index.ts` — `emails_dismiss` (line 172) is the reference for the dismiss action (awaiting-predicate check + `markDelivered`); `emails_get` (line 125) is the reference for full text (`findByPendingId` → `getAccount` → `fetchFullBody`).

Related patterns found:
- Plain-data component model (`ButtonData`/`ComponentData`) keeps cognition handlers decoupled from discord.js; the channel boundary (`bot.ts`) builds real discord.js objects. Extend this same pattern for select-menus.
- Ephemeral action replies with `MessageFlags.Ephemeral`, `deferReply` for slow IMAP ops, `findByPendingId` guard for "письмо пропало".

Dependencies identified: no new npm deps. discord.js 14 already exports `StringSelectMenuBuilder`/`StringSelectMenuOptionBuilder`. HTML→text is a small in-repo util (no `html-to-text` package).

## Development Approach

- **Testing approach**: Regular (implementation, then tests — within the same task; every task ends with tests + green run).
- Complete each task fully before the next.
- **Every task includes new/updated tests** (success + error/edge cases).
- **All tests pass before starting the next task.** Run `npm test -w @r2/server` (vitest). For type-touching tasks also run `npm run build -w @r2/server` (tsc).
- Keep the digest's existing one-message format and the existing urgent-email handlers working (backward compatible).

## Testing Strategy

- **Unit tests**: required every task. `html-to-text` pure-function tests; decode-path tests (HTML stripped, plain untouched); component-builder tests; digest menu-shape tests; interaction-routing/handler tests (valid id, missing row, idempotent dismiss, IMAP error).
- **E2E**: project has no browser e2e; Discord interactions are covered by unit tests against the router/handlers with stubbed interactions (existing pattern in `interactions` tests).

## Progress Tracking

- Mark `[x]` immediately when done.
- `➕` prefix for newly discovered tasks, `⚠️` for blockers.
- Update this plan if scope shifts.

## What Goes Where

- **Implementation Steps** (`[ ]`): code, tests, in-repo docs.
- **Post-Completion** (no checkboxes): manual Discord smoke test on the live bot, deploy via the dev→master flow.

## Implementation Steps

### Task 1: `htmlToText` utility
- [x] create `packages/server/src/emails/html-to-text.ts` exporting `htmlToText(html: string): string`
- [x] strip `<script>…</script>` and `<style>…</style>` (including contents) first
- [x] convert block boundaries to newlines: `<br>`, `</p>`, `</div>`, `</li>`, `</tr>`, `</h1>`–`</h6>`
- [x] remove all remaining tags (`<[^>]+>`); decode HTML entities — named (`&nbsp; &amp; &lt; &gt; &quot; &#39; &apos;`) and numeric (`&#NNN;`, `&#xHH;`)
- [x] collapse runs of blank lines/spaces to keep output compact but readable
- [x] write tests: tags removed; entities decoded; script/style dropped; nested/real-world HTML (a `<!DOCTYPE html>…` sample like the GERC.UA / Patreon mails); plain text with no tags returned unchanged; bare `&`/`<` in plain text not corrupted; empty string
- [x] run `npm test -w @r2/server` — must pass before Task 2

### Task 2: Strip HTML at the decode chokepoint
- [x] in `decodePickedText` (`imap-client.ts:48`): after `decodeBodyPart(...)`, when `picked.type === 'text/html'` return `htmlToText(decoded)`, else return decoded as-is
- [x] confirm this single change flows to `fetchNewMessages` (snippet → digest + scorer), `fetchFullBody` (`emails_get` + full-text action), and `fetchByMessageId` (draft thread)
- [x] update existing test in `__tests__/imap-client.test.ts` (~line 170-195): HTML-only message snippet now asserts clean text (e.g. contains `Hello, world`, does **not** contain `<p>`)
- [x] add test: `text/plain` part is passed through untouched (no entity/tag mangling)
- [x] add test: HTML-only `fetchFullBody` returns tag-free `body_text`
- [x] run `npm test -w @r2/server` — must pass before Task 3

### Task 3: Select-menu support in the plain-data component model
- [x] in `cognition/types.ts`: add `SelectOptionData { label; value; description?; emoji? }` and `SelectMenuData { customId; placeholder?; options: SelectOptionData[] }`; widen `ComponentData` to `{ type: 'row'; buttons: ButtonData[] } | { type: 'select'; menu: SelectMenuData }` (also added `buttonsOf()` guard so existing button-row consumers narrow cleanly)
- [x] in `bot.ts` `buildComponentsFromData`: handle `type: 'select'` → `ActionRowBuilder<StringSelectMenuBuilder>` with a `StringSelectMenuBuilder` (customId, placeholder, options); keep existing button-row branch unchanged
- [x] ensure the function's return type covers both `ActionRowBuilder<ButtonBuilder>` and `ActionRowBuilder<StringSelectMenuBuilder>`
- [x] write tests for `buildComponentsFromData` covering a select component (exported it; mirrors button-row building) — verify customId/placeholder/option mapping; button-row + mixed cases green
- [x] run `npm run build -w @r2/server` (tsc) and `npm test -w @r2/server` — must pass before Task 4

### Task 4: Attach the select-menu to the digest
- [x] in `emailDigest.helpers.ts`: add `buildDigestMenu(rows: EmailPendingRow[], includedIds: number[]): ComponentData[]` — one option per included row: `label = "${emojiFor(imp)} ${cleanSender} — ${subject}"` clamped to 100 chars, `value = String(row.id)`, `description = snippet` clamped to 100 chars; customId `email_digest:pick`; placeholder e.g. `Выбери письмо для действия`; cap at Discord's 25-option limit (included rows are already ≤ list size, but clamp defensively); return `[]` when no rows
- [x] in `emailDigest.ts` `run`: build `components` from `buildDigestMenu(pending, includedIds)` and return it alongside `content` (omit when empty); leave `onPublished`/`markDelivered` untouched
- [x] write tests: `buildDigestMenu` option shape (label/value/description, clamping, 25-cap); `emailDigest` run result includes a `select` component whose option values match `includedIds`
- [x] run `npm test -w @r2/server` — must pass before Task 5

### Task 5: Route select-menu + email picker → ephemeral action card
- [x] in `interactions.ts` `routeInteraction`: add `if (interaction.isStringSelectMenu()) { await routeStringSelectMenu(interaction, deps); return; }`
- [x] add `routeStringSelectMenu`: `splitCustomId`, dispatch `email_digest:pick` → `handleEmailDigestPick(ixn, deps, ixn.values[0])`
- [x] add `handleEmailDigestPick`: parse id from the selected value; `findByPendingId`; if missing → ephemeral `⚠️ Письмо больше недоступно`; else ephemeral reply with a short card (sender / subject / clean snippet) + one action row of 5 buttons:
  - `email_digest:dismiss:${id}` — `Разобрать` (success)
  - `email_draft:start:${id}` — `Ответить` (primary) *(reuses existing handler)*
  - `email_suppress:sender_start:${id}` — `🙈 Отправитель` (secondary) *(reuses existing)*
  - `email_suppress:subject_start:${id}` — `🙈 Тема` (secondary) *(reuses existing)*
  - `email_digest:fulltext:${id}` — `Полный текст` (secondary)
- [x] write tests: a `StringSelectMenu` interaction routes to the picker; valid id builds a card containing all 5 expected customIds; missing row → ephemeral "недоступно"; non-numeric/invalid value guarded (also: empty values, store-not-configured, non-whitelisted). Added `isStringSelectMenu: () => false` to existing interaction stubs so the new router branch is exercised cleanly.
- [x] run `npm test -w @r2/server` — must pass before Task 6

### Task 6: New button handlers — Разобрать & Полный текст
- [x] in `routeButton`: add `email_digest` domain with actions `dismiss` and `fulltext`
- [x] `handleEmailDigestDismiss(ixn, deps, rawId)`: parse id; `findByPendingId`; apply the same awaiting predicate as `emails_dismiss` (`delivered_at === null && (urgent_pinged_at === null || urgent_pinged_at < 0)`); if awaiting → `markDelivered([id], Date.now())` and reply/`update` ephemeral `✓ Разобрано`; if already handled → ephemeral `Уже разобрано` (honest, idempotent — safe on double-click)
- [x] `handleEmailDigestFullText(ixn, deps, rawId)`: parse id; `findByPendingId` (missing → ephemeral notice); `deps.imapClient`/account guard; `deferReply({ ephemeral })`; `fetchFullBody(account, row.message_uid)` (already clean text from Task 2); `editReply` with subject + body clamped to Discord's limit; catch IMAP errors → ephemeral error (also wired `fetchFullBody` into `DraftImapClient` + the bot's imapClient deps in `index.ts`)
- [x] write tests: dismiss marks delivered + idempotent second call reports already-handled; dismiss of missing row guarded; full-text returns body text (stubbed imapClient); full-text IMAP error surfaces gracefully; invalid id guarded
- [x] run `npm run build -w @r2/server` (tsc) and `npm test -w @r2/server` — must pass before Task 7

### Task 7: Verify acceptance criteria
- [ ] HTML no longer appears in: digest snippet, scorer input (snippet), `emails_get` body, full-text action — confirmed by tests
- [ ] digest publishes with a working select-menu; picking an email yields the ephemeral 5-button card
- [ ] all four actions work: Разобрать (idempotent), Ответить (existing draft flow), Заглушить (existing sender/subject flow), Полный текст
- [ ] run full `npm test -w @r2/server`
- [ ] run `npm run build -w @r2/server` (tsc clean — no type errors)
- [ ] verify no regression in urgent-email buttons (shared `email_draft`/`email_suppress` handlers unchanged)

### Task 8: Docs
- [ ] update the emails module docs (`AGENTS.md` / module README near the email pipeline) to note: HTML→text in `decodePickedText`, the digest select-menu + `email_digest:*` interaction domain, and the two new actions
- [ ] note in docs that the menu reuses `email_draft`/`email_suppress` so urgent + digest share one action surface

*Note: ralphex automatically moves completed plans to `docs/plans/completed/`.*

## Technical Details

- **Why centralize in `decodePickedText`**: all three IMAP body paths funnel through it, and `PickedPart.type` already distinguishes HTML from plain — so one guard fixes snippet, scorer, `emails_get`, full-text, and draft-thread context, with zero heuristic risk (we strip only when the server declared the part `text/html`, so plain-text bodies containing `<`/`&` are never touched).
- **Component decoupling**: cognition handlers emit plain `ComponentData`; discord.js objects are built only at the `bot.ts` boundary. The select-menu follows the same split — no discord.js import leaks into the cognition layer.
- **Two-step UX, not one**: the digest stays a single compact message with a select-menu; the action buttons live on the ephemeral card shown after a pick (per the chosen design — ephemeral, channel stays clean). 5 buttons fit one action row.
- **customId scheme**: new domain `email_digest` with `pick` (select), `dismiss`, `fulltext` (buttons). Reused: `email_draft:start:{id}`, `email_suppress:sender_start:{id}`, `email_suppress:subject_start:{id}`. ids are `email_pending.id`, looked up by `findByPendingId`.
- **Idempotency**: `markDelivered` only transitions `delivered_at IS NULL`; a stale digest menu picked twice is safe and honestly reports "уже разобрано".
- **Discord limits**: select-menu ≤ 25 options; option label/description ≤ 100 chars; full-text reply clamped to the message-size limit (reuse existing clamp helper if present).

## Post-Completion

*Manual / external — no checkboxes:*

**Manual verification (live Discord bot):**
- Trigger a digest, confirm previews are clean (no HTML), open the select-menu, pick an email, exercise all four actions (Разобрать removes it from the next digest; Ответить opens the draft modal; Заглушить writes a suppression rule; Полный текст shows readable body).
- Confirm urgent-email buttons still work unchanged.

**Deploy:**
- Per the project deploy flow: sync dev←master, run, then dev→master + `git push origin master` (supervisor polls origin/master, auto-restart).
