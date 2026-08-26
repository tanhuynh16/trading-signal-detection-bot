import { describe, expect, it } from 'vitest';
import { parseScaled } from '@sdb/shared';
import {
  baseIsToken0,
  buildPriceSeries,
  computeMetrics,
  nearestSample,
  type IndexedSwap,
  type PriceSeries,
} from './price-path.js';

const usd = (value: string) => parseScaled(value);
const at = (min: number) => new Date(Date.UTC(2026, 7, 26, 12, min, 0));

const series = (prices: string[], over: Partial<PriceSeries> = {}): PriceSeries => ({
  prices: prices.map(usd),
  tradeCount: prices.length,
  pricedCount: prices.length,
  ...over,
});

const metrics = (prices: string[], signal = '1', over: Partial<PriceSeries> = {}) =>
  computeMetrics({
    signalPriceUsd: usd(signal),
    series: series(prices, over),
    minCoverage: 0.8,
  });

describe('computeMetrics — §21 formulas', () => {
  it('measures return against the frozen signal price, not the first trade', () => {
    // §21 is explicit: every return is relative to the price at signal time.
    const result = metrics(['1.5', '2'], '1');
    expect(result.returnPct).toBe('100');
  });

  it('reports true extrema, not the endpoints', () => {
    // A path that spikes and retraces: the peak is the runup even though the
    // token ended lower. Sampling at horizons alone would miss this entirely,
    // which is the whole reason the path is reconstructed from every swap.
    const result = metrics(['3', '0.5', '1.2'], '1');
    expect(result.maxRunupPct).toBe('200');
    expect(result.maxDrawdownPct).toBe('-50');
    expect(result.returnPct).toBe('20');
  });

  it('never reports a negative runup on a token that only falls', () => {
    // The signal price is the path's first point, so "maximum observed price"
    // is at worst the entry itself. A negative maximum gain would be nonsense.
    const result = metrics(['0.9', '0.5', '0.4'], '1');
    expect(result.maxRunupPct).toBe('0');
    expect(result.maxDrawdownPct).toBe('-60');
  });

  it('never reports a positive drawdown on a token that only rises', () => {
    const result = metrics(['1.5', '3'], '1');
    expect(result.maxDrawdownPct).toBe('0');
  });

  it('keeps runup >= 0 >= drawdown for every path', () => {
    for (const path of [['2'], ['0.3'], ['1'], ['5', '0.1', '2']]) {
      const result = metrics(path, '1');
      expect(Number(result.maxRunupPct)).toBeGreaterThanOrEqual(0);
      expect(Number(result.maxDrawdownPct)).toBeLessThanOrEqual(0);
    }
  });

  it('treats an empty window as a flat return, not a failure', () => {
    // No trade means no price discovery — the last known price still stands.
    const result = metrics([], '1');
    expect(result.returnPct).toBe('0');
    expect(result.maxRunupPct).toBe('0');
    expect(result.maxDrawdownPct).toBe('0');
    expect(result.tradeCount).toBe(0);
    expect(result.failureReason).toBeNull();
  });

  it('records a reason rather than a number when there is no signal price', () => {
    const result = computeMetrics({
      signalPriceUsd: null,
      series: series(['2']),
      minCoverage: 0.8,
    });
    expect(result.returnPct).toBeNull();
    expect(result.maxRunupPct).toBeNull();
    expect(result.failureReason).toBe('no_signal_price');
  });

  it('refuses to measure against a zero signal price', () => {
    const result = computeMetrics({
      signalPriceUsd: 0n,
      series: series(['2']),
      minCoverage: 0.8,
    });
    expect(result.failureReason).toBe('no_signal_price');
  });

  it('fails when too few swaps could be priced', () => {
    // A gap in the quote series — usually the worker was down. A number from
    // the surviving minority would look authoritative and be wrong.
    const result = computeMetrics({
      signalPriceUsd: usd('1'),
      series: { prices: [usd('2')], tradeCount: 10, pricedCount: 1 },
      minCoverage: 0.8,
    });
    expect(result.failureReason).toBe('insufficient_quote_coverage');
    expect(result.tradeCount).toBe(10);
  });

  it('reports a partially covered path once coverage clears the bar', () => {
    const result = computeMetrics({
      signalPriceUsd: usd('1'),
      series: { prices: [usd('2'), usd('2')], tradeCount: 2, pricedCount: 2 },
      minCoverage: 0.8,
    });
    expect(result.failureReason).toBeNull();
    expect(result.returnPct).toBe('100');
  });

  it('records out-of-range rather than overflowing numeric(20,6)', () => {
    // Real risk: a token priced near the 1e-18 floor moving to something normal
    // produces a percentage too large for the column, aborting the insert.
    const result = computeMetrics({
      signalPriceUsd: 1n,
      series: series(['1000000']),
      minCoverage: 0.8,
    });
    expect(result.failureReason).toBe('return_out_of_range');
    expect(result.returnPct).toBeNull();
  });
});

describe('buildPriceSeries — pricing swaps', () => {
  const swap = (amount0: string, amount1: string, min = 0): IndexedSwap => ({
    amount0Raw: amount0,
    amount1Raw: amount1,
    occurredAt: at(min),
  });

  const base = {
    samples: [],
    baseDecimals: 18,
    quoteDecimals: 18,
    fixedQuoteUsd: parseScaled('2000'),
    maxSampleAgeMs: 300_000,
  };

  it('prices a swap from the ratio of the two amounts', () => {
    // 1 token out for 0.5 WETH in, at $2000/ETH -> $1000 per token.
    const result = buildPriceSeries({
      ...base,
      baseIsToken0: true,
      swaps: [swap('-1000000000000000000', '500000000000000000')],
    });
    expect(result.prices).toHaveLength(1);
    expect(result.prices[0]).toBe(parseScaled('1000'));
  });

  it('gives the same price whichever side the candidate token is on', () => {
    // Orientation is derived, not stored. Getting it backwards inverts every
    // price in the path while still producing plausible-looking numbers.
    const asToken0 = buildPriceSeries({
      ...base,
      baseIsToken0: true,
      swaps: [swap('-1000000000000000000', '500000000000000000')],
    });
    const asToken1 = buildPriceSeries({
      ...base,
      baseIsToken0: false,
      swaps: [swap('500000000000000000', '-1000000000000000000')],
    });
    expect(asToken1.prices).toEqual(asToken0.prices);
  });

  it('skips a swap that moved none of the candidate token', () => {
    // Not a data point — it is a zero denominator.
    const result = buildPriceSeries({
      ...base,
      baseIsToken0: true,
      swaps: [swap('0', '500000000000000000')],
    });
    expect(result.prices).toHaveLength(0);
    expect(result.tradeCount).toBe(1);
    expect(result.pricedCount).toBe(0);
  });

  it('handles a 6-decimal quote token without shifting the price by 10^12', () => {
    // USDC has 6 decimals on Base. Assuming 18 moves every USD figure by a
    // trillion — the exact trap the resolver's decimals config exists for.
    const result = buildPriceSeries({
      ...base,
      quoteDecimals: 6,
      fixedQuoteUsd: parseScaled('1'),
      baseIsToken0: true,
      swaps: [swap('-1000000000000000000', '2000000')],
    });
    expect(result.prices[0]).toBe(parseScaled('2'));
  });

  it('drops a swap whose price underflows rather than calling it $0', () => {
    // §15: below our resolution is not the same as worthless.
    const result = buildPriceSeries({
      ...base,
      baseIsToken0: true,
      fixedQuoteUsd: 1n,
      swaps: [swap('-1000000000000000000000000000', '1')],
    });
    expect(result.prices).toHaveLength(0);
    expect(result.pricedCount).toBe(0);
  });

  it('leaves a swap unpriced when no quote sample is near it', () => {
    const result = buildPriceSeries({
      ...base,
      fixedQuoteUsd: null,
      samples: [{ observedAt: at(60), priceUsd: parseScaled('2000') }],
      baseIsToken0: true,
      swaps: [swap('-1000000000000000000', '500000000000000000', 0)],
    });
    expect(result.tradeCount).toBe(1);
    expect(result.pricedCount).toBe(0);
  });
});

describe('nearestSample', () => {
  const samples = [
    { observedAt: at(0), priceUsd: parseScaled('2000') },
    { observedAt: at(10), priceUsd: parseScaled('2100') },
  ];

  it('picks the closest sample in either direction', () => {
    // A sample just after a trade describes it better than one long before.
    expect(nearestSample(samples, at(9), 300_000)).toBe(parseScaled('2100'));
    expect(nearestSample(samples, at(2), 300_000)).toBe(parseScaled('2000'));
  });

  it('returns null past the tolerance rather than reaching for a stale price', () => {
    // A stale ETH price silently rescales every metric derived from it.
    expect(nearestSample(samples, at(60), 300_000)).toBeNull();
  });

  it('returns null with no samples at all', () => {
    expect(nearestSample([], at(0), 300_000)).toBeNull();
  });
});

describe('baseIsToken0', () => {
  it('follows the address ordering every supported DEX sorts by', () => {
    expect(baseIsToken0('0xaaa', '0xbbb')).toBe(true);
    expect(baseIsToken0('0xccc', '0xbbb')).toBe(false);
  });

  it('is case-insensitive, since addresses arrive canonicalised', () => {
    expect(baseIsToken0('0xAAA', '0xbbb')).toBe(true);
  });
});

describe('price precision (regression, found in the Phase 7 live run)', () => {
  const swap = (amount0: string, amount1: string) => ({
    amount0Raw: amount0,
    amount1Raw: amount1,
    occurredAt: at(0),
  });

  const base = {
    samples: [],
    baseDecimals: 18,
    quoteDecimals: 18,
    maxSampleAgeMs: 300_000,
    baseIsToken0: true,
  };

  it('keeps full precision on a token priced far below 1 quote unit', () => {
    // Real trade from the live run. Computing the quote-denominated price first
    // truncates it to the integer 8527 — four significant digits — and yields
    // 20996112 instead of 20998305, a 1.0e-4 relative error.
    const result = buildPriceSeries({
      ...base,
      fixedQuoteUsd: parseScaled('2462.309482'),
      swaps: [swap('-1838405276892001700105232', '15677718585')],
    });
    expect(result.prices[0]).toBe(20998305n);
  });

  it('prices a token whose quote-denominated price underflows 1e-18', () => {
    // Below 1e-18 ETH the intermediate truncates to zero and the trade was
    // discarded as unpriceable — but at $2,462/ETH this token is worth
    // ~2.4e-16 USD, which stores exactly. Meme tokens live in this range, so
    // the old form silently dropped the population being measured.
    const result = buildPriceSeries({
      ...base,
      fixedQuoteUsd: parseScaled('2462.309482'),
      swaps: [swap('-10000000000000000000000000000', '1000000000')],
    });
    expect(result.pricedCount).toBe(1);
    expect(result.prices[0]).toBeGreaterThan(0n);
  });

  it('still reports null when even the USD price is below resolution', () => {
    // §15 holds: this is genuinely below our resolution, not worth zero.
    const result = buildPriceSeries({
      ...base,
      fixedQuoteUsd: 1n,
      swaps: [swap('-1000000000000000000000000000000000000000', '1')],
    });
    expect(result.pricedCount).toBe(0);
  });
});
