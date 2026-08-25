import { describe, expect, it } from 'vitest';
import { boundedRatio, logScale, minMax, normalize } from './normalize.js';

describe('minMax (spec §16)', () => {
  it('maps the range onto 0..100', () => {
    expect(minMax(0, { min: 0, max: 1 })).toBe(0);
    expect(minMax(0.5, { min: 0, max: 1 })).toBe(50);
    expect(minMax(1, { min: 0, max: 1 })).toBe(100);
  });

  it('clips rather than extrapolating beyond the range', () => {
    // 300% retention is a data error, not three times better than 100%.
    expect(minMax(3, { min: 0, max: 1 })).toBe(100);
    expect(minMax(-5, { min: 0, max: 1 })).toBe(0);
  });

  it('inverts when lower is better', () => {
    // top10_concentration: more concentrated is worse.
    expect(minMax(0.1, { min: 0.1, max: 0.8, direction: 'lower_is_better' })).toBe(100);
    expect(minMax(0.8, { min: 0.1, max: 0.8, direction: 'lower_is_better' })).toBe(0);
  });

  it('propagates null rather than defaulting', () => {
    expect(minMax(null, { min: 0, max: 1 })).toBeNull();
  });

  it('rejects non-finite input instead of emitting NaN', () => {
    expect(minMax(Number.NaN, { min: 0, max: 1 })).toBeNull();
    expect(minMax(Number.POSITIVE_INFINITY, { min: 0, max: 1 })).toBeNull();
  });

  it('returns null for a degenerate range rather than dividing by zero', () => {
    expect(minMax(5, { min: 1, max: 1 })).toBeNull();
  });
});

describe('logScale (spec §16)', () => {
  it('separates pools an order of magnitude apart', () => {
    // The whole point: on a linear $1k-$1M scale, $10k and $100k both land in
    // the bottom tenth — which is where every new pool lives.
    const ten = logScale(10_000, { min: 1_000, max: 1_000_000 })!;
    const hundred = logScale(100_000, { min: 1_000, max: 1_000_000 })!;
    expect(hundred - ten).toBeGreaterThan(30);

    const linearTen = minMax(10_000, { min: 1_000, max: 1_000_000 })!;
    const linearHundred = minMax(100_000, { min: 1_000, max: 1_000_000 })!;
    expect(linearHundred - linearTen).toBeLessThan(11);
  });

  it('places the geometric midpoint near 50', () => {
    expect(logScale(31_623, { min: 1_000, max: 1_000_000 })!).toBeCloseTo(50, 0);
  });

  it('floors at the minimum instead of returning -Infinity', () => {
    expect(logScale(0, { min: 1_000, max: 1_000_000 })).toBe(0);
    expect(logScale(-100, { min: 1_000, max: 1_000_000 })).toBe(0);
  });

  it('clips above the maximum', () => {
    expect(logScale(10_000_000, { min: 1_000, max: 1_000_000 })).toBe(100);
  });

  it('inverts when lower is better', () => {
    const low = logScale(1, { min: 1, max: 100, direction: 'lower_is_better' })!;
    const high = logScale(100, { min: 1, max: 100, direction: 'lower_is_better' })!;
    expect(low).toBe(100);
    expect(high).toBe(0);
  });

  it('propagates null', () => {
    expect(logScale(null, { min: 1, max: 100 })).toBeNull();
  });
});

describe('boundedRatio (spec §16)', () => {
  it('scores the neutral ratio at the neutral score', () => {
    // 1.0 means "no change" — a meaningful centre, not an arbitrary point.
    expect(boundedRatio(1, { neutral: 1, saturate: 5 })).toBe(50);
  });

  it('saturates at 100', () => {
    expect(boundedRatio(5, { neutral: 1, saturate: 5 })).toBe(100);
    expect(boundedRatio(50, { neutral: 1, saturate: 5 })).toBe(100);
  });

  it('scales proportionally below neutral', () => {
    expect(boundedRatio(0.5, { neutral: 1, saturate: 5 })).toBe(25);
    expect(boundedRatio(0, { neutral: 1, saturate: 5 })).toBe(0);
  });

  it('puts §19 thresholds in the informative part of the curve', () => {
    // minVolumeAcceleration 3.0 and minBuySellRatio 1.2 must not sit at an
    // extreme, or the threshold carries no discriminating power.
    const accel = boundedRatio(3, { neutral: 1, saturate: 5 })!;
    expect(accel).toBeGreaterThan(60);
    expect(accel).toBeLessThan(95);

    const ratio = boundedRatio(1.2, { neutral: 1, saturate: 3 })!;
    expect(ratio).toBeGreaterThan(50);
    expect(ratio).toBeLessThan(70);
  });

  it('rejects negative ratios and null', () => {
    expect(boundedRatio(-1, { neutral: 1, saturate: 5 })).toBeNull();
    expect(boundedRatio(null, { neutral: 1, saturate: 5 })).toBeNull();
  });

  it('returns null for an inverted configuration', () => {
    expect(boundedRatio(2, { neutral: 5, saturate: 1 })).toBeNull();
  });
});

describe('normalize dispatch', () => {
  it('routes to each normalizer by kind', () => {
    expect(normalize(0.5, { kind: 'minMax', min: 0, max: 1 })).toBe(50);
    expect(normalize(1, { kind: 'boundedRatio', neutral: 1, saturate: 5 })).toBe(50);
    expect(normalize(1_000, { kind: 'log', min: 1_000, max: 1_000_000 })).toBe(0);
  });

  it('never emits a value outside 0..100', () => {
    const specs = [
      { kind: 'minMax', min: 0, max: 1 },
      { kind: 'log', min: 1, max: 100 },
      { kind: 'boundedRatio', neutral: 1, saturate: 3 },
    ] as const;
    for (const spec of specs) {
      for (const v of [-1e9, 0, 0.001, 1, 1e9]) {
        const out = normalize(v, spec);
        if (out !== null) {
          expect(out).toBeGreaterThanOrEqual(0);
          expect(out).toBeLessThanOrEqual(100);
        }
      }
    }
  });
});
