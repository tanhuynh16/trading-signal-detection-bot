import { describe, expect, it } from 'vitest';
import { chunkRange } from './logs.js';

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
