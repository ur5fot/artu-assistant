/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { config } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '..', '..', '.env') });

export default defineConfig({
  plugins: [react()],
  server: {
    port: parseInt(process.env.CLIENT_PORT || '5173', 10),
    host: process.env.VITE_HOST === 'true' ? true : undefined,
    allowedHosts: process.env.VITE_HOST === 'true' ? true : undefined,
    proxy: {
      '/api': `http://localhost:${process.env.PORT || 3001}`,
    },
  },
  test: {
    environment: 'jsdom',
    globals: false,
  },
});
