import type { PublicClient } from 'viem';
import type { Dex } from '@sdb/domain';
import { canonicalize, InvalidDataError, TransientProviderError, type Address } from '@sdb/shared';
import {
  AERODROME_POOL_ABI,
  ERC20_ABI,
  UNISWAP_V2_POOL_ABI,
  UNISWAP_V3_POOL_ABI,
} from './abis.js';

/**
 * One observation of a pool's on-chain state.
 *
 * `reserve*` are the pool's actual token balances. For V2/Aerodrome these come
 * from getReserves; for V3 they are ERC-20 balanceOf on the pool, because V3's
 * `liquidity()` is an in-range virtual quantity that cannot be valued in USD.
 */
export type PoolState = {
  poolAddress: Address;
  token0: Address;
  token1: Address;
  reserve0: bigint;
  reserve1: bigint;
  /** V3 only; null elsewhere. */
  sqrtPriceX96: bigint | null;
  blockNumber: bigint;
};

export type TokenMeta = {
  address: Address;
  symbol: string | null;
  name: string | null;
  decimals: number;
  totalSupplyRaw: bigint;
};

type MulticallResult<T> = { status: 'success'; result: T } | { status: 'failure'; error: Error };

function unwrap<T>(result: MulticallResult<T>, what: string): T {
  if (result.status === 'failure') {
    throw new TransientProviderError(`multicall field failed: ${what}`, {
      cause: result.error.message,
    });
  }
  return result.result;
}

/**
 * Read a pool's full state in ONE multicall.
 *
 * Batching matters: spec §13 snapshots up to eight times per pool, and issuing
 * four or five separate eth_calls each time is what exhausts a rate-limited
 * provider (see the Phase 1 429s).
 */
export async function readPoolState(
  client: PublicClient,
  input: { poolAddress: Address; dex: Dex; blockNumber?: bigint },
): Promise<PoolState> {
  const { poolAddress, dex } = input;
  const block = input.blockNumber !== undefined ? { blockNumber: input.blockNumber } : {};

  if (dex === 'uniswap-v3') {
    const [slot0, token0, token1] = await client.multicall({
      allowFailure: true,
      contracts: [
        { address: poolAddress, abi: UNISWAP_V3_POOL_ABI, functionName: 'slot0' },
        { address: poolAddress, abi: UNISWAP_V3_POOL_ABI, functionName: 'token0' },
        { address: poolAddress, abi: UNISWAP_V3_POOL_ABI, functionName: 'token1' },
      ],
      ...block,
    });

    const t0 = canonicalize(unwrap(token0 as MulticallResult<string>, 'token0'));
    const t1 = canonicalize(unwrap(token1 as MulticallResult<string>, 'token1'));
    const slot = unwrap(slot0 as MulticallResult<readonly unknown[]>, 'slot0');

    // V3 holds no reserves; its tradeable depth is simply what it owns.
    const [balances, blockNumber] = await Promise.all([
      client.multicall({
        allowFailure: true,
        contracts: [
          { address: t0, abi: ERC20_ABI, functionName: 'balanceOf', args: [poolAddress] },
          { address: t1, abi: ERC20_ABI, functionName: 'balanceOf', args: [poolAddress] },
        ],
        ...block,
      }),
      input.blockNumber !== undefined
        ? Promise.resolve(input.blockNumber)
        : client.getBlockNumber(),
    ]);

    return {
      poolAddress,
      token0: t0,
      token1: t1,
      reserve0: unwrap(balances[0] as MulticallResult<bigint>, 'balanceOf(token0)'),
      reserve1: unwrap(balances[1] as MulticallResult<bigint>, 'balanceOf(token1)'),
      sqrtPriceX96: slot[0] as bigint,
      blockNumber,
    };
  }

  // V2 and Aerodrome share a call shape but NOT a return type: V2's getReserves
  // is (uint112,uint112,uint32), Aerodrome's is (uint256,uint256,uint256).
  const abi = dex === 'aerodrome' ? AERODROME_POOL_ABI : UNISWAP_V2_POOL_ABI;
  const [reserves, token0, token1] = await client.multicall({
    allowFailure: true,
    contracts: [
      { address: poolAddress, abi, functionName: 'getReserves' },
      { address: poolAddress, abi, functionName: 'token0' },
      { address: poolAddress, abi, functionName: 'token1' },
    ],
    ...block,
  });

  const r = unwrap(reserves as MulticallResult<readonly bigint[]>, 'getReserves');
  return {
    poolAddress,
    token0: canonicalize(unwrap(token0 as MulticallResult<string>, 'token0')),
    token1: canonicalize(unwrap(token1 as MulticallResult<string>, 'token1')),
    reserve0: r[0] as bigint,
    reserve1: r[1] as bigint,
    sqrtPriceX96: null,
    blockNumber: input.blockNumber ?? (await client.getBlockNumber()),
  };
}

/**
 * ERC-20 metadata in one multicall.
 *
 * `decimals` failing is fatal: without it every downstream amount is wrong by
 * orders of magnitude, so we refuse rather than assume 18. Symbol and name are
 * cosmetic and may legitimately be absent, so they degrade to null.
 */
export async function readTokenMetadata(
  client: PublicClient,
  address: Address,
): Promise<TokenMeta> {
  const [symbol, name, decimals, totalSupply] = await client.multicall({
    allowFailure: true,
    contracts: [
      { address, abi: ERC20_ABI, functionName: 'symbol' },
      { address, abi: ERC20_ABI, functionName: 'name' },
      { address, abi: ERC20_ABI, functionName: 'decimals' },
      { address, abi: ERC20_ABI, functionName: 'totalSupply' },
    ],
  });

  const decimalsValue =
    decimals.status === 'success'
      ? Number(decimals.result)
      : await resolveDecimals(client, address, decimals.error);

  return {
    address,
    symbol: symbol.status === 'success' ? sanitizeText(symbol.result) : null,
    name: name.status === 'success' ? sanitizeText(name.result) : null,
    decimals: decimalsValue,
    totalSupplyRaw: totalSupply.status === 'success' ? (totalSupply.result as bigint) : 0n,
  };
}

/**
 * Recover `decimals()` after a multicall entry failed, and classify the failure
 * honestly if it cannot be recovered.
 *
 * A multicall entry can fail two very different ways: the contract genuinely
 * has no `decimals()` (permanent — the token is unusable), or the request was
 * throttled or timed out (transient). The original code assumed the first and
 * threw `InvalidDataError`, which `guarded()` routes straight to `jobs_audit`
 * and never retries.
 *
 * That assumption was wrong and measurably costly. Both tokens dropped in a
 * Phase 4 run were probed on chain afterwards and are ordinary ERC-20s
 * (decimals 18, supply 1e27, identical launcher bytecode) — lost to rate
 * limiting, roughly a quarter of that run's discoveries. Note the sibling
 * `unwrap()` in this same file already treats an identical failure as
 * transient; the two disagreed.
 *
 * So: re-read directly first, and only condemn the token if the chain itself
 * says there is nothing there.
 */
async function resolveDecimals(
  client: PublicClient,
  address: Address,
  multicallError: Error,
): Promise<number> {
  try {
    const direct = await client.readContract({
      address,
      abi: ERC20_ABI,
      functionName: 'decimals',
    });
    return Number(direct);
  } catch (directError) {
    // The direct read failed too. An address with no bytecode cannot have a
    // decimals() to read, which is permanent; anything else is the provider
    // failing us, not the token.
    let hasCode: boolean;
    try {
      const code = await client.getCode({ address });
      hasCode = code !== undefined && code !== '0x';
    } catch {
      // Even the code check failed — clearly a provider problem, so treat the
      // token as innocent and let the job retry.
      throw new TransientProviderError(`could not verify decimals() for ${address}`, {
        cause: message(directError),
      });
    }

    if (!hasCode) {
      throw new InvalidDataError(`token ${address} has no contract code`, {
        cause: message(multicallError),
      });
    }

    throw new TransientProviderError(`decimals() unreadable for ${address}; will retry`, {
      cause: message(directError),
    });
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Control characters, including DEL, that must never reach a log or alert.
 * The control range is the entire point of this pattern, hence the disable.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/**
 * Token names and symbols are attacker-controlled: anyone can deploy a token
 * whose name contains terminal escape sequences, newlines that forge log lines,
 * or Telegram markup. Spec §25 requires input limits, so this strips control
 * characters and caps length before the value reaches a column or an alert.
 */
export function sanitizeText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(CONTROL_CHARS, '').trim();
  return cleaned.length === 0 ? null : cleaned.slice(0, 128);
}
