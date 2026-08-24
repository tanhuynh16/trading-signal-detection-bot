import { describe, expect, it } from 'vitest';
import type { Log } from 'viem';
import { InvalidDataError } from '@sdb/shared';
import {
  amountsFor,
  decodeSwapLog,
  SWAP_TOPICS,
  sideFor,
} from './swap-decoder.js';
import fixtures from './__fixtures__/swap-logs.json' with { type: 'json' };

type Raw = (typeof fixtures)['uniswap-v2'];

function toLog(raw: Raw): Log {
  return {
    address: raw.address as `0x${string}`,
    topics: raw.topics as [`0x${string}`, ...`0x${string}`[]],
    data: raw.data as `0x${string}`,
    blockNumber: BigInt(raw.blockNumber),
    transactionHash: raw.transactionHash as `0x${string}`,
    logIndex: Number(raw.logIndex),
    blockHash: `0x${'0'.repeat(64)}` as `0x${string}`,
    transactionIndex: 0,
    removed: false,
  } as Log;
}

describe('swap decoding against live Base logs', () => {
  it('dispatches each DEX by selector', () => {
    expect(decodeSwapLog(toLog(fixtures['uniswap-v2']))!.dex).toBe('uniswap-v2');
    expect(decodeSwapLog(toLog(fixtures['uniswap-v3']))!.dex).toBe('uniswap-v3');
    expect(decodeSwapLog(toLog(fixtures['aerodrome']))!.dex).toBe('aerodrome');
  });

  /**
   * Uniswap V2 and Aerodrome encode identically — same topic count, same data
   * layout, same field order — and differ ONLY in the event signature string,
   * hence the selector. Dispatching on log shape would confuse the two.
   */
  it('keeps V2 and Aerodrome distinct despite identical encoding', () => {
    const v2 = toLog(fixtures['uniswap-v2']);
    const aero = toLog(fixtures['aerodrome']);
    expect(v2.topics.length).toBe(aero.topics.length);
    expect(v2.data.length).toBe(aero.data.length);
    expect(v2.topics[0]).not.toBe(aero.topics[0]);
    expect(decodeSwapLog(v2)!.dex).not.toBe(decodeSwapLog(aero)!.dex);
  });

  it('extracts a real, non-zero trade from each DEX', () => {
    for (const key of ['uniswap-v2', 'uniswap-v3', 'aerodrome'] as const) {
      const swap = decodeSwapLog(toLog(fixtures[key]))!;
      expect(swap.poolAddress).toMatch(/^0x[0-9a-f]{40}$/);
      expect(swap.wallet).toMatch(/^0x[0-9a-f]{40}$/);
      expect(swap.txHash).toMatch(/^0x[0-9a-f]{64}$/);
      // A swap moves both sides; zero on both would mean a decode failure.
      expect(swap.amount0 !== 0n || swap.amount1 !== 0n).toBe(true);
    }
  });

  it('produces signed amounts with opposite signs — one side in, one out', () => {
    for (const key of ['uniswap-v2', 'uniswap-v3', 'aerodrome'] as const) {
      const { amount0, amount1 } = decodeSwapLog(toLog(fixtures[key]))!;
      expect(amount0 > 0n !== amount1 > 0n).toBe(true);
    }
  });

  it('ignores an unrelated log rather than misdecoding it', () => {
    const alien = { ...toLog(fixtures['uniswap-v2']) };
    (alien.topics as string[])[0] = `0x${'9'.repeat(64)}`;
    expect(decodeSwapLog(alien)).toBeNull();
  });

  it('rejects a pending log', () => {
    const pending = { ...toLog(fixtures['uniswap-v3']), blockNumber: null } as unknown as Log;
    expect(() => decodeSwapLog(pending)).toThrow(InvalidDataError);
  });

  it('exposes exactly three topics for the global tail filter', () => {
    expect(new Set(SWAP_TOPICS).size).toBe(3);
  });
});

describe('trade direction (spec §15.2 buy/sell ratio depends on this)', () => {
  it('reads base leaving the pool as a BUY', () => {
    // token0 is the candidate; negative delta = pool sent it to the trader.
    expect(sideFor({ amount0: -100n, amount1: 5n }, true)).toBe('BUY');
  });

  it('reads base entering the pool as a SELL', () => {
    expect(sideFor({ amount0: 100n, amount1: -5n }, true)).toBe('SELL');
  });

  it('flips correctly when the candidate is token1', () => {
    // Same swap, but now token1 is the candidate: it entered the pool.
    expect(sideFor({ amount0: -100n, amount1: 5n }, false)).toBe('SELL');
    expect(sideFor({ amount0: 100n, amount1: -5n }, false)).toBe('BUY');
  });

  it('returns absolute base and quote amounts regardless of direction', () => {
    const buy = amountsFor({ amount0: -100n, amount1: 5n }, true);
    expect(buy).toEqual({ baseAmountRaw: 100n, quoteAmountRaw: 5n });
    const sell = amountsFor({ amount0: 100n, amount1: -5n }, true);
    expect(sell).toEqual({ baseAmountRaw: 100n, quoteAmountRaw: 5n });
  });

  it('maps base/quote by position when the candidate is token1', () => {
    expect(amountsFor({ amount0: 7n, amount1: -3n }, false)).toEqual({
      baseAmountRaw: 3n,
      quoteAmountRaw: 7n,
    });
  });
});
