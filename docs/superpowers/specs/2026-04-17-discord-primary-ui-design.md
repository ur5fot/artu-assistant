# Discord as primary UI — MVP

## Problem

Web UI has historically been the primary surface for R2: chat streaming, reminder cards with dismiss/snooze, tool permission dialogs, plan review, slash commands (command palette). Discord was a secondary text-only channel.

From 2026-04-17 the primary channel is Discord DM. Web is frozen — it continues to run but receives no new features. Discord is now the single entry point for interactive R2 use.

Today Discord only supports:

- Plain-text chat in DMs (shared history with web)
- Reminder delivery as plain `⏰ {text}` DMs (no dismiss/snooze)

Missing in Discord (present in web):

- Dismiss / snooze buttons on reminders
- Permission approve / deny when a tool requests confirmation (currently hangs until request timeout)
- Plan review approve / reject
- Slash commands (`/clear`, `/status`, `/reminders`, `/memory`)

This spec closes that gap. Single whitelisted user, no cross-channel sync.

## Non-goals

- Cross-channel sync between web and Discord (no `permission_resolved` disabling Discord buttons when web approves — web is frozen, not dual-driven)
- Multi-user Discord DM sync (whitelist is one user; no need to edit multiple DMs)
- Plan editing from Discord (long-form text editing → stay with web fallback)
- Porting `ToolCallCard`, `DiffView`, `PiiBadge`, `MemoryRecalledCard` to Discord (Phase 2)
- Deleting `packages/client` (separate future decision)
- Disabling web routes or frontend serving

## Design

### 1. Services layer

New directory `packages/server/src/services/` with four thin services. HTTP routes become adapters that call services; Discord interaction handlers call the same services. Business logic has one source of truth.

```
services/
├── reminder-service.ts      — dismiss(id), snooze(id), list()
├── permission-service.ts    — requestConfirm(callId, meta), resolveConfirm(callId, allowed, remember)
├── plan-review-service.ts   — requestReview(callId, plan), resolveReview(callId, approved, editedPlan)
└── command-service.ts       — clearHistory(), status(), listReminders(), listMemory(query?)
```

Each service wraps an underlying store / pending-map / bus. The services emit bus events when state changes (e.g. `reminder_dismissed`, `permission_resolved`) so any channel subscribed to `bus` sees the change.

### 2. Discord bot: new deps

`DiscordBotDeps` gains:

```ts
interface DiscordBotDeps {
  // ...existing
  reminderService: ReminderService;
  permissionService: PermissionService;
  planReviewService: PlanReviewService;
  commandService: CommandService;
  bus: EventEmitter;  // subscribed for permission_request, plan_review_request, reminder_*
}
```

The existing `reminderBus` field is replaced by the unified `bus`.

### 3. Discord bot: file layout

```
packages/server/src/channels/discord/
├── bot.ts               — message stream, bus subscription, high-level flow (existing, simplified)
├── interactions.ts      — NEW: Button & SlashCommand interaction routing
├── embeds.ts            — NEW: embed factories for permission, plan-review, reminder
├── slash-commands.ts    — NEW: command definitions + register()
└── __tests__/
```

`bot.ts` becomes a thin adapter: Discord events → services; service events → Discord DMs.

### 4. Embeds and buttons

#### Reminder embed

Replaces the current plain-text `⏰ {text}` DM. When `reminder_ring` fires, the bot now sends:

```
⏰ {text}
footer: now ringing
[✓ Dismiss]   [😴 Snooze 10m]
```

- customId: `reminder:dismiss:{id}` / `reminder:snooze:{id}`
- Snooze duration: fixed 10 minutes (matches existing web UX)
- On click: edit message → remove buttons; update footer to "✓ Dismissed" / "😴 Snoozed 10m"
- On `reminder_done` (ring cycle expired without action): edit message → remove buttons; update footer to "⏰ missed"

#### Permission embed

```
🔐 Permission request
Tool: {toolName}
{one-line summary of args}
[✓ Allow once]   [✓ Allow always]   [✗ Deny]
```

- customId: `perm:allow_once:{callId}` / `perm:allow_always:{callId}` / `perm:deny:{callId}`
- On click: edit message → remove buttons; footer "✓ Allowed once" / "✓ Allowed always" / "✗ Denied"
- If no click before the bot request timeout fires: edit message → "⚠️ expired"
- Button styles: Success (green) for allow; Danger (red) for deny

#### Plan review (multi-message)

Plans can be several KB. Discord message content ≤ 2000 chars; embed description ≤ 4096 chars.

1. **Message 1:** `📋 Plan review (1/N)` + first slice of plan in a code block
2. **Messages 2..N-1:** continuation code blocks, no header
3. **Final message:** short summary line + embed with buttons `[✓ Approve]  [✗ Reject]`

- customId: `plan:approve:{callId}` / `plan:reject:{callId}`
- All N messages are tracked as a group (`planReviewThread`) so the bot can edit them together (e.g. remove buttons on resolve, append "✓ approved" footer).
- Split on line boundaries; never split inside a code fence.
- Cap at 20 chunks. If the plan is larger, last chunk shows "⚠️ plan truncated."
- Edit-plan from Discord: not in MVP.

### 5. Slash commands

Registered once on `clientReady` via `client.application.commands.set([...])`.

| Command | Args | Behavior |
|---|---|---|
| `/clear` | — | Ephemeral confirm "Clear all chat history? [Yes] [No]". On Yes → `commandService.clearHistory()` → `DELETE FROM chat_messages`. Follow-up DM: "🗑️ History cleared." |
| `/status` | — | Ephemeral: model name, uptime, active reminders count, pending permissions count |
| `/reminders` | — | Ephemeral list: `#id · {text} · {when}` for active reminders. Empty → "No active reminders." |
| `/memory` | `query?` | Ephemeral: if `query` is given → top-10 semantic search results from memory service; else → last 10 entries |

All interaction handlers check `interaction.user.id ∈ whitelist` → else ephemeral "Not authorized."

### 6. Mid-stream permission / plan-review flow

Today the bot accumulates `text_delta` into `buffer` and sends one DM on `done`. This breaks if a permission prompt fires mid-stream: the stream blocks waiting for confirmation that no UI will deliver.

New flow inside `handleMessage`'s `onEvent`:

```
text_delta       → buffer += event.content
tool_use_start   → flush buffer as DM (if non-empty); send "🔧 running {tool}..."
permission_request → flush buffer; send permission embed (bot does NOT block; server awaits resolver in its own pending map)
plan_review_request → flush buffer; send plan-review multi-message + embed
tool_use_end     → append compact tool-result line (or skip for noisy tools)
done             → flush remaining buffer
error            → flush buffer; send "⚠️ Something went wrong."
```

The pending maps (`PendingConfirms`, `PendingPlanReviews`) stay on the server. When the Discord user clicks a button:

1. `interactionCreate` handler parses customId
2. Calls `permissionService.resolveConfirm(callId, ...)` / `planReviewService.resolveReview(callId, ...)`
3. The service resolves the pending promise
4. The existing `runChatRequest` promise inside the bot unblocks and resumes streaming
5. `onEvent` continues delivering subsequent `text_delta` events

The bot itself never `await`s on a click — it only reacts to bus events and interaction events. All blocking happens inside the server's chat-request machinery.

### 7. Request timeout behavior

Bot's `requestTimeoutMs` (currently 300s) is enforced by `AbortController`. If a permission or plan-review button is not clicked before the abort fires:

- The whole chat request aborts
- `runChatRequest` rejects; the bot catches it
- Bot edits all pending permission/plan-review messages to "⚠️ expired"
- Bot sends "⏱️ Request timed out. Please try again."
- Late clicks find no pending entry and reply ephemerally "⚠️ expired"

### 8. Event bus contracts

New / clarified events on the shared `bus`:

- `permission_request { callId, toolName, argsSummary }` — emitted by chat pipeline when a tool needs confirmation
- `permission_resolved { callId, allowed, remember }` — emitted by `permissionService.resolveConfirm`
- `plan_review_request { callId, plan }` — emitted by chat pipeline when a plan is ready for review
- `plan_review_resolved { callId, approved }` — emitted by `planReviewService.resolveReview`
- `reminder_ring { id, text }` — existing
- `reminder_done { id }` — existing
- `reminder_stop_ring { id }` — existing
- `reminder_dismissed { id }` — emitted by `reminderService.dismiss`

The bot subscribes to the `*_request` events to know when to send embeds. It does not subscribe to `*_resolved` events: resolution is triggered by its own `interactionCreate` handler, so it already knows the result locally.

### 9. Authorization

Every `interactionCreate` handler must:

- Check `interaction.user.id ∈ whitelist`; else ephemeral "Not authorized."
- Parse customId; reject malformed
- Validate that referenced `callId` / reminder `id` still exists in the corresponding pending map / store; else update message to "⚠️ expired."

## Files

### New

- `packages/server/src/services/reminder-service.ts`
- `packages/server/src/services/permission-service.ts`
- `packages/server/src/services/plan-review-service.ts`
- `packages/server/src/services/command-service.ts`
- `packages/server/src/channels/discord/interactions.ts`
- `packages/server/src/channels/discord/embeds.ts`
- `packages/server/src/channels/discord/slash-commands.ts`
- Matching `__tests__/` files under `services/` and `channels/discord/`

### Modified

| File | Change |
|---|---|
| `packages/server/src/channels/discord/bot.ts` | Replace direct `reminderBus` usage with unified `bus` subscription; add `interactionCreate` hook (delegates to `interactions.ts`); mid-stream flush/permission/plan-review handling in `onEvent`; `clientReady` registers slash commands |
| `packages/server/src/routes/reminder.ts` | Thin adapter → `reminderService.dismiss/snooze` |
| `packages/server/src/routes/confirm.ts` | Thin adapter → `permissionService.resolveConfirm` |
| `packages/server/src/routes/plan-review.ts` | Thin adapter → `planReviewService.resolveReview` |
| `packages/server/src/index.ts` | Instantiate services; pass into Discord bot deps and web routes |
| `packages/server/src/ai/*` (chat pipeline) | Ensure `permission_request` / `plan_review_request` are emitted on `bus` (in addition to the existing pending-map mechanism) |
| `packages/shared/src/*` | Add event types: `PermissionRequestEvent`, `PermissionResolvedEvent`, `PlanReviewRequestEvent`, `PlanReviewResolvedEvent`, `ReminderDismissedEvent` |

### Deleted

None in this spec.

## Testing

- **Service unit tests** — each service tested in isolation with mocked store / pending maps / bus; verify correct events emitted on each operation.
- **Discord interaction tests** — mock `Interaction` objects; verify customId parsing, whitelist enforcement, service method calls, message edit on success and failure.
- **Embed factory tests** — verify output structure (buttons, customIds, truncation, multi-message split for plans).
- **Bot integration test** — feed a mock `runChatRequest` that emits `text_delta` → `permission_request` → `text_delta` → `done`. Verify buffer flush, embed sent, and on simulated button click (calling `permissionService.resolveConfirm` directly), the stream resumes and the second flush arrives.
- **Manual E2E** — trigger a tool requiring confirmation from Discord; click Allow; verify stream continues. Repeat for Deny. Create a reminder with `after_minutes: 1`; verify ring DM has buttons; click Dismiss; verify message edits and reminder is closed in DB.

## Risks / open points

- **Discord message rate limits** — multi-message plan review with 20 chunks could hit rate limits. Accept: Discord's per-channel limit is ~5/5s; 20 chunks over a few seconds is fine. If needed later, add small inter-message delay.
- **Interaction token lifespan** — button customIds reference `callId` / reminder `id`. These IDs don't expire on the Discord side; the server-side pending map does. Stale clicks must be handled gracefully (handled in §7 and §9).
- **Slash command propagation** — global commands can take up to an hour to appear on first register. For development, consider using guild-scoped commands if the bot is in a dev guild. MVP: accept global registration; commands register once per bot start but are idempotent.
- **Chat-pipeline emit changes** — ensuring `permission_request` / `plan_review_request` are emitted on `bus` touches `ai/*`. Verify no regressions in existing web flow (even though web is frozen, it should not break outright).
