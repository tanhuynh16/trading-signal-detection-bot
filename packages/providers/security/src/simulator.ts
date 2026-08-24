import type { PublicClient } from 'viem';
import type { Dex } from '@sdb/domain';
import { TransientProviderError, type Address } from '@sdb/shared';
import {
  dexFeeFraction,
  encodeApprove,
  encodeBalanceOf,
  encodeBuy,
  encodeSell,
  routerFor,
} from './routers.js';

/**
 * Honeypot and tax detection by simulating a real buy then a real sell.
 *
 * This is the primary source for §14's critical flags. The obvious alternative
 * — a third-party security API — was measured and rejected: GoPlus returns 10
 * of 39 fields for a one-minute-old token, with is_honeypot, is_mintable and
 * both tax fields simply absent, and still absent six minutes later. It does
 * not index tokens inside the window this bot operates in.
 *
 * The technique was validated end to end against the Base WETH/USDC V2 pair:
 * buy, approve, sell all succeeded and 0.01 ETH round-tripped to 0.009940 ETH
 * — exactly (1 - 0.003)^2, two Uniswap V2 fees and zero token tax.
 */

/** A synthetic account. Holds nothing real; funded only inside the simulation. */
const PROBE_ACCOUNT: Address = '0x00000000000000000000000000000000000f00d1';

/** Trade size for the probe. Small enough not to move a thin pool much. */
const DEFAULT_PROBE_WEI = 10n ** 16n; // 0.01 ETH

export type SimulationOutcome = {
  /** Did the buy leg execute at all? */
  canBuy: boolean;
  /**
   * Did the sell leg execute? Null when the buy failed, because a sell that
   * was never attempted is unknown, not safe — §15's rule applied to risk.
   */
  canSell: boolean | null;
  /** Round-trip tax attributable to the TOKEN, with the DEX fee divided out. */
  tokenTaxFraction: number | null;
  /** Raw retention before removing the DEX fee; useful for auditing. */
  observedRetention: number | null;
  ethIn: bigint;
  ethOut: bigint | null;
  tokensReceived: bigint | null;
  /** Provider revert text, when there is one. */
  failureReason: string | null;
};

type SimCall = { from: Address; to: Address; data: `0x${string}`; value?: bigint };

type SimCallResult = {
  status: `0x${string}`;
  returnData: `0x${string}`;
  gasUsed: `0x${string}`;
  error?: { message?: string };
};

/**
 * Run a sequence of calls with state carried between them, against an account
 * given a synthetic ETH balance.
 *
 * `eth_simulateV1` is used rather than repeated `eth_call` because the sell leg
 * must observe the token balance the buy leg created. `debug_traceCall` would
 * be an alternative but is not available on the free tier.
 */
async function simulateSequence(
  client: PublicClient,
  calls: SimCall[],
  balanceWei: bigint,
): Promise<SimCallResult[]> {
  try {
    const response = (await client.request({
      method: 'eth_simulateV1' as never,
      params: [
        {
          blockStateCalls: [
            {
              stateOverrides: { [PROBE_ACCOUNT]: { balance: toHex(balanceWei) } },
              calls: calls.map((call) => ({
                from: call.from,
                to: call.to,
                data: call.data,
                ...(call.value !== undefined ? { value: toHex(call.value) } : {}),
              })),
            },
          ],
          validation: false,
        },
        'latest',
      ] as never,
    })) as Array<{ calls: SimCallResult[] }>;

    return response[0]?.calls ?? [];
  } catch (error) {
    // A failed simulation RPC is a provider problem, not a verdict about the
    // token. Returning "honeypot" here would be a false accusation.
    throw new TransientProviderError('eth_simulateV1 failed', {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function toHex(value: bigint): `0x${string}` {
  return `0x${value.toString(16)}`;
}

function succeeded(result: SimCallResult | undefined): boolean {
  return result?.status === '0x1';
}

/** Decode a uint256[] return value and take the last element. */
function lastAmount(returnData: string): bigint | null {
  const body = returnData.slice(2);
  if (body.length < 64) return null;
  const words = body.length / 64;
  const last = body.slice((words - 1) * 64);
  return BigInt(`0x${last}`);
}

export async function simulateRoundTrip(
  client: PublicClient,
  input: {
    token: Address;
    dex: Dex;
    feeTier?: number | null;
    probeWei?: bigint;
  },
): Promise<SimulationOutcome> {
  const ethIn = input.probeWei ?? DEFAULT_PROBE_WEI;
  const router = routerFor(input.dex);
  const budget = ethIn * 100n; // ample headroom for gas

  const buyData = encodeBuy({
    dex: input.dex,
    token: input.token,
    to: PROBE_ACCOUNT,
    amountIn: ethIn,
    feeTier: input.feeTier ?? null,
  });

  // Phase 1: buy, then read the resulting balance in the SAME batch. The sell
  // amount cannot be computed mid-batch, which is why this is two round trips
  // rather than one.
  const phase1 = await simulateSequence(
    client,
    [
      { from: PROBE_ACCOUNT, to: router, data: buyData, value: ethIn },
      { from: PROBE_ACCOUNT, to: input.token, data: encodeBalanceOf(PROBE_ACCOUNT) },
    ],
    budget,
  );

  if (!succeeded(phase1[0])) {
    return {
      canBuy: false,
      canSell: null,
      tokenTaxFraction: null,
      observedRetention: null,
      ethIn,
      ethOut: null,
      tokensReceived: null,
      failureReason: phase1[0]?.error?.message ?? 'buy reverted',
    };
  }

  const tokensReceived = succeeded(phase1[1])
    ? BigInt(phase1[1]!.returnData || '0x0')
    : 0n;

  if (tokensReceived === 0n) {
    // The buy "succeeded" but delivered nothing — a 100% buy tax, or a token
    // that silently swallows transfers. Unsellable either way.
    return {
      canBuy: true,
      canSell: false,
      tokenTaxFraction: 1,
      observedRetention: 0,
      ethIn,
      ethOut: 0n,
      tokensReceived: 0n,
      failureReason: 'buy delivered zero tokens',
    };
  }

  // Phase 2: replay the buy, approve, then sell exactly what phase 1 produced.
  const phase2 = await simulateSequence(
    client,
    [
      { from: PROBE_ACCOUNT, to: router, data: buyData, value: ethIn },
      { from: PROBE_ACCOUNT, to: input.token, data: encodeApprove(router) },
      {
        from: PROBE_ACCOUNT,
        to: router,
        data: encodeSell({
          dex: input.dex,
          token: input.token,
          to: PROBE_ACCOUNT,
          amountIn: tokensReceived,
          feeTier: input.feeTier ?? null,
        }),
      },
    ],
    budget,
  );

  if (!succeeded(phase2[2])) {
    // Bought fine, cannot sell. This is the honeypot signature.
    return {
      canBuy: true,
      canSell: false,
      tokenTaxFraction: null,
      observedRetention: null,
      ethIn,
      ethOut: null,
      tokensReceived,
      failureReason: phase2[2]?.error?.message ?? 'sell reverted',
    };
  }

  const ethOut = lastAmount(phase2[2]!.returnData) ?? 0n;
  const observedRetention = Number(ethOut) / Number(ethIn);

  return {
    canBuy: true,
    canSell: true,
    tokenTaxFraction: deriveTax(observedRetention, input.dex, input.feeTier ?? null),
    observedRetention,
    ethIn,
    ethOut,
    tokensReceived,
    failureReason: null,
  };
}

/**
 * Separate the token's tax from the DEX's fee.
 *
 * A round trip pays the pool fee twice regardless of the token, so raw
 * retention is not tax. Comparing against a fixed constant would report a
 * clean token in a 1% V3 pool as carrying ~2% tax — and 1% pools are common
 * for new listings, so this would misclassify a large slice of the target set.
 *
 *   expectedRetention = (1 - dexFee)^2
 *   tokenTax          = 1 - observed / expected
 */
export function deriveTax(
  observedRetention: number,
  dex: Dex,
  feeTier: number | null,
): number {
  const fee = dexFeeFraction(dex, feeTier);
  const expected = (1 - fee) ** 2;
  if (expected <= 0) return 0;
  const tax = 1 - observedRetention / expected;
  // Slippage and rounding can make a clean token look microscopically
  // negative; clamp rather than report a nonsensical negative tax.
  return tax < 0 ? 0 : tax;
}

export { PROBE_ACCOUNT, DEFAULT_PROBE_WEI };
