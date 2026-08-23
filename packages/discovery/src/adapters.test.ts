import { describe, expect, it } from 'vitest';
import type { Log } from 'viem';
import { InvalidDataError } from '@sdb/shared';
import { decodeAerodrome, decodeUniswapV2, decodeUniswapV3 } from './adapters.js';
import fixtures from './__fixtures__/factory-logs.json' with { type: 'json' };

/** Rehydrate a captured JSON-RPC log into the shape viem hands to a decoder. */
function toLog(raw: (typeof fixtures)['uniswap-v2']): Log {
  return {
    address: raw.address as `0x${string}`,
    topics: raw.topics as [`0x${string}`, ...`0x${string}`[]],
    data: raw.data as `0x${string}`,
    blockNumber: BigInt(raw.blockNumber),
    transactionHash: raw.transactionHash as `0x${string}`,
    logIndex: Number(raw.logIndex),
    blockHash: '0x'.padEnd(66, '0') as `0x${string}`,
    transactionIndex: 0,
    removed: false,
  } as Log;
}

const ADDRESS = /^0x[0-9a-f]{40}$/;

describe('pool-creation decoders', () => {
  it('decodes a real Uniswap V2 PairCreated log', () => {
    const decoded = decodeUniswapV2(toLog(fixtures['uniswap-v2']));
    expect(decoded.dex).toBe('uniswap-v2');
    expect(decoded.poolAddress).toMatch(ADDRESS);
    expect(decoded.token0).toMatch(ADDRESS);
    expect(decoded.token1).toMatch(ADDRESS);
    expect(decoded.token0).not.toBe(decoded.token1);
    expect(decoded.blockNumber).toBe(BigInt(fixtures['uniswap-v2'].blockNumber));
  });

  it('decodes a real Uniswap V3 PoolCreated log, including the fee tier', () => {
    const decoded = decodeUniswapV3(toLog(fixtures['uniswap-v3']));
    expect(decoded.dex).toBe('uniswap-v3');
    expect(decoded.poolAddress).toMatch(ADDRESS);
    // Fee is an indexed uint24; a mis-declared ABI would surface as NaN here.
    expect(Number.isInteger(decoded.feeTier)).toBe(true);
    expect(decoded.feeTier).toBeGreaterThan(0);
  });

  it('decodes a real Aerodrome PoolCreated log, including the stable flag', () => {
    const decoded = decodeAerodrome(toLog(fixtures['aerodrome']));
    expect(decoded.dex).toBe('aerodrome');
    expect(decoded.poolAddress).toMatch(ADDRESS);
    // Aerodrome indexes `stable` as a third topic, unlike either Uniswap event.
    expect(typeof decoded.stable).toBe('boolean');
  });

  it('canonicalizes every address to lowercase (spec §11)', () => {
    const decoded = decodeUniswapV2(toLog(fixtures['uniswap-v2']));
    for (const value of [decoded.poolAddress, decoded.token0, decoded.token1]) {
      expect(value).toBe(value.toLowerCase());
    }
  });

  it('rejects a pending log rather than persisting null block identity', () => {
    const pending = { ...toLog(fixtures['uniswap-v2']), blockNumber: null } as unknown as Log;
    expect(() => decodeUniswapV2(pending)).toThrow(InvalidDataError);
  });
});
