import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDatabase, pools, tokens } from '@sdb/database';
import type { TokenCandidate } from '@sdb/domain';
import { persistCandidate } from './persist.js';

/**
 * Spec §10.3 acceptance criteria that only a real database can prove:
 * "a newly observed pool creates exactly one record" and "duplicate event
 * delivery does not create duplicate candidates".
 *
 * Requires the compose stack: docker compose up -d postgres
 */
const url = process.env.TEST_DATABASE_URL ?? 'postgres://sdb:sdb@localhost:5432/sdb';
const { db, close } = createDatabase(url, { max: 4 });

const CHAIN = 8453;
const candidate = (overrides: Partial<TokenCandidate> = {}): TokenCandidate => ({
  chain: 'base',
  tokenAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1',
  poolAddress: '0xccccccccccccccccccccccccccccccccccccccc1',
  dex: 'uniswap-v2',
  quoteTokenAddress: '0x4200000000000000000000000000000000000006',
  discoveredAt: new Date(),
  blockNumber: 123n,
  transactionHash: `0x${'1'.repeat(64)}`,
  ...overrides,
});

async function persist(c: TokenCandidate) {
  return persistCandidate(db, {
    chainId: CHAIN,
    candidate: c,
    hasKnownQuoteToken: true,
    poolCreatedAt: null,
  });
}

beforeEach(async () => {
  await db.execute(sql`TRUNCATE ${pools}, ${tokens} RESTART IDENTITY CASCADE`);
});

afterAll(async () => {
  await db.execute(sql`TRUNCATE ${pools}, ${tokens} RESTART IDENTITY CASCADE`);
  await close();
});

describe('persistCandidate (spec §10.3)', () => {
  it('creates exactly one pool record for a newly observed pool', async () => {
    const result = await persist(candidate());
    expect(result.created).toBe(true);

    const rows = await db.select({ id: pools.id }).from(pools);
    expect(rows).toHaveLength(1);
  });

  it('does not create a duplicate when the same event is delivered twice', async () => {
    const first = await persist(candidate());
    const second = await persist(candidate());

    expect(first.created).toBe(true);
    // The caller keys "should I enqueue?" off this flag, so it must be false.
    expect(second.created).toBe(false);
    expect(second.poolId).toBe(first.poolId);

    const rows = await db.select({ id: pools.id }).from(pools);
    expect(rows).toHaveLength(1);
  });

  it('survives concurrent delivery of the same pool without duplicating', async () => {
    // Three adapters draining overlapping ranges is the real production shape;
    // a check-then-insert would race here and insert twice.
    const results = await Promise.all([persist(candidate()), persist(candidate()), persist(candidate())]);

    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.poolId)).size).toBe(1);

    const rows = await db.select({ id: pools.id }).from(pools);
    expect(rows).toHaveLength(1);
  });

  it('reuses one token row across that token’s several pools', async () => {
    await persist(candidate({ poolAddress: '0xcccccccccccccccccccccccccccccccccccccc01' }));
    await persist(candidate({ poolAddress: '0xcccccccccccccccccccccccccccccccccccccc02', dex: 'uniswap-v3' }));

    const tokenRows = await db.select({ id: tokens.id }).from(tokens);
    const poolRows = await db.select({ id: pools.id }).from(pools);
    expect(tokenRows).toHaveLength(1);
    expect(poolRows).toHaveLength(2);
  });

  it('persists addresses lowercase, per spec §11', async () => {
    await persist(candidate());
    const [row] = await db
      .select({ address: pools.address, quote: pools.quoteTokenAddress })
      .from(pools);
    expect(row!.address).toBe(row!.address.toLowerCase());
    expect(row!.quote).toBe(row!.quote.toLowerCase());
  });

  it('keeps a pool whose quote token is not allowlisted (§11: never delete)', async () => {
    const result = await persistCandidate(db, {
      chainId: CHAIN,
      candidate: candidate(),
      hasKnownQuoteToken: false,
      poolCreatedAt: null,
    });
    expect(result.created).toBe(true);

    const [row] = await db.select({ known: pools.hasKnownQuoteToken }).from(pools);
    expect(row!.known).toBe(false);
  });
});
