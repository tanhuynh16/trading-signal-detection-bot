import { Redis } from 'ioredis';
import { Queue } from 'bullmq';
import { loadEnv, getStrategyConfig } from '@sdb/config';
import { createDatabase } from '@sdb/database';
import { assertChainId, createChainClients } from '@sdb/blockchain';
import { DiscoveryRunner } from '@sdb/discovery';
import { QuotePriceResolver } from '@sdb/market-data';
import { GoPlusSecurityProvider } from '@sdb/security';
import { DEFAULT_RULE_CONFIG } from '@sdb/risk-engine';
import { DEFAULT_COMPONENTS, DEFAULT_PENALTIES } from '@sdb/scoring';
import { pendingAlerts, TelegramNotifier, type Notifier } from '@sdb/notifications';
import {
  damagedOutcomes,
  dueOutcomes,
  evaluateOutcome,
  recordQuoteSample,
} from '@sdb/outcome-tracker';
import { SwapTail } from '@sdb/snapshot-engine';
import { TransferTail } from '@sdb/holder-index';
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
  // §21: every refresh becomes a point on the historical ETH/USD curve, at no
  // extra RPC cost. Outcomes need the rate that held at each point in a 24h
  // window; one spot rate applied to the whole path would let an ETH move
  // contaminate every return. Fire-and-forget — a failed sample must never
  // fail the snapshot that triggered it.
  onSample: ({ tokenAddress, priceUsd }) => {
    if (!env.OUTCOME_TRACKING_ENABLED) return;
    void recordQuoteSample(db, {
      chainId: env.BASE_CHAIN_ID,
      tokenAddress,
      priceUsd,
    }).catch((error: unknown) => {
      logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'failed to record quote price sample; outcome coverage may gap',
      );
    });
  },
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
    // §21: a signalled pool keeps being indexed past its discovery window, or
    // the 24h horizon has no trades to measure.
    outcomeRetentionHours: env.OUTCOME_TAIL_RETENTION_HOURS,
    // Unlike discovery, the tail stays behind head: its rows are what §21
    // measures outcomes from, and an outcome is never recomputed once written.
    confirmations: env.SWAP_TAIL_CONFIRMATIONS,
    reorgDepth: env.SWAP_TAIL_REORG_DEPTH,
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

// Third consumer of the cursor-driven tail pattern. ADR 0005: holder features
// have no other reproducible source — there is no "list holders" RPC.
const transferTail = new TransferTail({
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

// §20 delivery. Absent credentials the pipeline still runs and records alert
// decisions; they simply stay PENDING until a transport exists, rather than
// being marked FAILED for something that was never attempted.
const notifier: Notifier | null =
  env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID
    ? new TelegramNotifier({
        botToken: env.TELEGRAM_BOT_TOKEN,
        chatId: env.TELEGRAM_CHAT_ID,
      })
    : null;

if (!notifier) {
  logger.warn('telegram credentials absent; alerts will be recorded but not sent');
}

const workers = startProcessors({
  db,
  http: chain.http,
  connection,
  queues,
  quotePrices,
  logger,
  goplus,
  notifier,
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
    // §6.1: a globally broken transport is held open rather than retried per
    // token, so a bad credential cannot generate one failed send per evaluation.
    circuit: {
      enabled: env.NOTIFIER_CIRCUIT_ENABLED,
      failureThreshold: env.NOTIFIER_CIRCUIT_FAILURE_THRESHOLD,
      openDurationMs: env.NOTIFIER_CIRCUIT_OPEN_MS,
    },
    // §21 outcome measurement.
    outcome: {
      enabled: env.OUTCOME_TRACKING_ENABLED,
      minQuoteCoverage: env.OUTCOME_MIN_QUOTE_COVERAGE,
      maxSampleAgeMs: env.QUOTE_SAMPLE_MAX_AGE_MS,
      // §21: never measure a window the tail has not finished indexing.
      coverage: {
        enabled: env.OUTCOME_COVERAGE_GATE_ENABLED,
        deferIntervalMs: env.OUTCOME_DEFER_INTERVAL_MS,
        maxDeferMs: env.OUTCOME_MAX_DEFER_MS,
      },
    },
    features: {
      holders: {
        dustThresholdRaw: BigInt(strategy.holders.dustThresholdRaw),
        // The pool itself is the largest holder of every new token; leaving it
        // in makes top10_concentration read ~100% for all of them (§15.3).
        excludedAddresses: new Set(strategy.holders.excludedAddresses),
      },
      sampleToleranceMs: env.FEATURE_SAMPLE_TOLERANCE_MS,
      seedWallets: new Set(strategy.smartMoney.seedWallets),
      smartWalletScores: new Map(),
      chainId: env.BASE_CHAIN_ID,
      funding: env.CLUSTERING_ENABLED
        ? {
            maxWallets: env.CLUSTER_MAX_WALLETS,
            cluster: {
              timeProximityMs: strategy.clustering.timeProximityMs,
              amountTolerance: strategy.clustering.amountTolerance,
              minClusterSize: strategy.clustering.minClusterSize,
            },
          }
        : null,
    },
    // §17 scoring. Weights and thresholds come from strategy config so a
    // change mints a new strategyVersion rather than reinterpreting history.
    scoring: {
      weights: strategy.scoring.weights,
      nullPolicy: strategy.scoring.nullPolicy,
      minCoverage: strategy.scoring.minCoverage,
      strategyVersion: strategy.strategyVersion,
      components: DEFAULT_COMPONENTS,
      penalties: DEFAULT_PENALTIES,
    },
    // §18 state machine.
    transitions: {
      interestingThreshold: strategy.scoring.interestingThreshold,
      strongThreshold: strategy.scoring.strongThreshold,
      downgradePolicyEnabled: strategy.alerts.downgradePolicyEnabled,
      maxTokenAgeMinutes: strategy.discovery.maxTokenAgeMinutes,
      inactiveExpiryMinutes: strategy.tracking.inactiveExpiryMinutes,
      liquidityCollapseFraction: strategy.tracking.liquidityCollapseFraction,
    },
    dedupe: {
      rescoreDelta: strategy.alerts.rescoreDelta,
      cooldownMinutes: strategy.alerts.cooldownMinutes,
    },
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
    confirmations: env.DISCOVERY_CONFIRMATIONS,
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
  if (outcomeTimer) clearInterval(outcomeTimer);
  if (repairTimer) clearInterval(repairTimer);
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
    await transferTail.drain(head, tailFirstDrain);
    tailFirstDrain = false;
  } catch (error) {
    logger.error(
      { err: error instanceof Error ? error.message : String(error) },
      'swap tail drain failed; discovery continues',
    );
  }
});

/**
 * Requeue alerts left PENDING by a previous run.
 *
 * A PENDING row is a decision that survived dedup and is owed a delivery. If
 * the worker died between recording it and the queue job being consumed — or
 * Redis was flushed — the job is gone but the obligation is not. §20 requires
 * the signal not be discarded, so the durable table is the source of truth and
 * the queue is rebuilt from it at startup.
 *
 * Job IDs are keyed on the alert, so requeueing something still in flight is a
 * no-op rather than a double send.
 */
const orphaned = await pendingAlerts(db);
if (orphaned.length > 0) {
  await Promise.all(
    orphaned.map((alertId) =>
      queues[QUEUE_NAMES.notification]!.add(
        'send',
        { alertId },
        { ...DEFAULT_JOB_OPTIONS, jobId: jobId.notification(alertId) },
      ),
    ),
  );
  logger.info({ count: orphaned.length }, 'requeued pending alerts from a previous run');
}

/**
 * Requeue outcome horizons that came due while nothing was listening.
 *
 * §21 requires the same durable scheduling as snapshots, but a 24h BullMQ delay
 * lives in Redis, and Phase 6.1 settled that a long-lived obligation cannot
 * live only there — a restart is survivable, a FLUSHALL is not. The durable
 * `signals` rows are the source of truth; the queue is rebuilt from them.
 *
 * Job IDs are keyed on signal + horizon, so requeueing something still delayed
 * is a no-op rather than a double evaluation.
 */
async function reconcileOutcomes(): Promise<void> {
  try {
    const due = await dueOutcomes(db, {
      lookbackMs: env.OUTCOME_RECONCILE_LOOKBACK_HOURS * 3_600_000,
      limitPerHorizon: env.OUTCOME_RECONCILE_LIMIT,
    });
    if (due.length === 0) return;

    await Promise.all(
      due.map((item) =>
        queues[QUEUE_NAMES.outcome]!.add(
          'evaluate',
          { signalId: item.signalId, horizon: item.horizon },
          { ...DEFAULT_JOB_OPTIONS, jobId: jobId.outcome(item.signalId, item.horizon) },
        ),
      ),
    );
    logger.info({ count: due.length }, 'requeued outcome horizons that came due');
  } catch (error) {
    logger.error(
      { err: error instanceof Error ? error.message : String(error) },
      'outcome reconciliation failed; will retry on the next tick',
    );
  }
}

/**
 * Recompute outcomes that were measured before their trade history was complete.
 *
 * The coverage gate stops new rows being written that way, but Phase 7 already
 * finalised 13 of 176 from short windows, and nothing else can ever revisit
 * them — the insert refuses to rewrite and the reconciler skips any row that
 * exists. This runs in-process rather than as a one-off script because the gate
 * also records `incomplete_tail_coverage` when it gives up waiting, and those
 * become measurable the moment the tail catches up.
 *
 * Every correction is written with a bumped `revision` and logged old -> new,
 * so a restated measurement is never silent.
 */
async function repairOutcomes(): Promise<void> {
  try {
    const damaged = await damagedOutcomes(db, {
      lookbackMs: env.OUTCOME_REPAIR_LOOKBACK_HOURS * 3_600_000,
      limit: env.OUTCOME_REPAIR_LIMIT,
    });
    if (damaged.length === 0) return;

    let repaired = 0;
    let stillShort = 0;
    for (const item of damaged) {
      // The gate applies here too: repairing from coverage that is still short
      // would just replace one wrong number with another.
      const result = await evaluateOutcome(
        db,
        quotePrices,
        {
          minQuoteCoverage: env.OUTCOME_MIN_QUOTE_COVERAGE,
          maxSampleAgeMs: env.QUOTE_SAMPLE_MAX_AGE_MS,
          coverage: {
            enabled: env.OUTCOME_COVERAGE_GATE_ENABLED,
            deferIntervalMs: env.OUTCOME_DEFER_INTERVAL_MS,
            // Repair never waits: if coverage is short right now, leave the row
            // alone and let a later sweep pick it up.
            maxDeferMs: Number.MAX_SAFE_INTEGER,
          },
        },
        { signalId: item.signalId, horizon: item.horizon, replace: true },
      );

      if (result.status === 'deferred') {
        stillShort += 1;
        continue;
      }
      repaired += 1;
      logger.info(
        {
          signalId: item.signalId,
          horizon: item.horizon,
          was: item.reason,
          returnPct: result.metrics.returnPct,
          maxRunupPct: result.metrics.maxRunupPct,
          maxDrawdownPct: result.metrics.maxDrawdownPct,
          trades: result.metrics.tradeCount,
          failureReason: result.metrics.failureReason,
        },
        'outcome restated from complete trade history',
      );
    }

    logger.info({ found: damaged.length, repaired, stillShort }, 'outcome repair sweep');
  } catch (error) {
    logger.error(
      { err: error instanceof Error ? error.message : String(error) },
      'outcome repair failed; will retry on the next tick',
    );
  }
}

let outcomeTimer: NodeJS.Timeout | null = null;
let repairTimer: NodeJS.Timeout | null = null;
if (env.OUTCOME_TRACKING_ENABLED) {
  await reconcileOutcomes();
  outcomeTimer = setInterval(() => void reconcileOutcomes(), env.OUTCOME_RECONCILE_INTERVAL_MS);
  outcomeTimer.unref();

  if (env.OUTCOME_REPAIR_ENABLED) {
    await repairOutcomes();
    repairTimer = setInterval(() => void repairOutcomes(), env.OUTCOME_REPAIR_INTERVAL_MS);
    repairTimer.unref();
  }
}

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
