import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';
import { ConfigurationError } from '@sdb/shared';

/**
 * Spec §25: secrets come from environment variables, never from committed
 * files. Spec §19/§27: invalid configuration must fail loudly at startup rather
 * than degrade at runtime, so this throws instead of falling back to defaults
 * for anything that has no safe default.
 */

const addressList = z
  .string()
  .transform((value) => value.split(',').map((entry) => entry.trim().toLowerCase()))
  .pipe(z.array(z.string().regex(/^0x[0-9a-f]{40}$/, 'expected a 0x address')).min(1));

/**
 * An empty value in a .env file means "not configured", not "configured as an
 * empty string". `.env.example` ships TELEGRAM_BOT_TOKEN= blank for the phases
 * before notifications exist, so without this every fresh copy of the template
 * would fail startup on a credential it does not yet need.
 */
const blankAsUndefined = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  // Spec §10.2: WebSocket drives discovery; HTTP serves reads and multicall.
  BASE_RPC_HTTP_URL: z.string().url(),
  BASE_RPC_WSS_URL: z.string().url(),
  BASE_CHAIN_ID: z.coerce.number().int().positive().default(8453),

  // Spec §11: quote-token allowlist is configuration-driven.
  QUOTE_TOKEN_ALLOWLIST: addressList,

  // Phase 6 only; absent in earlier phases, so notifications stay disabled.
  TELEGRAM_BOT_TOKEN: blankAsUndefined(z.string().min(1).optional()),
  TELEGRAM_CHAT_ID: blankAsUndefined(z.string().min(1).optional()),

  API_PORT: z.coerce.number().int().positive().default(3000),

  // §6.1 notifier circuit breaker. A 401/403 is a global configuration fault
  // that will fail identically for every alert, so retrying it per token only
  // produces failure spam.
  NOTIFIER_CIRCUIT_ENABLED: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  NOTIFIER_CIRCUIT_FAILURE_THRESHOLD: z.coerce.number().int().positive().default(3),
  NOTIFIER_CIRCUIT_OPEN_MS: z.coerce.number().int().positive().default(300_000),

  // Spec §21 outcome tracking.
  OUTCOME_TRACKING_ENABLED: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  /**
   * The reconciler, not Redis, is what makes a 24h horizon durable — a delayed
   * BullMQ job does not survive a FLUSHALL.
   */
  OUTCOME_RECONCILE_INTERVAL_MS: z.coerce.number().int().positive().default(300_000),
  OUTCOME_RECONCILE_LOOKBACK_HOURS: z.coerce.number().int().positive().default(48),
  OUTCOME_RECONCILE_LIMIT: z.coerce.number().int().positive().default(200),
  /**
   * How long a signalled pool keeps being indexed by the swap tail. Must exceed
   * the longest horizon (24h) or that horizon has no trades to measure.
   */
  OUTCOME_TAIL_RETENTION_HOURS: z.coerce.number().int().positive().default(26),
  /** How far a quote-price sample may sit from a trade before it is unusable. */
  QUOTE_SAMPLE_MAX_AGE_MS: z.coerce.number().int().positive().default(300_000),
  /** Fraction of a path's swaps that must be priceable to report a number. */
  OUTCOME_MIN_QUOTE_COVERAGE: z.coerce.number().min(0).max(1).default(0.8),

  /**
   * §21 coverage gate (ADR 0020): refuse to measure a window the swap tail has
   * not finished indexing. Without it an outcome is finalised from whatever was
   * committed at the instant the horizon elapsed, which is never the whole
   * window — measured at 13 of 176 rows wrong, one by 45 percentage points.
   */
  OUTCOME_COVERAGE_GATE_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  OUTCOME_DEFER_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  /** Cap on waiting, so a stalled tail cannot leave a horizon unrecorded. */
  OUTCOME_MAX_DEFER_MS: z.coerce.number().int().positive().default(1_800_000),

  /** Self-healing repair of outcomes measured before their history was complete. */
  OUTCOME_REPAIR_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  OUTCOME_REPAIR_INTERVAL_MS: z.coerce.number().int().positive().default(900_000),
  OUTCOME_REPAIR_LOOKBACK_HOURS: z.coerce.number().int().positive().default(48),
  OUTCOME_REPAIR_LIMIT: z.coerce.number().int().positive().default(100),

  // Spec §10.2: replay overlap so a restart cannot skip blocks.
  DISCOVERY_BLOCK_OVERLAP: z.coerce.number().int().nonnegative().default(50),

  // On first start there is no cursor. Seeding at head - N surfaces real pools
  // within minutes instead of idling until a launch happens. ~1h at 2s blocks.
  DISCOVERY_FIRST_START_BACKFILL_BLOCKS: z.coerce.number().int().nonnegative().default(300),

  // Providers cap eth_getLogs span and the cap is plan-dependent: Alchemy's
  // free tier allows 10 blocks, paid tiers far more. The fetcher halves this
  // automatically when rejected, so an optimistic value self-corrects.
  DISCOVERY_LOG_CHUNK_BLOCKS: z.coerce.number().int().positive().default(10),

  // Fallback drain cadence when no new head arrives (dead socket, §10.2).
  DISCOVERY_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(15_000),

  // Floor between drains. Base blocks every ~2s; draining on each one costs
  // one eth_getLogs per factory and exhausts rate-limited plans.
  DISCOVERY_MIN_DRAIN_INTERVAL_MS: z.coerce.number().int().nonnegative().default(5_000),

  // Deep WETH/USDC pool used as the on-chain ETH/USD oracle (ADR 0002).
  // Derived from the Uniswap V3 factory, not hardcoded from memory.
  WETH_USD_REFERENCE_POOL: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .default('0x6c561b446416e1a00e8e93e221854d6ea4171372')
    .transform((v) => v.toLowerCase()),
  QUOTE_PRICE_TTL_MS: z.coerce.number().int().positive().default(15_000),

  // GoPlus is enrichment only: it does not index tokens inside our operating
  // window, so it can never supply a critical verdict. Keyless and free.
  GOPLUS_ENABLED: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  GOPLUS_BASE_URL: z.string().url().default('https://api.gopluslabs.io'),
  GOPLUS_TIMEOUT_MS: z.coerce.number().int().positive().default(8_000),

  // ETH probe size for the honeypot simulation. Small enough not to move a
  // thin pool, large enough to clear minimum-output rounding.
  RISK_PROBE_WEI: z.string().regex(/^\d+$/).default('10000000000000000'),

  // How long a pool may sit below the liquidity floor before we stop tracking.
  // Pools are often created empty and funded minutes later, so a T+0-only
  // check would discard exactly the launches worth watching.
  LIQUIDITY_GRACE_MINUTES: z.coerce.number().positive().default(5),

  // Addresses per eth_getLogs call in the swap tail; the list is batched to fit.
  SWAP_TAIL_MAX_ADDRESSES: z.coerce.number().int().positive().default(100),

  // Snapshots land on the §13 schedule, not on exact feature boundaries, so
  // "liquidity 5m ago" resolves to the nearest observation within this window.
  FEATURE_SAMPLE_TOLERANCE_MS: z.coerce.number().int().positive().default(120_000),

  // §15.4 clustering. One getAssetTransfers per wallet, but a wallet's first
  // funding is immutable so each is looked up once ever and cached.
  CLUSTERING_ENABLED: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  CLUSTER_MAX_WALLETS: z.coerce.number().int().positive().default(50),

  // Aerodrome stable pools pair correlated assets; new meme tokens land in
  // volatile pools. Off by default, configurable per §3.
  AERODROME_INCLUDE_STABLE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),

  STRATEGY_VERSION: z.string().min(1).default('base-meme-v1'),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

/**
 * Parse and validate the environment.
 *
 * Passing an explicit `source` bypasses .env and process.env entirely, so tests
 * are hermetic: a developer's local .env must not decide whether the suite
 * passes.
 */
export function loadEnv(source?: NodeJS.ProcessEnv): Env {
  if (source === undefined) loadDotenv();
  const parsed = envSchema.safeParse(source ?? process.env);
  if (!parsed.success) {
    // Report every problem at once; do not leak the values themselves.
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new ConfigurationError(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

export function getEnv(): Env {
  cached ??= loadEnv();
  return cached;
}

/** Test-only: drop the memoized env so a fresh one is parsed. */
export function resetEnvCache(): void {
  cached = null;
}
