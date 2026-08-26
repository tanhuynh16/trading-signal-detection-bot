import { describe, expect, it } from 'vitest';
import {
  distribution,
  mean,
  median,
  pairMeasured,
  profitFactor,
  quantile,
  spearman,
  winRate,
} from './stats.js';

describe('quantiles and median', () => {
  it('takes the midpoint of an even-length sample', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it('takes the middle element of an odd-length sample', () => {
    expect(median([3, 1, 2])).toBe(2);
  });

  it('handles a single element', () => {
    expect(median([7])).toBe(7);
    expect(quantile([7], 0.9)).toBe(7);
  });

  it('is null on an empty sample rather than 0', () => {
    // 0 would be a return of zero percent — a measurement, not an absence.
    expect(median([])).toBeNull();
    expect(mean([])).toBeNull();
    expect(quantile([], 0.5)).toBeNull();
  });

  it('interpolates linearly, matching percentile_cont', () => {
    // So a hand-written SQL cross-check agrees with the report.
    expect(quantile([1, 2, 3, 4, 5], 0.25)).toBe(2);
    expect(quantile([1, 2, 3, 4], 0.25)).toBeCloseTo(1.75, 10);
  });

  it('does not mutate the caller sample', () => {
    const values = [3, 1, 2];
    median(values);
    expect(values).toEqual([3, 1, 2]);
  });
});

describe('distribution — the mean never travels alone', () => {
  it('reports the full shape of a skewed sample', () => {
    // The §22 case: one 40x drags the mean somewhere no outcome ever was.
    const returns = [-50, -20, -5, 2, 4000];
    const d = distribution(returns);

    expect(d.median).toBe(-5);
    expect(d.mean).toBeCloseTo(785.4, 1);
    expect(d.min).toBe(-50);
    expect(d.max).toBe(4000);
    // The median and the mean disagree by three orders of magnitude, which is
    // exactly why the report leads with the median.
    expect(Math.abs(d.mean! - d.median!)).toBeGreaterThan(700);
  });
});

describe('winRate — Wilson interval, because n is small', () => {
  it('counts strictly positive returns as wins', () => {
    // Flat is not a win.
    expect(winRate([1, 0, -1]).wins).toBe(1);
  });

  it('is null on an empty sample', () => {
    const w = winRate([]);
    expect(w.rate).toBeNull();
    expect(w.low).toBeNull();
  });

  it('does not collapse to certainty at 100%', () => {
    // A normal approximation gives a zero-width interval here, which reads as
    // "always wins" from three data points.
    const w = winRate([1, 2, 3]);
    expect(w.rate).toBe(1);
    expect(w.low).toBeLessThan(0.9);
    expect(w.high).toBe(1);
  });

  it('stays inside [0,1] at 0%', () => {
    const w = winRate([-1, -2, -3]);
    expect(w.rate).toBe(0);
    expect(w.low).toBe(0);
    expect(w.high).toBeGreaterThan(0);
  });

  it('narrows as the sample grows', () => {
    const small = winRate([1, -1, 1, -1]);
    const large = winRate(Array.from({ length: 400 }, (_, i) => (i % 2 === 0 ? 1 : -1)));
    const width = (w: ReturnType<typeof winRate>) => w.high! - w.low!;

    expect(small.rate).toBeCloseTo(large.rate!, 10);
    expect(width(large)).toBeLessThan(width(small));
  });

  it('matches a known Wilson value', () => {
    // p=0.5, n=10, z=1.96 -> approximately [0.2366, 0.7634].
    const w = winRate([1, 1, 1, 1, 1, -1, -1, -1, -1, -1]);
    expect(w.low).toBeCloseTo(0.2366, 3);
    expect(w.high).toBeCloseTo(0.7634, 3);
  });
});

describe('profitFactor', () => {
  it('divides gross profit by gross loss', () => {
    expect(profitFactor([10, 20, -10])).toBeCloseTo(3, 10);
  });

  it('reports infinity when nothing has lost yet', () => {
    // Reported as a word, never as a big number that reads like a great result.
    expect(profitFactor([5, 10])).toBe(Number.POSITIVE_INFINITY);
  });

  it('is 0 when everything lost', () => {
    expect(profitFactor([-5, -10])).toBe(0);
  });

  it('is null with no trades at all', () => {
    expect(profitFactor([])).toBeNull();
  });

  it('is null when every return is exactly flat', () => {
    // No profit and no loss is undefined, not infinite.
    expect(profitFactor([0, 0])).toBeNull();
  });
});

describe('spearman — ranks, because returns are skewed', () => {
  it('is +1 for a perfectly increasing relationship', () => {
    expect(spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1, 10);
  });

  it('is -1 for a perfectly decreasing relationship', () => {
    expect(spearman([1, 2, 3, 4], [40, 30, 20, 10])).toBeCloseTo(-1, 10);
  });

  it('is unmoved by a single extreme outlier', () => {
    // The reason for using ranks: a Pearson coefficient here would be dominated
    // by the 40x and could make an unrelated feature look predictive.
    const features = [1, 2, 3, 4, 5];
    const ranked = spearman(features, [10, 20, 30, 40, 50]);
    const withOutlier = spearman(features, [10, 20, 30, 40, 400000]);
    expect(withOutlier).toBeCloseTo(ranked!, 10);
  });

  it('averages tied ranks instead of ordering arbitrarily', () => {
    const value = spearman([1, 1, 2, 2], [1, 1, 2, 2]);
    expect(value).toBeCloseTo(1, 10);
  });

  it('is null when a variable never varies', () => {
    // Correlation with a constant is undefined, not zero.
    expect(spearman([5, 5, 5, 5], [1, 2, 3, 4])).toBeNull();
  });

  it('is null below three pairs', () => {
    expect(spearman([1, 2], [3, 4])).toBeNull();
  });

  it('is null on mismatched lengths', () => {
    expect(spearman([1, 2, 3], [1, 2])).toBeNull();
  });
});

describe('pairMeasured — an unmeasured feature is not a zero', () => {
  it('drops null features rather than scoring them 0', () => {
    // §15 carried into analysis: coercing null to 0 would invent a low score
    // for every token whose smart-money data was absent, then correlate the
    // invention against returns.
    const paired = pairMeasured([
      { feature: 10, outcome: 1 },
      { feature: null, outcome: 2 },
      { feature: 30, outcome: 3 },
    ]);

    expect(paired.xs).toEqual([10, 30]);
    expect(paired.ys).toEqual([1, 3]);
    expect(paired.measured).toBe(2);
    expect(paired.total).toBe(3);
  });

  it('reports zero measured when the feature was never available', () => {
    const paired = pairMeasured([
      { feature: null, outcome: 1 },
      { feature: null, outcome: 2 },
    ]);
    expect(paired.measured).toBe(0);
    expect(paired.total).toBe(2);
    expect(spearman(paired.xs, paired.ys)).toBeNull();
  });
});
