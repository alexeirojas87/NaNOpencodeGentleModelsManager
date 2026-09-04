import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Dev proxy: Vite :5173 forwards API calls to the Hono server on :8787.
    proxy: {
      '/api': 'http://127.0.0.1:8787',
    },
  },
  build: {
    // dev/build run with `--root web` (package.json scripts), so outDir is
    // root-relative: '../dist' keeps production output at the repo root.
    outDir: '../dist',
    emptyOutDir: true,
  },
  test: {
    // Two projects: node-env tests for server/shared/tools/fixtures (default)
    // and a jsdom project for web component tests (WU6+).
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: [
            'server/**/*.test.{ts,tsx}',
            'shared/**/*.test.{ts,tsx}',
            'tools/**/*.test.{ts,tsx}',
            'test/**/*.test.{ts,tsx}',
          ],
        },
      },
      {
        extends: true,
        test: {
          name: 'web',
          environment: 'jsdom',
          include: ['web/**/*.test.{ts,tsx}'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['server/src/**', 'shared/**'],
      exclude: ['**/*.test.ts', 'web/src/main.tsx'],
    },
  },
});
