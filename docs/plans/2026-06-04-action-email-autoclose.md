# Pending actions — auto-close on a confirmation email (iter-2 of 3)

## Overview
iter-1 gave pending actions a one-tap "✓ Готово" button. iter-2 closes the loop automatically for
the cases where the external service **emails a confirmation** ("payment received", "permissions
updated", "request approved"): R2 matches a newly-arrived email to an open pending action and, if it
clearly confirms completion, auto-closes the action and sends a short **reversible** notice with a
"↩ Вернуть" button.

Honest scope: GitHub permission requests do **not** send a reliable "done" email, so iter-2 won't
fire for the GitHub case — that one closes via the iter-1 button (or iter-3 activity detection).
iter-2 helps for services that DO confirm by email (banks/payments, account changes, some portals).

Auto-close is **soft + reversible**: domain-gated + LLM-confirmed (conservative), and every auto-close
posts a notice with a one-tap "↩ Вернуть" so a wrong close costs nothing.

## Context (from discovery)
- Cognition handlers: `createXHandler(deps): Handler` with `trigger(state, ctx)` + `run(ctx)` →
  `{publish|skip}`; registered via `cognitionService.register(...)` in `index.ts` (conditionally, e.g.
  emailDigest only when email enabled). Pattern: `cognition/handlers/emailDigest.ts`.
- The cognition publish path delivers DMs and supports `components` (buttons) — and (from the
  redelivery work) persists payload + redelivers on reconnect. A handler's `{publish, content,
  components}` is delivered + tracked for free.
- LLM: `emails/scorer.ts` uses the `anthropic` SDK (+ optional `ollama`); reuse that call pattern for
  the match. `index.ts` already holds the `anthropic` client.
- `emailStore.fetchInWindow(sinceHours, limit, now)` → recent `EmailPendingRow[]` (`from_addr`,
  `subject`, `snippet`, `received_at`). Confirmation emails are typically importance ≥2 (notice), so
  they ARE stored (cutoff=2) and visible here.
- `topicStore` (iter-1): `getOpenActions(): {topicId, label, action, url}[]`, `dismissAction(topicId,
  now)`. Need to add `reopenAction`. Available in `index.ts` (passed to topicFinalizer).
- Buttons: `interactions.ts` `domain:action:rawId`; iter-1 added `followup:done`. Add `followup:reopen`.

## Development Approach
- **Testing approach**: TDD — failing store/handler/interaction tests first.
- Additive: new cognition handler + one store method + one button branch. No schema change (reuses
  iter-1 columns).
- Safety: domain/keyword gate before any LLM call; conservative LLM prompt (default not-a-match);
  soft + reversible (notice + "↩ Вернуть"). Idempotent (only acts on open actions).
- Out of scope: activity/URL auto-close (iter-3); natural-language close/reopen; matching against raw
  un-stored (importance-1) emails — confirmations are ≥2 so this is fine.

## Testing Strategy
- Store: `reopenAction(topicId)` clears `action_dismissed_at` (→ action open again); idempotent.
- Handler `emailActionMatch`:
  - open action + a matching confirmation email (domain + LLM yes) → `dismissAction` called, returns
    `{publish}` with the action in the notice + a `followup:reopen:<topicId>` button.
  - no open actions → `trigger` false (skip, no LLM).
  - candidate email from a different domain / unrelated → no LLM match → not closed.
  - LLM says not-confirmed → not closed.
  - already-dismissed action → not in getOpenActions → untouched.
- Interaction: `followup:reopen:<id>` → `reopenAction` → message updated; idempotent/stale-safe.

## Progress Tracking
- Mark `[x]` immediately. ➕ new tasks, ⚠️ blockers.

## Implementation Steps

### Task 1: store.reopenAction + reopen button
- [x] `topics/store.ts`: add `reopenAction(topicId, )`: `UPDATE chat_topics SET action_dismissed_at =
      NULL WHERE id = ? AND action_dismissed_at IS NOT NULL` (idempotent inverse of `dismissAction`).
- [x] `interactions.ts`: handle `domain === 'followup' && action === 'reopen'` → `topicStore.reopenAction`
      → `ixn.update(...)` (drop the reopen button / show "↩ вернул"). Stale-safe.
- [x] tests: reopenAction round-trip + idempotency; reopen button → reopenAction + message update
- [x] run `npm test` — must pass before next task

### Task 2: emailActionMatch cognition handler
- [x] new `cognition/handlers/emailActionMatch.ts`: `createEmailActionMatchHandler({ emailStore,
      topicStore, anthropic, ollama, lookbackHours=72 })`.
- [x] `trigger`: return true only if `topicStore.getOpenActions().length > 0` (cheap gate; no LLM in
      trigger). Optional short cooldown after a publish.
- [x] `run`: actions = getOpenActions(); recent = `emailStore.fetchInWindow(lookbackHours, N, now)`;
      build candidate (action,email) pairs by domain match (action.url host vs email from-domain) or
      keyword overlap (action label vs subject); LLM-confirm candidates with a conservative prompt
      ("match=true ONLY if this email clearly confirms THIS action is done; else false"); for each
      confirmed → `dismissAction(topicId, now)` (in `onPublished`, after the DM lands). Return
      `{publish:true, content: notice listing closed actions + sender, components: [↩ Вернуть per
      closed action]}`; nothing confirmed → `{skip}`.
- [x] reuse the scorer's Claude/Ollama call pattern for the match (small JSON in/out).
- [x] register conditionally in `index.ts` (email enabled + topicStore present), like emailDigest.
- [x] add `buildActionReopenComponents(actions)` in `embeds.ts` (→ `followup:reopen:<topicId>` buttons).
- [x] tests (match→close+notice+button, no-actions→skip, wrong-domain→no match, LLM-no→no close)
- [x] run `npm test` — must pass before next task

### Task 3: Verify acceptance & build
- [ ] verify: an open action + a matching confirmation email → handler closes it and DMs a notice with
      "↩ Вернуть"; tapping reopen restores it (next brief shows ✓ Готово again); unrelated emails don't close.
- [ ] run full suite (`npm test`) — all green
- [ ] run `npm run build` (tsc) in `packages/server` — no type errors
- [ ] confirm additive + safe (no schema change; only open actions touched; reversible)

## Technical Details
- Candidate gate (no LLM): action.url host == email sender domain, OR action-label keyword ∈ subject.
  Only gated pairs go to the LLM → cheap (open actions are few; runs only when some exist).
- LLM prompt is conservative: default `match=false`; require an explicit completion/confirmation
  signal tied to THIS action. Avoids false closes; the "↩ Вернуть" button covers the rare miss.
- Reuses cognition publish (DM + redelivery + published_at) and iter-1's action columns + button infra.
- Confirmation emails are importance ≥2 → already in `email_pending`, so `fetchInWindow` sees them.

## Post-Completion
*Informational only*

**Deploy** (per flow): ralphex on `dev`; `dev`→`master` + `git push origin master`; **stay on
`master`**; supervisor auto-restarts.

**Next:** iter-3 — activity/URL auto-close (window-logger captures active-tab URL via AppleScript →
matcher closes an action when a visited URL matches its `target_url`). Needs on-device verification.

**Manual verification:** with an open action whose service confirms by email, trigger the confirmation
(or inject a matching email) → R2 auto-closes it and DMs "Закрыл «…» — подтверждение письмом [↩ Вернуть]".
