import { and, asc, eq, sql } from 'drizzle-orm';
import { holderBalances, tokenSnapshots, trades, type Database } from '@sdb/database';
import type { TradeWindow } from './momentum.js';
import type { HolderBalance } from './holders.js';
import type { LiquiditySample } from './liquidity.js';

/**
 * Data loaders for the feature engine.
 *
 * All trade windows are read from Postgres, never from RPC: the swap tail
 * already ingests every Swap for tracked pools (ADR 0008), so an arbitrary
 * window costs one query regardless of how far back it reaches.
 */

/**
 * Aggregate one trade window.
 *
 * `side` is stored as which token left the pool (OUT0/OUT1), because BUY/SELL
 * depends on which side is the candidate and that is only known here.
 *
 * Dates are passed as ISO strings with an explicit cast: the postgres driver
 * does not serialize a JS Date through a raw sql`` parameter and fails at bind
 * time — a bug that broke every snapshot in Phase 2 before it was found.
 */
export async function tradeWindow(
  db: Database,
  input: { poolId: string; from: Date; to: Date; baseIsToken0: boolean },
): Promise<TradeWindow> {
  const buyMarker = input.baseIsToken0 ? 'OUT0' : 'OUT1';
  const from = input.from.toISOString();
  const to = input.to.toISOString();

  const rows = await db.execute<{
    buy_count: string;
    sell_count: string;
    unique_buyers: string;
    volume_usd: string | null;
  }>(sql`
    SELECT
      count(*) FILTER (WHERE side = ${buyMarker})               AS buy_count,
      count(*) FILTER (WHERE side <> ${buyMarker})              AS sell_count,
      count(DISTINCT wallet) FILTER (WHERE side = ${buyMarker}) AS unique_buyers,
      sum(${trades.usdValue})                                   AS volume_usd
    FROM ${trades}
    WHERE ${trades.poolId} = ${input.poolId}
      AND ${trades.occurredAt} >  ${from}::timestamptz
      AND ${trades.occurredAt} <= ${to}::timestamptz
  `);

  const row = rows[0];
  const durationMinutes = (input.to.getTime() - input.from.getTime()) / 60_000;

  return {
    buyCount: Number(row?.buy_count ?? 0),
    sellCount: Number(row?.sell_count ?? 0),
    uniqueBuyers: Number(row?.unique_buyers ?? 0),
    // Trades are stored without USD valuation (that would need a price lookup
    // per trade); volume falls back to trade count elsewhere. Null, not 0.
    volumeUsd: row?.volume_usd != null ? Number(row.volume_usd) : null,
    durationMinutes,
  };
}

/**
 * Consecutive equal-length windows ending at `endingAt`, most recent first.
 *
 * `volume_acceleration_5m` needs the current window plus three priors, so this
 * returns four by default — roughly 20 minutes of history, which is why the
 * feature is null for young tokens rather than defaulted.
 */
export async function consecutiveWindows(
  db: Database,
  input: {
    poolId: string;
    endingAt: Date;
    windowMs: number;
    count: number;
    baseIsToken0: boolean;
  },
): Promise<TradeWindow[]> {
  const windows: TradeWindow[] = [];
  for (let i = 0; i < input.count; i += 1) {
    const to = new Date(input.endingAt.getTime() - i * input.windowMs);
    const from = new Date(to.getTime() - input.windowMs);
    windows.push(
      await tradeWindow(db, { poolId: input.poolId, from, to, baseIsToken0: input.baseIsToken0 }),
    );
  }
  return windows;
}

/**
 * Volume proxy for a window.
 *
 * `trades.usd_value` is not populated (valuing each trade individually would
 * cost a price lookup per trade), so trade count stands in as the volume
 * measure. Acceleration is a *ratio* of like windows, so a consistent proxy
 * preserves the signal §15.2 is after even though the unit is not dollars.
 */
export function windowVolume(window: TradeWindow): number | null {
  if (window.volumeUsd !== null) return window.volumeUsd;
  const trades = window.buyCount + window.sellCount;
  return trades > 0 ? trades : 0;
}

/** Liquidity series for a pool, oldest first. */
export async function liquiditySeries(
  db: Database,
  poolId: string,
): Promise<LiquiditySample[]> {
  const rows = await db
    .select({ usd: tokenSnapshots.liquidityUsd, at: tokenSnapshots.capturedAt })
    .from(tokenSnapshots)
    .where(eq(tokenSnapshots.poolId, poolId))
    .orderBy(asc(tokenSnapshots.capturedAt));

  return rows.map((row) => ({
    usd: row.usd === null ? null : Number(row.usd),
    at: row.at,
  }));
}

/** Latest snapshot values needed by the liquidity features. */
export async function latestSnapshot(
  db: Database,
  poolId: string,
): Promise<{ liquidityUsd: number | null; marketCapUsd: number | null; at: Date } | null> {
  const rows = await db
    .select({
      liquidityUsd: tokenSnapshots.liquidityUsd,
      marketCapUsd: tokenSnapshots.marketCapUsd,
      at: tokenSnapshots.capturedAt,
    })
    .from(tokenSnapshots)
    .where(eq(tokenSnapshots.poolId, poolId))
    .orderBy(sql`${tokenSnapshots.capturedAt} DESC`)
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  return {
    liquidityUsd: row.liquidityUsd === null ? null : Number(row.liquidityUsd),
    marketCapUsd: row.marketCapUsd === null ? null : Number(row.marketCapUsd),
    at: row.at,
  };
}

/** Current holder balances for a token. Balances stay bigint (G4). */
export async function loadHolderBalances(
  db: Database,
  tokenId: string,
): Promise<HolderBalance[]> {
  const rows = await db
    .select({
      wallet: holderBalances.wallet,
      balanceRaw: holderBalances.balanceRaw,
      firstAcquiredAt: holderBalances.firstAcquiredAt,
    })
    .from(holderBalances)
    .where(and(eq(holderBalances.tokenId, tokenId)));

  return rows.map((row) => ({
    wallet: row.wallet,
    balanceRaw: BigInt(row.balanceRaw),
    firstAcquiredAt: row.firstAcquiredAt,
  }));
}
