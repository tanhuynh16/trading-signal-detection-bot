import { and, asc, eq, gte, lte } from 'drizzle-orm';
import {
  pools,
  quotePriceSamples,
  signalOutcomes,
  signals,
  tokens,
  trades,
  type Database,
} from '@sdb/database';
import { toColumn } from '@sdb/market-data';
import { InvalidDataError, parseScaled } from '@sdb/shared';
import { horizonMs } from './horizons.js';
import {
  baseIsToken0,
  buildPriceSeries,
  computeMetrics,
  type OutcomeMetrics,
} from './price-path.js';

/**
 * Everything needed to price a quote asset historically.
 *
 * Implemented by `QuotePriceResolver`, but taken as an interface so the pure
 * evaluation never depends on a live RPC client.
 */
export type QuoteInfo = {
  decimalsFor(tokenAddress: string): number;
  /** Constant USD value for a pegged quote asset; null means use the series. */
  fixedUsdFor(tokenAddress: string): bigint | null;
};

export type OutcomeConfig = {
  /** Fraction of swaps that must be priceable for a result to be reported. */
  minQuoteCoverage: number;
  /** How far a quote sample may be from a trade before it is unusable. */
  maxSampleAgeMs: number;
};

export type OutcomeResult = {
  created: boolean;
  metrics: OutcomeMetrics;
  horizon: string;
};

/**
 * Evaluate one signal at one horizon (§21).
 *
 * Idempotent by construction: the unique `(signal_id, horizon)` index means a
 * replayed job is a no-op, so a duplicated delayed job and the reconciler can
 * both fire without producing conflicting history. §21 also requires the record
 * be immutable once written — it is inserted, never updated.
 */
export async function evaluateOutcome(
  db: Database,
  quotes: QuoteInfo,
  config: OutcomeConfig,
  input: { signalId: string; horizon: string },
): Promise<OutcomeResult> {
  const elapsedMs = horizonMs(input.horizon);
  if (elapsedMs === null) {
    throw new InvalidDataError(`unknown outcome horizon '${input.horizon}'`, {
      horizon: input.horizon,
    });
  }

  const [row] = await db
    .select({
      signalId: signals.id,
      createdAt: signals.createdAt,
      signalPriceUsd: signals.signalPriceUsd,
      poolId: pools.id,
      quoteTokenAddress: pools.quoteTokenAddress,
      tokenAddress: tokens.address,
      tokenDecimals: tokens.decimals,
    })
    .from(signals)
    .innerJoin(pools, eq(pools.id, signals.poolId))
    .innerJoin(tokens, eq(tokens.id, signals.tokenId))
    .where(eq(signals.id, input.signalId))
    .limit(1);

  if (!row) {
    // Permanent: a deleted signal cannot be evaluated by any number of retries.
    throw new InvalidDataError(`signal ${input.signalId} no longer exists`, {
      signalId: input.signalId,
    });
  }

  const windowStart = row.createdAt;
  const windowEnd = new Date(windowStart.getTime() + elapsedMs);

  const swaps = await db
    .select({
      // The tail stores unoriented amount0/amount1 under these column names.
      amount0Raw: trades.baseAmountRaw,
      amount1Raw: trades.quoteAmountRaw,
      occurredAt: trades.occurredAt,
    })
    .from(trades)
    .where(
      and(
        eq(trades.poolId, row.poolId),
        gte(trades.occurredAt, windowStart),
        lte(trades.occurredAt, windowEnd),
      ),
    )
    // Chronological by chain order, not by wall clock: several swaps share a
    // block, and their sequence within it is the log index.
    .orderBy(asc(trades.blockNumber), asc(trades.logIndex));

  const fixedQuoteUsd = quotes.fixedUsdFor(row.quoteTokenAddress);
  const samples =
    fixedQuoteUsd === null
      ? await loadSamples(db, row.quoteTokenAddress, windowStart, windowEnd, config.maxSampleAgeMs)
      : [];

  const metrics =
    row.tokenDecimals === null
      ? // Without decimals every amount is off by an unknown power of ten.
        // Defaulting to 18 would produce a confident, wrong price path.
        unmeasurable('no_token_decimals', swaps.length)
      : computeMetrics({
          signalPriceUsd:
            row.signalPriceUsd === null ? null : parseScaled(row.signalPriceUsd),
          series: buildPriceSeries({
            swaps,
            samples,
            baseIsToken0: baseIsToken0(row.tokenAddress, row.quoteTokenAddress),
            baseDecimals: row.tokenDecimals,
            quoteDecimals: quotes.decimalsFor(row.quoteTokenAddress),
            fixedQuoteUsd,
            maxSampleAgeMs: config.maxSampleAgeMs,
          }),
          minCoverage: config.minQuoteCoverage,
        });

  const inserted = await db
    .insert(signalOutcomes)
    .values({
      signalId: row.signalId,
      horizon: input.horizon,
      evaluatedAt: new Date(),
      priceUsd: toColumn(metrics.priceUsd),
      returnPct: metrics.returnPct,
      maxRunupPct: metrics.maxRunupPct,
      maxDrawdownPct: metrics.maxDrawdownPct,
      tradeCount: metrics.tradeCount,
      failureReason: metrics.failureReason,
    })
    .onConflictDoNothing({ target: [signalOutcomes.signalId, signalOutcomes.horizon] })
    .returning({ id: signalOutcomes.id });

  return { created: inserted.length > 0, metrics, horizon: input.horizon };
}

/**
 * Quote-price samples covering the window, widened by the tolerance so a trade
 * at either edge can still find its nearest neighbour.
 */
async function loadSamples(
  db: Database,
  tokenAddress: string,
  windowStart: Date,
  windowEnd: Date,
  maxSampleAgeMs: number,
): Promise<Array<{ observedAt: Date; priceUsd: bigint }>> {
  const rows = await db
    .select({ observedAt: quotePriceSamples.observedAt, priceUsd: quotePriceSamples.priceUsd })
    .from(quotePriceSamples)
    .where(
      and(
        eq(quotePriceSamples.tokenAddress, tokenAddress.toLowerCase()),
        gte(quotePriceSamples.observedAt, new Date(windowStart.getTime() - maxSampleAgeMs)),
        lte(quotePriceSamples.observedAt, new Date(windowEnd.getTime() + maxSampleAgeMs)),
      ),
    )
    .orderBy(asc(quotePriceSamples.observedAt));

  return rows.map((row) => ({
    observedAt: row.observedAt,
    priceUsd: parseScaled(row.priceUsd),
  }));
}

/** §27: an unmeasurable outcome is recorded with its reason, never as a zero. */
function unmeasurable(reason: string, tradeCount: number): OutcomeMetrics {
  return {
    priceUsd: null,
    returnPct: null,
    maxRunupPct: null,
    maxDrawdownPct: null,
    tradeCount,
    failureReason: reason,
  };
}
