import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDatabase, pools, tokens, tokenSnapshots, trades } from '@sdb/database';
import { ResourceGoneError } from '@sdb/shared';
import { enrichToken } from './metadata.js';
import { tradeWindowStats } from './swap-tail.js';

/**
 * Requires the compose stack: docker compose up -d postgres
 */
const url = process.env.TEST_DATABASE_URL ?? 'postgres://sdb:sdb@localhost:5432/sdb';
const { db, close } = createDatabase(url, { max: 4 });

const CHAIN = 8453;
const WETH = '0x4200000000000000000000000000000000000006';

async function seedPool(overrides: { poolAddress?: string; tokenAddress?: string } = {}) {
  const tokenAddress = overrides.tokenAddress ?? '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1';
  const poolAddress = overrides.poolAddress ?? '0xccccccccccccccccccccccccccccccccccccccc1';

  const [token] = await db
    .insert(tokens)
    .values({ chainId: CHAIN, address: tokenAddress, firstSeenAt: new Date() })
    .returning({ id: tokens.id });

  const [pool] = await db
    .insert(pools)
    .values({
      tokenId: token!.id,
      chainId: CHAIN,
      dex: 'uniswap-v2',
      address: poolAddress,
      quoteTokenAddress: WETH,
      discoveredAt: new Date(),
      blockNumber: 1n,
      transactionHash: `0x${'1'.repeat(64)}`,
    })
    .returning({ id: pools.id });

  return { tokenId: token!.id, poolId: pool!.id };
}

beforeEach(async () => {
  await db.execute(
    sql`TRUNCATE ${tokenSnapshots}, ${trades}, ${pools}, ${tokens} RESTART IDENTITY CASCADE`,
  );
});

afterAll(async () => {
  await db.execute(
    sql`TRUNCATE ${tokenSnapshots}, ${trades}, ${pools}, ${tokens} RESTART IDENTITY CASCADE`,
  );
  await close();
});

describe('snapshot idempotency (spec §13)', () => {
  it('rejects a second row for the same pool and offset', async () => {
    const { poolId, tokenId } = await seedPool();
    const row = {
      tokenId,
      poolId,
      scheduledOffset: '5m',
      blockNumber: 100n,
      observedAt: new Date(),
      capturedAt: new Date(),
    };

    await db.insert(tokenSnapshots).values(row);
    const second = await db
      .insert(tokenSnapshots)
      .values(row)
      .onConflictDoNothing({
        target: [tokenSnapshots.poolId, tokenSnapshots.scheduledOffset],
      })
      .returning({ id: tokenSnapshots.id });

    // Empty RETURNING is how the job knows it was a replay, not a new capture.
    expect(second).toHaveLength(0);
    const all = await db.select({ id: tokenSnapshots.id }).from(tokenSnapshots);
    expect(all).toHaveLength(1);
  });

  it('allows different offsets for the same pool', async () => {
    const { poolId, tokenId } = await seedPool();
    for (const offset of ['T0', '30s', '1m']) {
      await db.insert(tokenSnapshots).values({
        tokenId,
        poolId,
        scheduledOffset: offset,
        blockNumber: 100n,
        observedAt: new Date(),
        capturedAt: new Date(),
      });
    }
    const all = await db.select({ id: tokenSnapshots.id }).from(tokenSnapshots);
    expect(all).toHaveLength(3);
  });

  it('stores prices at full numeric(38,18) precision, no float rounding', async () => {
    const { poolId, tokenId } = await seedPool();
    // A realistic meme-token price: tiny, and lethal to a float.
    const price = '0.000000000000123456';
    await db.insert(tokenSnapshots).values({
      tokenId,
      poolId,
      scheduledOffset: 'T0',
      blockNumber: 100n,
      observedAt: new Date(),
      capturedAt: new Date(),
      priceUsd: price,
    });
    const [row] = await db
      .select({ priceUsd: tokenSnapshots.priceUsd })
      .from(tokenSnapshots);
    expect(row!.priceUsd).toBe(price);
  });
});

describe('permanent failures (spec §23)', () => {
  it('reports a deleted pool as permanently gone, not retryable', async () => {
    // This is the shape of the stale jobs left in Redis after a truncate.
    const missing = '00000000-0000-0000-0000-000000000000';
    await expect(
      enrichToken({ db, http: {} as never }, missing),
    ).rejects.toBeInstanceOf(ResourceGoneError);

    const error = await enrichToken({ db, http: {} as never }, missing).catch((e) => e);
    expect(error.retryable).toBe(false);
  });
});

describe('trade window aggregation', () => {
  async function seedTrade(poolId: string, side: string, wallet: string, at: Date) {
    await db.insert(trades).values({
      poolId,
      txHash: `0x${Math.random().toString(16).slice(2).padEnd(64, '0')}`,
      logIndex: Math.floor(Math.random() * 100000),
      wallet,
      side,
      blockNumber: 1n,
      occurredAt: at,
      baseAmountRaw: '-1000',
      quoteAmountRaw: '500',
    });
  }

  it('counts buys and sells relative to which side is the candidate', async () => {
    const { poolId } = await seedPool();
    const now = new Date();
    await seedTrade(poolId, 'OUT0', '0x1111111111111111111111111111111111111111', now);
    await seedTrade(poolId, 'OUT0', '0x2222222222222222222222222222222222222222', now);
    await seedTrade(poolId, 'OUT1', '0x3333333333333333333333333333333333333333', now);

    const stats = await tradeWindowStats(db, {
      poolId,
      from: new Date(now.getTime() - 60_000),
      to: new Date(now.getTime() + 1000),
      baseIsToken0: true,
    });

    // OUT0 = token0 left the pool = a BUY when token0 is the candidate.
    expect(stats!.buyCount).toBe(2);
    expect(stats!.sellCount).toBe(1);
    expect(stats!.uniqueBuyers).toBe(2);
  });

  it('flips buy and sell when the candidate is token1', async () => {
    const { poolId } = await seedPool();
    const now = new Date();
    await seedTrade(poolId, 'OUT0', '0x1111111111111111111111111111111111111111', now);
    await seedTrade(poolId, 'OUT1', '0x2222222222222222222222222222222222222222', now);

    const stats = await tradeWindowStats(db, {
      poolId,
      from: new Date(now.getTime() - 60_000),
      to: new Date(now.getTime() + 1000),
      baseIsToken0: false,
    });
    expect(stats!.buyCount).toBe(1);
    expect(stats!.sellCount).toBe(1);
  });

  it('counts a repeat buyer once', async () => {
    const { poolId } = await seedPool();
    const now = new Date();
    const wallet = '0x1111111111111111111111111111111111111111';
    await seedTrade(poolId, 'OUT0', wallet, now);
    await seedTrade(poolId, 'OUT0', wallet, now);

    const stats = await tradeWindowStats(db, {
      poolId,
      from: new Date(now.getTime() - 60_000),
      to: new Date(now.getTime() + 1000),
      baseIsToken0: true,
    });
    expect(stats!.buyCount).toBe(2);
    expect(stats!.uniqueBuyers).toBe(1);
  });

  it('excludes trades outside the window', async () => {
    const { poolId } = await seedPool();
    const now = new Date();
    await seedTrade(poolId, 'OUT0', '0x1111111111111111111111111111111111111111', now);
    await seedTrade(
      poolId,
      'OUT0',
      '0x2222222222222222222222222222222222222222',
      new Date(now.getTime() - 3_600_000),
    );

    const stats = await tradeWindowStats(db, {
      poolId,
      from: new Date(now.getTime() - 60_000),
      to: new Date(now.getTime() + 1000),
      baseIsToken0: true,
    });
    expect(stats!.buyCount).toBe(1);
  });

  it('returns zero counts for an empty window without throwing', async () => {
    const { poolId } = await seedPool();
    const stats = await tradeWindowStats(db, {
      poolId,
      from: new Date(Date.now() - 60_000),
      to: new Date(),
      baseIsToken0: true,
    });
    expect(stats!.buyCount).toBe(0);
    expect(stats!.sellCount).toBe(0);
  });

  it('treats a re-ingested log as a no-op (unique on tx_hash, log_index)', async () => {
    const { poolId } = await seedPool();
    const row = {
      poolId,
      txHash: `0x${'a'.repeat(64)}`,
      logIndex: 7,
      wallet: '0x1111111111111111111111111111111111111111',
      side: 'OUT0',
      blockNumber: 1n,
      occurredAt: new Date(),
      baseAmountRaw: '-1000',
      quoteAmountRaw: '500',
    };
    await db.insert(trades).values(row);
    await db.insert(trades).values(row).onConflictDoNothing({
      target: [trades.txHash, trades.logIndex],
    });

    const all = await db.select({ id: trades.id }).from(trades);
    expect(all).toHaveLength(1);
  });
});
