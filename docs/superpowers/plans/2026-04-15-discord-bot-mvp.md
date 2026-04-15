# Discord DM bot (MVP, whitelist only)

## Overview

Add a Discord bot as a second input channel for R2. The bot listens on direct messages from a fixed whitelist of Discord user IDs, forwards each message through the existing chat pipeline (`runChatRequest` → tool loop → memory → PII), and replies with the final assistant text in the same DM.

MVP scope: DM only, whitelist only, no streaming (full reply sent on `done`), no tool-call UI, no attachments. First external-channel adapter in the project — sets the pattern for Telegram/etc. later.

## Context

- Chat pipeline entry: `packages/server/src/ai/router.ts` → `runChatRequest({ messages, onEvent, ... })`. The `onEvent` callback is the reusable event bus. `routes/chat.ts` is just an SSE adapter around it — we do NOT re-parse SSE, we plug directly into `runChatRequest`.
- Persistence: `chat_messages` table in `packages/server/src/db.ts` has a `source` column. Discord sessions are isolated via `source = 'discord:<userId>'`.
- Memory + PII: fully reusable — they live inside `runChatRequest`, Discord adapter does not touch them directly.
- No prior channel adapter exists. Reminder scheduler is the closest existing pattern for a long-lived background service bootstrapped from `index.ts`.
- `discord.js` is not yet a dependency.

## Development Approach

- **Testing approach:** regular (code first, then tests). Tests use a fake Discord Client (EventEmitter) and a mocked `runChatRequest` — no real network.
- Keep the adapter as a module under `packages/server/src/channels/discord/` (NOT a new workspace). A new workspace is premature until a second channel arrives.
- Reuse everything downstream of `runChatRequest`. Do not duplicate history, PII, memory, or message persistence logic.
- All tests must pass before the next task.

## Implementation Steps

### Task 1: Add discord.js dependency

- [x] `cd packages/server && npm install discord.js@^14`
- [x] verify `packages/server/package.json` has `discord.js` in `dependencies`
- [x] run `npm test` in `packages/server` — must still pass (no code changes yet)

### Task 2: Source-aware chat history + runChatRequest source param

- [ ] add `source?: string` (default `'web'`) to `runChatRequest` params in `packages/server/src/ai/router.ts`
- [ ] propagate `source` to every `saveMessage`/`chat_messages` insert inside the request flow so both user and assistant messages carry the correct origin
- [ ] verify existing `routes/chat.ts` still works unchanged (source defaults to `'web'`)
- [ ] write a unit test: call `runChatRequest` with `source='discord:1234'`, assert user+assistant rows in `chat_messages` have that source
- [ ] write a unit test: default (no source) falls back to `'web'`
- [ ] run `npm test` — must pass before next task

### Task 3: Discord bot module

- [ ] create `packages/server/src/channels/discord/bot.ts` exporting `startDiscordBot(deps): Promise<{ stop(): Promise<void> }>`
- [ ] deps interface: `{ token, whitelist: Set<string>, runChatRequest, db, historyLimit: number }`
- [ ] construct `new Client({ intents: [GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.Guilds], partials: [Partials.Channel, Partials.Message] })` — Guilds intent is required for the client to connect even if we only care about DMs; partials are required to receive uncached DMs
- [ ] register `client.on('messageCreate', handler)`:
  - ignore if `msg.author.bot`
  - ignore if `msg.channel.type !== ChannelType.DM`
  - ignore if `!whitelist.has(msg.author.id)` (silent — do not reply)
  - call `msg.channel.sendTyping()`
  - load prior history: `SELECT role, content FROM chat_messages WHERE source = ? ORDER BY timestamp DESC LIMIT ?` with `['discord:'+msg.author.id, historyLimit]`, then reverse
  - append the new user message to the history array
  - call `runChatRequest({ messages, source: 'discord:'+msg.author.id, onEvent })`
  - `onEvent` accumulates `text_delta` chunks into a buffer; on `done` event, call `sendReply(msg.channel, buffer)`; on `error` event, reply `⚠️ error: {message}`
- [ ] implement `sendReply(channel, text)`: split into chunks ≤2000 chars (Discord message limit), send sequentially via `channel.send`. Split on word boundaries where possible
- [ ] `client.login(token)` and return `{ stop: async () => { await client.destroy(); } }`
- [ ] write tests in `packages/server/src/channels/discord/__tests__/bot.test.ts`:
  - mock discord.js `Client` via a small EventEmitter stub that exposes `on`, `login`, `destroy`
  - test: non-whitelist DM → `runChatRequest` NOT called, `sendReply` NOT called
  - test: bot message → ignored
  - test: guild message (non-DM) → ignored
  - test: whitelist DM → `runChatRequest` called with `source='discord:<id>'` and prior history loaded from a seeded in-memory DB
  - test: accumulate `text_delta` then `done` → `channel.send` called once with full text
  - test: text longer than 2000 chars → multiple `channel.send` calls, each ≤2000 chars, concatenation equals original
  - test: `error` event → sends error message
- [ ] run `npm test` — must pass before next task

### Task 4: Wire bot into server bootstrap

- [ ] in `packages/server/src/index.ts`, after memory service init (~line 175), before tool discovery, read `process.env.DISCORD_BOT_TOKEN`
- [ ] if token present: parse `DISCORD_ALLOWED_USER_IDS` (comma-separated), throw `Error('DISCORD_BOT_TOKEN set but DISCORD_ALLOWED_USER_IDS empty')` if empty after trim/filter
- [ ] call `startDiscordBot({...})` and keep the handle in a module-scoped variable
- [ ] log `[discord] bot started, whitelist size: N`
- [ ] in SIGTERM/SIGINT shutdown handler (next to `stopScheduler()`), call `await discordBot?.stop()`
- [ ] write/update index bootstrap tests only if they already exist — otherwise skip (existing tests do not cover index.ts wiring)
- [ ] run `npm test` — must pass before next task

### Task 5: Docs + env example

- [ ] `.env.example`: add commented `DISCORD_BOT_TOKEN=` and `DISCORD_ALLOWED_USER_IDS=` with one-line hint
- [ ] `AGENTS.md`: add short section under the existing env/config area describing how to create a bot in Discord Developer Portal and how to find a user ID (Developer Mode → right-click → Copy ID)
- [ ] run full `npm test` from repo root — all green
- [ ] run typecheck — clean

### Task 6: Verify acceptance criteria

- [ ] code review: non-whitelist user messages are silently ignored (no log noise that leaks IDs)
- [ ] code review: Discord errors do not crash the server (all handlers wrapped in try/catch, bot errors logged)
- [ ] code review: bot uses the same `runChatRequest` instance as the web route (no duplicated PII/memory wiring)
- [ ] full test suite + typecheck clean

## Technical Details

**Event flow** (per incoming DM):

```
Discord DM
  → messageCreate handler
  → whitelist check
  → sendTyping()
  → load history from chat_messages WHERE source='discord:<id>'
  → runChatRequest({ messages, source, onEvent })
      → router → tool loop → PII → memory (as today)
      → emits text_delta, tool_call_*, done, error
  → onEvent accumulates text
  → on 'done': sendReply (chunked ≤2000 chars)
```

**Why `source` in runChatRequest and not just in the adapter**: the server persists both user and assistant messages inside the request flow (`chat.ts:261-270, 456-464`). To isolate Discord history from web history we must tag those rows at the source of the write, not retro-patch them later.

**Why no streaming**: Discord has no streaming text API. Options are (a) edit a placeholder message every N ms, (b) send one message on `done`. (b) is simpler and the UX difference for R2's typical short replies is negligible. (a) can be added later as a `STREAMING=progressive|final` env flag if needed.

## Post-Completion

- User creates a Discord application + bot in https://discord.com/developers/applications, copies the bot token, and adds it as `DISCORD_BOT_TOKEN` in `.env`
- User enables Developer Mode in Discord client, copies own user ID, adds it to `DISCORD_ALLOWED_USER_IDS` (comma-separated if multiple)
- User invites the bot to their own account via the OAuth2 URL generator (scopes: `bot`, no guild permissions needed for DMs)
- Restart server; send a DM to the bot; verify reply
