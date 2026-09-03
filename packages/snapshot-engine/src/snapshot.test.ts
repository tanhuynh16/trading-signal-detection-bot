import { describe, expect, it } from 'vitest';
import { computePriceInQuote } from './snapshot.js';

describe('computePriceInQuote refuses a price the pool cannot honour', () => {
  const base = { baseIsToken0: true, baseDecimals: 18, quoteDecimals: 18 };

  it('returns null for a V3 tick when the pool holds no quote reserve', () => {
    // A sqrtPriceX96 exists whether or not the pool holds anything — it is the
    // price the pool WOULD trade at. Measured: 214 of 348 snapshots with a zero
    // quote reserve still produced a USD price this way, while V2 (which prices
    // from reserves) produced 0 of 1,129. §21 then freezes one of those fictions
    // as the immutable denominator of a return.
    expect(
      computePriceInQuote({
        ...base,
        state: { sqrtPriceX96: 79228162514264337593543950336n, reserve0: 1_000n, reserve1: 0n },
      }),
    ).toBeNull();
  });

  it('returns null when the base side is empty', () => {
    expect(
      computePriceInQuote({
        ...base,
        state: { sqrtPriceX96: 79228162514264337593543950336n, reserve0: 0n, reserve1: 1_000n },
      }),
    ).toBeNull();
  });

  it('still prices a V3 pool that holds both sides', () => {
    expect(
      computePriceInQuote({
        ...base,
        state: {
          sqrtPriceX96: 79228162514264337593543950336n,
          reserve0: 10n ** 18n,
          reserve1: 10n ** 18n,
        },
      }),
    ).not.toBeNull();
  });

  it('still prices a V2 pool from reserves', () => {
    expect(
      computePriceInQuote({
        ...base,
        state: { sqrtPriceX96: null, reserve0: 10n ** 18n, reserve1: 2n * 10n ** 18n },
      }),
    ).not.toBeNull();
  });
});
