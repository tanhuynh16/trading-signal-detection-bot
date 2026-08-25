import { describe, expect, it } from 'vitest';
import type { PublicClient } from 'viem';
import { InvalidDataError, TransientProviderError } from '@sdb/shared';
import { readTokenMetadata, sanitizeText } from './pool-reader.js';

/**
 * Regression tests for the review-gate finding.
 *
 * `readTokenMetadata` used to throw `InvalidDataError` — permanent, routed
 * straight to jobs_audit and never retried — for ANY multicall failure on
 * `decimals()`. Both tokens dropped that way in a Phase 4 run were probed
 * afterwards and are ordinary ERC-20s (decimals 18, supply 1e27). They were
 * lost to rate limiting, roughly a quarter of that run's discoveries.
 */

const ADDRESS = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1' as const;

const ok = <T>(result: T) => ({ status: 'success' as const, result });
const fail = (message: string) => ({ status: 'failure' as const, error: new Error(message) });

/** Minimal client stub; only the three methods this path touches. */
function client(over: {
  multicall?: unknown[];
  readContract?: () => Promise<unknown>;
  getCode?: () => Promise<string>;
}): PublicClient {
  return {
    multicall: async () =>
      over.multicall ?? [ok('TKN'), ok('Token'), ok(18), ok(1000n)],
    readContract:
      over.readContract ?? (async () => { throw new Error('no readContract stub'); }),
    getCode: over.getCode ?? (async () => '0x'),
  } as unknown as PublicClient;
}

describe('readTokenMetadata — happy path', () => {
  it('returns metadata when the multicall succeeds', async () => {
    const meta = await readTokenMetadata(client({}), ADDRESS);
    expect(meta).toMatchObject({ symbol: 'TKN', name: 'Token', decimals: 18 });
    expect(meta.totalSupplyRaw).toBe(1000n);
  });

  it('degrades symbol and name to null without failing', async () => {
    // Cosmetic fields may legitimately be absent or non-standard.
    const meta = await readTokenMetadata(
      client({ multicall: [fail('no symbol'), fail('no name'), ok(6), ok(1n)] }),
      ADDRESS,
    );
    expect(meta.symbol).toBeNull();
    expect(meta.name).toBeNull();
    expect(meta.decimals).toBe(6);
  });
});

describe('readTokenMetadata — decimals failure classification', () => {
  it('recovers via a direct read when the multicall entry was collateral damage', async () => {
    const meta = await readTokenMetadata(
      client({
        multicall: [ok('TKN'), ok('Token'), fail('execution reverted'), ok(1n)],
        readContract: async () => 18,
      }),
      ADDRESS,
    );
    // The token was never actually broken — no error, correct decimals.
    expect(meta.decimals).toBe(18);
  });

  it('is TRANSIENT when the direct read also fails but the contract has code', async () => {
    // This is the exact scenario that dropped valid tokens: a throttled
    // provider, not a malformed token. Must be retryable.
    const error = await readTokenMetadata(
      client({
        multicall: [ok('TKN'), ok('Token'), fail('429 Too Many Requests'), ok(1n)],
        readContract: async () => { throw new Error('HTTP 429'); },
        getCode: async () => '0x60806040',
      }),
      ADDRESS,
    ).catch((e) => e);

    expect(error).toBeInstanceOf(TransientProviderError);
    expect(error.retryable).toBe(true);
  });

  it('is PERMANENT only when the address has no contract code', async () => {
    const error = await readTokenMetadata(
      client({
        multicall: [ok('TKN'), ok('Token'), fail('reverted'), ok(1n)],
        readContract: async () => { throw new Error('reverted'); },
        getCode: async () => '0x',
      }),
      ADDRESS,
    ).catch((e) => e);

    expect(error).toBeInstanceOf(InvalidDataError);
    expect(error.retryable).toBe(false);
  });

  it('treats a failing code check as transient, not as a guilty verdict', async () => {
    // If we cannot even read the code, the provider is the problem. Condemning
    // the token on that basis is what caused the original data loss.
    const error = await readTokenMetadata(
      client({
        multicall: [ok('TKN'), ok('Token'), fail('timeout'), ok(1n)],
        readContract: async () => { throw new Error('timeout'); },
        getCode: async () => { throw new Error('timeout'); },
      }),
      ADDRESS,
    ).catch((e) => e);

    expect(error).toBeInstanceOf(TransientProviderError);
  });

  it('never assumes 18 decimals as a fallback', async () => {
    // Guessing decimals shifts every downstream amount by orders of magnitude.
    const error = await readTokenMetadata(
      client({
        multicall: [ok('TKN'), ok('Token'), fail('reverted'), ok(1n)],
        readContract: async () => { throw new Error('reverted'); },
        getCode: async () => '0x',
      }),
      ADDRESS,
    ).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
  });
});

describe('sanitizeText', () => {
  it('strips control characters from attacker-controlled names', () => {
    expect(sanitizeText('A\u0000B\u001fC')).toBe('ABC');
  });

  it('caps length', () => {
    expect(sanitizeText('x'.repeat(500))!.length).toBe(128);
  });

  it('returns null for a non-string or empty result', () => {
    expect(sanitizeText(123)).toBeNull();
    expect(sanitizeText('   ')).toBeNull();
  });
});
