// R89: vitest config. Uses happy-dom (lighter than jsdom) для localStorage
// в тестах routing-ui. Pulse-desktop не имеет test infra до R89 — этот
// файл — первый. 5+ тестов в web/src/llm/routing-ui.test.ts покрывают
// pure-логику (без React rendering), DOM env не обязателен, но happy-dom
// даёт нам честный localStorage без polyfill'ов.

import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    environment: 'happy-dom',
    globals: false,
    include: ['web/src/**/*.test.{ts,tsx}'],
    // Подавляем warning о CSS/asset imports (routing-ui чистый TS, но
    // теоретически кто-то может добавить .test.tsx который импортит .css).
    css: false,
  },
  resolve: {
    alias: {
      // Маппинг для импортов в тестах: src/foo ↔ web/src/foo
      '@': resolve(__dirname, 'web/src'),
    },
  },
});
