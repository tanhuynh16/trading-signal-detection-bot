import type { TokenCandidate } from '@sdb/domain';
import type { Address } from '@sdb/shared';
import type { DecodedPoolCreation } from './adapters.js';

/**
 * Spec §11 token normalization: decide which side of the pair is the
 * tradeable candidate and which is the known quote asset.
 */
export type NormalizedCandidate = {
  candidate: TokenCandidate;
  /**
   * False when neither side is on the allowlist. Spec §11 is explicit that such
   * pools are stored at lower priority and never silently deleted, so this is a
   * ranking signal, not a filter.
   */
  hasKnownQuoteToken: boolean;
};

export type NormalizeOptions = {
  /** Lowercase addresses, per `env.QUOTE_TOKEN_ALLOWLIST`. */
  quoteTokens: readonly string[];
  discoveredAt: Date;
};

export function normalizePoolCreation(
  decoded: DecodedPoolCreation,
  options: NormalizeOptions,
): NormalizedCandidate {
  const allowlist = new Set(options.quoteTokens.map((address) => address.toLowerCase()));
  const zeroIsQuote = allowlist.has(decoded.token0);
  const oneIsQuote = allowlist.has(decoded.token1);

  let tokenAddress: Address;
  let quoteTokenAddress: Address;
  let hasKnownQuoteToken = true;

  if (zeroIsQuote && oneIsQuote) {
    // Two quote assets paired together (e.g. WETH/USDC). Not a meme candidate,
    // but §11 says store rather than drop; token0 is treated as the candidate
    // so the row is well-formed and the low priority flag does the filtering.
    tokenAddress = decoded.token0;
    quoteTokenAddress = decoded.token1;
    hasKnownQuoteToken = false;
  } else if (oneIsQuote) {
    tokenAddress = decoded.token0;
    quoteTokenAddress = decoded.token1;
  } else if (zeroIsQuote) {
    tokenAddress = decoded.token1;
    quoteTokenAddress = decoded.token0;
  } else {
    // Neither side recognised. Keep a deterministic assignment so replaying the
    // same log always produces the same row.
    tokenAddress = decoded.token0;
    quoteTokenAddress = decoded.token1;
    hasKnownQuoteToken = false;
  }

  return {
    hasKnownQuoteToken,
    candidate: {
      chain: 'base',
      tokenAddress,
      poolAddress: decoded.poolAddress,
      dex: decoded.dex,
      quoteTokenAddress,
      discoveredAt: options.discoveredAt,
      blockNumber: decoded.blockNumber,
      transactionHash: decoded.transactionHash,
    },
  };
}

/**
 * Spec §4 targets new meme tokens. Aerodrome stable pools pair correlated
 * assets and will effectively never hold one, so admitting them only buys
 * snapshot jobs for pools that cannot signal. Configurable, per §3.
 */
export function shouldAcceptPool(
  decoded: DecodedPoolCreation,
  options: { includeAerodromeStable: boolean },
): boolean {
  if (decoded.dex === 'aerodrome' && decoded.stable === true) {
    return options.includeAerodromeStable;
  }
  return true;
}
