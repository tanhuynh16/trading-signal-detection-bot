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

describe('liquidityStability: collapse vs warm-up vs transient failure', () => {
  const s = (usd: number | null) => ({ usd });

  // --- (A) leading nulls = warm-up -----------------------------------------
  it('ignores leading nulls: a pool not yet funded is warming up, not collapsing', () => {
    // Ray, from the database: five null samples at zero reserves, then $2.54 once
    // liquidity was actually added.
    const value = liquidityStability([s(null), s(null), s(14000), s(14100), s(14050)])!;
    expect(value).toBeGreaterThan(0.9);
  });

  // --- (B) trailing nulls = collapse ---------------------------------------
  it('scores 0 when liquidity becomes unmeasurable and stays that way', () => {
    // PEPKING's alerting pool, verbatim. Before the fix the nulls were filtered
    // out and the survivors scored 0.996, renormalising the liquidity component
    // to ~99/100 on a dead market — 3 of the system's 15 alerts.
    expect(
      liquidityStability([
        s(14000.27), s(14154.47), s(14154.48), s(14154.44), s(null), s(null), s(null), s(null),
      ]),
    ).toBe(0);
  });

  it('scores 0 when the series ends at zero rather than null', () => {
    expect(liquidityStability([s(14000), s(14100), s(14100), s(0)])).toBe(0);
  });

  // --- (C) interior null = transient pricing failure, NOT collapse ----------
  it('does NOT treat a recovered interior null as a collapse', () => {
    // A PEPKING pool, verbatim: quote_reserve was byte-identical at 61,593,422,200
    // across all three samples, so nothing moved — only the quote-price lookup
    // failed for the middle one. Classifying that as a rug would punish a token
    // for our own transient RPC failure. 9 pools show this shape.
    const value = liquidityStability([
      s(0.000296708620990369),
      s(null),
      s(0.000296708627211304),
      s(0.000296707167200825),
      s(0.000296707157407471),
    ])!;
    expect(value).not.toBe(0);
    expect(value).toBeGreaterThan(0.9);
  });

  it('scores a drain-and-recover well below a calm series, but not at 0', () => {
    // Deliberately asserting the REAL number rather than the one I expected.
    // [14000, 14100, null, 5] ends measured, so it is not flagged as a collapse,
    // and the step math gives steps of 0.71% and 99.965% for a mean of 0.5034 —
    // stability 0.4966, not ~0. Averaging dilutes a single catastrophic step.
    //
    // Known limitation, deliberately NOT changed in 10A: switching the metric
    // from mean to max step would re-score every pool in the system, which is a
    // redesign, not an audit fix. It is recorded so the next reader knows the
    // number is understood rather than accidental.
    const drained = liquidityStability([s(14000), s(14100), s(null), s(5)])!;
    const calm = liquidityStability([s(14000), s(14100), s(14050)])!;

    expect(drained).toBeCloseTo(0.4966, 3);
    expect(drained).toBeLessThan(calm / 1.5);
  });

  // --- unchanged guarantees -------------------------------------------------
  it('still reports genuine stability when nothing collapsed', () => {
    expect(liquidityStability([s(14000), s(14100), s(14050)])!).toBeGreaterThan(0.9);
  });

  it('still returns null below three measured samples', () => {
    expect(liquidityStability([s(14000), s(14100)])).toBeNull();
    expect(liquidityStability([s(14000), s(null), s(14100)])).toBeNull();
  });
});
