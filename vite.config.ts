import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// Tauri dev: фиксированный порт (Tauri знает, куда стучаться).
// frontend root = web/, build.outDir = web/dist/ (то же, что читает Tauri).
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  root: resolve(__dirname, 'web'),
  publicDir: resolve(__dirname, 'web/public'),
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 4319,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 4320 } : undefined,
    watch: { ignored: ['**/src-tauri/**', '**/target/**'] },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  build: {
    outDir: resolve(__dirname, 'web/dist'),
    emptyOutDir: true,
    target: process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'safari13',
    minify: !process.env.TAURI_ENV_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
