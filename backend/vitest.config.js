import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Exclude files that use Node.js native test runner (node:test), not vitest.
    // These run via `node --test` with a real PostgreSQL connection.
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/*.itest.js',
      '**/*PostgresIntegrationReal*',
      '**/*PerformanceReal*',
      '**/*RebuildIdempotencyReal*',
    ],
  },
});
