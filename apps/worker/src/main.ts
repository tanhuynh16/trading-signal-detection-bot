import { Redis } from 'ioredis';
import { Queue } from 'bullmq';
import { loadEnv, getStrategyConfig } from '@sdb/config';
import { createDatabase } from '@sdb/database';
import { assertChainId, createChainClients } from '@sdb/blockchain';
import { DiscoveryRunner } from '@sdb/discovery';
import { QuotePriceResolver } from '@sdb/market-data';
import { GoPlusSecurityProvider } from '@sdb/security';
import { DEFAULT_RULE_CONFIG } from '@sdb/risk-engine';
import { SwapTail } from '@sdb/snapshot-engine';
import { startProcessors } from './processors.js';
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

// USDC and DAI on Base carry different decimals (6 vs 18); the resolver is told
// explicitly rather than assuming, since a wrong value shifts USD by 10^12.
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const DAI = '0x50c5725949a6f0c72e6c4a641f24049a917db0cb';
const WETH = '0x4200000000000000000000000000000000000006';

const quotePrices = new QuotePriceResolver(chain.http, {
  stablecoins: [USDC, DAI],
  decimals: { [USDC]: 6, [DAI]: 18, [WETH]: 18 },
  weth: WETH,
  referencePool: env.WETH_USD_REFERENCE_POOL as `0x${string}`,
  ttlMs: env.QUOTE_PRICE_TTL_MS,
});

// One global tail ingests Swap logs for every tracked pool in a single query
// per block window, so snapshots read trades from Postgres at zero RPC cost.
const swapTail = new SwapTail({
  db,
  http: chain.http,
  logger,
  config: {
    chainId: env.BASE_CHAIN_ID,
    logChunkBlocks: env.DISCOVERY_LOG_CHUNK_BLOCKS,
    maxTokenAgeMinutes: strategy.discovery.maxTokenAgeMinutes,
    maxAddressesPerQuery: env.SWAP_TAIL_MAX_ADDRESSES,
  },
});

// Enrichment only. Measured: GoPlus returns 10 of 39 fields for a token one
// minute old, with every critical field absent, and unchanged six minutes
// later. The simulator owns the critical verdict; this fills the rest.
const goplus = env.GOPLUS_ENABLED
  ? new GoPlusSecurityProvider({
      baseUrl: env.GOPLUS_BASE_URL,
      chainId: env.BASE_CHAIN_ID,
      timeoutMs: env.GOPLUS_TIMEOUT_MS,
    })
  : null;

const workers = startProcessors({
  db,
  http: chain.http,
  connection,
  queues,
  quotePrices,
  logger,
  goplus,
  config: {
    minLiquidityUsd: strategy.discovery.minLiquidityUsd,
    liquidityGraceMinutes: env.LIQUIDITY_GRACE_MINUTES,
    // Strategy config overrides the §14.1 defaults, so a change to the table
    // mints a new strategyVersion rather than silently reinterpreting history.
    riskRules: {
      ...DEFAULT_RULE_CONFIG,
      actions: { ...DEFAULT_RULE_CONFIG.actions, ...strategy.risk.actions },
      severities: { ...DEFAULT_RULE_CONFIG.severities, ...strategy.risk.severities },
      maxTokenTaxFraction: strategy.risk.maxTokenTaxFraction,
      warnTokenTaxFraction: strategy.risk.warnTokenTaxFraction,
      warnTop10ConcentrationPercent: strategy.risk.warnTop10ConcentrationPercent,
      failTop10ConcentrationPercent: strategy.risk.failTop10ConcentrationPercent,
    },
    riskOffsets: strategy.risk.evaluateAtOffsets,
    riskProbeWei: BigInt(env.RISK_PROBE_WEI),
  },
});

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
  await Promise.all(workers.map((worker) => worker.close()));
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

// The tail rides the same head notifications as discovery: one drain pass
// keeps both the cursor and the trade log moving without extra polling.
let tailFirstDrain = true;
discovery.onDrained(async (head) => {
  try {
    await swapTail.drain(head, tailFirstDrain);
    tailFirstDrain = false;
  } catch (error) {
    logger.error(
      { err: error instanceof Error ? error.message : String(error) },
      'swap tail drain failed; discovery continues',
    );
  }
});

await discovery.start();

logger.info(
  {
    strategyVersion: strategy.strategyVersion,
    queues: Object.keys(queues),
    processors: workers.length,
  },
  'worker started; discovery + snapshot pipeline active (phase 2)',
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
