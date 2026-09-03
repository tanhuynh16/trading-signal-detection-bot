import { desc, eq, sql } from 'drizzle-orm';
import type { PublicClient } from 'viem';
import { featureSets, pools, tokens, type Database } from '@sdb/database';
import type { FeatureSet } from '@sdb/domain';
import { MINUTE_MS, type Logger } from '@sdb/shared';
import { clusterConcentration, type Cluster } from './clustering.js';
import { detectClusters, type FundingLookupConfig } from './funding.js';
import {
  holderCount,
  holderGrowthRate,
  holderRetention,
  top10Concentration,
  type HolderOptions,
} from './holders.js';
import { liquidityGrowth, liquidityStability, mcLiquidityRatio, sampleNear } from './liquidity.js';
import {
  buySellRatio,
  tradeVelocity,
  uniqueBuyerGrowth,
  volumeAcceleration,
} from './momentum.js';
import {
  independentSmartWalletCount,
  smartWalletEntryRecency,
  smartWalletQuality,
  type SmartEntry,
} from './smart-money.js';
import {
  consecutiveWindows,
  latestSnapshot,
  liquiditySeries,
  loadHolderBalances,
  poolAddressesForToken,
  smartWalletEntries,
  windowVolumeUsd,
} from './windows.js';

/** Bump when a formula changes, so stored values remain interpretable (§27). */
export const FEATURE_VERSION = 'features-v1';

export type FeatureConfig = {
  holders: HolderOptions;
  /** Tolerance when matching "liquidity 5m ago" to an actual snapshot. */
  sampleToleranceMs: number;
  /** Wallets seeded as smart money (§15.5). Ships empty. */
  seedWallets: ReadonlySet<string>;
  smartWalletScores: ReadonlyMap<string, number | null>;
  /** §15.4 clustering. Null disables it (e.g. to conserve RPC budget). */
  funding: FundingLookupConfig | null;
  chainId: number;
};

/**
 * Resolves the USD price and decimals of a quote token. Supplied by the worker,
 * which already holds a cached `QuotePriceResolver`.
 */
export type QuotePricing = {
  getUsdPrice(tokenAddress: string): Promise<bigint | null>;
  decimalsFor(tokenAddress: string): number;
};

export type FeatureContext = {
  db: Database;
  logger: Logger;
  config: FeatureConfig;
  /** Needed only for §15.4 funding lookups. */
  http?: PublicClient;
  /** Needed to express trade volume in dollars rather than trade counts. */
  quotePricing?: QuotePricing;
};

/**
 * Offsets at which clustering runs. It costs a network lookup per uncached
 * wallet, and re-running it on every snapshot for every pool produced a 429
 * storm with no new information — holder sets barely move in 30 seconds.
 */
export const CLUSTER_OFFSETS: readonly string[] = ['5m', '30m', '1h'];

export type CalculatedFeatures = {
  tokenId: string;
  poolId: string;
  calculatedAt: Date;
  /** Which snapshot this was computed for; the idempotency key. */
  scheduledOffset: string | null;
  values: FeatureSet;
};

const FIVE_MINUTES = 5 * MINUTE_MS;

/**
 * Compute the full §15 feature set for one pool.
 *
 * Every value is either a number or `null`. Null propagates from insufficient
 * data and is never replaced by a default — §15 forbids substituting zero, and
 * Phase 5's coverage renormalisation (plan G1) depends on being able to tell
 * "measured zero" from "not measurable".
 */
export async function calculateFeatures(
  ctx: FeatureContext,
  poolId: string,
  offset?: string,
): Promise<CalculatedFeatures | null> {
  const rows = await ctx.db
    .select({
      poolId: pools.id,
      tokenId: tokens.id,
      tokenAddress: tokens.address,
      quoteTokenAddress: pools.quoteTokenAddress,
      totalSupplyRaw: tokens.totalSupplyRaw,
      discoveredAt: pools.discoveredAt,
    })
    .from(pools)
    .innerJoin(tokens, eq(pools.tokenId, tokens.id))
    .where(eq(pools.id, poolId))
    .limit(1);

  const pool = rows[0];
  if (!pool) return null;

  const calculatedAt = new Date();
  // token0/token1 ordering follows address sort order on chain.
  const baseIsToken0 = pool.tokenAddress < pool.quoteTokenAddress;

  // ---- §15.1 liquidity -----------------------------------------------------
  const [snapshot, series] = await Promise.all([
    latestSnapshot(ctx.db, poolId),
    liquiditySeries(ctx.db, poolId),
  ]);

  const liquidityUsd = snapshot?.liquidityUsd ?? null;
  const fiveMinutesAgo = sampleNear(
    series,
    new Date(calculatedAt.getTime() - FIVE_MINUTES),
    ctx.config.sampleToleranceMs,
  );

  // ---- §15.2 momentum ------------------------------------------------------
  // Four consecutive 5m windows: the current one plus the three priors that
  // §15.2's acceleration formula averages over.
  const windows = await consecutiveWindows(ctx.db, {
    poolId,
    endingAt: calculatedAt,
    windowMs: FIVE_MINUTES,
    count: 4,
    baseIsToken0,
  });
  const current = windows[0]!;
  const priors = windows.slice(1);

  // Volume in dollars, not trade counts. Null when the quote token has no USD
  // path, which propagates to a null acceleration rather than a fabricated one.
  const quoteUsd = ctx.quotePricing
    ? await ctx.quotePricing.getUsdPrice(pool.quoteTokenAddress)
    : null;
  const quoteDecimals = ctx.quotePricing
    ? ctx.quotePricing.decimalsFor(pool.quoteTokenAddress)
    : 18;
  const toUsdVolume = (w: (typeof windows)[number]) =>
    windowVolumeUsd(w, quoteUsd, quoteDecimals);

  // ---- §15.3 holders -------------------------------------------------------
  const balances = await loadHolderBalances(ctx.db, pool.tokenId);
  const totalSupply = pool.totalSupplyRaw ? BigInt(pool.totalSupplyRaw) : null;
  // The pool is the counterparty to every trade, never a holder (§15.3). The
  // configured list is unioned with the derived one so an operator can still add
  // burn sinks and bridges that no query can infer.
  const holderOptions: HolderOptions = {
    ...ctx.config.holders,
    excludedAddresses: new Set([
      ...ctx.config.holders.excludedAddresses,
      ...(await poolAddressesForToken(ctx.db, pool.tokenId)),
    ]),
  };
  const holdersNow = holderCount(balances, holderOptions);

  const previous = await previousFeatureSet(ctx.db, poolId);
  const elapsedMinutes = previous
    ? (calculatedAt.getTime() - previous.calculatedAt.getTime()) / MINUTE_MS
    : 0;

  // ---- §15.4 / §15.5 -------------------------------------------------------
  // Clustering needs a network lookup per wallet, but each wallet's FIRST
  // funding is immutable and cached permanently, so a given wallet costs one
  // request in the lifetime of the database.
  let clusters: Cluster[] = [];
  const clusteringDue = offset === undefined || CLUSTER_OFFSETS.includes(offset);
  if (ctx.config.funding && ctx.http && clusteringDue) {
    try {
      clusters = await detectClusters(
        { db: ctx.db, http: ctx.http, logger: ctx.logger, chainId: ctx.config.chainId },
        pool.tokenId,
        ctx.config.funding,
      );
    } catch (error) {
      // Clustering is enrichment: losing it must not cost the whole feature
      // set. cluster_concentration then reports null, which is honest.
      ctx.logger.warn(
        { poolId, err: error instanceof Error ? error.message : String(error) },
        'cluster detection failed; cluster features unavailable',
      );
    }
  }
  const seededCount = ctx.config.seedWallets.size;
  // Was hardcoded to []: §15.5 could never observe an entry even with a seeded
  // list, so the count would have read as a measured 0 rather than null.
  const smartEntries: SmartEntry[] = await smartWalletEntries(ctx.db, {
    poolId,
    seedWallets: ctx.config.seedWallets,
    baseIsToken0,
  });

  const values: FeatureSet = {
    // §15.1
    liquidity_usd: liquidityUsd,
    liquidity_growth_5m: liquidityGrowth(liquidityUsd, fiveMinutesAgo?.usd ?? null),
    liquidity_stability: liquidityStability(series),
    mc_liquidity_ratio: mcLiquidityRatio(snapshot?.marketCapUsd ?? null, liquidityUsd),

    // §15.2
    volume_acceleration_5m: volumeAcceleration(
      toUsdVolume(current),
      priors.map(toUsdVolume),
    ),
    buy_sell_ratio: buySellRatio(current),
    trade_velocity: tradeVelocity(current),
    unique_buyer_growth: uniqueBuyerGrowth(current, priors[0] ?? null),

    // §15.3
    holder_count: holdersNow,
    holder_growth_rate: holderGrowthRate(
      holdersNow,
      (previous?.values['holder_count'] as number | null) ?? null,
      elapsedMinutes,
    ),
    top10_concentration: top10Concentration(balances, totalSupply, holderOptions),
    holder_retention: holderRetention(balances, {
      cohortBefore: new Date(calculatedAt.getTime() - FIVE_MINUTES),
      options: holderOptions,
    }),

    // §15.4
    cluster_concentration: clusterConcentration(clusters, balances),

    // §15.5 — null across the board while the seed list is empty. G1's coverage
    // renormalisation handles that; scoring it zero would cap every token.
    independent_smart_wallet_count: independentSmartWalletCount(
      smartEntries,
      clusters,
      seededCount,
    ),
    smart_wallet_entry_recency: smartWalletEntryRecency(smartEntries, calculatedAt, seededCount),
    smart_wallet_quality: smartWalletQuality(
      smartEntries,
      ctx.config.smartWalletScores,
      seededCount,
    ),
  };

  return {
    tokenId: pool.tokenId,
    poolId: pool.poolId,
    calculatedAt,
    scheduledOffset: offset ?? null,
    values,
  };
}

/** Most recent feature set for a pool; source of the previous holder count. */
async function previousFeatureSet(
  db: Database,
  poolId: string,
): Promise<{ calculatedAt: Date; values: FeatureSet } | null> {
  const rows = await db
    .select({ calculatedAt: featureSets.calculatedAt, values: featureSets.values })
    .from(featureSets)
    .where(eq(featureSets.poolId, poolId))
    .orderBy(desc(featureSets.calculatedAt))
    .limit(1);

  const row = rows[0];
  return row ? { calculatedAt: row.calculatedAt, values: row.values as FeatureSet } : null;
}

/**
 * Persist a feature set.
 *
 * `normalized_values` is written empty: normalisation is §16, i.e. Phase 5.
 * §29 forbids implementing ahead, and an invented normalisation now would have
 * to be unpicked later.
 */
export async function persistFeatures(
  db: Database,
  features: CalculatedFeatures,
): Promise<string | null> {
  const [row] = await db
    .insert(featureSets)
    .values({
      tokenId: features.tokenId,
      poolId: features.poolId,
      calculatedAt: features.calculatedAt,
      featureVersion: FEATURE_VERSION,
      scheduledOffset: features.scheduledOffset,
      values: features.values,
      normalizedValues: sql`'{}'::jsonb`,
    })
    // A retried job (5 attempts are configured) previously inserted a SECOND
    // row. Duplicates also corrupt holder_growth_rate, which reads the previous
    // feature set and divides by the elapsed interval between them.
    .onConflictDoNothing({
      target: [featureSets.poolId, featureSets.scheduledOffset],
    })
    .returning({ id: featureSets.id });
  return row?.id ?? null;
}

/** How many features were actually measurable? Useful for observability. */
export function coverage(values: FeatureSet): { measured: number; total: number } {
  const entries = Object.values(values);
  return {
    measured: entries.filter((v) => v !== null).length,
    total: entries.length,
  };
}
