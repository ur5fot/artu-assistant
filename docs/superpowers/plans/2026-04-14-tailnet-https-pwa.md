# Tailnet HTTPS + PWA install Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve the Vite dev server over Tailscale-issued HTTPS so the user can open R2 from a phone on the tailnet and install it as a home-screen PWA.

**Architecture:** `scripts/gen-tailnet-cert.sh` writes a cert/key pair to `.tailnet-cert/`. Vite dev reads those files when `VITE_HTTPS=true` and terminates TLS at the Vite surface. Express stays on loopback HTTP. The React app ships a Web App Manifest, a passthrough Service Worker, and iOS/Android meta tags to qualify for home-screen install.

**Tech Stack:** Tailscale cert CLI, Vite 6 `server.https`, Web App Manifest, Service Worker API, Node `fs`/`sharp` (or hand-rolled PNG generator) for placeholder icons.

**Spec:** `docs/superpowers/specs/2026-04-14-tailnet-https-pwa-design.md`

---

## File Structure

- **Create**
  - `scripts/gen-tailnet-cert.sh` — wraps `tailscale cert`, writes to `.tailnet-cert/<host>.{crt,key}`.
  - `scripts/gen-pwa-icons.mjs` — one-shot Node script generating placeholder PNG icons.
  - `packages/client/public/manifest.webmanifest` — PWA manifest.
  - `packages/client/public/sw.js` — minimal passthrough Service Worker.
  - `packages/client/public/icon-192.png`, `icon-512.png`, `icon-maskable-512.png` — placeholder icons (committed).
  - `packages/client/src/__tests__/manifest.test.ts` — unit test validating manifest shape.
- **Modify**
  - `.gitignore` — ignore `.tailnet-cert/`.
  - `packages/client/vite.config.ts` — add `server.https` when `VITE_HTTPS=true`.
  - `scripts/dev.sh` — export `VITE_HTTPS=true` in `tailnet` mode; warn if cert files missing.
  - `package.json` — add `tailnet:cert` script.
  - `packages/client/index.html` — manifest link + PWA meta tags.
  - `packages/client/src/main.tsx` — register Service Worker in secure contexts.
  - `README.md` — "Install on phone (dev)" section.

---

## Task 1: Cert generation script + gitignore

**Files:**
- Create: `scripts/gen-tailnet-cert.sh`
- Modify: `.gitignore`, `package.json`

- [x] **Step 1: Add `.tailnet-cert/` to `.gitignore`**

Open `.gitignore` and append at the end:

```
# Tailscale-issued HTTPS certs for dev (never commit private keys)
.tailnet-cert/
```

- [x] **Step 2: Create `scripts/gen-tailnet-cert.sh`**

```bash
#!/bin/bash
# Generate a Tailscale-issued HTTPS cert for this machine's tailnet hostname.
# Writes .tailnet-cert/<host>.crt and .tailnet-cert/<host>.key.
# Override the host by exporting R2_TAILNET_HOST.
set -e

if ! command -v tailscale >/dev/null 2>&1; then
  echo "error: 'tailscale' CLI not found on PATH." >&2
  echo "Install Tailscale and ensure the tailscaled daemon is running." >&2
  exit 1
fi

HOST="${R2_TAILNET_HOST:-}"
if [ -z "$HOST" ]; then
  if ! command -v jq >/dev/null 2>&1; then
    echo "error: 'jq' not found and R2_TAILNET_HOST is unset." >&2
    echo "Install jq or export R2_TAILNET_HOST=<your-host>.ts.net." >&2
    exit 1
  fi
  HOST=$(tailscale status --json | jq -r '.Self.DNSName' | sed 's/\.$//')
fi

if [ -z "$HOST" ] || [ "$HOST" = "null" ]; then
  echo "error: could not resolve tailnet hostname." >&2
  echo "Is Tailscale logged in? Try: tailscale status" >&2
  exit 1
fi

mkdir -p .tailnet-cert
echo "Requesting Tailscale cert for $HOST..."
tailscale cert \
  --cert-file ".tailnet-cert/${HOST}.crt" \
  --key-file ".tailnet-cert/${HOST}.key" \
  "$HOST"

echo "✓ Cert written to .tailnet-cert/${HOST}.crt"
echo "✓ Key  written to .tailnet-cert/${HOST}.key"
echo ""
echo "Next: npm run dev:tailnet"
```

- [x] **Step 3: Make the script executable**

Run: `chmod +x scripts/gen-tailnet-cert.sh`
Expected: no output, exit 0.

- [x] **Step 4: Add `tailnet:cert` to `package.json` scripts**

In `package.json`, inside `"scripts"`, insert below `dev:tailnet`:

```json
    "tailnet:cert": "./scripts/gen-tailnet-cert.sh",
```

- [x] **Step 5: Run the script to verify it works end-to-end**

Run: `npm run tailnet:cert`
Expected: prints `✓ Cert written to .tailnet-cert/<host>.ts.net.crt` and key; files exist in `.tailnet-cert/`.

- [x] **Step 6: Verify `.tailnet-cert/` is ignored**

Run: `git status`
Expected: `.tailnet-cert/` does NOT appear in Untracked files. Only tracked changes are `.gitignore`, `scripts/gen-tailnet-cert.sh`, `package.json`.

- [x] **Step 7: Commit**

```bash
git add .gitignore scripts/gen-tailnet-cert.sh package.json
git commit -m "feat(dev): tailnet cert generator script"
```

---

## Task 2: Vite HTTPS config + dev.sh wiring

**Files:**
- Modify: `packages/client/vite.config.ts`, `scripts/dev.sh`

- [x] **Step 1: Update `packages/client/vite.config.ts` to read cert files**

Replace the whole file with:

```ts
/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { config } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '..', '..', '.env') });

function loadTailnetCert(): { cert: Buffer; key: Buffer } | undefined {
  if (process.env.VITE_HTTPS !== 'true') return undefined;
  const dir = resolve(__dirname, '..', '..', '.tailnet-cert');
  if (!existsSync(dir)) {
    console.warn('[vite] VITE_HTTPS=true but .tailnet-cert/ is missing — falling back to HTTP. Run: npm run tailnet:cert');
    return undefined;
  }
  const files = readdirSync(dir);
  const crt = files.find((f) => f.endsWith('.crt'));
  if (!crt) {
    console.warn('[vite] VITE_HTTPS=true but no .crt found in .tailnet-cert/ — falling back to HTTP.');
    return undefined;
  }
  const stem = crt.slice(0, -4);
  const keyFile = `${stem}.key`;
  if (!files.includes(keyFile)) {
    console.warn(`[vite] VITE_HTTPS=true but ${keyFile} is missing — falling back to HTTP.`);
    return undefined;
  }
  return {
    cert: readFileSync(resolve(dir, crt)),
    key: readFileSync(resolve(dir, keyFile)),
  };
}

const https = loadTailnetCert();

export default defineConfig({
  plugins: [react()],
  server: {
    port: parseInt(process.env.CLIENT_PORT || '5173', 10),
    host: process.env.VITE_HOST === 'true' ? true : undefined,
    allowedHosts: process.env.VITE_HOST === 'true' ? true : undefined,
    https,
    proxy: {
      '/api': `http://localhost:${process.env.PORT || 3001}`,
    },
  },
  test: {
    environment: 'jsdom',
    globals: false,
  },
});
```

- [x] **Step 2: Update `scripts/dev.sh` tailnet mode to export `VITE_HTTPS`**

Find the `tailnet)` case block and replace it with:

```bash
  tailnet)
    if [ ! -d .tailnet-cert ] || [ -z "$(ls -A .tailnet-cert 2>/dev/null)" ]; then
      echo "hint: no Tailscale cert found — run 'npm run tailnet:cert' first for HTTPS."
      echo "hint: continuing with plain HTTP; PWA install will not work."
    fi
    npx concurrently "npm run dev:server" "VITE_HOST=true VITE_HTTPS=true npm run dev:client"
    ;;
```

- [x] **Step 3: Type-check Vite config**

Run: `cd /Users/dim/code/R2-D2 && npx tsc -p packages/client/tsconfig.json --noEmit`
Expected: no output, exit 0.

- [x] **Step 4: Run the dev server in tailnet mode and verify HTTPS banner**

Run: `npm run dev:tailnet` (in a terminal the user controls — agent cannot observe background run).
Expected: Vite prints `https://<host>.ts.net:5176/` in the Network section (not `http://`). Kill with Ctrl+C after verifying.

- [x] **Step 5: curl the HTTPS endpoint**

Run: `curl -sk -o /dev/null -w "code=%{http_code}\n" https://$(tailscale status --json | jq -r '.Self.DNSName' | sed 's/\.$//'):5176/`
Expected: `code=200`. The `-k` skips cert verification so this works even if the local root CA isn't installed for curl.

- [x] **Step 6: Commit**

```bash
git add packages/client/vite.config.ts scripts/dev.sh
git commit -m "feat(dev): Vite HTTPS in tailnet mode via Tailscale cert"
```

---

## Task 3: Placeholder PWA icons

**Files:**
- Create: `scripts/gen-pwa-icons.mjs`, `packages/client/public/icon-192.png`, `icon-512.png`, `icon-maskable-512.png`

- [ ] **Step 1: Create `scripts/gen-pwa-icons.mjs`**

This script draws "R2" text on a solid background using the `sharp` library if available, otherwise falls back to writing a minimal solid-color PNG via a tiny hand-rolled encoder. We use the fallback path to avoid adding a new dependency for placeholder art.

```js
#!/usr/bin/env node
// Generates placeholder PWA icons at the sizes required by manifest.webmanifest.
// Writes solid-color PNGs with a centered "R2" glyph drawn as simple rectangles.
// Intentionally dependency-free: uses Node's zlib + a tiny PNG encoder inline.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(__dirname, '..', 'packages', 'client', 'public');
mkdirSync(outDir, { recursive: true });

const BG = [0x0f, 0x17, 0x2a, 0xff]; // #0f172a
const FG = [0xff, 0xff, 0xff, 0xff];

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = (crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)) >>> 0;
  return (crc ^ 0xffffffff) >>> 0;
}

function encodePng(width, height, pixels) {
  function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([len, typeBuf, data, crcBuf]);
  }
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;      // bit depth
  ihdr[9] = 6;      // color type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const i = y * (1 + width * 4) + 1 + x * 4;
      const p = pixels[y * width + x];
      raw[i] = p[0]; raw[i + 1] = p[1]; raw[i + 2] = p[2]; raw[i + 3] = p[3];
    }
  }
  const idat = deflateSync(raw);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function drawIcon(size, { maskable = false } = {}) {
  const pixels = new Array(size * size);
  // Solid background
  for (let i = 0; i < pixels.length; i++) pixels[i] = BG;

  // For maskable, content must fit inside a 80% safe zone.
  const inset = maskable ? Math.floor(size * 0.1) : 0;
  const inner = size - inset * 2;

  // Draw two filled rectangles that read as "R2" at a glance:
  //   left bar  — vertical rectangle ~20% wide, centered vertically
  //   right bar — vertical rectangle ~20% wide, offset right, slightly shorter
  const barW = Math.floor(inner * 0.2);
  const barH = Math.floor(inner * 0.6);
  const gap = Math.floor(inner * 0.08);
  const totalW = barW * 2 + gap;
  const startX = inset + Math.floor((inner - totalW) / 2);
  const startY = inset + Math.floor((inner - barH) / 2);

  function fill(x0, y0, w, h) {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        if (x >= 0 && x < size && y >= 0 && y < size) pixels[y * size + x] = FG;
      }
    }
  }
  fill(startX, startY, barW, barH);
  fill(startX + barW + gap, startY + Math.floor(barH * 0.15), barW, Math.floor(barH * 0.85));

  return encodePng(size, size, pixels);
}

writeFileSync(resolve(outDir, 'icon-192.png'), drawIcon(192));
writeFileSync(resolve(outDir, 'icon-512.png'), drawIcon(512));
writeFileSync(resolve(outDir, 'icon-maskable-512.png'), drawIcon(512, { maskable: true }));

console.log('✓ Wrote icon-192.png, icon-512.png, icon-maskable-512.png');
```

- [ ] **Step 2: Run the generator**

Run: `node scripts/gen-pwa-icons.mjs`
Expected: prints `✓ Wrote icon-192.png, icon-512.png, icon-maskable-512.png`.

- [ ] **Step 3: Verify the PNGs are valid**

Run: `file packages/client/public/icon-192.png packages/client/public/icon-512.png packages/client/public/icon-maskable-512.png`
Expected: each line contains `PNG image data, 192 x 192` / `512 x 512` with 8-bit/color RGBA.

- [ ] **Step 4: Commit**

```bash
git add scripts/gen-pwa-icons.mjs packages/client/public/icon-192.png packages/client/public/icon-512.png packages/client/public/icon-maskable-512.png
git commit -m "feat(client): placeholder PWA icons"
```

---

## Task 4: Manifest + HTML meta tags

**Files:**
- Create: `packages/client/public/manifest.webmanifest`
- Modify: `packages/client/index.html`

- [ ] **Step 1: Create the manifest**

Create `packages/client/public/manifest.webmanifest`:

```json
{
  "name": "R2",
  "short_name": "R2",
  "description": "R2 personal assistant",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "orientation": "portrait",
  "theme_color": "#0f172a",
  "background_color": "#0f172a",
  "icons": [
    { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png" },
    { "src": "/icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ]
}
```

- [ ] **Step 2: Read current `packages/client/index.html`**

Run: `cat packages/client/index.html`
Expected: note the existing `<head>` contents so the next step inserts tags cleanly without duplicating `<title>` or `<link rel="icon">`.

- [ ] **Step 3: Add manifest link and PWA meta tags to `<head>`**

Insert the following lines into `packages/client/index.html` just before `</head>` (order does not matter, keep them grouped):

```html
    <link rel="manifest" href="/manifest.webmanifest" />
    <meta name="theme-color" content="#0f172a" />
    <link rel="apple-touch-icon" href="/icon-192.png" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-title" content="R2" />
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
```

- [ ] **Step 4: Verify manifest is served**

Start dev in a terminal: `npm run dev:tailnet` (or `npm run dev`), then in another terminal:

Run: `curl -s http://localhost:5176/manifest.webmanifest | head -5`
Expected: first lines of JSON showing `"name": "R2"`.

Stop dev with Ctrl+C.

- [ ] **Step 5: Commit**

```bash
git add packages/client/public/manifest.webmanifest packages/client/index.html
git commit -m "feat(client): PWA manifest + iOS meta tags"
```

---

## Task 5: Service Worker + registration

**Files:**
- Create: `packages/client/public/sw.js`
- Modify: `packages/client/src/main.tsx`

- [ ] **Step 1: Create `packages/client/public/sw.js`**

```js
// Minimal Service Worker: passthrough only.
// Exists so Chrome/Edge consider R2 installable. No caching — R2 requires a
// live connection to the local server and cannot run offline.
self.addEventListener('install', () => {
  self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});
self.addEventListener('fetch', () => {
  // Fall through to default network handling.
});
```

- [ ] **Step 2: Read current `packages/client/src/main.tsx`**

Run: `cat packages/client/src/main.tsx`
Expected: note where `createRoot(...).render(...)` is called, to append registration after it.

- [ ] **Step 3: Register the Service Worker after React mounts**

Append to `packages/client/src/main.tsx` (after the existing render call):

```ts
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('/sw.js').catch((err) => {
    console.warn('[pwa] Service Worker registration failed:', err);
  });
}
```

- [ ] **Step 4: Type-check client**

Run: `cd /Users/dim/code/R2-D2 && npx tsc -p packages/client/tsconfig.json --noEmit`
Expected: no output, exit 0.

- [ ] **Step 5: Start dev and verify SW registers in browser devtools**

Run dev in a terminal: `npm run dev:tailnet`
Open `https://<host>.ts.net:5176/` in Chrome on the Mac → DevTools → Application → Service Workers → confirm `sw.js` is "activated and running".
Stop dev with Ctrl+C.

- [ ] **Step 6: Commit**

```bash
git add packages/client/public/sw.js packages/client/src/main.tsx
git commit -m "feat(client): register passthrough service worker"
```

---

## Task 6: Manifest unit test

**Files:**
- Create: `packages/client/src/__tests__/manifest.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/client/src/__tests__/manifest.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('PWA manifest', () => {
  const manifestPath = resolve(__dirname, '..', '..', 'public', 'manifest.webmanifest');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

  it('has required top-level fields', () => {
    expect(manifest.name).toBe('R2');
    expect(manifest.short_name).toBe('R2');
    expect(manifest.start_url).toBe('/');
    expect(manifest.display).toBe('standalone');
    expect(manifest.theme_color).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(manifest.background_color).toMatch(/^#[0-9a-fA-F]{6}$/);
  });

  it('includes 192 and 512 icons plus a maskable variant', () => {
    const icons = manifest.icons as Array<{ sizes: string; purpose?: string }>;
    expect(icons.some((i) => i.sizes === '192x192')).toBe(true);
    expect(icons.some((i) => i.sizes === '512x512')).toBe(true);
    expect(icons.some((i) => i.purpose === 'maskable')).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `cd packages/client && npx vitest run src/__tests__/manifest.test.ts`
Expected: `2 passed` (manifest file was already created in Task 4).

- [ ] **Step 3: Commit**

```bash
git add packages/client/src/__tests__/manifest.test.ts
git commit -m "test(client): validate PWA manifest fields"
```

---

## Task 7: Documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Read current README**

Run: `cat README.md | head -60`
Expected: locate the "Development" or "Getting started" section to anchor the new block below it.

- [ ] **Step 2: Append "Install on phone (dev)" section**

Insert this block in `README.md` at the end of the Development section (or append to the file if no obvious anchor):

```markdown
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

   Vite will serve `https://<your-host>.ts.net:5176/`.

3. **Open that URL on the phone** (same tailnet, Tailscale app must be
   connected). If Mullvad or another VPN is active on the phone, put the
   Tailscale app in split-tunnel so tailnet traffic bypasses the VPN.

4. **Install to home screen:**
   - **iOS Safari:** Share → Add to Home Screen.
   - **Android Chrome:** menu → Install app.

   The app launches in standalone mode (no browser chrome) and uses the
   placeholder R2 icon. Replace icons in `packages/client/public/icon-*.png`
   when a real logo is ready.
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: install R2 on phone via Tailscale HTTPS"
```

---

## Final verification

- [ ] **Step 1: Full client test suite**

Run: `cd packages/client && npx vitest run`
Expected: all tests pass, including the new `manifest.test.ts`.

- [ ] **Step 2: Full server test suite**

Run: `cd packages/server && npx vitest run`
Expected: all tests pass (no server code was touched but guard against accidental breakage).

- [ ] **Step 3: Full type-check**

Run: `cd /Users/dim/code/R2-D2 && npx tsc -p packages/client/tsconfig.json --noEmit && npx tsc -p packages/server/tsconfig.json --noEmit`
Expected: both exit 0, no output.

- [ ] **Step 4: Manual PWA install smoke test**

- `npm run tailnet:cert` (if not already done).
- `npm run dev:tailnet`.
- Open `https://<host>.ts.net:5176/` in Chrome on Mac — DevTools → Application → Manifest shows name "R2", icons, display standalone. Service Worker is activated.
- Open the same URL on phone, install to home screen, launch from home screen, send a chat message, confirm the reply arrives.

If all four pass, the feature is done.
