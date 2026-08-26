import { ONE, div, fromRaw, formatScaled } from '@sdb/shared';
import { amountsFor } from '@sdb/market-data';

/**
 * Reconstruct a signal's price path from indexed swaps and measure §21.
 *
 * Everything here is pure. The price series comes from `trades`, which the
 * global tail (ADR 0008) already persists, so no horizon job makes an RPC call
 * — which is what makes the 24h horizon affordable at all. ADR 0004's original
 * plan to `eth_getLogs` the window at horizon time predates the tail and the
 * measured 10-block range cap; backfilling 24h for one pool is ~4,300 requests.
 */

/**
 * One indexed swap.
 *
 * `amount0Raw`/`amount1Raw` are the signed pool amounts exactly as the tail
 * stored them. The column names in `trades` say base/quote, but the tail writes
 * amount0/amount1 unoriented and defers orientation to the reader — see the
 * comment at `swap-tail.ts`. Naming them honestly here stops that trap being
 * inherited.
 */
export type IndexedSwap = {
  amount0Raw: string;
  amount1Raw: string;
  occurredAt: Date;
};

export type QuoteSample = {
  observedAt: Date;
  priceUsd: bigint;
};

/**
 * The quote token's USD price nearest in time to `at`, within tolerance.
 *
 * Nearest rather than last-before: a sample 5 seconds after a trade describes
 * that trade's moment far better than one 4 minutes before it, and the series
 * exists precisely so a 24h path is not priced at one spot rate.
 *
 * Returns null past the tolerance rather than reaching for a distant sample —
 * a stale ETH price silently rescales every metric derived from it.
 */
export function nearestSample(
  samples: readonly QuoteSample[],
  at: Date,
  maxAgeMs: number,
): bigint | null {
  let best: QuoteSample | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const sample of samples) {
    const distance = Math.abs(sample.observedAt.getTime() - at.getTime());
    if (distance < bestDistance) {
      best = sample;
      bestDistance = distance;
    }
  }

  if (best === null || bestDistance > maxAgeMs) return null;
  return best.priceUsd;
}

export type PathInput = {
  swaps: readonly IndexedSwap[];
  samples: readonly QuoteSample[];
  /** True when the candidate token is token0 in the pool's ordering. */
  baseIsToken0: boolean;
  baseDecimals: number;
  quoteDecimals: number;
  /** Constant for a stablecoin quote; null means sample the series. */
  fixedQuoteUsd: bigint | null;
  maxSampleAgeMs: number;
};

export type PriceSeries = {
  /** USD prices in chronological order. */
  prices: bigint[];
  /** Swaps considered, priceable or not. */
  tradeCount: number;
  /** Swaps that yielded a USD price. */
  pricedCount: number;
};

/**
 * Price each swap in USD.
 *
 * This is an EXECUTION price — what the trade actually paid, inclusive of fees
 * and slippage — not the pool mid price. For runup and drawdown that is the
 * more honest number: it is a price someone genuinely got, where a mid price is
 * one nobody could have traded at.
 */
export function buildPriceSeries(input: PathInput): PriceSeries {
  const prices: bigint[] = [];
  let tradeCount = 0;
  let pricedCount = 0;

  for (const swap of input.swaps) {
    tradeCount += 1;

    const { baseAmountRaw, quoteAmountRaw } = amountsFor(
      { amount0: BigInt(swap.amount0Raw), amount1: BigInt(swap.amount1Raw) },
      input.baseIsToken0,
    );

    // A swap that moved none of the candidate token prices nothing. Dividing
    // by it would be a zero denominator, not a data point.
    if (baseAmountRaw === 0n) continue;

    const quoteUsd =
      input.fixedQuoteUsd ??
      nearestSample(input.samples, swap.occurredAt, input.maxSampleAgeMs);

    const priceUsd = fusedPriceUsd({
      quoteScaled: fromRaw(quoteAmountRaw, input.quoteDecimals),
      baseScaled: fromRaw(baseAmountRaw, input.baseDecimals),
      quoteUsd,
    });
    if (priceUsd === null) continue;

    prices.push(priceUsd);
    pricedCount += 1;
  }

  return { prices, tradeCount, pricedCount };
}

/**
 * USD price of one candidate token, multiplying before dividing.
 *
 * The obvious route — `toUsd(div(quote, base), quoteUsd)`, as snapshots do —
 * truncates the quote-denominated price to 18 decimals BEFORE applying the USD
 * rate. Measured on a real Base token: a price of 8.5e-15 ETH survives that
 * intermediate as the integer 8527, leaving four significant digits and a
 * 1.0e-4 relative error in the result.
 *
 * Worse, a token below 1e-18 ETH truncates to zero and is discarded as
 * unpriceable even though its USD price is perfectly representable — with ETH
 * near $2,500 that is any token under about $2.5e-15. Meme tokens live exactly
 * in that range, so the two-step form silently drops the population this system
 * exists to measure.
 *
 * Fusing the operations keeps full precision: the only truncation is the final
 * one, at the scale the value is actually stored.
 */
function fusedPriceUsd(input: {
  quoteScaled: bigint;
  baseScaled: bigint;
  quoteUsd: bigint | null;
}): bigint | null {
  if (input.quoteUsd === null || input.baseScaled === 0n) return null;
  const value = (input.quoteScaled * input.quoteUsd) / input.baseScaled;
  // §15 discipline, unchanged: below our resolution is not the same as
  // worthless, so it is null rather than 0.
  return value === 0n ? null : value;
}

export type OutcomeMetrics = {
  /** Price at the horizon: the last observed, or the signal price if none. */
  priceUsd: bigint | null;
  returnPct: string | null;
  maxRunupPct: string | null;
  maxDrawdownPct: string | null;
  tradeCount: number;
  failureReason: string | null;
};

/**
 * `return_pct` is `numeric(20,6)` — 14 integer digits.
 *
 * A meme token can genuinely move from near the 1e-18 pricing floor to
 * something real, which is a percentage large enough to overflow the column and
 * abort the insert. Recording the outcome as out-of-range keeps the row (and
 * the run) alive and is honest about why there is no number.
 */
const MAX_PCT = 10n ** 14n * ONE;

const failed = (reason: string, tradeCount: number): OutcomeMetrics => ({
  priceUsd: null,
  returnPct: null,
  maxRunupPct: null,
  maxDrawdownPct: null,
  tradeCount,
  failureReason: reason,
});

export type MetricsInput = {
  /** Frozen at emission; §21 measures every return against this. */
  signalPriceUsd: bigint | null;
  series: PriceSeries;
  /** Fraction of swaps that must be priceable for the result to mean anything. */
  minCoverage: number;
};

/**
 * §21's three metrics.
 *
 * The signal price is the path's first point, so a token that only ever falls
 * reports `max_runup_pct = 0` rather than a negative "maximum gain" — the
 * standard reading of "maximum observed price relative to signal price", and
 * the one that keeps `runup >= 0 >= drawdown` true for every row.
 */
export function computeMetrics(input: MetricsInput): OutcomeMetrics {
  const { series } = input;
  const signalPrice = input.signalPriceUsd;

  // Nothing to measure against. §27: record why, never substitute a zero.
  if (signalPrice === null || signalPrice <= 0n) {
    return failed('no_signal_price', series.tradeCount);
  }

  // An unpriceable majority means the quote series had a gap over this window
  // — usually the worker was down. A number derived from the surviving minority
  // would look authoritative and be wrong.
  if (series.tradeCount > 0) {
    const coverage = series.pricedCount / series.tradeCount;
    if (coverage < input.minCoverage) {
      return failed('insufficient_quote_coverage', series.tradeCount);
    }
  }

  // No trade means no price discovery: the last known price still stands, so
  // the return is genuinely 0. `trade_count` is what lets §22 tell that apart
  // from a flat result that was actually traded.
  const path = [signalPrice, ...series.prices];
  const last = path[path.length - 1]!;
  const max = path.reduce((a, b) => (b > a ? b : a), path[0]!);
  const min = path.reduce((a, b) => (b < a ? b : a), path[0]!);

  const pct = (value: bigint): bigint | null => {
    const ratio = div(value - signalPrice, signalPrice);
    return ratio === null ? null : ratio * 100n;
  };

  const returnPct = pct(last);
  const runupPct = pct(max);
  const drawdownPct = pct(min);

  if (returnPct === null || runupPct === null || drawdownPct === null) {
    return failed('unmeasurable_return', series.tradeCount);
  }

  for (const value of [returnPct, runupPct, drawdownPct]) {
    if (value > MAX_PCT || value < -MAX_PCT) {
      return failed('return_out_of_range', series.tradeCount);
    }
  }

  return {
    priceUsd: last,
    returnPct: formatScaled(returnPct),
    maxRunupPct: formatScaled(runupPct),
    maxDrawdownPct: formatScaled(drawdownPct),
    tradeCount: series.tradeCount,
    failureReason: null,
  };
}

/**
 * Pool token ordering without an RPC call.
 *
 * Uniswap V2, V3 and Aerodrome all sort `token0 < token1` by address at pool
 * creation, and every address in this system is canonicalised lowercase, so a
 * string compare settles it. An integration test pins this against a real pool
 * via `readPoolState` so the assumption fails loudly rather than silently
 * inverting every price.
 */
export function baseIsToken0(tokenAddress: string, quoteTokenAddress: string): boolean {
  return tokenAddress.toLowerCase() < quoteTokenAddress.toLowerCase();
}
