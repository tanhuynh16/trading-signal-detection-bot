import { describe, expect, it } from 'vitest';
import { createPublicClient, http as httpTransport } from 'viem';
import { base } from 'viem/chains';
import { readPoolState } from '@sdb/market-data';
import { baseIsToken0 } from './price-path.js';

/**
 * Pins the one assumption the price path cannot verify from the database.
 *
 * `baseIsToken0` derives pool ordering from an address comparison rather than an
 * RPC call, because doing it per trade would cost a request per pool per
 * horizon. Every supported DEX sorts `token0 < token1` at pool creation — but if
 * that were ever false, every price in the path would silently invert while
 * still looking like a plausible number. This makes it fail loudly instead.
 *
 * Opt-in: needs a real Base RPC endpoint, so the default suite does not depend
 * on a paid API. Run with BASE_RPC_HTTP_URL set.
 */
const rpcUrl = process.env.BASE_RPC_HTTP_URL;
const pools = [
  // Uniswap V3 WETH/USDC — the ETH/USD reference pool.
  { address: '0xd0b53d9277642d899df5c87a3966a349a798f224', dex: 'uniswap-v3' },
  // Uniswap V2 WETH/USDC on Base.
  { address: '0x88a43bbdf9d098eec7bceda4e2494615dfd9bb9c', dex: 'uniswap-v2' },
] as const;

describe.skipIf(!rpcUrl)('pool token ordering, against real Base pools', () => {
  const client = createPublicClient({
    chain: base,
    transport: httpTransport(rpcUrl ?? ''),
  });

  for (const pool of pools) {
    it(`sorts token0 < token1 on ${pool.dex}`, async () => {
      const state = await readPoolState(client, {
        poolAddress: pool.address as `0x${string}`,
        dex: pool.dex,
      });

      expect(state.token0.toLowerCase() < state.token1.toLowerCase()).toBe(true);

      // And the derivation agrees with the chain for both orientations.
      expect(baseIsToken0(state.token0, state.token1)).toBe(true);
      expect(baseIsToken0(state.token1, state.token0)).toBe(false);
    }, 30_000);
  }
});
