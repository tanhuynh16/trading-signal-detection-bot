import { encodeFunctionData, parseAbi } from 'viem';
import type { Dex } from '@sdb/domain';
import { canonicalize, type Address } from '@sdb/shared';

/**
 * Swap routers used for honeypot simulation.
 *
 * Addresses come from each protocol's own deployment documentation and were
 * confirmed to have code on Base. A wrong router makes every simulation revert,
 * which would read as "every token is a honeypot" — a silent, total failure of
 * the risk gate.
 */
export const UNISWAP_V2_ROUTER: Address = canonicalize(
  // Uniswap v2 deployments documentation, Base (chain 8453)
  '0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24',
);

export const UNISWAP_V3_ROUTER: Address = canonicalize(
  // Uniswap v3 Base deployments documentation (SwapRouter02)
  '0x2626664c2603336E57B271c5C0b26F421741e481',
);

export const AERODROME_ROUTER: Address = canonicalize(
  // aerodrome-finance/contracts README
  '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43',
);

export const WETH: Address = canonicalize('0x4200000000000000000000000000000000000006');

export function routerFor(dex: Dex): Address {
  switch (dex) {
    case 'uniswap-v2':
      return UNISWAP_V2_ROUTER;
    case 'uniswap-v3':
      return UNISWAP_V3_ROUTER;
    case 'aerodrome':
      return AERODROME_ROUTER;
  }
}

/**
 * DEX fee as a fraction, per leg.
 *
 * This matters more than it looks. Round-trip retention conflates the DEX fee
 * with the token's own tax: a clean token in a 1% V3 pool retains ~98%, which
 * compared against a fixed baseline would be reported as a 2%-tax token. The
 * fee is divided out in `deriveTax` so only genuine token tax remains.
 *
 * Measured baseline: a clean Uniswap V2 round trip retained exactly 99.40%,
 * which is (1 - 0.003)^2.
 */
export function dexFeeFraction(dex: Dex, feeTier?: number | null): number {
  switch (dex) {
    case 'uniswap-v2':
      return 0.003;
    case 'aerodrome':
      // Aerodrome volatile pools; stable pools use a lower fee but are
      // filtered out at discovery (ADR: volatile-only).
      return 0.003;
    case 'uniswap-v3':
      // feeTier is in hundredths of a basis point: 3000 => 0.3%.
      return feeTier != null && feeTier > 0 ? feeTier / 1_000_000 : 0.003;
  }
}

const V2_ROUTER_ABI = parseAbi([
  'function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[] amounts)',
  'function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)',
]);

const AERODROME_ROUTER_ABI = parseAbi([
  'struct Route { address from; address to; bool stable; address factory; }',
  'function swapExactETHForTokens(uint256 amountOutMin, Route[] routes, address to, uint256 deadline) payable returns (uint256[] amounts)',
  'function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, Route[] routes, address to, uint256 deadline) returns (uint256[] amounts)',
]);

const V3_ROUTER_ABI = parseAbi([
  'struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }',
  'function exactInputSingle(ExactInputSingleParams params) payable returns (uint256 amountOut)',
]);

export const ERC20_ABI = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
]);

const DEADLINE = 2n ** 32n;

export function encodeApprove(spender: Address): `0x${string}` {
  return encodeFunctionData({
    abi: ERC20_ABI,
    functionName: 'approve',
    args: [spender, 2n ** 256n - 1n],
  });
}

export function encodeBalanceOf(account: Address): `0x${string}` {
  return encodeFunctionData({ abi: ERC20_ABI, functionName: 'balanceOf', args: [account] });
}

/** Buy `token` with native ETH. */
export function encodeBuy(input: {
  dex: Dex;
  token: Address;
  to: Address;
  /** Native ETH in. V3's router needs it in calldata as well as msg.value. */
  amountIn: bigint;
  feeTier?: number | null;
  aerodromeFactory?: Address;
}): `0x${string}` {
  const { dex, token, to } = input;

  if (dex === 'uniswap-v3') {
    return encodeFunctionData({
      abi: V3_ROUTER_ABI,
      functionName: 'exactInputSingle',
      args: [
        {
          tokenIn: WETH,
          tokenOut: token,
          fee: input.feeTier ?? 3000,
          recipient: to,
          // SwapRouter02 is payable and wraps msg.value when tokenIn is WETH,
          // but amountIn must still match or the swap reverts.
          amountIn: input.amountIn,
          amountOutMinimum: 0n,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
  }

  if (dex === 'aerodrome') {
    return encodeFunctionData({
      abi: AERODROME_ROUTER_ABI,
      functionName: 'swapExactETHForTokens',
      args: [
        0n,
        [
          {
            from: WETH,
            to: token,
            stable: false,
            factory: input.aerodromeFactory ?? canonicalize('0x420DD381b31aEf6683db6B902084cB0FFECe40Da'),
          },
        ],
        to,
        DEADLINE,
      ],
    });
  }

  return encodeFunctionData({
    abi: V2_ROUTER_ABI,
    functionName: 'swapExactETHForTokens',
    args: [0n, [WETH, token], to, DEADLINE],
  });
}

/** Sell an exact amount of `token` back to native ETH. */
export function encodeSell(input: {
  dex: Dex;
  token: Address;
  to: Address;
  amountIn: bigint;
  feeTier?: number | null;
  aerodromeFactory?: Address;
}): `0x${string}` {
  const { dex, token, to, amountIn } = input;

  if (dex === 'uniswap-v3') {
    return encodeFunctionData({
      abi: V3_ROUTER_ABI,
      functionName: 'exactInputSingle',
      args: [
        {
          tokenIn: token,
          tokenOut: WETH,
          fee: input.feeTier ?? 3000,
          recipient: to,
          amountIn,
          amountOutMinimum: 0n,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
  }

  if (dex === 'aerodrome') {
    return encodeFunctionData({
      abi: AERODROME_ROUTER_ABI,
      functionName: 'swapExactTokensForETH',
      args: [
        amountIn,
        0n,
        [
          {
            from: token,
            to: WETH,
            stable: false,
            factory: input.aerodromeFactory ?? canonicalize('0x420DD381b31aEf6683db6B902084cB0FFECe40Da'),
          },
        ],
        to,
        DEADLINE,
      ],
    });
  }

  return encodeFunctionData({
    abi: V2_ROUTER_ABI,
    functionName: 'swapExactTokensForETH',
    args: [amountIn, 0n, [token, WETH], to, DEADLINE],
  });
}
