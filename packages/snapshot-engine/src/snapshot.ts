import { and, eq } from 'drizzle-orm';
import type { PublicClient } from 'viem';
import { pools, tokens, tokenSnapshots, type Database } from '@sdb/database';
import {
  liquidityUsd,
  marketCapUsd,
  priceFromReserves,
  priceFromSqrtPriceX96,
  readPoolState,
  toColumn,
  toUsd,
  type QuotePriceResolver,
} from '@sdb/market-data';
import type { Dex } from '@sdb/domain';
import {
  div,
  fromRaw,
  fromUnixSeconds,
  InvalidDataError,
  ONE,
  ResourceGoneError,
  type Address,
} from '@sdb/shared';
import { tradeWindowStats } from './swap-tail.js';

/**
 * Capture one snapshot of a pool and persist it.
 *
 * Spec §13: each job is identified by pool + scheduled offset and is idempotent
 * — the unique index on (pool_id, scheduled_offset) makes a replay a no-op.
 *
 * Everything here follows §15's rule that unmeasurable values are null, never
 * zero: a pool with no allowlisted quote token has no USD path, and reporting
 * $0 liquidity would read as "worthless" rather than "unknown".
 */
export type SnapshotInput = {
  poolId: string;
  /** 'T0' | '30s' | '1m' | ... — the §13 offset label. */
  scheduledOffset: string;
  /** Window over which trade statistics are aggregated. */
  windowMs: number;
};

export type SnapshotDeps = {
  db: Database;
  http: PublicClient;
  quotePrices: QuotePriceResolver;
};

export type SnapshotResult = {
  created: boolean;
  priceUsd: string | null;
  liquidityUsd: string | null;
};

export async function captureSnapshot(
  deps: SnapshotDeps,
  input: SnapshotInput,
): Promise<SnapshotResult> {
  const { db, http } = deps;

  const rows = await db
    .select({
      poolId: pools.id,
      poolAddress: pools.address,
      dex: pools.dex,
      quoteTokenAddress: pools.quoteTokenAddress,
      tokenId: tokens.id,
      tokenAddress: tokens.address,
      decimals: tokens.decimals,
      totalSupplyRaw: tokens.totalSupplyRaw,
    })
    .from(pools)
    .innerJoin(tokens, eq(pools.tokenId, tokens.id))
    .where(eq(pools.id, input.poolId))
    .limit(1);

  const pool = rows[0];
  // The pool was deleted between scheduling and execution. Permanent, not
  // transient: retrying can never make it exist again (§23).
  if (!pool) {
    throw new ResourceGoneError(`pool ${input.poolId} no longer exists`, {
      poolId: input.poolId,
    });
  }
  if (pool.decimals === null) {
    throw new InvalidDataError(`token ${pool.tokenAddress} has no decimals yet`, {
      poolId: input.poolId,
    });
  }

  // Fetch the head block ONCE and reuse it: it carries both the number the
  // pool read is pinned to and the timestamp §3 requires as event time.
  // Previously this cost two extra round trips per snapshot (getBlockNumber
  // inside readPoolState, then getBlock here), which was a third of the
  // request volume driving provider 429s.
  const block = await http.getBlock({ blockTag: 'latest', includeTransactions: false });
  const observedAt = fromUnixSeconds(block.timestamp);

  const state = await readPoolState(http, {
    poolAddress: pool.poolAddress as Address,
    dex: pool.dex as Dex,
    blockNumber: block.number ?? undefined,
  });

  const baseIsToken0 = state.token0 === pool.tokenAddress;
  const baseDecimals = pool.decimals;

  // The quote token's decimals are not in our tokens table (we only track
  // candidates), so they come from the allowlist config via the resolver.
  const quoteUsd = await deps.quotePrices.getUsdPrice(pool.quoteTokenAddress);
  const quoteDecimals = deps.quotePrices.decimalsFor(pool.quoteTokenAddress);

  // price of the CANDIDATE token denominated in the quote asset
  const priceInQuote = computePriceInQuote({
    state,
    baseIsToken0,
    baseDecimals,
    quoteDecimals,
  });

  const priceUsd = toUsd(priceInQuote, quoteUsd);
  const supply = pool.totalSupplyRaw ? BigInt(pool.totalSupplyRaw) : 0n;

  const mc = marketCapUsd({
    totalSupplyRaw: supply,
    decimals: baseDecimals,
    priceUsd,
  });

  const liq = liquidityUsd({
    baseBalanceRaw: baseIsToken0 ? state.reserve0 : state.reserve1,
    quoteBalanceRaw: baseIsToken0 ? state.reserve1 : state.reserve0,
    baseDecimals,
    quoteDecimals,
    basePriceUsd: priceUsd,
    quotePriceUsd: quoteUsd,
  });

  const capturedAt = new Date();

  // Trade stats come from Postgres — the swap tail already ingested them, so
  // this costs no RPC regardless of how long the window is.
  const stats = await tradeWindowStats(db, {
    poolId: pool.poolId,
    from: new Date(capturedAt.getTime() - input.windowMs),
    to: capturedAt,
    baseIsToken0,
  });

  const volumeUsd =
    stats && quoteUsd !== null
      ? toColumn(toUsd(fromRaw(stats.quoteVolumeRaw, quoteDecimals), quoteUsd))
      : null;

  const inserted = await db
    .insert(tokenSnapshots)
    .values({
      tokenId: pool.tokenId,
      poolId: pool.poolId,
      scheduledOffset: input.scheduledOffset,
      blockNumber: state.blockNumber,
      observedAt,
      capturedAt,
      priceUsd: toColumn(priceUsd),
      marketCapUsd: toColumn(mc),
      liquidityUsd: toColumn(liq),
      baseReserveRaw: (baseIsToken0 ? state.reserve0 : state.reserve1).toString(),
      quoteReserveRaw: (baseIsToken0 ? state.reserve1 : state.reserve0).toString(),
      volumeUsd5m: volumeUsd,
      buyCount5m: stats?.buyCount ?? null,
      sellCount5m: stats?.sellCount ?? null,
      uniqueBuyers5m: stats?.uniqueBuyers ?? null,
    })
    .onConflictDoNothing({
      target: [tokenSnapshots.poolId, tokenSnapshots.scheduledOffset],
    })
    .returning({ id: tokenSnapshots.id });

  return {
    created: inserted.length > 0,
    priceUsd: toColumn(priceUsd),
    liquidityUsd: toColumn(liq),
  };
}

/** Price of the candidate token in the quote asset, per DEX pricing model. */
function computePriceInQuote(input: {
  state: { sqrtPriceX96: bigint | null; reserve0: bigint; reserve1: bigint };
  baseIsToken0: boolean;
  baseDecimals: number;
  quoteDecimals: number;
}): bigint | null {
  const { state, baseIsToken0, baseDecimals, quoteDecimals } = input;
  const decimals0 = baseIsToken0 ? baseDecimals : quoteDecimals;
  const decimals1 = baseIsToken0 ? quoteDecimals : baseDecimals;

  if (state.sqrtPriceX96 !== null) {
    const token0InToken1 = priceFromSqrtPriceX96({
      sqrtPriceX96: state.sqrtPriceX96,
      decimals0,
      decimals1,
    });
    if (token0InToken1 === null) return null;
    // The formula yields token0 priced in token1; invert when the candidate is
    // token1 so the result is always "candidate priced in quote".
    return baseIsToken0 ? token0InToken1 : invert(token0InToken1);
  }

  const token0InToken1 = priceFromReserves({
    reserve0: state.reserve0,
    reserve1: state.reserve1,
    decimals0,
    decimals1,
  });
  if (token0InToken1 === null) return null;
  return baseIsToken0 ? token0InToken1 : invert(token0InToken1);
}

function invert(price: bigint): bigint | null {
  if (price <= 0n) return null;
  return div(ONE, price);
}

/** Load recent snapshots for a pool, oldest first. Used by the expiry check. */
export async function recentSnapshots(
  db: Database,
  poolId: string,
): Promise<Array<{ liquidityUsd: string | null; capturedAt: Date }>> {
  return db
    .select({ liquidityUsd: tokenSnapshots.liquidityUsd, capturedAt: tokenSnapshots.capturedAt })
    .from(tokenSnapshots)
    .where(and(eq(tokenSnapshots.poolId, poolId)))
    .orderBy(tokenSnapshots.capturedAt);
}
