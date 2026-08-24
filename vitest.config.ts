import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['{packages,apps}/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node',
    /**
     * Integration tests share one Postgres database and TRUNCATE the same
     * tables between cases. Running files in parallel lets one suite wipe rows
     * another is mid-assertion on, which surfaces as flaky failures that pass
     * in isolation. The suite is small, so serialising costs a few seconds and
     * buys determinism.
     */
    fileParallelism: false,
  },
});
