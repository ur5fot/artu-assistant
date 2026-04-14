# Tailnet HTTPS + PWA install (dev)

## Goal

Let the user open R2 on a phone from the Tailscale tailnet URL and install it
as a home-screen app. Requires a trusted HTTPS origin (Tailscale-issued cert)
plus a Web App Manifest and a minimal Service Worker.

Scope: **dev environment only.** Production (`npm start` / supervisor) is not
touched in this spec.

## Context

- Dev runs via `scripts/dev.sh tailnet`, which sets `VITE_HOST=true` so Vite
  binds to all interfaces and accepts the tailnet hostname.
- Express server (`packages/server/src/index.ts:221`) already binds to
  `127.0.0.1:3004`. Vite proxies `/api/*` there. The API server stays plain
  HTTP on loopback — only Vite terminates TLS toward the tailnet.
- CORS (`packages/server/src/index.ts:38`) already allows `*.ts.net` origins,
  so the HTTPS origin will be accepted without further changes.
- Tailscale HTTPS Certificates feature is enabled on the user's tailnet.

## Architecture

### 1. HTTPS termination at Vite

- New script `scripts/gen-tailnet-cert.sh`:
  - Resolves the tailnet FQDN by running
    `tailscale status --json | jq -r .Self.DNSName` and stripping the
    trailing dot. Can be overridden by `R2_TAILNET_HOST` env var.
  - Runs `tailscale cert --cert-file .tailnet-cert/<host>.crt
    --key-file .tailnet-cert/<host>.key <host>`.
  - Creates `.tailnet-cert/` if missing; the directory is gitignored.
  - Fails fast with a clear message if `tailscale` is not on PATH or the
    command errors (e.g. HTTPS Certificates not enabled in admin console).
- `packages/client/vite.config.ts`:
  - Read `VITE_HTTPS=true` from env. If set, scan `.tailnet-cert/` for the
    first `*.crt` / `*.key` pair (glob match by stem). Host name is not
    re-derived in JS — whatever the shell script wrote is what Vite uses.
  - If both files exist, set `server.https: { cert, key }`.
  - If `VITE_HTTPS=true` but files missing, log a warning and fall back to
    HTTP so dev still works — but the user will see the warning in the
    Vite banner.
- `scripts/dev.sh` tailnet mode:
  - Export `VITE_HTTPS=true` alongside `VITE_HOST=true`.
  - Before launching concurrently, check whether cert files exist. If not,
    print a one-line hint to run `npm run tailnet:cert` but still start
    (HTTP fallback).

### 2. PWA manifest and meta tags

- `packages/client/public/manifest.webmanifest`:
  ```json
  {
    "name": "R2",
    "short_name": "R2",
    "start_url": "/",
    "scope": "/",
    "display": "standalone",
    "theme_color": "#0f172a",
    "background_color": "#0f172a",
    "icons": [
      { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png" },
      { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png" },
      { "src": "/icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
    ]
  }
  ```
- `packages/client/public/icon-192.png`, `icon-512.png`, `icon-maskable-512.png`:
  temporary placeholder icons. A small Node-based generator script
  (`scripts/gen-pwa-icons.mjs`) draws "R2" white text on the theme color
  background using a minimal PNG encoder. Runs on demand, commits the PNGs
  to git so no build-time generation is required.
- `packages/client/index.html` `<head>` additions:
  - `<link rel="manifest" href="/manifest.webmanifest">`
  - `<meta name="theme-color" content="#0f172a">`
  - `<link rel="apple-touch-icon" href="/icon-192.png">`
  - `<meta name="apple-mobile-web-app-capable" content="yes">`
  - `<meta name="apple-mobile-web-app-title" content="R2">`
  - `<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">`

### 3. Service Worker

- `packages/client/public/sw.js` — passthrough only:
  ```js
  self.addEventListener('install', () => self.skipWaiting());
  self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
  self.addEventListener('fetch', () => { /* default network */ });
  ```
  Satisfies Chrome's installability criteria without caching or intercepting
  anything. No offline mode — R2 needs the live server.
- Registration in `packages/client/src/main.tsx`:
  - After `createRoot(...).render(...)`, if `'serviceWorker' in navigator` AND
    the origin is HTTPS (or localhost), call
    `navigator.serviceWorker.register('/sw.js')`.
  - Swallow errors to a `console.warn` — registration failures should never
    break the app.

### 4. Developer workflow

- `package.json` scripts:
  - `"tailnet:cert": "./scripts/gen-tailnet-cert.sh"` (new)
  - `"dev:tailnet": "./scripts/dev.sh tailnet"` (already exists)
- First-run sequence for the user:
  1. `npm run tailnet:cert` — once per cert lifetime (~90 days).
  2. `npm run dev:tailnet`.
  3. On the phone: open `https://<host>.ts.net:5176/` via Safari/Chrome.
  4. Share → Add to Home Screen.

## Data flow

```
Phone browser
  │  HTTPS to <host>.ts.net:5176
  ▼
Tailscale route → Mac → Vite dev (HTTPS, cert from tailscale cert)
  │                        │
  │  static /manifest, /sw.js, /icon-*.png, React app
  │
  │  proxy /api/* → 127.0.0.1:3004 (Express, HTTP loopback)
```

Only the Vite surface is HTTPS. Express stays HTTP on loopback; nothing
outside the Mac sees it.

## Error handling

- `gen-tailnet-cert.sh` exits non-zero with a clear message on:
  - `tailscale` not installed / not on PATH
  - `tailscale cert` fails (not authorized, HTTPS certs disabled, etc.)
- Vite `server.https` gracefully degrades to HTTP if cert files are missing,
  with a warning printed to the terminal.
- Service Worker registration wrapped in try/catch → warn only, never throw.
- Manifest parse / missing icons — handled by the browser, not the app; we
  ship correct files and rely on devtools to surface problems.

## Testing

- **Unit test** `packages/client/src/__tests__/manifest.test.ts`: reads
  `public/manifest.webmanifest`, `JSON.parse`, asserts required fields
  (`name`, `start_url`, `display`, at least one 192 and one 512 icon).
- No E2E. PWA install flow depends on real browser state and is manual:
  the user opens the URL on phone and confirms Add to Home Screen works.
- `npx tsc --noEmit` must still pass.
- Existing client tests stay green.

## Documentation

- `README.md` gains a "Install on phone (dev)" section listing the two-step
  sequence (`tailnet:cert`, `dev:tailnet`) and the iOS/Android install flow.
- Caveat noted: Tailscale certs expire ~90 days; re-run the cert script
  when the browser reports an expired/invalid cert.

## Risks

- `tailscale cert` is interactive-free but can still fail due to rate limits
  or admin config. Mitigation: clear error message, doc points to admin
  console URL.
- Vite HTTPS + HMR: the HMR WebSocket must upgrade to `wss://`. Vite 6
  handles this automatically when `server.https` is set; if HMR breaks we
  may need `server.hmr: { protocol: 'wss', host: <tailnet host> }`.
- Cert files live in `.tailnet-cert/` — must be in `.gitignore` to avoid
  committing private keys. This is a hard safety requirement.
- Placeholder icons are ugly by design. Backlog item "favicon + лого"
  still stands; PWA launch doesn't block on real design.

## Out of scope

- Production (`npm start` / supervisor) HTTPS — separate future spec.
- Offline mode / Service Worker caching strategies.
- Real logo / favicon design (tracked separately in project backlog).
- Push notifications, Web Share Target, file handlers, protocol handlers.
