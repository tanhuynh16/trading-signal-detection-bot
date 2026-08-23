import { decodeEventLog, type Log } from 'viem';
import type { Dex } from '@sdb/domain';
import { canonicalize, canonicalizeHash, InvalidDataError, type Address, type Hash } from '@sdb/shared';
import {
  AERODROME_FACTORY,
  UNISWAP_V2_FACTORY,
  UNISWAP_V3_FACTORY,
  type FactoryDefinition,
} from './factories.js';

/**
 * The chain-level facts a pool-creation event carries, before we decide which
 * side is the tradeable token. Adapters are pure: log in, this out. That keeps
 * ABI correctness testable against captured fixtures with no network or
 * database in the loop (§29).
 */
export type DecodedPoolCreation = {
  dex: Dex;
  poolAddress: Address;
  token0: Address;
  token1: Address;
  blockNumber: bigint;
  transactionHash: Address;
  logIndex: number;
  /** Aerodrome only: stable pools pair correlated assets. */
  stable?: boolean;
  /** Uniswap V3 only. */
  feeTier?: number;
};

function requireLogIdentity(log: Log): {
  blockNumber: bigint;
  transactionHash: Hash;
  logIndex: number;
} {
  // Pending logs carry nulls. They are unusable for a cursor-driven pipeline
  // and must never be persisted as if they were confirmed.
  if (log.blockNumber === null || log.transactionHash === null || log.logIndex === null) {
    throw new InvalidDataError('pool-creation log is pending (null block/tx/index)', {
      address: log.address,
    });
  }
  return {
    blockNumber: log.blockNumber,
    transactionHash: canonicalizeHash(log.transactionHash),
    logIndex: log.logIndex,
  };
}

export function decodeUniswapV2(log: Log): DecodedPoolCreation {
  const { args } = decodeEventLog({
    abi: [UNISWAP_V2_FACTORY.event],
    data: log.data,
    topics: log.topics,
  }) as unknown as { args: { token0: string; token1: string; pair: string } };
  return {
    dex: 'uniswap-v2',
    poolAddress: canonicalize(args.pair),
    token0: canonicalize(args.token0),
    token1: canonicalize(args.token1),
    ...requireLogIdentity(log),
  };
}

export function decodeUniswapV3(log: Log): DecodedPoolCreation {
  const { args } = decodeEventLog({
    abi: [UNISWAP_V3_FACTORY.event],
    data: log.data,
    topics: log.topics,
  }) as unknown as { args: { token0: string; token1: string; pool: string; fee: number } };
  return {
    dex: 'uniswap-v3',
    poolAddress: canonicalize(args.pool),
    token0: canonicalize(args.token0),
    token1: canonicalize(args.token1),
    feeTier: Number(args.fee),
    ...requireLogIdentity(log),
  };
}

export function decodeAerodrome(log: Log): DecodedPoolCreation {
  const { args } = decodeEventLog({
    abi: [AERODROME_FACTORY.event],
    data: log.data,
    topics: log.topics,
  }) as unknown as { args: { token0: string; token1: string; pool: string; stable: boolean } };
  return {
    dex: 'aerodrome',
    poolAddress: canonicalize(args.pool),
    token0: canonicalize(args.token0),
    token1: canonicalize(args.token1),
    stable: args.stable,
    ...requireLogIdentity(log),
  };
}

const DECODERS: Record<string, (log: Log) => DecodedPoolCreation> = {
  'uniswap-v2': decodeUniswapV2,
  'uniswap-v3': decodeUniswapV3,
  aerodrome: decodeAerodrome,
};

export function decoderFor(factory: FactoryDefinition): (log: Log) => DecodedPoolCreation {
  const decoder = DECODERS[factory.source];
  if (!decoder) throw new InvalidDataError(`no decoder for factory ${factory.source}`);
  return decoder;
}
