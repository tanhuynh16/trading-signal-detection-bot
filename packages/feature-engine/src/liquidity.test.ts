import { describe, expect, it } from 'vitest';
import {
  liquidityGrowth,
  liquidityStability,
  mcLiquidityRatio,
  sampleNear,
  type LiquiditySample,
} from './liquidity.js';

const at = (min: number): Date => new Date(Date.UTC(2026, 7, 24, 12, min, 0));
const s = (usd: number | null, min: number): LiquiditySample => ({ usd, at: at(min) });

describe('liquidityGrowth (spec §15.1)', () => {
  it('computes relative change over the window', () => {
    expect(liquidityGrowth(150_000, 100_000)).toBeCloseTo(0.5, 9);
  });

  it('reports a decline as negative', () => {
    expect(liquidityGrowth(50_000, 100_000)).toBeCloseTo(-0.5, 9);
  });

  it('returns null when growing from below epsilon rather than Infinity', () => {
    // New pools start at ~0 liquidity, so this is the common case, not an edge.
    expect(liquidityGrowth(100_000, 0)).toBeNull();
    expect(liquidityGrowth(100_000, 0.5, 1)).toBeNull();
  });

  it('returns null when either side is unmeasurable', () => {
    expect(liquidityGrowth(null, 100_000)).toBeNull();
    expect(liquidityGrowth(100_000, null)).toBeNull();
  });
});

describe('liquidityStability (spec §15.1)', () => {
  it('scores a perfectly flat series 1', () => {
    expect(liquidityStability([s(100, 0), s(100, 1), s(100, 2)])).toBe(1);
  });

  it('scores a violently swinging series near 0', () => {
    const value = liquidityStability([s(100, 0), s(200, 1), s(50, 2), s(300, 3)])!;
    expect(value).toBeLessThan(0.5);
  });

  it('ranks a steady pool above a choppy one', () => {
    const steady = liquidityStability([s(100, 0), s(102, 1), s(101, 2), s(103, 3)])!;
    const choppy = liquidityStability([s(100, 0), s(160, 1), s(70, 2), s(140, 3)])!;
    expect(steady).toBeGreaterThan(choppy);
  });

  it('returns null with fewer than three samples, not a flattering 1.0', () => {
    expect(liquidityStability([s(100, 0), s(100, 1)])).toBeNull();
    expect(liquidityStability([])).toBeNull();
  });

  it('ignores null and zero samples when counting usable history', () => {
    expect(liquidityStability([s(100, 0), s(null, 1), s(100, 2)])).toBeNull();
  });

  it('stays within 0..1', () => {
    const value = liquidityStability([s(1, 0), s(1000, 1), s(1, 2), s(5000, 3)])!;
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThanOrEqual(1);
  });
});

describe('mcLiquidityRatio (spec §15.1)', () => {
  it('divides market cap by liquidity', () => {
    expect(mcLiquidityRatio(500_000, 100_000)).toBe(5);
  });

  it('applies the epsilon guard on a near-empty pool', () => {
    expect(mcLiquidityRatio(1000, 0, 1)).toBe(1000);
  });

  it('returns null when either side is unknown', () => {
    expect(mcLiquidityRatio(null, 100)).toBeNull();
    expect(mcLiquidityRatio(100, null)).toBeNull();
  });
});

describe('sampleNear', () => {
  const samples = [s(100, 0), s(200, 5), s(300, 10)];

  it('finds the sample closest to the target instant', () => {
    expect(sampleNear(samples, at(5), 60_000)?.usd).toBe(200);
  });

  it('tolerates a near miss, since snapshots land on the §13 schedule', () => {
    expect(sampleNear(samples, at(6), 90_000)?.usd).toBe(200);
  });

  it('returns null rather than passing off a stale reading as current', () => {
    expect(sampleNear(samples, at(30), 60_000)).toBeNull();
  });

  it('returns null for an empty series', () => {
    expect(sampleNear([], at(0), 60_000)).toBeNull();
  });
});
