import { parseAbiItem, toEventSelector, type AbiEvent, type Hex } from 'viem';
import type { Dex } from '@sdb/domain';
import { canonicalize, type Address } from '@sdb/shared';

/**
 * Factory definitions for Base mainnet.
 *
 * Every address below was read from the protocol's own deployment
 * documentation, not from recall, and each carries its source. Spec §29 treats
 * a wrong factory address as a silent-failure class: the worker would run
 * cleanly forever and simply never discover anything.
 *
 * The event selectors are derived from the ABI at module load rather than
 * pasted in, so a typo in a signature cannot silently produce a filter that
 * matches nothing. `factories.test.ts` pins them against a log captured from
 * the live chain.
 */
export type FactoryDefinition = {
  /** Stable key; also the `discovery_cursors.source` primary key. */
  source: string;
  dex: Dex;
  address: Address;
  event: AbiEvent;
  topic0: Hex;
  /** Where the address came from, kept next to the value it justifies. */
  provenance: string;
};

// https://docs.uniswap.org/contracts/v2/reference/smart-contracts/v2-deployments
const UNISWAP_V2_EVENT: AbiEvent = parseAbiItem(
  'event PairCreated(address indexed token0, address indexed token1, address pair, uint256 allPairsLength)',
);

// https://docs.uniswap.org/contracts/v3/reference/deployments/base-deployments
const UNISWAP_V3_EVENT: AbiEvent = parseAbiItem(
  'event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)',
);

// https://github.com/aerodrome-finance/contracts — IPoolFactory.sol
// Note the third indexed parameter (`stable`), which Uniswap's events lack.
const AERODROME_EVENT: AbiEvent = parseAbiItem(
  'event PoolCreated(address indexed token0, address indexed token1, bool indexed stable, address pool, uint256 allPoolsLength)',
);

export const UNISWAP_V2_FACTORY: FactoryDefinition = {
  source: 'uniswap-v2',
  dex: 'uniswap-v2',
  address: canonicalize('0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6'),
  event: UNISWAP_V2_EVENT,
  topic0: toEventSelector(UNISWAP_V2_EVENT),
  provenance: 'Uniswap v2 deployments documentation (Base, chain 8453)',
};

export const UNISWAP_V3_FACTORY: FactoryDefinition = {
  source: 'uniswap-v3',
  dex: 'uniswap-v3',
  address: canonicalize('0x33128a8fC17869897dcE68Ed026d694621f6FDfD'),
  event: UNISWAP_V3_EVENT,
  topic0: toEventSelector(UNISWAP_V3_EVENT),
  provenance: 'Uniswap v3 Base deployments documentation',
};

export const AERODROME_FACTORY: FactoryDefinition = {
  source: 'aerodrome',
  dex: 'aerodrome',
  address: canonicalize('0x420DD381b31aEf6683db6B902084cB0FFECe40Da'),
  event: AERODROME_EVENT,
  topic0: toEventSelector(AERODROME_EVENT),
  provenance: 'aerodrome-finance/contracts README, PoolFactory',
};

export const FACTORIES: readonly FactoryDefinition[] = [
  UNISWAP_V2_FACTORY,
  UNISWAP_V3_FACTORY,
  AERODROME_FACTORY,
];

export function factoryBySource(source: string): FactoryDefinition | undefined {
  return FACTORIES.find((factory) => factory.source === source);
}
