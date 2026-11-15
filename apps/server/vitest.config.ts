import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Each test file starts its own in-memory Postgres (PGlite, with pg_trgm) and runs every
    // migration; with many files in parallel that can take more than vitest's default 5 seconds.
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
