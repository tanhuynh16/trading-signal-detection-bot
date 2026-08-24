import { describe, expect, it } from 'vitest';
import { formatScaled, parseScaled, toNumber } from '@sdb/shared';
import {
  invertPrice,
  liquidityUsd,
  marketCapUsd,
  priceFromReserves,
  priceFromSqrtPriceX96,
  toUsd,
} from './price.js';

describe('priceFromSqrtPriceX96', () => {
  /**
   * Captured from the Base WETH/USDC v3 fee-3000 pool
   * (0x6c561b446416e1a00e8e93e221854d6ea4171372) where token0=WETH(18) and
   * token1=USDC(6). An anchored value is the point: with the decimal exponent
   * inverted this still returns a number, just one ~10^20 too large.
   */
  const SQRT_PRICE_X96 = 3908589177080886977778552n;

  it('prices ETH in the low thousands of USD, matching the live pool', () => {
    const price = priceFromSqrtPriceX96({
      sqrtPriceX96: SQRT_PRICE_X96,
      decimals0: 18,
      decimals1: 6,
    })!;
    const usd = toNumber(price);
    expect(usd).toBeGreaterThan(2_400);
    expect(usd).toBeLessThan(2_470);
    expect(usd).toBeCloseTo(2433.78, 1);
  });

  it('does not silently return a plausible number if the exponent is inverted', () => {
    // Swapping d0/d1 is what a careless reading of the formula produces. Here
    // it underflows to zero and is reported as null — the correct outcome under
    // §15 (no measurable value) rather than a wrong price presented as fact.
    const wrong = priceFromSqrtPriceX96({
      sqrtPriceX96: SQRT_PRICE_X96,
      decimals0: 6,
      decimals1: 18,
    });
    expect(wrong).toBeNull();
  });

  it('handles a token cheaper than the quote asset without underflowing', () => {
    // A meme token worth ~1e-7 WETH: both 18 decimals, tiny sqrt price.
    const price = priceFromSqrtPriceX96({
      sqrtPriceX96: 2n ** 96n / 3163n, // (1/3163)^2 ~= 1e-7
      decimals0: 18,
      decimals1: 18,
    })!;
    expect(toNumber(price)).toBeGreaterThan(0);
    expect(toNumber(price)).toBeLessThan(0.000001);
  });

  it('is symmetric for equal decimals', () => {
    // sqrtPriceX96 = 2^96 means a raw ratio of exactly 1.
    const price = priceFromSqrtPriceX96({
      sqrtPriceX96: 2n ** 96n,
      decimals0: 18,
      decimals1: 18,
    })!;
    expect(formatScaled(price)).toBe('1');
  });

  it('returns null for an uninitialized pool rather than zero', () => {
    expect(priceFromSqrtPriceX96({ sqrtPriceX96: 0n, decimals0: 18, decimals1: 18 })).toBeNull();
  });
});

describe('priceFromReserves', () => {
  it('prices an 18/6 decimal pair correctly', () => {
    // 10 WETH against 24,337 USDC -> ~2433.7 USDC per WETH
    const price = priceFromReserves({
      reserve0: 10n * 10n ** 18n,
      reserve1: 24_337n * 10n ** 6n,
      decimals0: 18,
      decimals1: 6,
    })!;
    expect(toNumber(price)).toBeCloseTo(2433.7, 1);
  });

  it('handles an 18/18 pair', () => {
    const price = priceFromReserves({
      reserve0: 2n * 10n ** 18n,
      reserve1: 6n * 10n ** 18n,
      decimals0: 18,
      decimals1: 18,
    })!;
    expect(formatScaled(price)).toBe('3');
  });

  it('returns null on an empty side instead of dividing by zero', () => {
    expect(
      priceFromReserves({ reserve0: 0n, reserve1: 10n ** 18n, decimals0: 18, decimals1: 18 }),
    ).toBeNull();
    expect(
      priceFromReserves({ reserve0: 10n ** 18n, reserve1: 0n, decimals0: 18, decimals1: 18 }),
    ).toBeNull();
  });

  it('survives the extreme ratios a fresh meme pool actually has', () => {
    // 1e15 tokens against 0.1 WETH — the shape of a launch pool.
    const price = priceFromReserves({
      reserve0: 10n ** 15n * 10n ** 18n,
      reserve1: 10n ** 17n,
      decimals0: 18,
      decimals1: 18,
    });
    expect(price).not.toBeNull();
    expect(price!).toBeGreaterThan(0n);
  });
});

describe('derived values', () => {
  it('converts a quote-denominated price to USD', () => {
    const priceInEth = parseScaled('0.0001');
    const ethUsd = parseScaled('2433.78');
    expect(toNumber(toUsd(priceInEth, ethUsd)!)).toBeCloseTo(0.243378, 6);
  });

  it('propagates null rather than inventing a USD price', () => {
    expect(toUsd(null, parseScaled('2433'))).toBeNull();
    expect(toUsd(parseScaled('1'), null)).toBeNull();
  });

  it('computes market cap from supply and price', () => {
    const mc = marketCapUsd({
      totalSupplyRaw: 1_000_000n * 10n ** 18n,
      decimals: 18,
      priceUsd: parseScaled('0.42'),
    })!;
    expect(toNumber(mc)).toBeCloseTo(420_000, 0);
  });

  it('returns null market cap when price is unknown', () => {
    expect(
      marketCapUsd({ totalSupplyRaw: 10n ** 18n, decimals: 18, priceUsd: null }),
    ).toBeNull();
  });

  it('sums both sides of the pool for liquidity', () => {
    const liq = liquidityUsd({
      baseBalanceRaw: 1_000_000n * 10n ** 18n,
      quoteBalanceRaw: 20n * 10n ** 18n,
      baseDecimals: 18,
      quoteDecimals: 18,
      basePriceUsd: parseScaled('0.048'),
      quotePriceUsd: parseScaled('2433.78'),
    })!;
    // 48,000 of token + 48,675 of WETH
    expect(toNumber(liq)).toBeCloseTo(96_675.6, 0);
  });

  it('inverts a price', () => {
    expect(toNumber(invertPrice(parseScaled('4'))!)).toBeCloseTo(0.25, 9);
  });
});

describe('underflow is unknown, not zero (spec §15)', () => {
  it('reports a price below 1e-18 of the quote as null, not $0', () => {
    // A real shape on Base: 1e15 tokens against a fraction of an ETH. The
    // quotient truncates to zero in 18-decimal fixed point, and storing $0
    // would assert the token is worthless rather than unpriceable at our
    // resolution.
    const price = priceFromReserves({
      reserve0: 10n ** 33n, // 1e15 tokens, 18 decimals
      reserve1: 1n, // 1 wei
      decimals0: 18,
      decimals1: 18,
    });
    expect(price).toBeNull();
  });

  it('does not turn a tiny but representable price into null', () => {
    const price = priceFromReserves({
      reserve0: 10n ** 18n,
      reserve1: 10n,
      decimals0: 18,
      decimals1: 18,
    });
    expect(price).not.toBeNull();
  });

  it('collapses a USD conversion that underflows', () => {
    expect(toUsd(1n, 1n)).toBeNull(); // 1e-18 * 1e-18 -> 0
  });

  it('collapses a market cap that underflows', () => {
    expect(
      marketCapUsd({ totalSupplyRaw: 1n, decimals: 18, priceUsd: 1n }),
    ).toBeNull();
  });
});
