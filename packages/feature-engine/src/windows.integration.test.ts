import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDatabase, featureSets, pools, tokens, trades } from '@sdb/database';
import { parseScaled } from '@sdb/shared';
import { persistFeatures, type CalculatedFeatures } from './calculate.js';
import {
  poolAddressesForToken,
  smartWalletEntries,
  tradeWindow,
  windowVolumeUsd,
} from './windows.js';

/** Requires: docker compose up -d postgres */
const url = process.env.TEST_DATABASE_URL ?? 'postgres://sdb:sdb@localhost:5432/sdb';
const { db, close } = createDatabase(url, { max: 4 });

const CHAIN = 8453;
const WETH = '0x4200000000000000000000000000000000000006';
const w = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const at = (min: number) => new Date(Date.UTC(2026, 7, 25, 12, min, 0));

async function seedPool() {
  const [token] = await db
    .insert(tokens)
    .values({ chainId: CHAIN, address: w(1001), firstSeenAt: at(0) })
    .returning({ id: tokens.id });
  const [pool] = await db
    .insert(pools)
    .values({
      tokenId: token!.id,
      chainId: CHAIN,
      dex: 'uniswap-v2',
      address: w(2001),
      quoteTokenAddress: WETH,
      discoveredAt: at(0),
      blockNumber: 1n,
      transactionHash: `0x${'1'.repeat(64)}`,
    })
    .returning({ id: pools.id });
  return { tokenId: token!.id, poolId: pool!.id };
}

let seq = 0;
async function seedTrade(
  poolId: string,
  o: { side: string; wallet: string; at: Date; amount0: string; amount1: string },
) {
  seq += 1;
  await db.insert(trades).values({
    poolId,
    txHash: `0x${seq.toString(16).padStart(64, '0')}`,
    logIndex: seq,
    wallet: o.wallet,
    side: o.side,
    blockNumber: 1n,
    occurredAt: o.at,
    baseAmountRaw: o.amount0,
    quoteAmountRaw: o.amount1,
  });
}

const features = (poolId: string, tokenId: string, offset: string | null): CalculatedFeatures => ({
  tokenId,
  poolId,
  calculatedAt: at(5),
  scheduledOffset: offset,
  values: { liquidity_usd: 100, volume_acceleration_5m: null },
});

beforeEach(async () => {
  await db.execute(
    sql`TRUNCATE ${featureSets}, ${trades}, ${pools}, ${tokens} RESTART IDENTITY CASCADE`,
  );
});

afterAll(async () => {
  await db.execute(
    sql`TRUNCATE ${featureSets}, ${trades}, ${pools}, ${tokens} RESTART IDENTITY CASCADE`,
  );
  await close();
});

describe('feature_sets idempotency (review-gate fix 3)', () => {
  it('collapses a retried job to a single row', async () => {
    // Previously a transient failure would retry (5 attempts configured) and
    // insert a SECOND row, because feature_sets had no uniqueness guard.
    const { poolId, tokenId } = await seedPool();

    const first = await persistFeatures(db, features(poolId, tokenId, '5m'));
    const second = await persistFeatures(db, features(poolId, tokenId, '5m'));

    expect(first).not.toBeNull();
    expect(second).toBeNull(); // conflict: nothing inserted

    const rows = await db.select({ id: featureSets.id }).from(featureSets);
    expect(rows).toHaveLength(1);
  });

  it('keeps distinct offsets as separate rows', async () => {
    const { poolId, tokenId } = await seedPool();
    for (const offset of ['T0', '30s', '5m']) {
      await persistFeatures(db, features(poolId, tokenId, offset));
    }
    const rows = await db.select({ id: featureSets.id }).from(featureSets);
    expect(rows).toHaveLength(3);
  });

  it('records which snapshot the feature set belongs to', async () => {
    // Previously unauditable: nothing tied a feature set to its window.
    const { poolId, tokenId } = await seedPool();
    await persistFeatures(db, features(poolId, tokenId, '30m'));
    const [row] = await db
      .select({ offset: featureSets.scheduledOffset })
      .from(featureSets);
    expect(row!.offset).toBe('30m');
  });

  it('preserves null feature values as JSON null, never 0', async () => {
    const { poolId, tokenId } = await seedPool();
    await persistFeatures(db, features(poolId, tokenId, 'T0'));
    const rows = await db.execute<{ is_null: boolean }>(
      sql`SELECT values->'volume_acceleration_5m' = 'null'::jsonb AS is_null FROM ${featureSets}`,
    );
    expect(rows[0]!.is_null).toBe(true);
  });
});

describe('quote-side volume (review-gate fix 4)', () => {
  it('sums the quote column when the candidate is token0', async () => {
    const { poolId } = await seedPool();
    // amount1 is the quote side here; amount0 is the candidate token.
    await seedTrade(poolId, {
      side: 'OUT0',
      wallet: w(1),
      at: at(3),
      amount0: '-1000',
      amount1: '5000000000000000', // 0.005 WETH
    });

    const win = await tradeWindow(db, {
      poolId,
      from: at(0),
      to: at(5),
      baseIsToken0: true,
    });
    expect(win.quoteVolumeRaw).toBe(5_000_000_000_000_000n);
  });

  it('sums the OTHER column when the candidate is token1', async () => {
    // base_amount_raw/quote_amount_raw actually hold amount0/amount1, so the
    // quote side flips with token ordering. Getting this backwards would
    // report the meme token's own amount as dollar volume.
    const { poolId } = await seedPool();
    await seedTrade(poolId, {
      side: 'OUT1',
      wallet: w(1),
      at: at(3),
      amount0: '7000000000000000', // quote side when candidate is token1
      amount1: '-1000',
    });

    const win = await tradeWindow(db, {
      poolId,
      from: at(0),
      to: at(5),
      baseIsToken0: false,
    });
    expect(win.quoteVolumeRaw).toBe(7_000_000_000_000_000n);
  });

  it('converts raw quote units to dollars', async () => {
    const win = { quoteVolumeRaw: 10n ** 18n, volumeUsd: null } as never;
    // 1 WETH at $2433.78
    expect(windowVolumeUsd(win, parseScaled('2433.78'), 18)).toBeCloseTo(2433.78, 2);
  });

  it('returns null when the quote token has no USD price', async () => {
    // A pool quoted in an unrecognised asset has no dollar volume we can
    // honestly report — §15 forbids substituting a number.
    const win = { quoteVolumeRaw: 10n ** 18n, volumeUsd: null } as never;
    expect(windowVolumeUsd(win, null, 18)).toBeNull();
  });

  it('returns null volume for a window with no trades', async () => {
    const { poolId } = await seedPool();
    const win = await tradeWindow(db, {
      poolId,
      from: at(0),
      to: at(5),
      baseIsToken0: true,
    });
    expect(win.quoteVolumeRaw).toBeNull();
    expect(windowVolumeUsd(win, parseScaled('2433'), 18)).toBeNull();
  });
});

describe('smart-wallet entries (review-gate fix 2)', () => {
  it('returns nothing, without querying, for an empty seed list', async () => {
    const { poolId } = await seedPool();
    const entries = await smartWalletEntries(db, {
      poolId,
      seedWallets: new Set(),
      baseIsToken0: true,
    });
    expect(entries).toEqual([]);
  });

  it('finds a seeded wallet that bought, at its earliest entry', async () => {
    const { poolId } = await seedPool();
    const smart = w(77);
    await seedTrade(poolId, { side: 'OUT0', wallet: smart, at: at(4), amount0: '-1', amount1: '1' });
    await seedTrade(poolId, { side: 'OUT0', wallet: smart, at: at(2), amount0: '-1', amount1: '1' });

    const entries = await smartWalletEntries(db, {
      poolId,
      seedWallets: new Set([smart]),
      baseIsToken0: true,
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.enteredAt.toISOString()).toBe(at(2).toISOString());
  });

  it('ignores buyers that are not seeded', async () => {
    const { poolId } = await seedPool();
    await seedTrade(poolId, { side: 'OUT0', wallet: w(5), at: at(2), amount0: '-1', amount1: '1' });
    const entries = await smartWalletEntries(db, {
      poolId,
      seedWallets: new Set([w(77)]),
      baseIsToken0: true,
    });
    expect(entries).toEqual([]);
  });

  it('ignores a seeded wallet that only sold', async () => {
    // §15.5 is about smart money entering, not exiting.
    const { poolId } = await seedPool();
    const smart = w(77);
    await seedTrade(poolId, { side: 'OUT1', wallet: smart, at: at(2), amount0: '1', amount1: '-1' });
    const entries = await smartWalletEntries(db, {
      poolId,
      seedWallets: new Set([smart]),
      baseIsToken0: true,
    });
    expect(entries).toEqual([]);
  });
});


describe('pool contracts are never holders (§15.3)', () => {
  it('returns every pool address for the token, lowercased', async () => {
    // The AMM pool is the counterparty to every trade, so it is the largest
    // holder of essentially every new token — measured at 108 of 156 tokens
    // (69.2%). Counting it pushes top10_concentration toward 1.0 for all of
    // them and flattens the very differences the holder component exists to see.
    const { tokenId } = await seedPool();
    await db.insert(pools).values({
      tokenId,
      chainId: CHAIN,
      dex: 'uniswap-v3',
      address: w(2002),
      quoteTokenAddress: WETH,
      discoveredAt: at(0),
      blockNumber: 2n,
      transactionHash: `0x${'2'.repeat(64)}`,
    });

    const addresses = await poolAddressesForToken(db, tokenId);

    // Both pools, not just the one the features are being calculated for: a
    // token's supply sitting in a sibling venue is no more a holder than in this
    // one.
    expect(addresses.sort()).toEqual([w(2001), w(2002)].sort());
    for (const a of addresses) expect(a).toBe(a.toLowerCase());
  });

  it('returns an empty list for a token with no pools rather than throwing', async () => {
    const [token] = await db
      .insert(tokens)
      .values({ chainId: CHAIN, address: w(1099), firstSeenAt: at(0) })
      .returning({ id: tokens.id });
    expect(await poolAddressesForToken(db, token!.id)).toEqual([]);
  });
});
