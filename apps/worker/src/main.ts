import { Redis } from 'ioredis';
import { Queue } from 'bullmq';
import { loadEnv, getStrategyConfig } from '@sdb/config';
import { createDatabase } from '@sdb/database';
import { assertChainId, createChainClients } from '@sdb/blockchain';
import { DiscoveryRunner } from '@sdb/discovery';
import { bootstrap, createLogger, registerSecret } from '@sdb/shared';
import { DEFAULT_JOB_OPTIONS, QUEUE_NAMES, jobId } from './queues.js';

const logger = createLogger({ name: 'worker' });

// Spec §19/§27: invalid config aborts startup rather than degrading at runtime.
const env = bootstrap('worker configuration is invalid', () => loadEnv(), logger);
const strategy = bootstrap(
  'cannot load strategy config',
  () => getStrategyConfig(env.STRATEGY_VERSION),
  logger,
);

// Spec §25: teach the logger the real secret values so a provider error that
// quotes its own request URL cannot leak the API key (§24).
for (const secret of [
  env.BASE_RPC_HTTP_URL,
  env.BASE_RPC_WSS_URL,
  env.DATABASE_URL,
  env.REDIS_URL,
  env.TELEGRAM_BOT_TOKEN,
]) {
  registerSecret(secret);
}

const { db, close: closeDb } = createDatabase(env.DATABASE_URL);
const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

const queues = Object.fromEntries(
  Object.values(QUEUE_NAMES).map((name) => [name, new Queue(name, { connection })]),
) as Record<string, Queue>;

const chain = createChainClients({
  httpUrl: env.BASE_RPC_HTTP_URL,
  wsUrl: env.BASE_RPC_WSS_URL,
  expectedChainId: env.BASE_CHAIN_ID,
});

// Indexing the wrong chain is silent corruption, not a crash. Check first.
await bootstrapAsync('RPC endpoint is not Base', () => assertChainId(chain.http));

const discoveryQueue = queues[QUEUE_NAMES.discoveryAnalysis]!;

const discovery = new DiscoveryRunner({
  db,
  http: chain.http,
  ws: chain.ws,
  logger,
  config: {
    chainId: env.BASE_CHAIN_ID,
    quoteTokens: env.QUOTE_TOKEN_ALLOWLIST,
    overlapBlocks: env.DISCOVERY_BLOCK_OVERLAP,
    firstStartBackfillBlocks: env.DISCOVERY_FIRST_START_BACKFILL_BLOCKS,
    logChunkBlocks: env.DISCOVERY_LOG_CHUNK_BLOCKS,
    includeAerodromeStable: env.AERODROME_INCLUDE_STABLE,
    pollIntervalMs: env.DISCOVERY_POLL_INTERVAL_MS,
    minDrainIntervalMs: env.DISCOVERY_MIN_DRAIN_INTERVAL_MS,
  },
  // Spec §23: the job ID is derived from the work, so a replayed block range
  // cannot enqueue the same candidate twice.
  enqueue: async (poolId) => {
    await discoveryQueue.add(
      'analyze',
      { poolId, strategyVersion: strategy.strategyVersion },
      { ...DEFAULT_JOB_OPTIONS, jobId: jobId.discoveryAnalysis(poolId) },
    );
  },
});

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'shutting down worker');
  await discovery.stop();
  await Promise.all(Object.values(queues).map((queue) => queue.close()));
  await chain.close().catch(() => {});
  await connection.quit().catch(() => connection.disconnect());
  await closeDb();
  process.exit(0);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => void shutdown(signal));
}

// Spec §24: an unhandled rejection must be visible, not silently fatal.
process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'unhandled rejection');
});

await discovery.start();

logger.info(
  { strategyVersion: strategy.strategyVersion, queues: Object.keys(queues) },
  'worker started; discovery active (phase 1)',
);

/** Async twin of `bootstrap()` for startup steps that hit the network. */
async function bootstrapAsync<T>(message: string, step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (error) {
    logger.fatal(
      { err: error instanceof Error ? error.message : String(error) },
      message,
    );
    process.exit(1);
  }
}
