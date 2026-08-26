import { describe, expect, it } from 'vitest';
import { bandFor, scoreBands } from './bands.js';
import { byBandAndHorizon, byCoverage, featureContribution } from './aggregate.js';
import type { OutcomeSample } from './query.js';

const thresholds = { interestingThreshold: 60, strongThreshold: 75 };
const bands = scoreBands(thresholds);
const config = { minSampleSize: 3 };

let seq = 0;
const sample = (over: Partial<OutcomeSample> = {}): OutcomeSample => {
  seq += 1;
  return {
    signalId: `sig-${seq}`,
    tokenId: `tok-${seq}`,
    strategyVersion: 'base-meme-v1',
    alphaScore: 50,
    coverage: 0.9,
    horizon: '1m',
    returnPct: 10,
    maxRunupPct: 12,
    maxDrawdownPct: -3,
    tradeCount: 4,
    failureReason: null,
    components: { liquidity: 50, momentum: 50 },
    createdAt: new Date(),
    ...over,
  };
};

describe('score bands follow configuration, not constants', () => {
  it('places a score in the band the §17 table specifies', () => {
    expect(bandFor(0, bands)?.label).toBe('IGNORE');
    expect(bandFor(39.9, bands)?.label).toBe('IGNORE');
    expect(bandFor(40, bands)?.label).toBe('WATCHING');
    expect(bandFor(59.9, bands)?.label).toBe('WATCHING');
    expect(bandFor(60, bands)?.label).toBe('INTERESTING');
    expect(bandFor(74.9, bands)?.label).toBe('INTERESTING');
    expect(bandFor(75, bands)?.label).toBe('STRONG');
    expect(bandFor(89.9, bands)?.label).toBe('STRONG');
    expect(bandFor(90, bands)?.label).toBe('HIGH_CONVICTION');
    expect(bandFor(100, bands)?.label).toBe('HIGH_CONVICTION');
  });

  it('moves the boundaries when the configured thresholds move', () => {
    // The point of reading them from config: a threshold change reshapes the
    // bands and mints a new strategyVersion, rather than the report silently
    // reporting against stale boundaries.
    const shifted = scoreBands({ interestingThreshold: 50, strongThreshold: 65 });
    expect(bandFor(55, shifted)?.label).toBe('INTERESTING');
    expect(bandFor(55, bands)?.label).toBe('WATCHING');
  });
});

describe('byBandAndHorizon', () => {
  it('refuses to report a cell below the sample threshold', () => {
    // The core discipline: not a caveat next to a number, but no number.
    const cells = byBandAndHorizon(
      [sample({ returnPct: 50 }), sample({ returnPct: 60 })],
      bands,
      ['1m'],
      config,
    );
    expect(cells).toHaveLength(1);
    expect(cells[0]!.sufficient).toBe(false);
    expect(cells[0]!.measured).toBe(2);
  });

  it('reports a cell once it has enough measured outcomes', () => {
    const cells = byBandAndHorizon(
      [sample({ returnPct: 10 }), sample({ returnPct: -5 }), sample({ returnPct: 20 })],
      bands,
      ['1m'],
      config,
    );
    expect(cells[0]!.sufficient).toBe(true);
    expect(cells[0]!.winRate.wins).toBe(2);
    expect(cells[0]!.returns.median).toBe(10);
  });

  it('counts distinct tokens separately from outcomes', () => {
    // Three outcomes from one token are one token's worth of evidence, and the
    // report has to be able to say so.
    const cells = byBandAndHorizon(
      [
        sample({ tokenId: 'same' }),
        sample({ tokenId: 'same' }),
        sample({ tokenId: 'same' }),
      ],
      bands,
      ['1m'],
      config,
    );
    expect(cells[0]!.n).toBe(3);
    expect(cells[0]!.tokens).toBe(1);
  });

  it('excludes unmeasurable outcomes from metrics but counts why', () => {
    const cells = byBandAndHorizon(
      [
        sample({ returnPct: 10 }),
        sample({ returnPct: null, failureReason: 'no_signal_price' }),
        sample({ returnPct: null, failureReason: 'incomplete_tail_coverage' }),
      ],
      bands,
      ['1m'],
      config,
    );

    expect(cells[0]!.n).toBe(3);
    expect(cells[0]!.measured).toBe(1);
    expect(cells[0]!.sufficient).toBe(false);
    expect(cells[0]!.excluded).toEqual({
      no_signal_price: 1,
      incomplete_tail_coverage: 1,
    });
  });

  it('separates bands and horizons rather than pooling them', () => {
    const cells = byBandAndHorizon(
      [
        sample({ alphaScore: 50, horizon: '1m' }),
        sample({ alphaScore: 80, horizon: '1m' }),
        sample({ alphaScore: 50, horizon: '5m' }),
      ],
      bands,
      ['1m', '5m'],
      config,
    );

    const labels = cells.map((c) => `${c.band}/${c.horizon}`).sort();
    expect(labels).toEqual(['STRONG/1m', 'WATCHING/1m', 'WATCHING/5m']);
  });

  it('omits bands that never occurred instead of printing empty rows', () => {
    const cells = byBandAndHorizon([sample({ alphaScore: 50 })], bands, ['1m'], config);
    expect(cells).toHaveLength(1);
    expect(cells[0]!.band).toBe('WATCHING');
  });
});

describe('featureContribution', () => {
  it('correlates each component against return, per horizon', () => {
    const samples = [10, 20, 30, 40].map((score, i) =>
      sample({ components: { liquidity: score }, returnPct: score * 2, tokenId: `t${i}` }),
    );
    const features = featureContribution(samples, ['1m'], { minSampleSize: 3 });

    expect(features).toHaveLength(1);
    expect(features[0]!.feature).toBe('liquidity');
    expect(features[0]!.correlation).toBeCloseTo(1, 10);
    expect(features[0]!.sufficient).toBe(true);
  });

  it('drops unmeasured components rather than scoring them zero', () => {
    const samples = [
      sample({ components: { smartMoney: null }, returnPct: 5 }),
      sample({ components: { smartMoney: null }, returnPct: 50 }),
      sample({ components: { smartMoney: 80 }, returnPct: 10 }),
    ];
    const features = featureContribution(samples, ['1m'], { minSampleSize: 3 });

    expect(features[0]!.measured).toBe(1);
    expect(features[0]!.total).toBe(3);
    expect(features[0]!.sufficient).toBe(false);
    expect(features[0]!.correlation).toBeNull();
  });

  it('ignores outcomes that could not be measured', () => {
    const samples = [
      sample({ components: { liquidity: 10 }, returnPct: null }),
      sample({ components: { liquidity: 20 }, returnPct: 5 }),
    ];
    const features = featureContribution(samples, ['1m'], { minSampleSize: 1 });
    expect(features[0]!.total).toBe(1);
  });
});

describe('byCoverage — the combination question the data can answer', () => {
  it('buckets outcomes by how much evidence the score was built on', () => {
    const samples = [
      sample({ coverage: 0.3, returnPct: 1 }),
      sample({ coverage: 0.6, returnPct: 2 }),
      sample({ coverage: 0.95, returnPct: 3 }),
    ];
    const rows = byCoverage(samples, '1m', { minSampleSize: 1 });

    expect(rows.map((r) => r.band)).toEqual([
      'coverage <0.5',
      'coverage 0.5-0.8',
      'coverage >=0.8',
    ]);
    expect(rows.every((r) => r.n === 1)).toBe(true);
  });
});
