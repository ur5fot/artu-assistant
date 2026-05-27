# Artu (R2) — Personal AI Assistant

A localhost-first home life-operator. Watches your digital, physical, and
human contexts, then proactively helps with the routine so you can think about
what matters.

> **⚠️ Vibe-coded.** Most of this codebase was written end-to-end with Claude
> (via Claude Code in agentic mode, with the `ralphex` deploy loop doing the
> commits). It is not a polished framework — it is one person's evolving
> experiment in living with an AI assistant. Read the code with that lens:
> patterns are not always consistent, abstractions appear and dissolve, and
> "good enough to ship and learn from" beats "architecturally pure."

---

## Idea

R2 (codename Artu) is built around **three layers of observation**:

1. **Digital** — screen, windows, browser, IDE, documents, mail, calendar, tasks
2. **Physical** — rooms, lights, temperature, doors, motion, appliances, time of day
3. **Human** — where you are, what you're doing, active or tired, at the desk
   or moving around, whether you forgot something

The interaction loop is not "type a command" but **observe → infer → suggest
or act**. Some target moments:

- "You were going to leave in 20 minutes."
- "Kitchen light is still on."
- "You've been at it for 2 hours."
- "Start the vacuum while you work?"
- "Restore the tabs you had open yesterday?"

### Core principles

- **One chat for everything** — use, configure, and extend R2 from a single conversation
- **Tools-first** — features ship as discrete tools (`@r2/tool-*` workspace packages)
- **Brainstorm-before-execute** — spec → plan → run for non-trivial work
- **Delegate the unpleasant** — R2 takes paperwork, reminders, errands; the fun
  parts (deciding, thinking, creating) stay yours
- **Privacy first** — local processing, events not recordings, opt-in modes for
  camera/screen
- **No emotion-reading** — only observable signals (presence, posture,
  duration, movement, voice, patterns)

---

## What works today

### Core (Phase 1-2)

- React 19 + Vite UI and Express backend (web is frozen — see below)
- Claude API agentic loop with streaming + tool use + extended thinking
- Modular tools — each tool is its own npm package, auto-discovered from
  `packages/tool-*/`
- SQLite (better-sqlite3) for chat history, audit log, memory
- Permission system: `auto` / `confirm` / `forbidden` levels with UI dialog
- PII gateway via Microsoft Presidio (en/ru/uk recognizers, Docker)
- Self-hosted SearXNG for web search

### Self-modification (Phase 3)

R2 can edit and redeploy itself from chat:

- **Supervisor + worker split** with auto-restart, crash backoff, and WS status broadcast
- **Chat persistence** — full conversation history in SQLite
- **Git-in-the-loop** — `code_task` tool spawns Claude in a dev worktree, commits to `dev`
- **Git watcher + auto-deploy** — supervisor polls `master`, `code_deploy` merges `dev → master`, supervisor restarts the worker on the new commit
- **Eval system** — Haiku-as-judge for behavioral tests, gates `code_deploy` pre-merge
- **Slash commands + colored diff view** — command palette (Cmd+K / `/`), diff2html unified diffs

### Claude Code parity (Phase 4)

Closing the gap between Claude Code (the harness) and R2:

- **Memory (4A)** — embeddings via Ollama (`mxbai-embed-large`) or Voyage AI;
  fact extraction via Ollama (`qwen2.5:7b`) or Claude Haiku. Auto-injected
  into system prompt, decay-weighted ranking, `/запам'ятай` and `/забудь`
  slash commands. Memory edits (forget / update / forget-last) are
  confirm-gated with an Edit-and-approve modal.
- **Context compaction (4C)** — chat clusters into "topics" by source + idle
  gap; a background finalizer summarizes closed topics via Haiku and embeds
  the summary into the same vector DB. Prompt builder serves recent verbatim
  + top finalized topic summaries within budget. Old topics stay reachable
  via vector recall.
- **Local LLM router (4G)** — Ollama as first attempt for chat, Claude as
  fallback on empty / tool-need / unreachable. `LOCAL_LLM_MODE=disabled` kill switch.
- **Email watcher (4F, partial)** — multi-account IMAP polling (Gmail / iCloud
  via app passwords), LLM importance scoring (Ollama → Claude), `emailDigest`
  cognition handler with quiet hours / cooldown / post-morning-brief hold.
  On-demand access via `@r2/tool-emails` (`emails_list`, `emails_get`).

### Cognition + channels (Phase 5)

- **Cognition layer (5B)** — background "thinking" loop separate from the
  reactive request path. Handlers:
  - `morningBrief` — summarizes yesterday + overnight emails via Claude (with
    `web_search` injected for real weather lookup), publishes to Discord.
    Gap-return mode greets you back after multi-day absences with a recap.
  - `emailDigest` — registered when email watcher is enabled.
  - `pulseHandler` — demo / placeholder.
- **Discord channel** — DM-only, whitelist-gated. The only active channel today.
  Interactive embeds: reminder ring (dismiss / snooze 10m), permission requests
  (allow once / allow always / deny), plan review (approve / reject), memory
  confirm (approve / edit + approve / deny), tool-call status (running → done
  / error edits in place). Burst coalescing (1.5 s debounce) — multi-message
  clarifications produce one reply, not five.
- **Reminders (5A)** — one-shot and recurring (daily / weekly / monthly).
  Three-ring alarm cycle (60 s ring → 2 min pause, ×3), snooze creates a
  10-min one-shot clone. State machine is restart-idempotent.

---

## What's frozen

- **Web UI** — frozen since 2026-04-17. The Vite client still builds and you
  can install it as a PWA over Tailscale (see "Install on phone" below), but
  **no new features land in web**. Discord is the active channel.
  Cross-channel parity is not maintained; the web client will likely be
  removed eventually.

---

## What's planned

### Long-term roadmap — the home life-operator vision

The big direction is the three observation layers above. Decomposed into
epics:

- **EPIC 1 — Digital Observer** — active window, periodic screenshots, OCR /
  UI parsing, clipboard, activity classification (work / chat / search /
  debug / rest)
- **EPIC 2 — Human Observer** — local camera with presence detection
  (sitting / stood up / left / walking), voice + wake word, local Whisper STT
- **EPIC 3 — Home Observer** — Home Assistant bridge for lights, motion,
  temperature, humidity, doors, sockets, energy; appliance state
- **EPIC 4 — Context Fusion** — single unified context model (screen + person
  + home + time + calendar + habits), timeline of events, scenario inference
- **EPIC 5 — Personal Routine Engine** — recurring patterns, time-of-day
  habits (morning / evening / before-leaving / before-sleep)
- **EPIC 6 — Suggestion Engine** — proactive nudges from fused context
  ("light's on in an empty room", "want your tabs from yesterday?",
  "30 minutes until your calendar event")
- **EPIC 7 — Action Engine** — execute home actions (light scenes, vacuum,
  climate, phone notifications) and digital actions (open windows, restore
  context, create reminders)
- **EPIC 8 — Safety / Privacy** — local-only video, events-not-recordings,
  privacy modes (camera off / presence only / home only / PC only),
  whitelisted automatic actions, full decision log

### MVP slices toward the vision

1. **Computer** — active window + screenshot + "what are you doing right now"
2. **Person** — camera-based "at desk / away / been here too long"
3. **Home** — Home Assistant integration: lights, motion, doors, sockets
4. **Reactions** — suggest, remind, propose action, execute simple things

### Smaller items in the backlog

- **Image input (vision)** — drop a photo into chat, R2 sees it ("what's on
  this screen?", "extract text", "what's wrong with this design")
- **Telegram channel** — mobile-first usecase, polling or webhook adapter
- **Voice pipeline** — Whisper STT (local or API) + ElevenLabs / system TTS
- **Settings tool** — runtime env edits via slash command instead of
  `.env` edit + restart
- **Canvas / live UI** — interactive forms, tables, charts rendered in chat
  (especially useful for paperwork)
- **Dedicated home server** — Mac Mini M4 Pro (48–64 GB RAM, 1–2 TB SSD) as
  always-on R2 host. Sweet spot: 32B Q5 local model (Qwen2.5 32B / Qwen3-32B,
  ~23 GB) for router / memory / classification; Claude API for heavy
  reasoning. MacBook as thin client over Thunderbolt 4 or Tailscale.

---

## Stack

- **Runtime:** Node.js ≥ 20 LTS, TypeScript strict
- **Backend:** Express 4 + tsx watch in dev
- **Frontend (frozen):** React 19 + Vite + diff2html
- **AI:** Anthropic Claude API (Sonnet 4.6 / Haiku 4.5) — tool use + extended thinking
- **Local LLM:** Ollama (qwen2.5:7b + mxbai-embed-large)
- **DB:** SQLite (better-sqlite3 + sqlite-vec)
- **Search:** SearXNG (Docker)
- **PII:** Microsoft Presidio (Docker, en/ru/uk via custom image)
- **Tests:** Vitest

---

## Quick start

```bash
git clone https://github.com/ur5fot/artu-assistant
cd artu-assistant
npm install
cp .env.example .env   # at minimum: ANTHROPIC_API_KEY
docker compose up -d   # SearXNG + Presidio (~3-5 min first time, builds Presidio image)
npm run dev            # tsx watch, server only (web client is frozen)
```

For Discord bot setup, phone install over Tailscale, email watcher, and
API-only mode (no Ollama), see the sections below.

For production with the supervisor (auto-restart + git watcher pulling
`master`):

```bash
npm run start:build    # build shared / server / supervisor + start supervisor
# or, if already built:
npm start
```

---

## Install on phone (frozen web UI, but works)

R2's web client can be installed as a home-screen PWA on a phone that's on the
same Tailscale tailnet as the dev machine. The web UI is no longer the active
channel, but the install still works.

1. **One-time: issue an HTTPS cert** (Tailscale's HTTPS Certificates feature
   must be enabled in https://login.tailscale.com/admin/dns):
   ```bash
   npm run tailnet:cert
   ```
   Writes cert+key to `.tailnet-cert/`. Tailscale-issued certs are valid
   ~90 days — rerun when the browser starts reporting an expired cert.

2. **Start dev in tailnet mode:**
   ```bash
   npm run dev:tailnet
   ```
   Vite serves `https://<your-host>.ts.net:$CLIENT_PORT/`.

3. **Open that URL on the phone** (same tailnet, Tailscale app connected).
   If Mullvad or another VPN is active, put Tailscale in split-tunnel mode.

4. **Install to home screen:**
   - iOS Safari: Share → Add to Home Screen.
   - Android Chrome: menu → Install app.

---

## Discord bot

The active channel. DM-only and whitelist-gated — only configured user IDs
can interact, all other DMs are silently ignored.

1. Create a Discord application at https://discord.com/developers/applications.
2. Add a bot, enable the **Message Content** intent, copy the bot token →
   `DISCORD_BOT_TOKEN` in `.env`.
3. Add your Discord user ID to `DISCORD_ALLOWED_USER_IDS`. (Enable
   Developer Mode in Discord → right-click yourself → Copy User ID.)
4. Create a private Discord server (you and the bot must share one — Discord
   has no way to invite a bot directly to DMs).
5. Invite the bot via OAuth2 → URL Generator (scope `bot`, permission
   `Send Messages`) into that server.
6. Restart the server, find the bot in your private server's member list,
   click → **Message** to start a DM.

Multi-turn coalescing: the bot waits ~1.5 s of idle time before replying, so a
chain of short DMs ("Change user.nickname" → "Name" → "Do it") is treated as
one turn and the model answers once. Tune via `DISCORD_COALESCE_MS` in
`.env` (default `1500`).

Slash commands available in DM: `/clear`, `/status`, `/reminders`,
`/memory [query]`, `/permissions`, `/heartbeat status|pause|resume`.

See `AGENTS.md` for the full architecture and event flow.

---

## Email watcher

Incoming IMAP messages are scored for importance by the local LLM (or Claude)
and either delivered as a digest in Discord or surfaced on demand via
`/почта` (the `emails_list` tool).

- Configure `IMAP_ACCOUNTS` in `.env` as a JSON array of `{id, host, port,
  user, password, tls}` objects.
- For Gmail: enable 2FA, generate an app password
  (https://myaccount.google.com/apppasswords).
- For iCloud: https://support.apple.com/en-us/102654.
- `EMAIL_ENABLED=false` is a kill switch.

New accounts skip historical backlog on first connect — only emails arriving
**after** the account is configured are processed. Bodies and headers are
MIME-decoded (quoted-printable, base64, charset via `bodyStructure` dispatch).

---

## Running without Ollama (API-only mode)

By default R2 uses local Ollama for memory embeddings (`mxbai-embed-large`)
and fact extraction (`qwen2.5:7b`). To run fully without Ollama (e.g. on a
laptop with no GPU):

```bash
# Required
export EMBEDDING_PROVIDER=voyage
export VOYAGE_API_KEY="<get from https://www.voyageai.com/>"
export MEMORY_TEXT_PROVIDER=claude
export LOCAL_LLM_MODE=disabled
export MEMORY_ALLOW_REMOTE_PII=1   # explicit acknowledgment, see below

# Optional defaults
export VOYAGE_MODEL=voyage-3
export MEMORY_EXTRACT_MODEL_CLAUDE=claude-haiku-4-5-20251001
```

**Privacy note.** The memory pipeline does not route through the PII
anonymization proxy. With remote providers enabled, every indexed message and
extracted fact (including any PII the conversation contains) goes to Voyage
(embeddings) and Anthropic (extraction). R2 refuses to start in this mode
unless `MEMORY_ALLOW_REMOTE_PII=1` is set. If you need anonymization, keep
the Ollama default or set `MEMORY_ENABLED=false`.

Costs (low-volume personal use, rough):
- Voyage embeddings: ~$0.06 per 1M tokens — fractions of a cent per turn
- Claude Haiku fact extraction: ~$0.003 per turn

On first start under a new provider, R2 wipes and re-embeds existing memory
automatically (~15 s for typical sizes). Switching back to Ollama later
re-embeds again.

All R2 memory uses **1024-dim embeddings**. Supported models:
`mxbai-embed-large` (Ollama), `voyage-3` / `voyage-3-large` (Voyage). Custom
models with different dimensions are rejected at boot.

---

## License

MIT — see [LICENSE](LICENSE).
