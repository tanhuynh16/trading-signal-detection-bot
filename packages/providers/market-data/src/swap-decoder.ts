import { decodeEventLog, toEventSelector, type AbiEvent, type Hex, type Log } from 'viem';
import type { Dex, TradeSide } from '@sdb/domain';
import { canonicalize, canonicalizeHash, InvalidDataError, type Address, type Hash } from '@sdb/shared';
import {
  AERODROME_SWAP_EVENT,
  UNISWAP_V2_SWAP_EVENT,
  UNISWAP_V3_SWAP_EVENT,
} from './abis.js';

/**
 * A swap reduced to the two facts features need: how much of each token moved,
 * and in which direction. Amounts are signed from the POOL's perspective —
 * positive means the pool received it.
 */
export type DecodedSwap = {
  dex: Dex;
  poolAddress: Address;
  txHash: Hash;
  logIndex: number;
  blockNumber: bigint;
  /** The address credited with the swap; the closest thing to a trader. */
  wallet: Address;
  amount0: bigint;
  amount1: bigint;
};

/**
 * Trade direction from the CANDIDATE token's point of view.
 *
 * A BUY means the candidate token left the pool (the trader received it). This
 * has to be resolved against which side of the pair is the candidate, because
 * token0 is decided by address sort order and carries no economic meaning.
 */
export function sideFor(swap: { amount0: bigint; amount1: bigint }, baseIsToken0: boolean): TradeSide {
  const baseDelta = baseIsToken0 ? swap.amount0 : swap.amount1;
  // Base flowing OUT of the pool (negative delta) is the trader buying it.
  return baseDelta < 0n ? 'BUY' : 'SELL';
}

/** Absolute base/quote amounts for a swap, given which side is the candidate. */
export function amountsFor(
  swap: { amount0: bigint; amount1: bigint },
  baseIsToken0: boolean,
): { baseAmountRaw: bigint; quoteAmountRaw: bigint } {
  const base = baseIsToken0 ? swap.amount0 : swap.amount1;
  const quote = baseIsToken0 ? swap.amount1 : swap.amount0;
  return { baseAmountRaw: abs(base), quoteAmountRaw: abs(quote) };
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function identity(log: Log): { txHash: Hash; logIndex: number; blockNumber: bigint } {
  if (log.blockNumber === null || log.transactionHash === null || log.logIndex === null) {
    throw new InvalidDataError('swap log is pending (null block/tx/index)', {
      address: log.address,
    });
  }
  return {
    txHash: canonicalizeHash(log.transactionHash),
    logIndex: log.logIndex,
    blockNumber: log.blockNumber,
  };
}

/**
 * Uniswap V2 reports gross in/out per side. Net movement is
 * `in - out`, positive when the pool gained that token.
 */
function decodeV2Style(log: Log, dex: Dex, event: AbiEvent): DecodedSwap {
  const { args } = decodeEventLog({ abi: [event], data: log.data, topics: log.topics }) as unknown as {
    args: {
      amount0In: bigint;
      amount1In: bigint;
      amount0Out: bigint;
      amount1Out: bigint;
      to?: string;
      sender: string;
    };
  };
  return {
    dex,
    poolAddress: canonicalize(log.address),
    // `to` is the recipient; it identifies the trader better than `sender`,
    // which on a routed swap is the router contract.
    wallet: canonicalize(args.to ?? args.sender),
    amount0: args.amount0In - args.amount0Out,
    amount1: args.amount1In - args.amount1Out,
    ...identity(log),
  };
}

export function decodeUniswapV2Swap(log: Log): DecodedSwap {
  return decodeV2Style(log, 'uniswap-v2', UNISWAP_V2_SWAP_EVENT);
}

export function decodeAerodromeSwap(log: Log): DecodedSwap {
  return decodeV2Style(log, 'aerodrome', AERODROME_SWAP_EVENT);
}

/** Uniswap V3 already reports signed deltas from the pool's perspective. */
export function decodeUniswapV3Swap(log: Log): DecodedSwap {
  const { args } = decodeEventLog({
    abi: [UNISWAP_V3_SWAP_EVENT],
    data: log.data,
    topics: log.topics,
  }) as unknown as { args: { amount0: bigint; amount1: bigint; recipient: string } };
  return {
    dex: 'uniswap-v3',
    poolAddress: canonicalize(log.address),
    wallet: canonicalize(args.recipient),
    amount0: args.amount0,
    amount1: args.amount1,
    ...identity(log),
  };
}


/**
 * Selector -> decoder. The global swap tail queries all three topics at once,
 * so dispatch must be by selector: V2 and Aerodrome have identical topic counts
 * and differ only in parameter order, and keying on anything else would
 * silently swap their amount fields.
 */
export const SWAP_DECODERS: ReadonlyMap<Hex, (log: Log) => DecodedSwap> = new Map([
  [toEventSelector(UNISWAP_V2_SWAP_EVENT), decodeUniswapV2Swap],
  [toEventSelector(UNISWAP_V3_SWAP_EVENT), decodeUniswapV3Swap],
  [toEventSelector(AERODROME_SWAP_EVENT), decodeAerodromeSwap],
]);

export const SWAP_TOPICS: readonly Hex[] = [...SWAP_DECODERS.keys()];

export function decodeSwapLog(log: Log): DecodedSwap | null {
  const topic0 = log.topics[0];
  if (!topic0) return null;
  const decoder = SWAP_DECODERS.get(topic0);
  return decoder ? decoder(log) : null;
}
