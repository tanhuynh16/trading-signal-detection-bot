import { parseAbi } from 'viem';

/**
 * Pool ABIs, per DEX.
 *
 * Uniswap V2 and Aerodrome both expose `getReserves`, but with DIFFERENT return
 * types — V2 returns (uint112, uint112, uint32); Aerodrome returns
 * (uint256, uint256, uint256), confirmed from aerodrome-finance/contracts
 * IPool.sol. Sharing one ABI decodes the wrong widths and produces plausible
 * but wrong reserves, so they are kept deliberately separate.
 */

export const ERC20_ABI = parseAbi([
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
]);

/** Some tokens return bytes32 rather than string for symbol/name. */
export const ERC20_BYTES32_ABI = parseAbi([
  'function symbol() view returns (bytes32)',
  'function name() view returns (bytes32)',
]);

export const UNISWAP_V2_POOL_ABI = parseAbi([
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
]);

export const AERODROME_POOL_ABI = parseAbi([
  'function getReserves() view returns (uint256 reserve0, uint256 reserve1, uint256 blockTimestampLast)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function stable() view returns (bool)',
]);

export const UNISWAP_V3_POOL_ABI = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function liquidity() view returns (uint128)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function fee() view returns (uint24)',
]);

/**
 * Swap events. All three selectors were verified against logs captured from
 * Base mainnet; V2 and Aerodrome differ only in parameter ORDER, which changes
 * the selector but not the topic count — a decoder keyed on topic count alone
 * would silently confuse them.
 */
export const UNISWAP_V2_SWAP_EVENT = parseAbi([
  'event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)',
])[0];

export const UNISWAP_V3_SWAP_EVENT = parseAbi([
  'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
])[0];

export const AERODROME_SWAP_EVENT = parseAbi([
  'event Swap(address indexed sender, address indexed to, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out)',
])[0];
