import { describe, expect, it } from 'vitest';
import {
  independentSmartWalletCount,
  smartWalletEntryRecency,
  smartWalletQuality,
  walletAlphaScore,
  WALLET_ALPHA_WEIGHTS,
  type WalletPerformance,
} from './smart-money.js';

const w = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const at = (min: number) => new Date(Date.UTC(2026, 7, 24, 12, min, 0));

const perf = (over: Partial<WalletPerformance> = {}): WalletPerformance => ({
  historicalRoiScore: 0,
  winRateScore: 0,
  consistencyScore: 0,
  earlyEntryAccuracyScore: 0,
  recentPerformanceScore: 0,
  ...over,
});

describe('walletAlphaScore (spec §15.5)', () => {
  it('uses the exact weights the spec lists', () => {
    expect(WALLET_ALPHA_WEIGHTS).toEqual({
      historicalRoiScore: 0.2,
      winRateScore: 0.15,
      consistencyScore: 0.2,
      earlyEntryAccuracyScore: 0.25,
      recentPerformanceScore: 0.2,
    });
  });

  it('has weights summing to exactly 1', () => {
    const sum = Object.values(WALLET_ALPHA_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 10);
  });

  it('scores an all-zero wallet 0', () => {
    expect(walletAlphaScore(perf())).toBe(0);
  });

  it('scores a perfect wallet 100', () => {
    expect(
      walletAlphaScore(
        perf({
          historicalRoiScore: 100,
          winRateScore: 100,
          consistencyScore: 100,
          earlyEntryAccuracyScore: 100,
          recentPerformanceScore: 100,
        }),
      ),
    ).toBeCloseTo(100, 9);
  });

  it('weights early-entry accuracy most heavily, as the spec does', () => {
    const early = walletAlphaScore(perf({ earlyEntryAccuracyScore: 100 }));
    const winRate = walletAlphaScore(perf({ winRateScore: 100 }));
    expect(early).toBeGreaterThan(winRate);
    expect(early).toBeCloseTo(25, 9);
    expect(winRate).toBeCloseTo(15, 9);
  });

  it('clamps out-of-range component scores rather than exceeding 100', () => {
    expect(walletAlphaScore(perf({ historicalRoiScore: 100_000 }))).toBeCloseTo(20, 9);
  });

  it('treats a non-finite component as zero rather than producing NaN', () => {
    expect(walletAlphaScore(perf({ winRateScore: Number.POSITIVE_INFINITY }))).toBe(0);
  });
});

describe('smart-money features with an empty seed list (spec §15.5)', () => {
  /**
   * The list ships empty, so every feature must report null. Plan G1's coverage
   * renormalisation then divides alpha by the weight actually present. Scoring
   * these 0 instead would cap every token near 70 and make STRONG_SIGNAL
   * unreachable — the exact failure G1 was designed to prevent.
   */
  it('reports independent wallet count as null, not 0', () => {
    expect(independentSmartWalletCount([], [], 0)).toBeNull();
  });

  it('reports entry recency as null', () => {
    expect(smartWalletEntryRecency([], at(10), 0)).toBeNull();
  });

  it('reports quality as null', () => {
    expect(smartWalletQuality([], new Map(), 0)).toBeNull();
  });
});

describe('smart-money features with a seeded list', () => {
  it('reports 0 independent wallets when none entered — a real measurement', () => {
    // Distinct from null above: we have a list and observed no entries.
    expect(independentSmartWalletCount([], [], 5)).toBe(0);
  });

  it('counts independent entrants after clustering', () => {
    const entries = [{ wallet: w(1), enteredAt: at(0) }, { wallet: w(2), enteredAt: at(1) }];
    const clusters = [{ key: 'funder:x', wallets: [w(1), w(2)], evidence: [] }];
    expect(independentSmartWalletCount(entries, clusters, 5)).toBe(1);
  });

  it('measures recency from the most recent entry', () => {
    const entries = [{ wallet: w(1), enteredAt: at(0) }, { wallet: w(2), enteredAt: at(7) }];
    expect(smartWalletEntryRecency(entries, at(10), 5)).toBe(3);
  });

  it('averages the alpha scores of entrants', () => {
    const entries = [{ wallet: w(1), enteredAt: at(0) }, { wallet: w(2), enteredAt: at(0) }];
    const scores = new Map([[w(1), 80], [w(2), 60]]);
    expect(smartWalletQuality(entries, scores, 5)).toBe(70);
  });

  it('ignores unscored wallets rather than counting them as zero', () => {
    // An unscored wallet is missing data; scoring it 0 would penalise the token
    // for our own gap.
    const entries = [{ wallet: w(1), enteredAt: at(0) }, { wallet: w(2), enteredAt: at(0) }];
    const scores = new Map<string, number | null>([[w(1), 80], [w(2), null]]);
    expect(smartWalletQuality(entries, scores, 5)).toBe(80);
  });

  it('returns null quality when no entrant has a score yet', () => {
    const entries = [{ wallet: w(1), enteredAt: at(0) }];
    expect(smartWalletQuality(entries, new Map(), 5)).toBeNull();
  });
});
