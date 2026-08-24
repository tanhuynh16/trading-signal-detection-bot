import { describe, expect, it } from 'vitest';
import {
  holderCount,
  holderGrowthRate,
  holderRetention,
  top10Concentration,
  type HolderBalance,
  type HolderOptions,
} from './holders.js';

const LP = '0xcccccccccccccccccccccccccccccccccccccccc';
const at = (min: number) => new Date(Date.UTC(2026, 7, 24, 12, min, 0));
const h = (wallet: string, balance: bigint, min = 0): HolderBalance => ({
  wallet,
  balanceRaw: balance,
  firstAcquiredAt: at(min),
});
const opts = (over: Partial<HolderOptions> = {}): HolderOptions => ({
  dustThresholdRaw: 1000n,
  excludedAddresses: new Set(),
  ...over,
});
const w = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;

describe('holderCount (spec §15.3)', () => {
  it('counts non-dust holders', () => {
    expect(holderCount([h(w(1), 5000n), h(w(2), 9999n)], opts())).toBe(2);
  });

  it('excludes dust balances below the configured threshold', () => {
    expect(holderCount([h(w(1), 5000n), h(w(2), 10n)], opts())).toBe(1);
  });

  it('excludes configured LP and burn addresses', () => {
    const options = opts({ excludedAddresses: new Set([LP]) });
    expect(holderCount([h(w(1), 5000n), h(LP, 10n ** 30n)], options)).toBe(1);
  });

  it('excludes a wallet that has sold down to zero', () => {
    expect(holderCount([h(w(1), 5000n), h(w(2), 0n)], opts())).toBe(1);
  });
});

describe('holderGrowthRate (spec §15.3)', () => {
  it('computes holders gained per minute', () => {
    expect(holderGrowthRate(210, 10, 5)).toBe(40);
  });

  it('reports a decline as negative', () => {
    expect(holderGrowthRate(10, 60, 5)).toBe(-10);
  });

  it('returns null without a previous observation, not 0', () => {
    // The first calculation has no rate. Reporting 0 would claim the holder
    // base is flat when we simply have not watched it yet.
    expect(holderGrowthRate(100, null, 5)).toBeNull();
  });

  it('returns null over a zero interval rather than Infinity', () => {
    expect(holderGrowthRate(100, 10, 0)).toBeNull();
  });
});

describe('top10Concentration (spec §15.3)', () => {
  const supply = 1_000_000n;

  it('sums the ten largest balances as a fraction of supply', () => {
    const balances = [h(w(1), 400_000n), h(w(2), 100_000n)];
    expect(top10Concentration(balances, supply, opts())!).toBeCloseTo(0.5, 6);
  });

  it('takes only the top ten of a longer holder list', () => {
    const balances = Array.from({ length: 20 }, (_, i) => h(w(i + 1), 10_000n));
    // 10 x 10,000 = 100,000 of 1,000,000
    expect(top10Concentration(balances, supply, opts())!).toBeCloseTo(0.1, 6);
  });

  it('changes materially once the LP address is excluded', () => {
    // Without exclusion the pool is the largest holder of every new token and
    // concentration reads ~100% for all of them — the metric carries no
    // information at all. §15.3 requires the adjustment for exactly this.
    const balances = [h(LP, 900_000n), h(w(1), 50_000n)];
    const included = top10Concentration(balances, supply, opts())!;
    const excluded = top10Concentration(
      balances,
      supply,
      opts({ excludedAddresses: new Set([LP]) }),
    )!;
    expect(included).toBeCloseTo(0.95, 4);
    expect(excluded).toBeCloseTo(0.05, 4);
  });

  it('returns null when total supply is unknown', () => {
    expect(top10Concentration([h(w(1), 1n)], null, opts())).toBeNull();
    expect(top10Concentration([h(w(1), 1n)], 0n, opts())).toBeNull();
  });

  it('returns null when no eligible holders remain', () => {
    expect(top10Concentration([h(w(1), 1n)], supply, opts())).toBeNull();
  });

  it('does not truncate a small fraction to zero', () => {
    // Integer division without scaling would floor this to 0.
    const value = top10Concentration([h(w(1), 5_000n)], 10_000_000n, opts())!;
    expect(value).toBeGreaterThan(0);
    expect(value).toBeCloseTo(0.0005, 6);
  });

  it('survives a uint256-scale supply without float loss', () => {
    const huge = 10n ** 30n;
    const value = top10Concentration([h(w(1), huge / 4n)], huge, opts())!;
    expect(value).toBeCloseTo(0.25, 6);
  });
});

describe('holderRetention (spec §15.3)', () => {
  it('measures the cohort still holding after the horizon', () => {
    const balances = [h(w(1), 5000n, 0), h(w(2), 5000n, 0), h(w(3), 0n, 0), h(w(4), 0n, 0)];
    expect(holderRetention(balances, { cohortBefore: at(5), options: opts() })).toBe(0.5);
  });

  it('ignores wallets that joined after the cohort window', () => {
    const balances = [h(w(1), 5000n, 0), h(w(2), 5000n, 30)];
    expect(holderRetention(balances, { cohortBefore: at(5), options: opts() })).toBe(1);
  });

  it('returns null for an empty cohort rather than 0 or 1', () => {
    // Retention over zero holders is undefined, not 0% and not 100%.
    const balances = [h(w(1), 5000n, 30)];
    expect(holderRetention(balances, { cohortBefore: at(5), options: opts() })).toBeNull();
  });

  it('counts a dust balance as not retained', () => {
    const balances = [h(w(1), 5000n, 0), h(w(2), 5n, 0)];
    expect(holderRetention(balances, { cohortBefore: at(5), options: opts() })).toBe(0.5);
  });
});
