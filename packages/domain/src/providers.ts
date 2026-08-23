import type { Address } from '@sdb/shared';
import type {
  PoolSnapshot,
  PricePoint,
  SecurityReport,
  TokenCandidate,
  TokenMetadata,
  Trade,
} from './types.js';

/**
 * Spec §9: business logic must not depend on DexScreener, GeckoTerminal, a
 * specific RPC vendor or a security API. Everything crosses one of these
 * boundaries, and every one has a mock implementation for tests (§29).
 */

export interface PoolDiscoveryProvider {
  readonly name: string;
  start(onPool: (pool: TokenCandidate) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
}

export interface MarketDataProvider {
  getTokenMetadata(address: Address): Promise<TokenMetadata>;
  getPoolSnapshot(poolAddress: Address): Promise<PoolSnapshot>;
  getTrades(poolAddress: Address, from: Date, to: Date): Promise<Trade[]>;
  getPrice(poolAddress: Address): Promise<PricePoint | null>;
}

export interface SecurityProvider {
  readonly name: string;
  analyzeToken(tokenAddress: Address, poolAddress: Address): Promise<SecurityReport>;
}

export type SimulationRequest = {
  from: Address;
  to: Address;
  data: `0x${string}`;
  value?: bigint;
  blockNumber?: bigint;
};

export type SimulationResult = {
  success: boolean;
  returnData: `0x${string}` | null;
  gasUsed: bigint | null;
  revertReason: string | null;
};

export interface BlockchainProvider {
  getCode(address: Address): Promise<`0x${string}`>;
  simulate(call: SimulationRequest): Promise<SimulationResult>;
  getBlockTimestamp(blockNumber: bigint): Promise<Date>;
  getBlockNumber(): Promise<bigint>;
}
