import type { PublicClient } from 'viem';
import { canonicalize, type Address } from '@sdb/shared';
import { readPoolState } from './pool-reader.js';
import { ONE_USD, priceFromSqrtPriceX96, invertPrice } from './price.js';

/**
 * USD pricing for quote assets, read on-chain.
 *
 * ADR 0002 keeps every price on-chain, so WETH/USD comes from a deep reference
 * pool rather than a price API. Stablecoins are pinned to $1 — their peg noise
 * is far smaller than the uncertainty in a minutes-old meme token's own price,
 * and a depeg large enough to matter would invalidate the signal anyway.
 */

export type QuoteTokenConfig = {
  /** Lowercase. Priced at exactly $1. */
  stablecoins: readonly string[];
  /**
   * Decimals per quote token, lowercase-keyed. USDC has 6 and DAI has 18 on
   * Base; assuming 18 for both would shift every USDC-quoted USD figure by
   * 10^12, so these are configured rather than guessed.
   */
  decimals: Readonly<Record<string, number>>;
  /** Lowercase WETH address on Base. */
  weth: string;
  /** Deep WETH/stable pool used as the ETH/USD oracle. */
  referencePool: Address;
  /** Cache lifetime. ETH moves slowly relative to a 30s snapshot cadence. */
  ttlMs: number;
  /**
   * Called on each successful refresh so §21 can persist a historical curve.
   *
   * A callback rather than a database handle: this package resolves prices and
   * knows nothing about storage, and a refresh must never fail because a write
   * did. Errors are swallowed at the call site for that reason.
   */
  onSample?: (sample: { tokenAddress: string; priceUsd: bigint }) => void;
};

export class QuotePriceResolver {
  private cachedWethUsd: bigint | null = null;
  private cachedAt = 0;
  private inFlight: Promise<bigint | null> | null = null;

  constructor(
    private readonly client: PublicClient,
    private readonly config: QuoteTokenConfig,
  ) {}

  /**
   * USD price of a quote asset, or null if we have no way to price it.
   *
   * Null is deliberate: a pool quoted in some unknown token has no USD value we
   * can honestly report, and §15 forbids substituting a number for missing data.
   */
  async getUsdPrice(tokenAddress: string): Promise<bigint | null> {
    const address = tokenAddress.toLowerCase();
    if (this.config.stablecoins.includes(address)) return ONE_USD;
    if (address === this.config.weth.toLowerCase()) return this.getWethUsd();
    return null;
  }

  /**
   * Decimals for a quote token. Falls back to 18 — the ERC-20 default — but
   * that fallback only applies to tokens outside the configured allowlist,
   * which have no USD price anyway, so it cannot corrupt a reported figure.
   */
  decimalsFor(tokenAddress: string): number {
    return this.config.decimals[tokenAddress.toLowerCase()] ?? 18;
  }

  async getWethUsd(): Promise<bigint | null> {
    const fresh = Date.now() - this.cachedAt < this.config.ttlMs;
    if (fresh && this.cachedWethUsd !== null) return this.cachedWethUsd;

    // Collapse concurrent refreshes: eight snapshot jobs firing at once must
    // not each read the reference pool.
    this.inFlight ??= this.refresh().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async refresh(): Promise<bigint | null> {
    try {
      const state = await readPoolState(this.client, {
        poolAddress: this.config.referencePool,
        dex: 'uniswap-v3',
      });

      const wethIsToken0 = state.token0 === canonicalize(this.config.weth);
      const stableAddress = wethIsToken0 ? state.token1 : state.token0;
      if (!this.config.stablecoins.includes(stableAddress)) {
        // Misconfigured reference pool: refuse rather than price ETH off an
        // asset we cannot value.
        return this.cachedWethUsd;
      }

      if (state.sqrtPriceX96 === null) return this.cachedWethUsd;

      // The reference pool is WETH/USDC: 18 and 6 decimals respectively.
      const wethDecimals = 18;
      const stableDecimals = 6;
      const token0Price = priceFromSqrtPriceX96({
        sqrtPriceX96: state.sqrtPriceX96,
        decimals0: wethIsToken0 ? wethDecimals : stableDecimals,
        decimals1: wethIsToken0 ? stableDecimals : wethDecimals,
      });
      if (token0Price === null) return this.cachedWethUsd;

      // priceFromSqrtPriceX96 gives token0 in token1; invert when WETH is
      // token1 so the result is always WETH priced in the stablecoin.
      const wethUsd = wethIsToken0 ? token0Price : invertPrice(token0Price);
      if (wethUsd === null || wethUsd <= 0n) return this.cachedWethUsd;

      this.cachedWethUsd = wethUsd;
      this.cachedAt = Date.now();
      this.emitSample(this.config.weth, wethUsd);
      return wethUsd;
    } catch {
      // A failed refresh serves the last good value rather than nulling every
      // snapshot in flight; staleness is bounded by how often this is called.
      return this.cachedWethUsd;
    }
  }

  /**
   * Is this quote asset pegged, and therefore priceable historically without a
   * sample series? Stablecoins are $1 at every point in the past as well as now.
   */
  fixedUsdFor(tokenAddress: string): bigint | null {
    return this.config.stablecoins.includes(tokenAddress.toLowerCase()) ? ONE_USD : null;
  }

  private emitSample(tokenAddress: string, priceUsd: bigint): void {
    try {
      this.config.onSample?.({ tokenAddress, priceUsd });
    } catch {
      // Recording history must never break the price path that produced it.
    }
  }

  /** Test seam. */
  primeForTest(wethUsd: bigint): void {
    this.cachedWethUsd = wethUsd;
    this.cachedAt = Date.now();
  }
}
