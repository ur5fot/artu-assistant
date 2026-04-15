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
4. Add your Discord user ID to `DISCORD_ALLOWED_USER_IDS` in `.env`
5. Invite the bot via OAuth2 URL Generator (scope: `bot`)
6. Restart the server and send a DM to the bot

See `AGENTS.md` for detailed setup instructions.
