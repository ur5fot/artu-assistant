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
