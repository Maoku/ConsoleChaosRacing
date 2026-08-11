import { defineConfig } from 'vitest/config';

export default defineConfig({
  // リポジトリルート = アプリルート（Docs/IMPLEMENTATION_PLAN.md §2.4）
  root: '.',
  publicDir: 'public',
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
  },
  server: {
    port: 5173,
  },
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
  },
});
