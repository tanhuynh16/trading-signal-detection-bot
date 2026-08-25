import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  createDatabase,
  featureSets,
  pools,
  riskResults,
  signalTransitions,
  signals,
  tokenSnapshots,
  tokens,
  trades,
} from '@sdb/database';
import { createLogger } from '@sdb/shared';
import { DEFAULT_COMPONENTS, DEFAULT_PENALTIES } from '@sdb/scoring';
import { evaluateSignal } from './evaluate.js';

/** Requires: docker compose up -d postgres */
const url = process.env.TEST_DATABASE_URL ?? 'postgres://sdb:sdb@localhost:5432/sdb';
const { db, close } = createDatabase(url, { max: 4 });
const logger = createLogger({ name: 'test', level: 'silent' });

const CHAIN = 8453;
const WETH = '0x4200000000000000000000000000000000000006';
const w = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;

const deps = {
  db,
  logger,
  scoring: {
    weights: { liquidity: 0.2, momentum: 0.3, holder: 0.2, smartMoney: 0.3 },
    nullPolicy: 'renormalize' as const,
    minCoverage: 0.6,
    strategyVersion: 'base-meme-v1',
    components: DEFAULT_COMPONENTS,
    penalties: DEFAULT_PENALTIES,
  },
  transitions: {
    interestingThreshold: 60,
    strongThreshold: 75,
    downgradePolicyEnabled: false,
    maxTokenAgeMinutes: 360,
    inactiveExpiryMinutes: 30,
    liquidityCollapseFraction: 0.2,
  },
  dedupe: { rescoreDelta: 10, cooldownMinutes: 60 },
};

/** Features strong enough to clear strongThreshold with smartMoney null. */
const STRONG = {
  liquidity_usd: 900_000,
  liquidity_stability: 1,
  liquidity_growth_5m: 1,
  mc_liquidity_ratio: 1,
  volume_acceleration_5m: 10,
  buy_sell_ratio: 5,
  trade_velocity: 50,
  unique_buyer_growth: 5,
  holder_count: 2_000,
  holder_growth_rate: 20,
  top10_concentration: 0.1,
  holder_retention: 1,
};

const WEAK = { liquidity_usd: 1_000, buy_sell_ratio: 0.1, holder_count: 10 };

async function seed(features: Record<string, number | null>, liquidityUsd = '500000') {
  const [token] = await db
    .insert(tokens)
    .values({ chainId: CHAIN, address: w(1001), firstSeenAt: new Date(), decimals: 18 })
    .returning({ id: tokens.id });
  const [pool] = await db
    .insert(pools)
    .values({
      tokenId: token!.id,
      chainId: CHAIN,
      dex: 'uniswap-v2',
      address: w(2001),
      quoteTokenAddress: WETH,
      discoveredAt: new Date(),
      blockNumber: 1n,
      transactionHash: `0x${'1'.repeat(64)}`,
    })
    .returning({ id: pools.id });

  await db.insert(tokenSnapshots).values({
    tokenId: token!.id,
    poolId: pool!.id,
    scheduledOffset: 'T0',
    blockNumber: 100n,
    observedAt: new Date(),
    capturedAt: new Date(),
    priceUsd: '0.000042',
    liquidityUsd,
  });

  await db.insert(featureSets).values({
    tokenId: token!.id,
    poolId: pool!.id,
    calculatedAt: new Date(),
    featureVersion: 'features-v1',
    scheduledOffset: 'T0',
    values: features,
    normalizedValues: {},
  });

  await db.insert(trades).values({
    poolId: pool!.id,
    txHash: `0x${'a'.repeat(64)}`,
    logIndex: 1,
    wallet: w(9),
    side: 'OUT0',
    blockNumber: 1n,
    occurredAt: new Date(),
    baseAmountRaw: '-1000',
    quoteAmountRaw: '1000',
  });

  return { tokenId: token!.id, poolId: pool!.id };
}

async function setRisk(tokenId: string, poolId: string, status: string) {
  await db.insert(riskResults).values({
    tokenId,
    poolId,
    evaluatedAt: new Date(),
    status,
    riskScore: status === 'FAIL' ? '100.000' : '0.000',
    flags: [],
  });
}

beforeEach(async () => {
  await db.execute(sql`TRUNCATE ${signalTransitions}, ${signals}, ${riskResults},
    ${featureSets}, ${tokenSnapshots}, ${trades}, ${pools}, ${tokens} RESTART IDENTITY CASCADE`);
});

afterAll(async () => {
  await db.execute(sql`TRUNCATE ${signalTransitions}, ${signals}, ${riskResults},
    ${featureSets}, ${tokenSnapshots}, ${trades}, ${pools}, ${tokens} RESTART IDENTITY CASCADE`);
  await close();
});

describe('signal evaluation end to end (§17, §18)', () => {
  it('writes one signal row and one transition on a state entry', async () => {
    const { tokenId, poolId } = await seed(WEAK);
    await setRisk(tokenId, poolId, 'PASS');

    const result = await evaluateSignal(deps, poolId);
    expect(result!.changed).toBe(true);
    expect(result!.toState).toBe('WATCHING');

    expect(await db.select({ id: signals.id }).from(signals)).toHaveLength(1);
    expect(await db.select({ id: signalTransitions.id }).from(signalTransitions)).toHaveLength(1);
  });

  it('adds no new row when the state has not changed', async () => {
    // Re-scoring on every snapshot must not bury real transitions in noise or
    // multiply the rows §21 attaches outcomes to.
    const { tokenId, poolId } = await seed(WEAK);
    await setRisk(tokenId, poolId, 'PASS');

    await evaluateSignal(deps, poolId); // NEW -> WATCHING
    const second = await evaluateSignal(deps, poolId);

    expect(second!.changed).toBe(false);
    expect(await db.select({ id: signals.id }).from(signals)).toHaveLength(1);
  });

  it('reaches STRONG_SIGNAL and alerts even with smart money null', async () => {
    // The G1 property, end to end: an empty seed list must not make
    // strongThreshold unreachable.
    const { tokenId, poolId } = await seed(STRONG);
    await setRisk(tokenId, poolId, 'PASS');

    await evaluateSignal(deps, poolId); // -> WATCHING
    const result = await evaluateSignal(deps, poolId); // -> STRONG_SIGNAL

    expect(result!.toState).toBe('STRONG_SIGNAL');
    expect(result!.alertLevel).toBe('STRONG');
    expect(result!.coverage).toBeCloseTo(0.7, 5);
  });

  it('persists coverage and the component breakdown (§27)', async () => {
    const { tokenId, poolId } = await seed(STRONG);
    await setRisk(tokenId, poolId, 'PASS');
    await evaluateSignal(deps, poolId);

    const [row] = await db
      .select({ components: signals.components, coverage: signals.coverage })
      .from(signals);
    const components = row!.components as Array<{ name: string; raw: number | null }>;
    expect(components.map((c) => c.name)).toEqual([
      'liquidity',
      'momentum',
      'holder',
      'smartMoney',
    ]);
    expect(components.find((c) => c.name === 'smartMoney')!.raw).toBeNull();
    expect(Number(row!.coverage)).toBeCloseTo(0.7, 4);
  });

  it('freezes a reference price for §21 outcome tracking', async () => {
    const { tokenId, poolId } = await seed(STRONG);
    await setRisk(tokenId, poolId, 'PASS');
    await evaluateSignal(deps, poolId);

    const [row] = await db.select({ price: signals.signalPriceUsd }).from(signals);
    expect(Number(row!.price)).toBeCloseTo(0.000042, 9);
  });

  it('expires on risk FAIL and refuses to alert (§27)', async () => {
    const { tokenId, poolId } = await seed(STRONG);
    await setRisk(tokenId, poolId, 'PASS');
    await evaluateSignal(deps, poolId); // -> WATCHING

    await setRisk(tokenId, poolId, 'FAIL');
    const result = await evaluateSignal(deps, poolId);

    expect(result!.toState).toBe('EXPIRED');
    expect(result!.reason).toBe('risk_fail');
    // A maximal score must not produce an alert once risk has failed.
    expect(result!.alertLevel).toBe('NONE');
  });

  it('never attaches an alert level to an EXPIRED signal', async () => {
    const { tokenId, poolId } = await seed(STRONG);
    await setRisk(tokenId, poolId, 'FAIL');
    await evaluateSignal(deps, poolId);

    const rows = await db
      .select({ state: signals.state, alertLevel: signals.alertLevel })
      .from(signals);
    for (const row of rows) {
      if (row.state === 'EXPIRED') expect(row.alertLevel).toBe('NONE');
    }
  });

  it('treats an unevaluated token as WARNING, not PASS', async () => {
    // §14 makes risk a gate; a token with no verdict has not passed it.
    const { poolId } = await seed(WEAK);
    const result = await evaluateSignal(deps, poolId);
    expect(result!.toState).toBe('WATCHING'); // allowed through, but not silently PASSed
  });

  it('records the from/to states on the transition row', async () => {
    const { tokenId, poolId } = await seed(STRONG);
    await setRisk(tokenId, poolId, 'PASS');
    await evaluateSignal(deps, poolId);
    await evaluateSignal(deps, poolId);

    const rows = await db
      .select({ from: signalTransitions.fromState, to: signalTransitions.toState })
      .from(signalTransitions)
      .orderBy(signalTransitions.occurredAt);

    expect(rows[0]).toMatchObject({ from: null, to: 'WATCHING' });
    expect(rows[1]).toMatchObject({ from: 'WATCHING', to: 'STRONG_SIGNAL' });
  });

  it('returns null for a pool that no longer exists', async () => {
    expect(await evaluateSignal(deps, '00000000-0000-0000-0000-000000000000')).toBeNull();
  });
});
