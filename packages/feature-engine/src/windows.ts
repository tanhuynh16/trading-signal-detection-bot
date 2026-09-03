import { and, asc, eq, inArray, min, sql } from 'drizzle-orm';
import { holderBalances, pools, tokenSnapshots, trades, type Database } from '@sdb/database';
import { fromRaw, mul, toNumber } from '@sdb/shared';
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

  /**
   * Volume comes from the QUOTE side of each swap.
   *
   * `trades.usd_value` is never populated — valuing each trade individually
   * would need a price lookup per trade — so this previously fell through to a
   * trade COUNT, which is a different signal: ten dust trades and one whale
   * trade are not the same volume. The quote side is always WETH/USDC/DAI,
   * whose USD price the pipeline already resolves and caches, so summing raw
   * quote amounts here and converting once in the caller gives real dollars.
   *
   * Column naming is a legacy trap: base_amount_raw/quote_amount_raw actually
   * hold amount0/amount1 as emitted, NOT base/quote. So the quote side is
   * quote_amount_raw when the candidate is token0, and base_amount_raw when it
   * is token1 — the same inversion buyMarker applies above.
   */
  const quoteColumn = input.baseIsToken0 ? trades.quoteAmountRaw : trades.baseAmountRaw;

  const rows = await db.execute<{
    buy_count: string;
    sell_count: string;
    unique_buyers: string;
    quote_volume_raw: string | null;
  }>(sql`
    SELECT
      count(*) FILTER (WHERE side = ${buyMarker})               AS buy_count,
      count(*) FILTER (WHERE side <> ${buyMarker})              AS sell_count,
      count(DISTINCT wallet) FILTER (WHERE side = ${buyMarker}) AS unique_buyers,
      sum(abs(${quoteColumn}))                                  AS quote_volume_raw
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
    // Raw quote units; the caller converts to USD once it knows the quote
    // token's decimals and price. Null means no trades, not zero volume.
    quoteVolumeRaw: row?.quote_volume_raw != null ? BigInt(row.quote_volume_raw) : null,
    volumeUsd: null,
    durationMinutes,
  };
}

/**
 * Convert a window's raw quote volume into USD.
 *
 * Returns null when the quote token has no USD path — a pool quoted in an
 * unrecognised asset has no dollar volume we can honestly report, and §15
 * forbids substituting a number for missing data.
 */
export function windowVolumeUsd(
  window: TradeWindow,
  quoteUsd: bigint | null,
  quoteDecimals: number,
): number | null {
  if (window.quoteVolumeRaw === null || quoteUsd === null) return null;
  return toNumber(mul(fromRaw(window.quoteVolumeRaw, quoteDecimals), quoteUsd));
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
/**
 * Pool contracts holding this token, which are never "holders" for §15.3.
 *
 * An AMM pool is the counterparty to every trade, so it is the largest holder of
 * essentially every new token — measured: **108 of 156 tokens (69.2%) had a pool
 * contract as their top holder**. Counting it pushes `top10_concentration`
 * toward 1.0 for all of them and drags the holder component down uniformly,
 * hiding real distribution differences between tokens.
 *
 * `holders.excludedAddresses` exists for exactly this and was documented for it,
 * but ships empty and a static list cannot keep up: new pools appear
 * continuously, so any curated list is stale the moment it is written. Deriving
 * the set from `pools` at calculation time is self-maintaining. The DERIVATION
 * is what is versioned by the strategy, not the resulting address list.
 *
 * **Known trade-off — historical reproducibility.** Because the set is derived
 * when the feature is calculated, recomputing an old feature set later can use a
 * DIFFERENT exclusion set than the original run did: more pools for that token
 * may exist by then, so a wallet counted as a holder in the stored row would be
 * excluded on recomputation. Stored rows are never rewritten, so nothing already
 * recorded changes — but a recomputation is not guaranteed to reproduce one.
 *
 * That is accepted deliberately here: the alternative, a static list, is wrong
 * continuously rather than only on replay, and 69.2% of tokens are affected
 * today. Making replay exact needs the pool set pinned as of the feature's
 * block, which changes what the feature MEANS and therefore belongs to a new
 * `feature_version` — not to this audit.
 */
export async function poolAddressesForToken(
  db: Database,
  tokenId: string,
): Promise<string[]> {
  const rows = await db
    .select({ address: pools.address })
    .from(pools)
    .where(eq(pools.tokenId, tokenId));
  return rows.map((row) => row.address.toLowerCase());
}

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


/**
 * Seeded smart wallets that BOUGHT this token, with their earliest entry.
 *
 * Previously `smartEntries` was hardcoded to `[]`, so §15.5 could never see an
 * entry even with a populated seed list — and `independent_smart_wallet_count`
 * would have reported a *measured* 0 ("no smart money entered") when nothing
 * had actually looked. On a component carrying 0.30 of the alpha weight that
 * is precisely the null-vs-zero failure §15 exists to prevent.
 *
 * An empty seed list short-circuits without querying, so the features stay null
 * for the right reason rather than by accident.
 *
 * Known approximation: `trades.wallet` is the swap recipient. For a routed
 * swap that is the trader, but a contract that forwards tokens onward would be
 * attributed the entry instead.
 */
export async function smartWalletEntries(
  db: Database,
  input: { poolId: string; seedWallets: ReadonlySet<string>; baseIsToken0: boolean },
): Promise<Array<{ wallet: string; enteredAt: Date }>> {
  if (input.seedWallets.size === 0) return [];

  const buyMarker = input.baseIsToken0 ? 'OUT0' : 'OUT1';
  const seeded = [...input.seedWallets].map((w) => w.toLowerCase());

  // Query builder rather than raw sql``: the driver does not serialize a JS
  // array into `= ANY(...)` and fails at bind time with "malformed array
  // literal" — the same class of trap as passing a Date through a raw
  // parameter, which broke every snapshot in Phase 2.
  const rows = await db
    .select({ wallet: trades.wallet, enteredAt: min(trades.occurredAt) })
    .from(trades)
    .where(
      and(
        eq(trades.poolId, input.poolId),
        eq(trades.side, buyMarker),
        inArray(trades.wallet, seeded),
      ),
    )
    .groupBy(trades.wallet);

  return rows
    .filter((row): row is { wallet: string; enteredAt: Date } => row.enteredAt !== null)
    .map((row) => ({ wallet: row.wallet, enteredAt: row.enteredAt }));
}
