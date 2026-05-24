# R2

Personal assistant.

## Development

```bash
npm install
npm run dev
```

### Install on phone (dev, via Tailscale)

R2 can be installed as a home-screen app on a phone that is on the same
Tailscale tailnet as the dev machine.

1. **One-time: issue an HTTPS cert.** Tailscale's HTTPS Certificates feature
   must be enabled in the admin console
   (https://login.tailscale.com/admin/dns). Then run:

   ```bash
   npm run tailnet:cert
   ```

   This calls `tailscale cert` and writes cert+key to `.tailnet-cert/`.
   Tailscale-issued certs are valid ~90 days — rerun this command when the
   browser starts reporting an expired cert.

2. **Start dev in tailnet mode:**

   ```bash
   npm run dev:tailnet
   ```

   Vite will serve `https://<your-host>.ts.net:$CLIENT_PORT/` (the
   port from `.env`, default `5173`).

3. **Open that URL on the phone** (same tailnet, Tailscale app must be
   connected). If Mullvad or another VPN is active on the phone, put the
   Tailscale app in split-tunnel so tailnet traffic bypasses the VPN.

4. **Install to home screen:**
   - **iOS Safari:** Share → Add to Home Screen.
   - **Android Chrome:** menu → Install app.

   The app launches in standalone mode (no browser chrome) and uses the
   placeholder R2 icon. Replace icons in `packages/client/public/icon-*.png`
   when a real logo is ready.

### Discord bot

R2 can also respond via Discord direct messages. The bot is whitelist-gated —
only configured user IDs can interact with it.

1. Create a Discord application at https://discord.com/developers/applications
2. Add a bot, enable the **Message Content** intent
3. Copy the bot token into `DISCORD_BOT_TOKEN` in `.env`
4. Add your Discord user ID to `DISCORD_ALLOWED_USER_IDS` in `.env` (enable Developer Mode → right-click self → Copy User ID)
5. Create a private Discord server (you and the bot must share one — Discord has no way to invite a bot directly to DMs)
6. Invite the bot via OAuth2 URL Generator (scope `bot`, permission `Send Messages`) into that server
7. Restart the server, find the bot in your private server's member list, click → **Message** to start a DM

Multi-turn messages: the bot waits ~1.5s of idle time before replying, so a
chain of short DMs ("Change user.nickname" → "Name" → "Do it") is treated as
one turn and the model answers once. Tune via `DISCORD_COALESCE_MS` in
`.env` (milliseconds, default `1500`).

See `AGENTS.md` for detailed setup instructions.

### Emails

Incoming IMAP messages have their bodies and headers MIME-decoded
(quoted-printable, base64, charset via `bodyStructure` dispatch — see
`packages/server/src/emails/mime-decode.ts`). Stale rows from before this
fix may still display raw encoding in the DB — they're already marked
`delivered_at` so they're skipped by the daily digest, but `emails_list`
filters by `received_at` only and will still surface them (with their
raw-encoded snippet) until they age out of the requested time window.

New IMAP accounts skip historical backlog on first connect — only emails
arriving **after** the account is configured are processed. Existing
accounts are unaffected.

### Running R2 without Ollama (API-only mode)

By default R2 uses local Ollama for memory embeddings (`mxbai-embed-large`) and fact extraction (`qwen2.5:7b`). To run fully without Ollama (e.g. on a laptop with no GPU), use Voyage AI for embeddings and Claude for fact extraction:

```bash
# Required
export EMBEDDING_PROVIDER=voyage
export VOYAGE_API_KEY="<get from https://www.voyageai.com/>"
export MEMORY_TEXT_PROVIDER=claude
export LOCAL_LLM_MODE=disabled
export MEMORY_ALLOW_REMOTE_PII=1                            # required acknowledgment, see below

# Optional defaults (override if needed)
export VOYAGE_MODEL=voyage-3                                # 1024 dim, default
export MEMORY_EXTRACT_MODEL_CLAUDE=claude-haiku-4-5-20251001
```

**Privacy note (PII flows to external APIs in this mode).** The memory pipeline does not run through the PII anonymization proxy that protects the main Claude chat path. With remote providers enabled, every indexed user message, assistant reply, and extracted fact — including any emails, phone numbers, addresses, or other personal data the conversation contains — is sent to Voyage (for embeddings) and Anthropic (for fact extraction). To prevent accidental leakage, R2 refuses to start in this mode unless you set `MEMORY_ALLOW_REMOTE_PII=1` as an explicit acknowledgment. The same applies if you use `auto` and Ollama is not available, or if you mix Ollama embeddings with Claude fact extraction. If you need anonymization, keep the Ollama default or set `MEMORY_ENABLED=false`.

Costs (rough, at low-volume personal use):
- Voyage embeddings: ~$0.06 / 1M tokens — typical chat is fractions of a cent per turn
- Claude Haiku fact extraction: ~$0.003 per turn

On first start under a new provider, R2 wipes and re-embeds existing memory facts/entries automatically. Takes ~15 seconds for typical memory sizes.

To switch back to local Ollama later, unset the env vars (or `EMBEDDING_PROVIDER=ollama`, `MEMORY_TEXT_PROVIDER=ollama`). The migration runs again automatically — re-embeds everything under Ollama.

**Embedding standard:** all R2 memory uses 1024-dim embeddings. Supported models: `mxbai-embed-large` (Ollama), `voyage-3` / `voyage-3-large` (Voyage). Custom models with different dimensions are rejected at boot.

### Context compaction

R2 keeps the chat prompt under budget by clustering messages into **topics**
instead of truncating the tail. A topic is a run of messages on the same
source (Discord / web) with no idle gap longer than **2 hours**; the gap
heuristic runs on every `saveMessage` and is cheap enough to stay on the hot
path (no LLM classifier — see `packages/server/src/topics/detector.ts`).

When a topic has been closed for at least 10 minutes (so streaming
tool-loops can settle), a background finalizer asks Claude Haiku for a
`{label, summary, importance}` JSON object, stores it on the
`chat_topics` row, and embeds the summary into the same `memory_vec`
table 4A uses — so older topics stay reachable through vector recall even
after they fall out of the verbatim window.

The prompt builder then serves: recent verbatim turns up to ~50% of the
character budget, plus the highest-importance finalized topic summaries
up to ~40%, leaving headroom for the 4A memory recall prefix. Topics that
don't fit are silently dropped from the prefix but remain searchable via
embeddings.

If Haiku fails to return parseable JSON 5 times in a row for the same
topic, the finalizer gives up and marks it finalized with a placeholder
label so the queue keeps moving. On server restart, any open topic whose
last message is older than the 2h gap is auto-closed at the cutoff
timestamp, so a crash mid-conversation does not leave a topic open
forever.

**PII boundary.** The finalizer sends raw topic transcripts to Anthropic
Haiku, which sits outside the PII anonymization proxy. When memory is
configured local-only (`MEMORY_TEXT_PROVIDER=ollama`) the finalizer is
skipped unless `MEMORY_ALLOW_REMOTE_PII=1` is set — topics will still be
detected and closed, but never summarized. Set `MEMORY_ALLOW_REMOTE_PII=1`
to opt in.

**Tuning** (defaults are sensible — only touch if you measure a problem):

- `TOPIC_FINALIZER_BUFFER_MS` — debounce before a closed topic becomes
  eligible for summarization (default `600000`, i.e. 10 min). Gives
  streaming tool-loops time to fully settle before Haiku reads the
  transcript.
- `TOPIC_FINALIZER_BATCH` — max topics summarized per cognition tick
  (default `5`, range 1–50).
- `TOPIC_FINALIZER_MAX_FAILURES` — give-up threshold after which a topic
  is finalized with a placeholder label (default `5`, range 1–100).
