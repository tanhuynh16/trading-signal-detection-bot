import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDatabase, pools, riskResults, tokens } from '@sdb/database';
import type { RiskResult } from '@sdb/domain';
import { persistRisk } from './evaluate.js';
import { DEFAULT_RULE_CONFIG, FLAG, decide } from './rules.js';

/**
 * Requires the compose stack: docker compose up -d postgres
 */
const url = process.env.TEST_DATABASE_URL ?? 'postgres://sdb:sdb@localhost:5432/sdb';
const { db, close } = createDatabase(url, { max: 4 });

const CHAIN = 8453;

async function seedPool() {
  const [token] = await db
    .insert(tokens)
    .values({
      chainId: CHAIN,
      address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1',
      firstSeenAt: new Date(),
    })
    .returning({ id: tokens.id });

  const [pool] = await db
    .insert(pools)
    .values({
      tokenId: token!.id,
      chainId: CHAIN,
      dex: 'uniswap-v2',
      address: '0xccccccccccccccccccccccccccccccccccccccc1',
      quoteTokenAddress: '0x4200000000000000000000000000000000000006',
      discoveredAt: new Date(),
      blockNumber: 1n,
      transactionHash: `0x${'1'.repeat(64)}`,
    })
    .returning({ id: pools.id });

  return { tokenId: token!.id, poolId: pool!.id };
}

function evaluation(tokenId: string, poolId: string, result: RiskResult) {
  return {
    result,
    tokenId,
    poolId,
    simulation: null,
    providerName: 'goplus',
    providerRaw: { is_honeypot: '0', buy_tax: '0' },
  };
}

beforeEach(async () => {
  await db.execute(sql`TRUNCATE ${riskResults}, ${pools}, ${tokens} RESTART IDENTITY CASCADE`);
});

afterAll(async () => {
  await db.execute(sql`TRUNCATE ${riskResults}, ${pools}, ${tokens} RESTART IDENTITY CASCADE`);
  await close();
});

describe('risk persistence (spec §14, §21)', () => {
  it('retains the raw provider response, as §14.1 requires', async () => {
    const { tokenId, poolId } = await seedPool();
    await persistRisk(db, evaluation(tokenId, poolId, decide([], DEFAULT_RULE_CONFIG)));

    const [row] = await db
      .select({ raw: riskResults.providerRaw, provider: riskResults.providerName })
      .from(riskResults);
    expect(row!.provider).toBe('goplus');
    expect(row!.raw).toMatchObject({ is_honeypot: '0' });
  });

  it('appends each re-check rather than overwriting (§21 immutability)', async () => {
    // The T+0/5m/30m checks are separate observations of a contract whose state
    // can genuinely change; overwriting would erase the evidence that it did.
    const { tokenId, poolId } = await seedPool();

    await persistRisk(db, evaluation(tokenId, poolId, decide([], DEFAULT_RULE_CONFIG)));
    await persistRisk(
      db,
      evaluation(
        tokenId,
        poolId,
        decide(
          [{ code: FLAG.HONEYPOT, severity: 'CRITICAL', message: 'turned malicious' }],
          DEFAULT_RULE_CONFIG,
        ),
      ),
    );

    const rows = await db
      .select({ status: riskResults.status, score: riskResults.riskScore })
      .from(riskResults)
      .orderBy(riskResults.evaluatedAt);

    expect(rows).toHaveLength(2);
    expect(rows[0]!.status).toBe('PASS');
    expect(rows[1]!.status).toBe('FAIL');
  });

  it('stores the risk score without float rounding', async () => {
    const { tokenId, poolId } = await seedPool();
    const result = decide(
      [{ code: FLAG.LP_CONCERN, severity: 'MEDIUM', message: '' }],
      DEFAULT_RULE_CONFIG,
    );
    await persistRisk(db, evaluation(tokenId, poolId, result));

    const [row] = await db.select({ score: riskResults.riskScore }).from(riskResults);
    expect(Number(row!.score)).toBe(result.riskScore);
  });

  it('persists flags as structured JSON, queryable by code', async () => {
    const { tokenId, poolId } = await seedPool();
    await persistRisk(
      db,
      evaluation(
        tokenId,
        poolId,
        decide(
          [{ code: FLAG.OWNER_CAN_MINT, severity: 'HIGH', message: 'owner can mint' }],
          DEFAULT_RULE_CONFIG,
        ),
      ),
    );

    const rows = await db.execute<{ code: string }>(
      sql`SELECT f->>'code' AS code FROM ${riskResults}, jsonb_array_elements(flags) f`,
    );
    expect(rows[0]!.code).toBe(FLAG.OWNER_CAN_MINT);
  });

  it('records a FAIL verdict with its critical flag intact', async () => {
    const { tokenId, poolId } = await seedPool();
    const result = decide(
      [{ code: FLAG.HONEYPOT, severity: 'CRITICAL', message: 'sell reverted' }],
      DEFAULT_RULE_CONFIG,
    );
    expect(result.status).toBe('FAIL');

    await persistRisk(db, evaluation(tokenId, poolId, result));
    const [row] = await db
      .select({ status: riskResults.status, score: riskResults.riskScore })
      .from(riskResults);
    expect(row!.status).toBe('FAIL');
    expect(Number(row!.score)).toBe(100);
  });
});
