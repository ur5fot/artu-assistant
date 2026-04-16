# Reminder: inline chat cards + Discord delivery

## Problem

Reminders currently render as a modal popup (`ReminderAlarm.tsx`) that overlays the entire UI. This is intrusive and inconsistent with how other tool results appear (inline in the chat). Additionally, reminders only reach the web UI — Discord users never see them.

## Design

### 1. Discord delivery

When a reminder fires, send a DM to all whitelisted Discord users.

**Changes:**

- `DiscordBotDeps` gains `reminderBus?: EventEmitter`
- In `startDiscordBot`, after `clientReady`, subscribe to `deps.reminderBus.on('push', handler)`:
  - `reminder_ring` → send `⏰ {text}` to each whitelisted user's pre-cached DM channel
  - `reminder_done` → send `⏰ пропущено: {text}`
  - `reminder_stop_ring` → no-op (paused state not relevant for Discord)
- In `index.ts`, pass `reminderBus` to `startDiscordBot` deps
- On `stop()`, remove the bus listener

**Files:** `bot.ts`, `index.ts`

### 2. Web: inline chat card with dismiss/snooze

Replace the modal popup with an inline card in the chat message stream, styled like `ToolCallCard`.

#### Event flow

1. `useChat.ts` opens a **second** `EventSource('/api/events')` (or reuses existing if refactored) to listen for `ServerPushEvent`
2. On `reminder_ring`: insert a new assistant message into `messages[]` with a `reminder` field: `{ id, text, status: 'ringing' }`. Start alarm audio loop.
3. On `reminder_stop_ring`: find the message by reminder id, update status to `'paused'`. Stop audio.
4. On `reminder_done`: update status to `'done'`. Stop audio.
5. On dismiss button click: `POST /api/reminder/dismiss { id }` → remove card from ringing state, stop audio.
6. On snooze button click: `POST /api/reminder/snooze { id }` → remove card from ringing state, stop audio.

#### ReminderCard component

Renders inside `MessageBubble.tsx` when `message.reminder` is present.

Visual structure:
```
┌──────────────────────────────┐
│ ⏰ Купити рибу              │
│                              │
│ [✓ Выключить] [😴 10 мин]   │
└──────────────────────────────┘
```

- Ringing state: red left border (like error), pulsing ⏰ icon
- Paused state: yellow left border, static icon, buttons still active
- Done/dismissed: grey, no buttons, static text

#### Audio

Reuse existing `packages/client/src/lib/alarm-audio.ts` (`createAlarmAudio`). The `useChat` hook (or a dedicated `useReminderEvents` hook) manages the audio lifecycle:
- Start loop on first `reminder_ring`
- Stop loop when no reminders are ringing (all dismissed/paused/done)

#### Removal

- Delete `packages/client/src/components/ReminderAlarm.tsx`
- Delete `packages/client/src/components/__tests__/ReminderAlarm.test.tsx`
- Remove `<ReminderAlarm />` from `App.tsx`

### 3. Shared types

Extend `ChatMessage` (or the client-side message type) with:
```ts
reminder?: {
  id: number;
  text: string;
  status: 'ringing' | 'paused' | 'done' | 'dismissed';
}
```

This field is client-only (not persisted in DB — the scheduler already persists `⏰ {text}` as a plain assistant message via `persistChatMessage`).

## Files to modify

| File | Change |
|------|--------|
| `packages/server/src/channels/discord/bot.ts` | Add `reminderBus` to deps, subscribe to ring/done events, send DMs |
| `packages/server/src/index.ts` | Pass `reminderBus` to Discord bot deps |
| `packages/client/src/hooks/useChat.ts` | Listen to `/api/events` for reminder events, manage audio, insert/update reminder messages |
| `packages/client/src/components/ReminderCard.tsx` | **New** — inline card with dismiss/snooze buttons |
| `packages/client/src/components/MessageBubble.tsx` | Render `ReminderCard` when `message.reminder` is set |
| `packages/client/src/components/ReminderAlarm.tsx` | **Delete** |
| `packages/client/src/components/__tests__/ReminderAlarm.test.tsx` | **Delete** |
| `packages/client/src/App.tsx` | Remove `<ReminderAlarm />` import and usage |

## Testing

- **Server:** test that `reminderBus` `reminder_ring` event triggers DM send to whitelisted users in Discord bot tests
- **Client:** test `ReminderCard` renders with dismiss/snooze buttons, test click handlers call correct API endpoints
- **E2E:** create a reminder via web chat with `after_minutes: 1`, wait for ring, verify card appears in chat stream and DM arrives in Discord

## Out of scope

- Snooze/dismiss from Discord (would require Discord interactions API — save for later)
- Reminder-specific sounds per reminder type
- Progressive streaming of reminder text
