import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { config } from 'dotenv';
import { resolve } from 'node:path';

config({ path: resolve(__dirname, '..', '..', '.env') });

export default defineConfig({
  plugins: [react()],
  server: {
    port: parseInt(process.env.CLIENT_PORT || '5173', 10),
    proxy: {
      '/api': `http://localhost:${process.env.PORT || 3001}`,
    },
  },
});
