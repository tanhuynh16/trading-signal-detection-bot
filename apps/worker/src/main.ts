import { Redis } from 'ioredis';
import { Queue } from 'bullmq';
import { loadEnv, getStrategyConfig } from '@sdb/config';
import { createDatabase } from '@sdb/database';
import { bootstrap, createLogger } from '@sdb/shared';
import { QUEUE_NAMES } from './queues.js';

const logger = createLogger({ name: 'worker' });

// Spec §19/§27: invalid config aborts startup rather than degrading at runtime.
const env = bootstrap('worker configuration is invalid', () => loadEnv(), logger);
const strategy = bootstrap(
  'cannot load strategy config',
  () => getStrategyConfig(env.STRATEGY_VERSION),
  logger,
);

const { db, close: closeDb } = createDatabase(env.DATABASE_URL);
const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

/**
 * Phase 0 stands the queues up and verifies connectivity. Producers and
 * processors land in Phases 1-7; spec §29 forbids implementing them early.
 */
const queues = Object.fromEntries(
  Object.values(QUEUE_NAMES).map((name) => [name, new Queue(name, { connection })]),
) as Record<string, Queue>;

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'shutting down worker');
  await Promise.all(Object.values(queues).map((queue) => queue.close()));
  await connection.quit().catch(() => connection.disconnect());
  await closeDb();
  process.exit(0);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => void shutdown(signal));
}

// Spec §24: never let an unhandled rejection kill the process silently.
process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'unhandled rejection');
});

logger.info(
  {
    strategyVersion: strategy.strategyVersion,
    queues: Object.keys(queues),
    quoteTokens: env.QUOTE_TOKEN_ALLOWLIST.length,
  },
  'worker started (phase 0: infrastructure only, no processors registered)',
);

// Keep the process alive; queues hold no listeners until Phase 1.
void db;
