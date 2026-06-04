# Pending action items — foundation + one-tap "✓ Готово" button (iter-1 of 3)

## Overview
When a conversation leaves an action the owner must do **externally** (confirm GitHub permissions,
pay an invoice, reply somewhere), R2 keeps re-surfacing it in the morning brief until told — in
natural language — that it's done. That's friction. R2 can't reliably auto-detect external completion,
so this gives a structured, closeable action item with a one-tap **"✓ Готово"** button.

**Staged delivery (owner-approved):**
- **iter-1 (this plan):** structured pending actions on `chat_topics` + topicFinalizer extraction
  (incl. `target_url` for later matching) + morningBrief surfaces them with "✓ Готово" buttons +
  button handler closes them. Ships the reliable one-tap close.
- **iter-2 (later):** auto-close an action when a matching confirmation **email** arrives.
- **iter-3 (later):** observer captures the active-tab **URL** (AppleScript) and auto-closes an action
  when the owner visits its `target_url`. (Needs on-device verification — out of scope here.)

iter-1 captures `target_url` now so iter-3 has the data; nothing in iter-1 reads it for matching yet
(it's only shown as a clickable link in the brief).

## Context (from discovery)
- `packages/server/src/topics/finalizer.ts` — `topicFinalizer` runs Haiku over a closed topic's
  transcript, extracts `{label, summary, importance}` (`ParsedSummary` ~L58-62, prompt ~L46-56,
  `parseSummary` ~L148-165), then `store.finalize(topic.id, label, summary, importance, now)` (~L254).
- `packages/server/src/cognition/handlers/morningBrief.ts` — `run()` returns `{publish, content}`;
  result type already supports `embed?`/`components?` (`cognition/types.ts:39-46`). `gatherData()`
  (`morningBrief.helpers.ts:439-552`); "что висит" is currently pure LLM prose (`composePrompt` ~L640).
- `packages/server/src/channels/discord/interactions.ts` — buttons use `domain:action:rawId`
  (`splitCustomId` ~L179), routed in `routeButton` (~L197-410); handlers `.update({...})` the message.
- `packages/server/src/channels/discord/bot.ts` — `buildComponentsFromData` (~L195) renders
  `ComponentData[]` → buttons; cognition publish path already sends `components` to a DM
  (distractionPullback proves it).
- No existing follow-up/task table; `chat_topics` (`db.ts:360-372`, status open/closed/finalized) is
  the home — actions emerge from topics (the GitHub case is topic 14).

## Development Approach
- **Testing approach**: TDD — failing store/finalizer/handler/interaction tests first.
- Additive & backward-safe: nullable columns (PRAGMA-guarded migration); brief still returns text plus
  (now) optional components; topics without an action behave exactly as before.
- Out of scope (this iter): email auto-close (iter-2), activity/URL auto-close + observer URL capture
  (iter-3); natural-language close; >1 action per topic; surfacing in on-demand `проверь почту`.

## Testing Strategy
- Store: `getOpenActions()` returns only `action_required IS NOT NULL AND action_dismissed_at IS NULL`
  (finalized topics), incl. `target_url`; `dismissAction(topicId, now)` sets the timestamp; idempotent.
- Finalizer: prompt/parse extracts `action_required` + `target_url` (or null) and persists them.
- morningBrief: open actions appear in `components` as `followup:done:<topicId>` buttons (capped at 5)
  and in the prose (with clickable `target_url` when present); no open actions → no components.
- Interaction: `followup:done:<id>` → `dismissAction` called → message updated; stale/already-dismissed
  button handled gracefully.

## Progress Tracking
- Mark `[x]` immediately. ➕ new tasks, ⚠️ blockers.

## Implementation Steps

### Task 1: chat_topics action columns + finalizer extraction (store + migration)
- [x] migration in `db.ts`: PRAGMA-guarded `ALTER TABLE chat_topics ADD COLUMN` for `action_required
      TEXT`, `action_dismissed_at INTEGER`, and `target_url TEXT` (all nullable, backward-safe).
- [x] `finalizer.ts`: extend the Haiku JSON schema + prompt to also return `action_required` ("if the
      owner still has a manual EXTERNAL action to do — confirm permission, pay, reply — state it in ≤7
      words; else null") and `target_url` (the URL that action points to, if any in the transcript;
      else null). Extend `ParsedSummary` + `parseSummary`; thread both through `store.finalize`.
- [x] topic store: persist `action_required` + `target_url` in `finalize`; add `getOpenActions():
      {topicId, label, action, url}[]` (finalized, action_required not null, action_dismissed_at null)
      and `dismissAction(topicId, now)`.
- [x] write store + finalizer tests (extraction of action+url, getOpenActions filter, dismissAction idempotency)
- [x] run `npm test` — must pass before next task

### Task 2: morningBrief surfaces open actions with buttons
- [x] `gatherData()` reads `topicStore.getOpenActions()`; pass them into `composePrompt` so the prose
      lists them under "что висит" (with the clickable `target_url` when present), consistent with the buttons.
- [x] `run()` returns `components`: one "✓ Готово" button per open action (label `✓ <short action>`,
      customId `followup:done:<topicId>`), capped at 5. No open actions → omit components (text-only as today).
- [x] add `buildPendingActionsComponents(actions)` in `channels/discord/embeds.ts` (→ `ComponentData[]`).
- [x] write morningBrief tests (components from open actions, capped, empty when none)
- [x] run `npm test` — must pass before next task

### Task 3: "✓ Готово" button handler closes the action
- [ ] `interactions.ts`: handle `domain === 'followup' && action === 'done'` → parse topicId →
      `topicStore.dismissAction(topicId, now)` → `ixn.update(...)` to drop the tapped button / show ✓.
      Handle already-dismissed gracefully.
- [ ] wire the topic store/service into `InteractionDeps`.
- [ ] write interaction tests (done → dismissAction + message updated; stale button → graceful)
- [ ] run `npm test` — must pass before next task

### Task 4: Verify acceptance & build
- [ ] verify end-to-end: a finalized topic with `action_required` shows in the next brief with a
      "✓ Готово" button (and its link); tapping closes it; the following brief omits it.
- [ ] run full suite (`npm test`) — all green
- [ ] run `npm run build` (tsc) in `packages/server` — no type errors
- [ ] confirm backward-safe (topics without action_required unchanged; text-only brief path intact)

## Technical Details
- Open action = `chat_topics.status='finalized' AND action_required IS NOT NULL AND action_dismissed_at
  IS NULL`. Closing = set `action_dismissed_at`. Idempotent; brief re-surfaces only still-open ones.
- Buttons persist on the brief DM message; the owner can tap anytime; still-open actions recur with a
  fresh button next brief. Tapping an old message's button for a closed action no-ops.
- customId `followup:done:<topicId>` fits the existing `domain:action:rawId` convention.
- `target_url` is stored + shown but NOT matched against activity in iter-1 (that's iter-3).

## Post-Completion
*Items requiring manual intervention or external systems — informational only*

**Deploy** (per flow): ralphex on `dev`; `dev`→`master` + `git push origin master`; **stay on
`master`**; supervisor auto-restarts.

**Next iterations** (separate plans/ralphex runs):
- **iter-2 — email auto-close:** on new email ingest, match to an open action (sender/subject vs
  action label) → `dismissAction` + reversible one-line notice.
- **iter-3 — activity auto-close:** extend the window-logger to capture the active-tab URL
  (AppleScript for Chrome/Safari) into `window_history`; a matcher closes an action when a visited URL
  matches its `target_url` → `dismissAction` + reversible notice. Privacy: URLs stored locally only.
  Requires manual on-device verification (Automation permission; headless ralphex can't test the grab).

**Existing topic 14 (GitHub):** finalized before this feature → no `action_required`, no button. Closes
via the owner's natural-language "done" message (or I mark it resolved in the DB after deploy). New
GitHub-style topics get the structured action + button automatically.

**Manual verification (Discord):** have a conversation that leaves a manual action → next morning brief
lists it with a "✓ Готово" button + link → tap → confirm it's gone from the following brief.
