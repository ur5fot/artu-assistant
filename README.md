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
  Urgent (`importance=5`) emails ping immediately as a Discord embed with a
  `Draft reply` button → full-thread context → Claude draft → SMTP send (same
  app password as IMAP). On-demand access via `@r2/tool-emails`
  (`emails_list`, `emails_get`).

### Cognition + channels (Phase 5)

- **Cognition layer (5B)** — background "thinking" loop separate from the
  reactive request path. Handlers:
  - `morningBrief` — summarizes yesterday + overnight emails via Claude (with
    `web_search` injected for real weather lookup), publishes to Discord.
    Gap-return mode greets you back after multi-day absences with a recap.
  - `emailDigest` — registered when email watcher is enabled.
  - `emailUrgent` — immediate Discord ping for `importance=5` emails, gated on
    `EMAIL_URGENT_ENABLED=true` and suppressed during quiet hours.
  - `contextSwitch` — macOS Digital Observer (Pain #2 iter 1); see the
    [Digital Observer](#digital-observer-pain-2--macos-only) section.
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

### Approach — one pain at a time

Strategic shift from "build infrastructure, then features" to
**use-case-first**: pick one concrete pain, build the whole loop for it
(observation → suggestion → action → learning → transparency) end-to-end,
ship it, live with it for two weeks, then decide what to extract into
reusable modules. Full reasoning, candidates, and operating principles in
[docs/superpowers/plans/2026-05-27-toward-ideal-r2.md](docs/superpowers/plans/2026-05-27-toward-ideal-r2.md).

### Active focus — Pain #1: Email triage (June 2026)

Concrete goal: by end of June, R2 catches **≥ 80%** of emails that need a
response within 24 h *before* the user opens the inbox, with one-click
drafts and a 30-second undo zone on send. Implicit feedback (open rate,
reply timing, dismissals) tunes the threshold automatically — no explicit
thumbs-up/down buttons.

Success is measured against four criteria (catch rate, false-positive
rate, draft-usage rate, time-to-reply) at month end. Hit ≥ 2 of 4 → keep
shipped feature. Hit ≥ 3 → extract reusable modules (implicit feedback
aggregator, undo-zone wrapper, per-feature `/why`). Hit < 2 → diagnose
before moving on.

### Long-term vision — the home life-operator

The big direction stays the three observation layers (digital / physical /
human). The epics below frame the destination, not a sequenced backlog —
each is pulled into focus only when it's the next most painful thing,
following the use-case-first principle:

- **EPIC 1-3** — Digital / Human / Home observers (active window + OCR /
  camera presence / Home Assistant bridge)
- **EPIC 4** — Context fusion (unified state across screen + person + home
  + calendar + habits)
- **EPIC 5-7** — Routine engine / Suggestion engine / Action engine
  (pattern detection → proactive nudges → execute)
- **EPIC 8** — Safety / privacy (local-only video, privacy modes, action
  whitelists, full decision log)

### Deferred (not picked up until a concrete pain demands them)

- **Image input (vision)** — drop a photo into chat, R2 sees it
- **Telegram channel** — mobile-first usecase
- **Voice pipeline** — Whisper STT + ElevenLabs / system TTS
- **Settings tool** — runtime env edits via slash command instead of
  `.env` + restart
- **Canvas / live UI** — interactive forms, tables, charts in chat
- **Dedicated home server** — Mac Mini M4 Pro (48–64 GB RAM, 1–2 TB SSD)
  as always-on host with a local 32B Q5 model for router / memory /
  classification; Claude API for heavy reasoning. MacBook as thin client
  over Thunderbolt 4 or Tailscale.

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

**Mailbox-recreate self-heal (`UIDVALIDITY`).** IMAP UIDs are only stable while
the mailbox's `UIDVALIDITY` is unchanged. If a provider recreates/resets the
mailbox, `UIDVALIDITY` flips and UIDs restart from low numbers — a watcher that
only remembers a high `last_seen_uid` would then silently stop ingesting new
mail (it lives below the stale watermark). R2 now stores `UIDVALIDITY` alongside
`last_seen_uid` and, on each poll tick, reads the current value **before**
fetching. On a mismatch it logs an `[emails] UIDVALIDITY changed …` warning,
rebuilds the baseline by skipping the new-epoch backlog (`last_seen_uid` → the
current max UID), persists the new `UIDVALIDITY`, and sends a **single** Discord
DM — ingest resumes from the next new email. There is **no new env-var**: a
`UIDVALIDITY` change is a discrete, rare event, so no threshold or counter is
needed (the alert fires exactly once per reset because the next tick sees the
stored value match).

Urgent emails (`importance=5`) ping immediately when `EMAIL_URGENT_ENABLED=true`
(suppressed during quiet hours; one ping per cognition tick).

**One-click drafts.** The urgent ping carries a `Draft reply` button. Click →
R2 walks the IMAP thread via `References`/`In-Reply-To` headers, asks Claude
for a context-aware draft (language follows the original thread), and shows
it ephemerally with `Send` / `Edit` / `Cancel`. Send goes out over SMTP using
the **same app password as IMAP** — Gmail's `imap.gmail.com` maps to
`smtp.gmail.com` automatically. Send is held for 30s before hitting SMTP —
ephemeral shows `"✉️ Will send at HH:MM:SS"` with a `Cancel send` button;
configurable via `EMAIL_SEND_HOLD_SECONDS` (0 disables the hold and restores
instant send). Pending drafts live in memory only and are lost on restart by
design.

**Transparency + shut-up.** The urgent ping also carries `🙈 Sender` / `🙈 Subject`
buttons — pick a TTL (1d/7d/30d/forever) or edit a subject substring in a modal,
and future matching emails skip the ping. Run `/why` (or `/why id:<n>`) to see
why a ping fired: scorer importance, last-7-day history with the same sender
(pings, sent, cancelled, errors), and any active suppression rule.

**Implicit feedback (silence as data).** Beyond the explicit 🙈 buttons, R2 can
learn from how you *react* to urgent pings and auto-mute senders you keep
ignoring — opt-in via `EMAIL_FEEDBACK_ENABLED=true` (default off ⇒ nothing is
recorded and the urgent path is unchanged). For every urgent ping it watches
the IMAP flags of that email: each poll tick re-reads `\Seen` / `\Answered` for
unresolved pings (reusing the open connection, capped per tick) and finalizes
an outcome — **replied** (`\Answered`), **read** (`\Seen` but no reply after
`EMAIL_FEEDBACK_IGNORE_HOURS`, default 24h), or **ignored** (never opened).
When a sender's negative outcomes (ignored + read-without-reply) reach
`EMAIL_FEEDBACK_SUPPRESS_AFTER` (default 3) within the lookback, R2 writes an
*automatic* sender suppression rule (TTL `EMAIL_FEEDBACK_SUPPRESS_TTL_DAYS`,
default 7) — so future urgent emails from that sender quietly fall into the
digest instead of pinging. It's **downgrade-only** (it never auto-promotes), it
reuses the same suppression machinery as the 🙈 buttons (so it's visible in
`/why`), and trust is re-earned by replying: a reply (`\Answered`) to a
still-tracked urgent ping clears the auto-rule. Once a sender is suppressed
their future emails are demoted straight to the digest and no longer tracked,
so a reply from there isn't observed (the watcher-only scope doesn't scan the
inbox by sender) — the auto-rule instead lapses at its TTL, and a reply to the
next post-TTL urgent ping keeps the sender from being re-suppressed. Manual 🙈
rules are never touched. The boost direction, subject-pattern scoring, and a
true reply-driven self-heal (an INBOX `\Answered` sweep) are deferred to a
later iteration.

---

## Digital Observer (Pain #2) — macOS only

R2's first OS-level integration. Every 30 s it polls the foreground app +
window title via `osascript` (no native deps — AppleScript through the
existing `execFile` wrapper), coalesces identical consecutive samples into
`window_history`, and runs a pure heuristic to detect a **context switch**:
you spent a long stretch in app B, then stably returned to app A. When that
fires, R2 proactively DMs you a `🔁 Restore context?` embed.

**Privacy by default.** The embed shows only a summary — `Was on Chrome
~45 min`. Window titles (which can leak PDF names, DM partners, banking URLs)
never appear in the default embed. A `Show titles` button reveals the list as
an **ephemeral** message visible only to you.

**This iteration is observation only** — it detects and notifies. Actual
restore (reopening tabs / files / cwd) is a later iteration.

**Self-diagnostics (iter 1.5).** The poller can go silently blind — after a
sleep/wake macOS often revokes Automation access and `osascript` starts
returning `null`/timeout, so the observer stops recording with no log line and
no alert (this happened for ~26 h on 2026-05-30). The poller now counts
consecutive blind ticks (`null` **or** throw) and, once it reaches
`WINDOW_LOGGER_BLIND_ALERT_AFTER` (default 10 ≈ 5 min at the 30 s interval),
emits **one** `[window-logger] BLIND: …` warning + a single Discord DM
("observer ослеп / lost Automation permission — re-grant in System Settings").
The counter resets on the first good sample; recovery is logged
(`[window-logger] recovered after N blind ticks`) without a second DM. No spam:
exactly one alert per blind streak.

**Enable it:**

1. Set `WINDOW_LOGGER_ENABLED=true` in `.env` and restart. (Requires a live
   Discord bot — the ping has nowhere else to go.)
2. On the first poll, macOS prompts: *"R2 (or node) wants to send events to
   System Events"* → click **Allow**. If no prompt appears, grant it manually
   in **System Settings → Privacy & Security → Automation → R2 / node →
   System Events**.
3. Tune detection via env vars (all in `.env.example`):
   `CONTEXT_SWITCH_LONG_SESSION_MIN` (30), `CONTEXT_SWITCH_GAP_MIN` (5),
   `CONTEXT_SWITCH_STABLE_NEW_MIN` (5), `CONTEXT_SWITCH_DEDUPE_WINDOW_H` (8),
   `WINDOW_LOGGER_BLIND_ALERT_AFTER` (10 — consecutive blind ticks before the
   self-diagnostics warning + Discord ping; range 1–2880).

**Known limitations (iter 1):**

- **Screen-lock false positive** — macOS reports the last-focused app as
  active even while the screen is locked, so a sleeping laptop with Chrome in
  front looks like "deep work on Chrome". A screen-lock detector is deferred to
  iter 1.5.
- **Read-in-browser false positive** — reading docs in a browser for a few
  minutes can read as a switch away from coding; threshold tuning covers this
  in practice.
- macOS only — Linux / Docker silently see nothing.

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
