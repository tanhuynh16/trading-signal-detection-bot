import { div, formatScaled, fromRaw, mul, ONE, parseScaled } from '@sdb/shared';

/**
 * Pool price math. Every function here is pure and fixed-point — plan G4
 * forbids IEEE floats on money, and these values feed market cap and liquidity
 * straight into numeric(38,18) columns.
 *
 * Convention throughout: "price of X in Y" means how many whole Y one whole X
 * buys, returned as a scaled bigint (18 places).
 */

/** 2^96, the Uniswap V3 fixed-point denominator. */
const Q96 = 2n ** 96n;

/**
 * Constant-product price from reserves (Uniswap V2, Aerodrome volatile).
 *
 * price(token0 in token1) = (reserve1 / 10^d1) / (reserve0 / 10^d0)
 *
 * Returns null on an empty side rather than dividing by zero: a pool with no
 * reserves has no price, and §15 forbids substituting a number for missing data.
 */
export function priceFromReserves(input: {
  reserve0: bigint;
  reserve1: bigint;
  decimals0: number;
  decimals1: number;
}): bigint | null {
  if (input.reserve0 <= 0n || input.reserve1 <= 0n) return null;
  const scaled0 = fromRaw(input.reserve0, input.decimals0);
  const scaled1 = fromRaw(input.reserve1, input.decimals1);
  return nonZero(div(scaled1, scaled0));
}

/**
 * Uniswap V3 price from slot0.
 *
 *   price(token0 in token1) = (sqrtPriceX96 / 2^96)^2 * 10^(d0 - d1)
 *
 * The decimal exponent is (d0 - d1), NOT (d1 - d0). Inverting it yields a value
 * off by ~10^20 that still looks like a number — validated against the Base
 * WETH/USDC pool, which must price ETH in the low thousands of USD.
 *
 * Squaring is done before scaling down so precision is not lost to truncation.
 */
export function priceFromSqrtPriceX96(input: {
  sqrtPriceX96: bigint;
  decimals0: number;
  decimals1: number;
}): bigint | null {
  const { sqrtPriceX96, decimals0, decimals1 } = input;
  if (sqrtPriceX96 <= 0n) return null;

  // (sqrt^2 * 10^18) / 2^192, keeping the numerator intact until the last step.
  const numerator = sqrtPriceX96 * sqrtPriceX96 * ONE;
  let price = numerator / (Q96 * Q96);

  const exponent = decimals0 - decimals1;
  if (exponent > 0) price *= 10n ** BigInt(exponent);
  else if (exponent < 0) price /= 10n ** BigInt(-exponent);

  return price > 0n ? price : null;
}

/** Invert a price: price(Y in X) from price(X in Y). */
export function invertPrice(price: bigint): bigint | null {
  return div(ONE, price);
}

/**
 * Convert a token's price denominated in the quote asset into USD.
 * Returns null if either input is missing — never a partial guess.
 */
export function toUsd(priceInQuote: bigint | null, quoteUsd: bigint | null): bigint | null {
  if (priceInQuote === null || quoteUsd === null) return null;
  return nonZero(mul(priceInQuote, quoteUsd));
}

/**
 * Collapse a fixed-point zero to null.
 *
 * A token priced below 1e-18 of the quote asset truncates to zero here. Storing
 * that as $0 asserts the token is worthless, when what we actually know is that
 * its price is below our resolution — §15 requires the difference be explicit.
 * Real Base pools hit this: reserves of 1e15 tokens against a fraction of an
 * ETH underflow easily.
 */
function nonZero(value: bigint | null): bigint | null {
  if (value === null || value === 0n) return null;
  return value;
}

/**
 * Market cap = circulating supply * price.
 *
 * Uses total supply, which overstates for tokens with locked or burned
 * balances. Spec §12 asks for market_cap_usd without defining circulating
 * supply, and any burn-address adjustment needs the holder index (Phase 4b),
 * so this stays total-supply-based and the limitation is recorded here.
 */
export function marketCapUsd(input: {
  totalSupplyRaw: bigint;
  decimals: number;
  priceUsd: bigint | null;
}): bigint | null {
  if (input.priceUsd === null || input.totalSupplyRaw <= 0n) return null;
  return nonZero(mul(fromRaw(input.totalSupplyRaw, input.decimals), input.priceUsd));
}

/**
 * Pool liquidity in USD, measured as the USD value of both sides actually held
 * by the pool contract.
 *
 * For V3 this is deliberately the token balances rather than the `liquidity()`
 * figure: `liquidity()` is an in-range virtual quantity that cannot be compared
 * across pools or converted to dollars, whereas balances are what a seller can
 * actually trade against.
 */
export function liquidityUsd(input: {
  baseBalanceRaw: bigint;
  quoteBalanceRaw: bigint;
  baseDecimals: number;
  quoteDecimals: number;
  basePriceUsd: bigint | null;
  quotePriceUsd: bigint | null;
}): bigint | null {
  if (input.basePriceUsd === null || input.quotePriceUsd === null) return null;
  const baseSide = mul(fromRaw(input.baseBalanceRaw, input.baseDecimals), input.basePriceUsd);
  const quoteSide = mul(fromRaw(input.quoteBalanceRaw, input.quoteDecimals), input.quotePriceUsd);
  return baseSide + quoteSide;
}

/** Render a scaled value for a numeric(38,18) column, or null. */
export function toColumn(value: bigint | null): string | null {
  return value === null ? null : formatScaled(value);
}

/** Stablecoins are pinned to $1; see quote-price.ts for why that is adequate. */
export const ONE_USD = parseScaled('1');
