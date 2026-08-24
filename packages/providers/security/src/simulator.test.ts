import { describe, expect, it } from 'vitest';
import { deriveTax } from './simulator.js';
import { dexFeeFraction } from './routers.js';

/**
 * The measured baseline. A clean round trip through the Base Uniswap V2 router
 * (WETH -> USDC -> WETH) retained 0.009940 of 0.010000 ETH: exactly two 0.3%
 * pool fees and zero token tax. Every assertion below is anchored to it.
 */
const CLEAN_V2_RETENTION = 0.994009;

describe('deriveTax — separating token tax from DEX fee', () => {
  it('reports ~0% tax for the measured clean Uniswap V2 round trip', () => {
    const tax = deriveTax(CLEAN_V2_RETENTION, 'uniswap-v2', null);
    expect(tax).toBeLessThan(0.001);
  });

  it('does not count a 1% V3 pool fee as a 2% token tax', () => {
    // This is the bug the fee division exists to prevent. A clean token in a
    // 1% tier retains ~98%; compared against a fixed baseline it would look
    // heavily taxed, and 1% tiers are common for new listings.
    const cleanIn1PercentPool = (1 - 0.01) ** 2; // 0.9801
    const tax = deriveTax(cleanIn1PercentPool, 'uniswap-v3', 10_000);
    expect(tax).toBeLessThan(0.001);
  });

  it('does not count a 0.05% V3 pool fee as tax either', () => {
    const clean = (1 - 0.0005) ** 2;
    expect(deriveTax(clean, 'uniswap-v3', 500)).toBeLessThan(0.001);
  });

  it('detects a genuine 10% round-trip tax on top of the pool fee', () => {
    const observed = (1 - 0.003) ** 2 * 0.9;
    const tax = deriveTax(observed, 'uniswap-v2', null);
    expect(tax).toBeCloseTo(0.1, 3);
  });

  it('detects a punitive 50% tax', () => {
    const observed = (1 - 0.003) ** 2 * 0.5;
    expect(deriveTax(observed, 'uniswap-v2', null)).toBeCloseTo(0.5, 3);
  });

  it('clamps to zero rather than reporting a negative tax', () => {
    // Rounding and slippage can put observed marginally above expected.
    expect(deriveTax(0.9999, 'uniswap-v2', null)).toBe(0);
  });

  it('reports total loss as 100% tax', () => {
    expect(deriveTax(0, 'uniswap-v2', null)).toBe(1);
  });
});

describe('dexFeeFraction', () => {
  it('reads V3 fee tiers from hundredths of a basis point', () => {
    expect(dexFeeFraction('uniswap-v3', 100)).toBeCloseTo(0.0001, 9);
    expect(dexFeeFraction('uniswap-v3', 500)).toBeCloseTo(0.0005, 9);
    expect(dexFeeFraction('uniswap-v3', 3000)).toBeCloseTo(0.003, 9);
    expect(dexFeeFraction('uniswap-v3', 10_000)).toBeCloseTo(0.01, 9);
  });

  it('uses the fixed 0.3% fee for V2 and Aerodrome volatile pools', () => {
    expect(dexFeeFraction('uniswap-v2')).toBeCloseTo(0.003, 9);
    expect(dexFeeFraction('aerodrome')).toBeCloseTo(0.003, 9);
  });

  it('falls back to 0.3% for a V3 pool with an unknown tier', () => {
    // Better to assume the common tier than to divide by zero and report a
    // clean token as 100% taxed.
    expect(dexFeeFraction('uniswap-v3', null)).toBeCloseTo(0.003, 9);
    expect(dexFeeFraction('uniswap-v3', 0)).toBeCloseTo(0.003, 9);
  });

  it('squares to the observed baseline for V2', () => {
    const expected = (1 - dexFeeFraction('uniswap-v2')) ** 2;
    expect(expected).toBeCloseTo(CLEAN_V2_RETENTION, 4);
  });
});
