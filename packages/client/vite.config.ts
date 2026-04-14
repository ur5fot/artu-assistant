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
