import { describe, expect, it } from 'vitest';
import {
  clusterConcentration,
  clusterWallets,
  independentCount,
  withinTolerance,
  type ClusterOptions,
  type WalletFunding,
} from './clustering.js';
import type { HolderBalance } from './holders.js';

const w = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const at = (sec: number) => new Date(Date.UTC(2026, 7, 24, 12, 0, sec));
const ETH = 10n ** 18n;

const funding = (over: Partial<WalletFunding> & { wallet: string }): WalletFunding => ({
  funder: w(900),
  txHash: `0x${'a'.repeat(64)}`,
  fundedAt: at(0),
  valueWei: ETH,
  ...over,
});

const opts = (over: Partial<ClusterOptions> = {}): ClusterOptions => ({
  timeProximityMs: 60_000,
  amountTolerance: 0.05,
  minClusterSize: 2,
  ...over,
});

describe('clusterWallets (spec §15.4)', () => {
  it('groups wallets funded by the same source', () => {
    const clusters = clusterWallets(
      [
        funding({ wallet: w(1), txHash: `0x${'1'.repeat(64)}` }),
        funding({ wallet: w(2), txHash: `0x${'2'.repeat(64)}` }),
      ],
      opts(),
    );
    const byFunder = clusters.find((c) => c.key.startsWith('funder:'));
    expect(byFunder?.wallets).toEqual([w(1), w(2)]);
    expect(byFunder?.evidence.some((e) => e.type === 'same_funder')).toBe(true);
  });

  it('groups wallets paid by the same transaction', () => {
    const tx = `0x${'f'.repeat(64)}`;
    const clusters = clusterWallets(
      [
        funding({ wallet: w(1), funder: w(901), txHash: tx }),
        funding({ wallet: w(2), funder: w(902), txHash: tx }),
      ],
      opts(),
    );
    const byTx = clusters.find((c) => c.key.startsWith('tx:'));
    expect(byTx?.wallets).toEqual([w(1), w(2)]);
  });

  it('groups a batch funded moments apart with equal amounts', () => {
    // Different funder and different tx, but a scripted batch all the same.
    const clusters = clusterWallets(
      [
        funding({ wallet: w(1), funder: w(901), txHash: `0x${'1'.repeat(64)}`, fundedAt: at(0) }),
        funding({ wallet: w(2), funder: w(902), txHash: `0x${'2'.repeat(64)}`, fundedAt: at(5) }),
      ],
      opts(),
    );
    expect(clusters.some((c) => c.key.startsWith('batch:'))).toBe(true);
  });

  it('does not group wallets funded far apart in time', () => {
    const clusters = clusterWallets(
      [
        funding({ wallet: w(1), funder: w(901), txHash: `0x${'1'.repeat(64)}`, fundedAt: at(0) }),
        funding({ wallet: w(2), funder: w(902), txHash: `0x${'2'.repeat(64)}`, fundedAt: at(50) }),
      ],
      opts({ timeProximityMs: 10_000 }),
    );
    expect(clusters.some((c) => c.key.startsWith('batch:'))).toBe(false);
  });

  it('does not group wallets funded with dissimilar amounts', () => {
    const clusters = clusterWallets(
      [
        funding({ wallet: w(1), funder: w(901), txHash: `0x${'1'.repeat(64)}`, valueWei: ETH }),
        funding({ wallet: w(2), funder: w(902), txHash: `0x${'2'.repeat(64)}`, valueWei: ETH * 50n }),
      ],
      opts(),
    );
    expect(clusters.some((c) => c.key.startsWith('batch:'))).toBe(false);
  });

  it('forms no cluster from a single wallet', () => {
    expect(clusterWallets([funding({ wallet: w(1) })], opts())).toEqual([]);
  });

  it('respects a raised minimum cluster size', () => {
    const two = [funding({ wallet: w(1) }), funding({ wallet: w(2) })];
    expect(clusterWallets(two, opts({ minClusterSize: 3 }))).toEqual([]);
  });

  it('carries both pieces of evidence when funder and tx agree', () => {
    const clusters = clusterWallets(
      [funding({ wallet: w(1) }), funding({ wallet: w(2) })],
      opts(),
    );
    const types = clusters.flatMap((c) => c.evidence.map((e) => e.type));
    expect(types).toContain('same_funder');
    expect(types).toContain('same_funding_tx');
  });

  it('is deterministic — the same input always yields the same clusters', () => {
    const input = [funding({ wallet: w(2) }), funding({ wallet: w(1) })];
    expect(clusterWallets(input, opts())).toEqual(clusterWallets(input, opts()));
  });
});

describe('withinTolerance', () => {
  it('accepts amounts inside the tolerance', () => {
    expect(withinTolerance(ETH, ETH + ETH / 100n, 0.05)).toBe(true);
  });

  it('rejects amounts outside it', () => {
    expect(withinTolerance(ETH, ETH * 2n, 0.05)).toBe(false);
  });

  it('treats identical amounts as within any tolerance', () => {
    expect(withinTolerance(ETH, ETH, 0)).toBe(true);
  });

  it('never treats a zero amount as similar to a non-zero one', () => {
    expect(withinTolerance(0n, ETH, 0.99)).toBe(false);
  });

  it('handles wei-scale values without float loss', () => {
    const huge = 10n ** 30n;
    expect(withinTolerance(huge, huge + 1n, 0.0001)).toBe(true);
  });
});

describe('clusterConcentration (spec §15.4)', () => {
  const balances: HolderBalance[] = [
    { wallet: w(1), balanceRaw: 300n, firstAcquiredAt: at(0) },
    { wallet: w(2), balanceRaw: 200n, firstAcquiredAt: at(0) },
    { wallet: w(3), balanceRaw: 500n, firstAcquiredAt: at(0) },
  ];

  it('reports the largest cluster share of tracked holdings', () => {
    const clusters = [{ key: 'funder:x', wallets: [w(1), w(2)], evidence: [] }];
    expect(clusterConcentration(clusters, balances)!).toBeCloseTo(0.5, 6);
  });

  it('returns null when no cluster was detected', () => {
    // "No coordination found" is different from a measured 0%.
    expect(clusterConcentration([], balances)).toBeNull();
  });

  it('returns null when there are no holdings to attribute', () => {
    expect(clusterConcentration([{ key: 'k', wallets: [w(1)], evidence: [] }], [])).toBeNull();
  });
});

describe('independentCount (spec §15.5 uses this)', () => {
  it('collapses a cluster to a single actor', () => {
    // Ten wallets funded by one source is one actor wearing ten hats.
    const clusters = [{ key: 'funder:x', wallets: [w(1), w(2), w(3)], evidence: [] }];
    expect(independentCount([w(1), w(2), w(3)], clusters)).toBe(1);
  });

  it('counts unclustered wallets individually', () => {
    expect(independentCount([w(1), w(2)], [])).toBe(2);
  });

  it('mixes clustered and independent wallets correctly', () => {
    const clusters = [{ key: 'funder:x', wallets: [w(1), w(2)], evidence: [] }];
    // w(1)+w(2) collapse to 1, w(3) stands alone => 2
    expect(independentCount([w(1), w(2), w(3)], clusters)).toBe(2);
  });

  it('ignores cluster members that are not in the wallet set', () => {
    const clusters = [{ key: 'funder:x', wallets: [w(1), w(9)], evidence: [] }];
    expect(independentCount([w(1)], clusters)).toBe(1);
  });
});

describe('clusterConcentration with incomplete balance history', () => {
  it('ignores negative balances, which are tracking artifacts not positions', () => {
    // The Transfer indexer starts mid-life, so a wallet that received tokens
    // before tracking and then sold shows negative. Summing those into the
    // denominator dragged the total to <= 0 and nulled the feature for every
    // token in a live run.
    const balances: HolderBalance[] = [
      { wallet: w(1), balanceRaw: 300n, firstAcquiredAt: at(0) },
      { wallet: w(2), balanceRaw: 200n, firstAcquiredAt: at(0) },
      { wallet: w(3), balanceRaw: -900n, firstAcquiredAt: at(0) },
    ];
    const clusters = [{ key: 'funder:x', wallets: [w(1), w(2)], evidence: [] }];
    // 500 of 500 positive supply, not 500 of -400.
    expect(clusterConcentration(clusters, balances)!).toBeCloseTo(1, 6);
  });

  it('still returns null when no positive balances exist at all', () => {
    const balances: HolderBalance[] = [
      { wallet: w(1), balanceRaw: -5n, firstAcquiredAt: at(0) },
    ];
    expect(clusterConcentration([{ key: 'k', wallets: [w(1)], evidence: [] }], balances)).toBeNull();
  });
});
