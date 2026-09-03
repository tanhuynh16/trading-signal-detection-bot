import { describe, expect, it } from 'vitest';
import type { FeatureSet } from '@sdb/domain';
import { DEFAULT_COMPONENTS, DEFAULT_PENALTIES } from './feature-map.js';
import { calculateAlphaScore, hasSufficientCoverage, scoreComponent, scorePenalties } from './score.js';

const config = {
  weights: { liquidity: 0.2, momentum: 0.3, holder: 0.2, smartMoney: 0.3 },
  nullPolicy: 'renormalize' as const,
  minCoverage: 0.6,
  strategyVersion: 'base-meme-v1',
};

const allNull: FeatureSet = Object.fromEntries(
  [...DEFAULT_COMPONENTS.flatMap((c) => c.features.map((f) => f.feature)),
   ...DEFAULT_PENALTIES.map((p) => p.feature)].map((k) => [k, null]),
);

const momentum = DEFAULT_COMPONENTS.find((c) => c.name === 'momentum')!;

describe('scoreComponent — inner renormalisation (plan G1, inner level)', () => {
  it('reports the single available feature, not a quarter of it', () => {
    // volume_acceleration_5m is null for the first ~20 minutes of EVERY token,
    // so a partially-populated momentum component is the common case. Diluting
    // by implicit zeros would make momentum read weak exactly when newest.
    const features = { ...allNull, buy_sell_ratio: 3 }; // saturates at 100
    const score = scoreComponent(features, momentum, 'renormalize')!;
    expect(score).toBe(100);
  });

  it('would have been diluted to a quarter under the zero policy', () => {
    const features = { ...allNull, buy_sell_ratio: 3 };
    const zeroed = scoreComponent(features, momentum, 'zero')!;
    // 100 * 0.3 (its weight) = 30, versus 100 when renormalised.
    expect(zeroed).toBeCloseTo(30, 5);
    expect(zeroed).toBeLessThan(scoreComponent(features, momentum, 'renormalize')!);
  });

  it('returns null when every feature is null, not 0', () => {
    expect(scoreComponent(allNull, momentum, 'renormalize')).toBeNull();
  });

  it('weights features relative to each other when several are present', () => {
    const features = { ...allNull, volume_acceleration_5m: 5, buy_sell_ratio: 0 };
    // acceleration 100 at weight .4, ratio 0 at weight .3 -> 100*.4/.7
    expect(scoreComponent(features, momentum, 'renormalize')!).toBeCloseTo(57.14, 1);
  });

  it('applies a neutral score under the neutral policy', () => {
    const score = scoreComponent({ ...allNull, buy_sell_ratio: 1 }, momentum, 'neutral')!;
    // toBeCloseTo, not toBe: summing float weights accumulates ~1e-14.
    expect(score).toBeCloseTo(50, 9);
  });
});

describe('calculateAlphaScore — outer renormalisation (plan G1)', () => {
  it('does NOT cap the score when smart money is unavailable', () => {
    // This is the whole reason G1 exists. With an empty seed list the 0.30
    // smartMoney weight is null; scoring it 0 would cap alpha at 70 and make
    // strongThreshold (75) unreachable for every token, forever.
    const strong: FeatureSet = {
      ...allNull,
      liquidity_usd: 1_000_000,
      liquidity_stability: 1,
      buy_sell_ratio: 5,
      volume_acceleration_5m: 10,
      trade_velocity: 50,
      holder_count: 2_000,
      holder_growth_rate: 20,
      holder_retention: 1,
      top10_concentration: 0.1,
    };
    const score = calculateAlphaScore(strong, config);
    expect(score.components.find((c) => c.name === 'smartMoney')!.raw).toBeNull();
    expect(score.coverage).toBeCloseTo(0.7, 5);
    expect(score.score).toBeGreaterThan(75);
  });

  it('reports coverage of exactly 0.70 with an empty seed list', () => {
    // Asserted so a future weight change cannot silently push coverage below
    // minCoverage and make STRONG unreachable again.
    const score = calculateAlphaScore(
      { ...allNull, liquidity_usd: 50_000, buy_sell_ratio: 2, holder_count: 100 },
      config,
    );
    expect(score.coverage).toBeCloseTo(0.7, 5);
    expect(score.coverage).toBeGreaterThan(config.minCoverage);
  });

  it('scores 0 with no measurable features at all', () => {
    const score = calculateAlphaScore(allNull, config);
    expect(score.score).toBe(0);
    expect(score.coverage).toBe(0);
    expect(score.components.every((c) => c.raw === null)).toBe(true);
  });

  it('always includes the full component breakdown (spec §27)', () => {
    const score = calculateAlphaScore(allNull, config);
    expect(score.components.map((c) => c.name)).toEqual([
      'liquidity',
      'momentum',
      'holder',
      'smartMoney',
    ]);
    for (const c of score.components) expect(c.weight).toBeGreaterThan(0);
  });

  it('stamps the strategy version onto every score (spec §22)', () => {
    expect(calculateAlphaScore(allNull, config).strategyVersion).toBe('base-meme-v1');
  });

  it('is deterministic — identical inputs give identical output (spec §27)', () => {
    const features = { ...allNull, liquidity_usd: 42_000, buy_sell_ratio: 1.7 };
    expect(calculateAlphaScore(features, config)).toEqual(
      calculateAlphaScore(features, config),
    );
  });

  it('never leaves 0..100 even with absurd inputs', () => {
    const wild = { ...allNull, liquidity_usd: 1e18, buy_sell_ratio: 1e9, holder_count: 1e12 };
    const score = calculateAlphaScore(wild, config).score;
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });
});

describe('penalties (spec §17)', () => {
  it('subtracts for a concentrated cluster', () => {
    const base = { ...allNull, liquidity_usd: 500_000, buy_sell_ratio: 3, holder_count: 500 };
    const clean = calculateAlphaScore(base, config).score;
    const clustered = calculateAlphaScore({ ...base, cluster_concentration: 0.6 }, config);
    expect(clustered.penalties).toBeGreaterThan(0);
    expect(clustered.score).toBeLessThan(clean);
  });

  it('applies no penalty when no cluster was detected', () => {
    // Absence of evidence is not evidence — a null must not be read as clean
    // OR as guilty.
    expect(scorePenalties(allNull, DEFAULT_PENALTIES)).toBe(0);
  });

  it('scales the penalty with severity', () => {
    const light = scorePenalties({ ...allNull, cluster_concentration: 0.2 }, DEFAULT_PENALTIES);
    const heavy = scorePenalties({ ...allNull, cluster_concentration: 0.6 }, DEFAULT_PENALTIES);
    expect(heavy).toBeGreaterThan(light);
  });

  it('cannot push the score below zero', () => {
    const score = calculateAlphaScore({ ...allNull, cluster_concentration: 1 }, config);
    expect(score.score).toBeGreaterThanOrEqual(0);
  });
});

describe('hasSufficientCoverage', () => {
  it('accepts coverage at or above the floor', () => {
    const score = calculateAlphaScore({ ...allNull, liquidity_usd: 1, buy_sell_ratio: 1, holder_count: 1 }, config);
    expect(hasSufficientCoverage(score, config)).toBe(true);
  });

  it('rejects a score built on one component alone', () => {
    // 95 on a quarter of the picture is not high conviction.
    const score = calculateAlphaScore({ ...allNull, liquidity_usd: 1_000_000 }, config);
    expect(score.coverage).toBeCloseTo(0.2, 5);
    expect(hasSufficientCoverage(score, config)).toBe(false);
  });
});

describe('the cost of seeding smart money (§15.5 + plan G1)', () => {
  /**
   * Seeding a wallet list does not just add information — it converts the
   * smartMoney component from "unmeasured" to "measured 0" for every pool none
   * of the seeded wallets bought. `independentSmartWalletCount` returns null
   * only when the seed list is EMPTY, so with seeds present and no entries it
   * reports a real 0, which normalises to 0 rather than dropping out.
   *
   * The consequence is a fixed multiplier on every such score:
   *
   *     score_after = score_before * coverage_before / (coverage_before + 0.30)
   *
   * Asserted here so the trade-off is discoverable in code. Replayed against
   * 1,242 signals recorded under base-meme-v1 it moved the best score from
   * 74.345 to 46.466 and took the count clearing interestingThreshold from 5
   * to 0 — which is why base-meme-v2 exists but is not the default.
   */
  const promising: FeatureSet = {
    ...allNull,
    liquidity_usd: 500_000,
    liquidity_stability: 0.9,
    buy_sell_ratio: 3,
    trade_velocity: 30,
    holder_count: 800,
    holder_growth_rate: 12,
    holder_retention: 0.8,
    top10_concentration: 0.2,
  };

  it('applies cov/(cov+0.30) when an untouched pool starts reporting a zero', () => {
    const unseeded = calculateAlphaScore(promising, config);
    const seededNoEntries = calculateAlphaScore(
      { ...promising, independent_smart_wallet_count: 0 },
      config,
    );

    expect(unseeded.components.find((c) => c.name === 'smartMoney')!.raw).toBeNull();
    expect(seededNoEntries.components.find((c) => c.name === 'smartMoney')!.raw).toBe(0);

    expect(unseeded.coverage).toBeCloseTo(0.7, 5);
    expect(seededNoEntries.coverage).toBeCloseTo(1.0, 5);

    const expected = unseeded.score * (0.7 / (0.7 + 0.3));
    expect(seededNoEntries.score).toBeCloseTo(expected, 6);
    expect(seededNoEntries.score).toBeLessThan(unseeded.score);
  });

  it('does not let one seeded entrant recover the original score', () => {
    // A single wallet entering 5 minutes ago scores the component ~40, well
    // under the ~74 it is being averaged against. It takes roughly 4+
    // independent entrants before a touched pool beats its unseeded score.
    const oneEntrant = calculateAlphaScore(
      {
        ...promising,
        independent_smart_wallet_count: 1,
        smart_wallet_entry_recency: 5,
      },
      config,
    );
    const unseeded = calculateAlphaScore(promising, config);
    expect(oneEntrant.score).toBeLessThan(unseeded.score);
  });

  it('raises evidence coverage, which is the one unambiguous gain', () => {
    // 163 of the 1,242 recorded signals sat at coverage 0.50 and were capped at
    // INTERESTING by minCoverage. A measured smartMoney lifts them to 0.80.
    const thin: FeatureSet = { ...allNull, buy_sell_ratio: 3, holder_count: 800 };
    const before = calculateAlphaScore(thin, config);
    const after = calculateAlphaScore({ ...thin, independent_smart_wallet_count: 0 }, config);
    expect(hasSufficientCoverage(before, config)).toBe(false);
    expect(hasSufficientCoverage(after, config)).toBe(true);
  });
});
