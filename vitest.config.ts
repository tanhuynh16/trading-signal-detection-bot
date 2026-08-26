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
    env: {
      /**
       * A database of its own, separate from the one a running worker uses.
       *
       * The suites truncate the tables the pipeline writes to, which destroyed
       * a live verification run three times before this was added — and made
       * every "why is the data gone?" moment look like a product bug. Create it
       * once with:
       *
       *   docker compose exec postgres psql -U sdb -d postgres \
       *     -c 'CREATE DATABASE sdb_test OWNER sdb;'
       *   DATABASE_URL=postgres://sdb:sdb@localhost:5432/sdb_test \
       *     pnpm --filter @sdb/database migrate
       *
       * Individual suites still honour TEST_DATABASE_URL from the environment.
       */
      TEST_DATABASE_URL:
        process.env.TEST_DATABASE_URL ?? 'postgres://sdb:sdb@localhost:5432/sdb_test',
    },
  },
});
