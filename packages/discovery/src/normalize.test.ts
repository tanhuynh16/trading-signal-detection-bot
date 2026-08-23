import { describe, expect, it } from 'vitest';
import type { DecodedPoolCreation } from './adapters.js';
import { normalizePoolCreation, shouldAcceptPool } from './normalize.js';

const WETH = '0x4200000000000000000000000000000000000006';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const MEME = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const base = {
  dex: 'uniswap-v2' as const,
  poolAddress: '0xcccccccccccccccccccccccccccccccccccccccc',
  blockNumber: 1n,
  transactionHash: `0x${'1'.repeat(64)}`,
  logIndex: 0,
} as unknown as DecodedPoolCreation;

const options = { quoteTokens: [WETH, USDC], discoveredAt: new Date('2026-01-01T00:00:00Z') };

function normalize(token0: string, token1: string) {
  return normalizePoolCreation({ ...base, token0, token1 } as DecodedPoolCreation, options);
}

describe('token normalization (spec §11)', () => {
  it('picks token0 as the candidate when token1 is the quote asset', () => {
    const { candidate, hasKnownQuoteToken } = normalize(MEME, WETH);
    expect(candidate.tokenAddress).toBe(MEME);
    expect(candidate.quoteTokenAddress).toBe(WETH);
    expect(hasKnownQuoteToken).toBe(true);
  });

  it('picks token1 as the candidate when token0 is the quote asset', () => {
    const { candidate, hasKnownQuoteToken } = normalize(USDC, MEME);
    expect(candidate.tokenAddress).toBe(MEME);
    expect(candidate.quoteTokenAddress).toBe(USDC);
    expect(hasKnownQuoteToken).toBe(true);
  });

  it('stores rather than drops a pool with no allowlisted quote token', () => {
    // §11 is explicit: lower the priority, never silently delete.
    const { candidate, hasKnownQuoteToken } = normalize(MEME, OTHER);
    expect(hasKnownQuoteToken).toBe(false);
    expect(candidate.tokenAddress).toBe(MEME);
    expect(candidate.poolAddress).toBe(base.poolAddress);
  });

  it('deprioritizes a quote/quote pair, which is not a meme candidate', () => {
    const { hasKnownQuoteToken } = normalize(WETH, USDC);
    expect(hasKnownQuoteToken).toBe(false);
  });

  it('is deterministic: the same log always yields the same assignment', () => {
    const a = normalize(MEME, OTHER);
    const b = normalize(MEME, OTHER);
    expect(a.candidate).toEqual(b.candidate);
  });

  it('matches the allowlist case-insensitively', () => {
    const upper = { quoteTokens: [WETH.toUpperCase()], discoveredAt: options.discoveredAt };
    const result = normalizePoolCreation({ ...base, token0: MEME, token1: WETH } as DecodedPoolCreation, upper);
    expect(result.hasKnownQuoteToken).toBe(true);
  });
});

describe('pool acceptance', () => {
  const aerodrome = (stable: boolean) =>
    ({ ...base, dex: 'aerodrome', token0: MEME, token1: WETH, stable }) as DecodedPoolCreation;

  it('filters Aerodrome stable pools by default', () => {
    expect(shouldAcceptPool(aerodrome(true), { includeAerodromeStable: false })).toBe(false);
  });

  it('keeps Aerodrome volatile pools, where meme tokens launch', () => {
    expect(shouldAcceptPool(aerodrome(false), { includeAerodromeStable: false })).toBe(true);
  });

  it('admits stable pools when configured to', () => {
    expect(shouldAcceptPool(aerodrome(true), { includeAerodromeStable: true })).toBe(true);
  });

  it('never filters Uniswap pools, which carry no stable flag', () => {
    const uni = { ...base, token0: MEME, token1: WETH } as DecodedPoolCreation;
    expect(shouldAcceptPool(uni, { includeAerodromeStable: false })).toBe(true);
  });
});
