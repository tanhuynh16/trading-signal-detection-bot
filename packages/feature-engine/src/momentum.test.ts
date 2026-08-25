import { describe, expect, it } from 'vitest';
import {
  buySellRatio,
  tradeVelocity,
  uniqueBuyerGrowth,
  volumeAcceleration,
  type TradeWindow,
} from './momentum.js';

const window = (over: Partial<TradeWindow> = {}): TradeWindow => ({
  quoteVolumeRaw: 1000n,
  volumeUsd: 1000,
  buyCount: 10,
  sellCount: 5,
  uniqueBuyers: 8,
  durationMinutes: 5,
  ...over,
});

describe('volumeAcceleration (spec §15.2)', () => {
  it("reproduces the spec's worked example exactly", () => {
    // §15.2: "current 5m volume = $50k; previous windows = $10k, $12k, $8k;
    // average = $10k; acceleration = 5.0."
    expect(volumeAcceleration(50_000, [10_000, 12_000, 8_000])).toBe(5);
  });

  it('returns null with only two prior windows — not 1.0, not 0', () => {
    // A token ~10 minutes old has no basis for an acceleration figure. The
    // tempting defaults both assert something we have not measured.
    expect(volumeAcceleration(50_000, [10_000, 12_000])).toBeNull();
  });

  it('returns null with no prior windows at all', () => {
    expect(volumeAcceleration(50_000, [])).toBeNull();
  });

  it('ignores null prior windows when counting available history', () => {
    expect(volumeAcceleration(50_000, [10_000, null, 12_000])).toBeNull();
    expect(volumeAcceleration(50_000, [10_000, null, 12_000, 8_000])).toBe(5);
  });

  it('returns null when every prior window was empty', () => {
    // Zero baseline: the ratio is undefined, not infinite growth.
    expect(volumeAcceleration(50_000, [0, 0, 0])).toBeNull();
  });

  it('returns null when the current window is unmeasurable', () => {
    expect(volumeAcceleration(null, [10_000, 12_000, 8_000])).toBeNull();
  });

  it('reports deceleration below 1', () => {
    expect(volumeAcceleration(5_000, [10_000, 10_000, 10_000])).toBe(0.5);
  });

  it('uses only the three most recent prior windows', () => {
    // A fourth, much larger window must not drag the baseline.
    expect(volumeAcceleration(50_000, [10_000, 10_000, 10_000, 1_000_000])).toBe(5);
  });
});

describe('buySellRatio (spec §15.2)', () => {
  it('divides buys by sells', () => {
    expect(buySellRatio(window({ buyCount: 10, sellCount: 5 }))).toBe(2);
  });

  it("applies the spec's max(sells, 1) guard rather than dividing by zero", () => {
    expect(buySellRatio(window({ buyCount: 3, sellCount: 0 }))).toBe(3);
  });

  it('returns null for a window with no trades at all', () => {
    // No trading is not balanced trading.
    expect(buySellRatio(window({ buyCount: 0, sellCount: 0 }))).toBeNull();
  });

  it('reports sell pressure below 1', () => {
    expect(buySellRatio(window({ buyCount: 2, sellCount: 8 }))).toBe(0.25);
  });

  it('handles sells with no buys', () => {
    expect(buySellRatio(window({ buyCount: 0, sellCount: 4 }))).toBe(0);
  });
});

describe('tradeVelocity (spec §15.2)', () => {
  it('counts trades per minute across both sides', () => {
    expect(tradeVelocity(window({ buyCount: 10, sellCount: 5, durationMinutes: 5 }))).toBe(3);
  });

  it('returns null for a zero-length window rather than Infinity', () => {
    expect(tradeVelocity(window({ durationMinutes: 0 }))).toBeNull();
  });

  it('reports zero for a real window with no trades', () => {
    // Distinct from the null above: the window exists and was genuinely empty.
    expect(tradeVelocity(window({ buyCount: 0, sellCount: 0, durationMinutes: 5 }))).toBe(0);
  });
});

describe('uniqueBuyerGrowth (spec §15.2)', () => {
  it('expresses growth as a ratio of unique buyers', () => {
    expect(uniqueBuyerGrowth(window({ uniqueBuyers: 20 }), window({ uniqueBuyers: 10 }))).toBe(2);
  });

  it('returns null without a previous window', () => {
    expect(uniqueBuyerGrowth(window({ uniqueBuyers: 20 }), null)).toBeNull();
  });

  it('returns null when the previous window had no buyers', () => {
    // Growth from zero is undefined; reporting Infinity would top any scale.
    expect(uniqueBuyerGrowth(window({ uniqueBuyers: 20 }), window({ uniqueBuyers: 0 }))).toBeNull();
  });

  it('reports contraction below 1', () => {
    expect(uniqueBuyerGrowth(window({ uniqueBuyers: 5 }), window({ uniqueBuyers: 10 }))).toBe(0.5);
  });
});
