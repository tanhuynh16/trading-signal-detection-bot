import { describe, expect, it } from 'vitest';
import { renderBands, renderExclusions, renderFeatures, renderHeader } from './report.js';
import type { CellStats, FeatureStats } from './aggregate.js';

const cell = (over: Partial<CellStats> = {}): CellStats => ({
  band: 'WATCHING',
  horizon: '5m',
  n: 40,
  tokens: 40,
  measured: 40,
  excluded: {},
  sufficient: true,
  winRate: { wins: 28, n: 40, rate: 0.7, low: 0.55, high: 0.82 },
  returns: {
    n: 40, min: -30, p10: -22, p25: -10, median: 16, p75: 30, p90: 35, max: 940, mean: 37,
  },
  medianRunup: 16,
  medianDrawdown: -4,
  profitFactor: 6.36,
  ...over,
});

describe('renderBands — INSUFFICIENT replaces the numbers', () => {
  it('omits every metric for a cell below the threshold', () => {
    // The whole discipline: a number beside a caveat is still read as a number.
    const out = renderBands([cell({ sufficient: false, n: 5, measured: 5 })]);

    expect(out).toContain('INSUFFICIENT');
    expect(out).not.toContain('70%');
    expect(out).not.toContain('6.36');
    expect(out).not.toContain('+16.0%');
  });

  it('shows the median before the mean for a sufficient cell', () => {
    // §22 asks for average return, but skew means it must never lead.
    const out = renderBands([cell()]);
    expect(out.indexOf('median')).toBeLessThan(out.indexOf('mean'));
    expect(out).toContain('+16.0%');
    expect(out).toContain('+37.0%');
  });

  it('always reports the spread alongside the mean', () => {
    const out = renderBands([cell()]);
    expect(out).toContain('-22.0% / +35.0%');
  });

  it('reports distinct tokens beside the outcome count', () => {
    // Three outcomes from one token are one token's worth of evidence.
    const out = renderBands([cell({ n: 9, tokens: 3 })]);
    expect(out).toContain('9 (3 tok)');
  });

  it('says "no losses yet" rather than printing a huge number', () => {
    const out = renderBands([cell({ profitFactor: Number.POSITIVE_INFINITY })]);
    expect(out).toContain('∞ (no losses yet)');
    expect(out).not.toContain('Infinity');
  });

  it('says n/a when there were no trades to evaluate', () => {
    expect(renderBands([cell({ profitFactor: null })])).toContain('n/a');
  });
});

describe('renderFeatures', () => {
  const feature = (over: Partial<FeatureStats> = {}): FeatureStats => ({
    feature: 'smartMoney',
    horizon: '5m',
    measured: 0,
    total: 40,
    sufficient: false,
    correlation: null,
    ...over,
  });

  it('reports an unmeasured feature as insufficient, not as zero correlation', () => {
    // A component we never measured has no correlation; printing 0.00 would
    // claim we looked and found nothing.
    const out = renderFeatures([feature()]);
    expect(out).toContain('0/40');
    expect(out).toContain('INSUFFICIENT');
    expect(out).not.toContain('0.00');
  });

  it('distinguishes "no variation" from insufficient data', () => {
    const out = renderFeatures([
      feature({ measured: 40, sufficient: true, correlation: null }),
    ]);
    expect(out).toContain('no variation');
  });
});

describe('renderExclusions', () => {
  it('counts unmeasurable outcomes by reason instead of hiding them', () => {
    const out = renderExclusions([
      cell({ excluded: { incomplete_tail_coverage: 2, no_signal_price: 1 } }),
      cell({ excluded: { incomplete_tail_coverage: 3 } }),
    ]);
    expect(out).toContain('incomplete_tail_coverage');
    expect(out).toContain('5');
    expect(out).toContain('no_signal_price');
  });

  it('says so plainly when nothing was excluded', () => {
    expect(renderExclusions([cell()])).toContain('every outcome in the sample was measurable');
  });
});

describe('renderHeader', () => {
  it('restates the profit-factor assumption and the no-trading stance every run', () => {
    // So the figure can never travel without the convention that produced it.
    const out = renderHeader({
      strategyVersion: 'base-meme-v1',
      minSampleSize: 30,
      totalOutcomes: 41,
      generatedAt: new Date('2026-08-26T10:00:00Z'),
    });

    expect(out).toContain('notional entry at the frozen signal price');
    expect(out).toContain('does not trade');
    expect(out).toContain('base-meme-v1');
    expect(out).toContain('30');
  });
});
