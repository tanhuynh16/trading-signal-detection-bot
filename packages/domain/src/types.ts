import type { Address } from '@sdb/shared';

/** Spec §8 canonical domain types. Base only for v1 (§4). */
export type Chain = 'base';

export type Dex = 'uniswap-v2' | 'uniswap-v3' | 'aerodrome';

export type RiskStatus = 'PASS' | 'WARNING' | 'FAIL';

export type SignalState = 'NEW' | 'WATCHING' | 'INTERESTING' | 'STRONG_SIGNAL' | 'EXPIRED';

export type AlertLevel = 'NONE' | 'INTERESTING' | 'STRONG';

export type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

/**
 * Spec §8 names a single `dex: 'uniswap' | 'aerodrome'`. We widen it to
 * distinguish Uniswap V2 from V3 because liquidity is read differently for each
 * (reserves vs. slot0 + pool token balances) — a v2/v3 pool cannot share a code
 * path. Documented deviation per §29.
 */
export type TokenCandidate = {
  chain: Chain;
  tokenAddress: Address;
  poolAddress: Address;
  dex: Dex;
  quoteTokenAddress: Address;
  discoveredAt: Date;
  blockNumber: bigint;
  transactionHash: Address;
};

export type TokenMetadata = {
  address: Address;
  symbol: string | null;
  name: string | null;
  decimals: number;
  totalSupplyRaw: bigint;
};

/**
 * One observation of a pool. Spec §3 requires distinguishing when the chain
 * produced the state from when we read it, so both timestamps are carried.
 */
export type PoolSnapshot = {
  poolAddress: Address;
  blockNumber: bigint;
  /** Block timestamp — when the chain state was true. */
  observedAt: Date;
  /** Wall clock — when we captured it. */
  capturedAt: Date;
  priceUsd: string | null;
  marketCapUsd: string | null;
  liquidityUsd: string | null;
  baseReserveRaw: bigint | null;
  quoteReserveRaw: bigint | null;
};

export type TradeSide = 'BUY' | 'SELL';

export type Trade = {
  poolAddress: Address;
  txHash: Address;
  logIndex: number;
  wallet: Address;
  side: TradeSide;
  blockNumber: bigint;
  occurredAt: Date;
  baseAmountRaw: bigint;
  quoteAmountRaw: bigint;
  usdValue: string | null;
};

export type PricePoint = {
  poolAddress: Address;
  priceUsd: string;
  blockNumber: bigint;
  observedAt: Date;
};

export type RiskFlag = {
  code: string;
  severity: Severity;
  message: string;
};

/** Spec §14.2. riskScore: 0 = safest, 100 = riskiest. */
export type RiskResult = {
  status: RiskStatus;
  riskScore: number;
  flags: RiskFlag[];
  evaluatedAt: Date;
};

export type SecurityReport = {
  tokenAddress: Address;
  poolAddress: Address;
  flags: RiskFlag[];
  /** Spec §14.1: retain the raw provider response where feasible. */
  raw: unknown;
  fetchedAt: Date;
};

/**
 * Spec §15: features are numeric or explicitly null. Null means "not
 * measurable from the data we hold", and must never be coerced to zero.
 */
export type FeatureValue = number | null;
export type FeatureSet = Record<string, FeatureValue>;

/** Spec §17 component breakdown, retained on every signal for §27 auditability. */
export type ScoreComponent = {
  name: 'liquidity' | 'momentum' | 'holder' | 'smartMoney';
  raw: number | null;
  weight: number;
};

export type AlphaScore = {
  score: number;
  components: ScoreComponent[];
  penalties: number;
  /** Plan G1: fraction of total weight that had a non-null component. */
  coverage: number;
  strategyVersion: string;
};
