import { describe, expect, it } from 'vitest';
import { ProviderHistoryUnavailableError, isRetryable } from '@sdb/shared';
import { AdaptiveChunkSize, chunkRange, fetchLogsChunked } from './logs.js';

/**
 * Providers cap the eth_getLogs span — Alchemy's free tier at 10 blocks. A
 * chunker that drops or overlaps blocks would silently lose pool creations.
 */
describe('chunkRange', () => {
  it('covers the range exactly, with no gaps and no overlaps', () => {
    const chunks = chunkRange(100n, 135n, 10);
    expect(chunks[0]).toEqual({ fromBlock: 100n, toBlock: 109n });
    expect(chunks.at(-1)).toEqual({ fromBlock: 130n, toBlock: 135n });
    for (let i = 1; i < chunks.length; i += 1) {
      expect(chunks[i]!.fromBlock).toBe(chunks[i - 1]!.toBlock + 1n);
    }
  });

  it('returns a single chunk when the range fits', () => {
    expect(chunkRange(10n, 12n, 10)).toEqual([{ fromBlock: 10n, toBlock: 12n }]);
  });

  it('handles a single-block range', () => {
    expect(chunkRange(7n, 7n, 10)).toEqual([{ fromBlock: 7n, toBlock: 7n }]);
  });

  it('returns nothing when the range is inverted', () => {
    expect(chunkRange(20n, 10n, 10)).toEqual([]);
  });

  it('never emits a zero-width chunk even with a nonsense size', () => {
    const chunks = chunkRange(1n, 5n, 0);
    expect(chunks).toHaveLength(5);
    expect(chunks.every((c) => c.toBlock >= c.fromBlock)).toBe(true);
  });
});

describe('AdaptiveChunkSize', () => {
  it('halves on shrink and remembers the learned value', async () => {
    const { AdaptiveChunkSize } = await import('./logs.js');
    const sizer = new AdaptiveChunkSize(500);
    expect(sizer.value).toBe(500);
    sizer.shrink();
    expect(sizer.value).toBe(250);
    // The point of the class: a second drain starts from what we learned,
    // not from the optimistic configured value.
    expect(sizer.value).toBe(250);
  });

  it('stops shrinking at the floor', async () => {
    const { AdaptiveChunkSize } = await import('./logs.js');
    const sizer = new AdaptiveChunkSize(4, 1);
    for (let i = 0; i < 10; i += 1) sizer.shrink();
    expect(sizer.value).toBe(1);
    expect(sizer.canShrink()).toBe(false);
  });

  it('never starts below the floor', async () => {
    const { AdaptiveChunkSize } = await import('./logs.js');
    expect(new AdaptiveChunkSize(0, 1).value).toBe(1);
  });
});

/**
 * A provider that has pruned a block will never serve it, no matter how small
 * the chunk or how long the backoff. Misclassifying that as transient is what
 * turned a 4.3-minute outage into a permanent, silent stall (ADR 0023) — so
 * these cases pin the classifier against the exact wording each provider uses.
 */
describe('classifying a range the provider cannot serve', () => {
  const client = (fail: string, onCall?: () => void) =>
    ({
      getLogs: async () => {
        onCall?.();
        throw new Error(fail);
      },
    }) as never;

  const params = {
    address: '0x0000000000000000000000000000000000000001' as const,
    topics: [],
    fromBlock: 100n,
    toBlock: 109n,
  };
  const noop = async () => undefined;

  it('raises a non-retryable error on Chainstack’s archive message', async () => {
    // The exact string measured from the endpoint.
    const message =
      'Archive, Debug and Trace requests are not available on your current plan.';
    await expect(
      fetchLogsChunked(client(message), params, { maxChunk: 10 }, noop),
    ).rejects.toBeInstanceOf(ProviderHistoryUnavailableError);
  });

  it.each([
    'missing trie node 0xabc',
    'state is not available for block 123',
    'requested block is older than the node history',
    'header not found',
  ])('recognises %s as the same condition', async (message) => {
    await expect(
      fetchLogsChunked(client(message), params, { maxChunk: 10 }, noop),
    ).rejects.toBeInstanceOf(ProviderHistoryUnavailableError);
  });

  it('does not retry it — a pruned block never comes back', async () => {
    let calls = 0;
    await fetchLogsChunked(
      client('missing trie node', () => {
        calls += 1;
      }),
      params,
      { maxChunk: 10, maxAttempts: 4 },
      noop,
    ).catch(() => undefined);
    expect(calls).toBe(1);
    expect(isRetryable(new ProviderHistoryUnavailableError('x'))).toBe(false);
  });

  it('still treats a width complaint as a range error and shrinks', async () => {
    // Chainstack's other message. Halving must keep working, or the wide-chunk
    // setting could never self-correct.
    let calls = 0;
    await fetchLogsChunked(
      client('Block range limit exceeded', () => {
        calls += 1;
      }),
      params,
      { maxChunk: 10 },
      noop,
    ).catch(() => undefined);
    // 10 -> 5 -> 2 -> 1, then it gives up shrinking and throws: four attempts.
    expect(calls).toBe(4);
  });

  it('shrinks even when nobody is listening for the shrink', async () => {
    // Regression: `onChunkShrink?.(before, sizing.shrink())` short-circuits its
    // own arguments, so with no callback the window never narrowed and this
    // retried the same range forever. Every production caller passes a logger,
    // which is the only reason it was never hit.
    const sizer = new AdaptiveChunkSize(10);
    await fetchLogsChunked(
      client('Block range limit exceeded'),
      params,
      { maxChunk: 10, chunkSize: sizer },
      noop,
    ).catch(() => undefined);
    expect(sizer.value).toBe(1);
  });

  it('still backs off on a rate limit rather than skipping', async () => {
    let calls = 0;
    await fetchLogsChunked(
      client('429 Too Many Requests', () => {
        calls += 1;
      }),
      params,
      { maxChunk: 10, maxAttempts: 2 },
      noop,
    ).catch(() => undefined);
    expect(calls).toBe(3); // initial + 2 retries
  });
});
