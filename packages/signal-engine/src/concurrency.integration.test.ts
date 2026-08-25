import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  createDatabase,
  featureSets,
  pools,
  riskResults,
  signalAlerts,
  signalTransitions,
  signals,
  tokenSnapshots,
  tokens,
  trades,
} from '@sdb/database';
import { createLogger } from '@sdb/shared';
import { DEFAULT_COMPONENTS, DEFAULT_PENALTIES } from '@sdb/scoring';
import { evaluateSignal, type SignalEvaluationDeps } from './evaluate.js';

/**
 * Phase 5.1 regression suite.
 *
 * These exercise real concurrency — `Promise.all` over independent connections
 * — rather than sequential calls that would pass trivially. The pool is sized
 * above the concurrency used so racers genuinely run in parallel rather than
 * queueing on a single connection.
 *
 * Requires: docker compose up -d postgres
 */
const url = process.env.TEST_DATABASE_URL ?? 'postgres://sdb:sdb@localhost:5432/sdb';
const { db, close } = createDatabase(url, { max: 10 });
const logger = createLogger({ name: 'test', level: 'silent' });

const CHAIN = 8453;
const WETH = '0x4200000000000000000000000000000000000006';
const w = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;

const deps = (over: Partial<SignalEvaluationDeps> = {}): SignalEvaluationDeps => ({
  db,
  logger,
  scoring: {
    weights: { liquidity: 0.2, momentum: 0.3, holder: 0.2, smartMoney: 0.3 },
    nullPolicy: 'renormalize',
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
  ...over,
});

/** Scores ~63 -> INTERESTING. */
const INTERESTING_FEATURES = {
  liquidity_usd: 120_000,
  liquidity_stability: 0.8,
  volume_acceleration_5m: 3,
  buy_sell_ratio: 2,
  trade_velocity: 8,
  holder_count: 300,
  holder_growth_rate: 8,
  top10_concentration: 0.3,
  holder_retention: 0.7,
};

/** Scores high enough for STRONG_SIGNAL. */
const STRONG_FEATURES = {
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

const WEAK_FEATURES = { liquidity_usd: 1_000, buy_sell_ratio: 0.1, holder_count: 10 };

let ids = 0;
async function seedPool() {
  ids += 1;
  const [token] = await db
    .insert(tokens)
    .values({ chainId: CHAIN, address: w(1000 + ids), firstSeenAt: new Date(), decimals: 18 })
    .returning({ id: tokens.id });
  const [pool] = await db
    .insert(pools)
    .values({
      tokenId: token!.id,
      chainId: CHAIN,
      dex: 'uniswap-v2',
      address: w(5000 + ids),
      quoteTokenAddress: WETH,
      discoveredAt: new Date(),
      blockNumber: 1n,
      transactionHash: `0x${ids.toString(16).padStart(64, '0')}`,
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
    liquidityUsd: '500000',
  });
  await db.insert(trades).values({
    poolId: pool!.id,
    txHash: `0x${(9000 + ids).toString(16).padStart(64, '0')}`,
    logIndex: 1,
    wallet: w(9),
    side: 'OUT0',
    blockNumber: 1n,
    occurredAt: new Date(),
    baseAmountRaw: '-1000',
    quoteAmountRaw: '1000',
  });
  await db.insert(riskResults).values({
    tokenId: token!.id,
    poolId: pool!.id,
    evaluatedAt: new Date(),
    status: 'PASS',
    riskScore: '0.000',
    flags: [],
  });
  return { tokenId: token!.id, poolId: pool!.id };
}

let fsSeq = 0;
async function addFeatureSet(
  tokenId: string,
  poolId: string,
  values: Record<string, number | null>,
) {
  fsSeq += 1;
  const [row] = await db
    .insert(featureSets)
    .values({
      tokenId,
      poolId,
      // Strictly increasing so "latest" is deterministic.
      calculatedAt: new Date(Date.now() + fsSeq * 1000),
      featureVersion: 'features-v1',
      scheduledOffset: `t${fsSeq}`,
      values,
      normalizedValues: {},
    })
    .returning({ id: featureSets.id });
  return row!.id;
}

const countRows = async (table: typeof signals | typeof signalTransitions | typeof signalAlerts) =>
  (await db.select({ id: table.id }).from(table)).length;

beforeEach(async () => {
  await db.execute(sql`TRUNCATE ${signalAlerts}, ${signalTransitions}, ${signals},
    ${riskResults}, ${featureSets}, ${tokenSnapshots}, ${trades}, ${pools}, ${tokens}
    RESTART IDENTITY CASCADE`);
});

afterAll(async () => {
  await db.execute(sql`TRUNCATE ${signalAlerts}, ${signalTransitions}, ${signals},
    ${riskResults}, ${featureSets}, ${tokenSnapshots}, ${trades}, ${pools}, ${tokens}
    RESTART IDENTITY CASCADE`);
  await close();
});

describe('1. concurrent evaluation, same feature set', () => {
  it('produces exactly one signals row, one transition, one alert', async () => {
    const { tokenId, poolId } = await seedPool();
    await addFeatureSet(tokenId, poolId, INTERESTING_FEATURES);
    await evaluateSignal(deps(), poolId); // NEW -> WATCHING

    // Four genuine racers on the SAME feature set, all trying WATCHING ->
    // INTERESTING. Without the advisory lock all four read WATCHING and insert.
    const results = await Promise.all([
      evaluateSignal(deps(), poolId),
      evaluateSignal(deps(), poolId),
      evaluateSignal(deps(), poolId),
      evaluateSignal(deps(), poolId),
    ]);

    expect(results.filter((r) => r?.changed)).toHaveLength(1);
    expect(await countRows(signals)).toBe(2); // WATCHING + INTERESTING
    expect(await countRows(signalTransitions)).toBe(2);
    // One decision per (signal, feature set), enforced by the unique key.
    expect(await countRows(signalAlerts)).toBe(1);
  });

  it('leaves no duplicate (token_id, state) rows', async () => {
    const { tokenId, poolId } = await seedPool();
    await addFeatureSet(tokenId, poolId, STRONG_FEATURES);
    await Promise.all([
      evaluateSignal(deps(), poolId),
      evaluateSignal(deps(), poolId),
      evaluateSignal(deps(), poolId),
    ]);

    const dupes = await db.execute<{ n: string }>(
      sql`SELECT count(*) AS n FROM (
            SELECT token_id, state FROM ${signals} GROUP BY 1,2 HAVING count(*) > 1
          ) d`,
    );
    expect(Number(dupes[0]!.n)).toBe(0);
  });
});

describe('2. concurrent evaluation, different feature sets', () => {
  it('still yields one state entry; the loser sees the committed state', async () => {
    const { tokenId, poolId } = await seedPool();
    await addFeatureSet(tokenId, poolId, INTERESTING_FEATURES);
    await evaluateSignal(deps(), poolId); // -> WATCHING

    // Two racers whose "latest feature set" may differ, as happens when two
    // snapshot offsets complete near-simultaneously.
    await addFeatureSet(tokenId, poolId, INTERESTING_FEATURES);
    const results = await Promise.all([
      evaluateSignal(deps(), poolId),
      (async () => {
        await addFeatureSet(tokenId, poolId, STRONG_FEATURES);
        return evaluateSignal(deps(), poolId);
      })(),
    ]);

    // Both serialise; at most one may enter each distinct state.
    const dupes = await db.execute<{ n: string }>(
      sql`SELECT count(*) AS n FROM (
            SELECT token_id, state FROM ${signals} GROUP BY 1,2 HAVING count(*) > 1
          ) d`,
    );
    expect(Number(dupes[0]!.n)).toBe(0);
    expect(results.every((r) => r !== null)).toBe(true);
  });
});

describe('3. retry idempotency on the same feature set', () => {
  it('adds no second alert row when the job is replayed', async () => {
    const { tokenId, poolId } = await seedPool();
    await addFeatureSet(tokenId, poolId, INTERESTING_FEATURES);
    await evaluateSignal(deps(), poolId); // -> WATCHING
    await evaluateSignal(deps(), poolId); // -> INTERESTING, first alert

    const before = await countRows(signalAlerts);
    // A retried BullMQ job re-runs the identical evaluation.
    await evaluateSignal(deps(), poolId);
    await evaluateSignal(deps(), poolId);

    expect(await countRows(signalAlerts)).toBe(before);
    expect(await countRows(signals)).toBe(2);
  });
});

describe('4. unchanged state + score delta → re-alert, no new signal row', () => {
  it('records SCORE_MOVED without a new signals or transition row', async () => {
    const { tokenId, poolId } = await seedPool();
    await addFeatureSet(tokenId, poolId, INTERESTING_FEATURES);
    await evaluateSignal(deps(), poolId); // -> WATCHING
    await evaluateSignal(deps(), poolId); // -> INTERESTING, FIRST_ALERT

    const signalsBefore = await countRows(signals);
    const transitionsBefore = await countRows(signalTransitions);
    const [first] = await db
      .select({ score: signalAlerts.alphaScore })
      .from(signalAlerts);

    // A materially WORSE score. Downward is the cleaner probe: no-downgrade
    // holds the state at INTERESTING, so any state change would be a bug,
    // whereas a big upward move could legitimately cross strongThreshold.
    await addFeatureSet(tokenId, poolId, {
      ...INTERESTING_FEATURES,
      liquidity_usd: 5_000,
      volume_acceleration_5m: 0.5,
      buy_sell_ratio: 0.3,
      trade_velocity: 0.5,
      holder_count: 20,
      holder_growth_rate: 0,
      holder_retention: 0.1,
    });
    const result = await evaluateSignal(deps(), poolId);

    expect(result!.changed).toBe(false);
    expect(result!.alertDecision!.reason).toBe('score_moved');
    expect(await countRows(signals)).toBe(signalsBefore);
    expect(await countRows(signalTransitions)).toBe(transitionsBefore);

    const rows = await db
      .select({ trigger: signalAlerts.triggerReason, status: signalAlerts.status })
      .from(signalAlerts)
      .orderBy(signalAlerts.createdAt);
    expect(rows.map((r) => r.trigger)).toEqual(['FIRST_ALERT', 'SCORE_MOVED']);
    expect(rows.every((r) => r.status === 'PENDING')).toBe(true);
    // Sanity: the score really did move by at least the configured delta.
    const moved = Math.abs(result!.alphaScore - Number(first!.score));
    expect(moved).toBeGreaterThanOrEqual(10);
  });
});

describe('5. unchanged state + cooldown → re-alert, no new signal row', () => {
  it('records COOLDOWN_ELAPSED without a new signals row', async () => {
    const { tokenId, poolId } = await seedPool();
    await addFeatureSet(tokenId, poolId, INTERESTING_FEATURES);
    await evaluateSignal(deps(), poolId);
    await evaluateSignal(deps(), poolId); // FIRST_ALERT

    const signalsBefore = await countRows(signals);
    // Age the existing alert past the cooldown.
    await db.execute(
      sql`UPDATE ${signalAlerts} SET created_at = now() - interval '2 hours'`,
    );

    // Same score, so only the cooldown can justify re-alerting.
    await addFeatureSet(tokenId, poolId, INTERESTING_FEATURES);
    const result = await evaluateSignal(deps(), poolId);

    expect(result!.changed).toBe(false);
    expect(result!.alertDecision!.reason).toBe('cooldown_elapsed');
    expect(await countRows(signals)).toBe(signalsBefore);

    const [latest] = await db
      .select({ trigger: signalAlerts.triggerReason })
      .from(signalAlerts)
      .orderBy(sql`${signalAlerts.createdAt} DESC`)
      .limit(1);
    expect(latest!.trigger).toBe('COOLDOWN_ELAPSED');
  });
});

describe('6. unchanged state, neither condition → suppressed', () => {
  it('records SUPPRESSED with a reason and emits nothing', async () => {
    const { tokenId, poolId } = await seedPool();
    await addFeatureSet(tokenId, poolId, INTERESTING_FEATURES);
    await evaluateSignal(deps(), poolId);
    await evaluateSignal(deps(), poolId); // FIRST_ALERT

    await addFeatureSet(tokenId, poolId, INTERESTING_FEATURES); // identical score
    const result = await evaluateSignal(deps(), poolId);

    expect(result!.alertLevel).toBe('NONE');
    expect(result!.alertDecision!.status).toBe('SUPPRESSED');

    const [latest] = await db
      .select({
        status: signalAlerts.status,
        suppression: signalAlerts.suppressionReason,
        trigger: signalAlerts.triggerReason,
      })
      .from(signalAlerts)
      .orderBy(sql`${signalAlerts.createdAt} DESC`)
      .limit(1);
    expect(latest!.status).toBe('SUPPRESSED');
    expect(latest!.suppression).toBe('suppressed_duplicate');
    expect(latest!.trigger).toBeNull();
  });
});

describe('7. downgrade re-entry stays valid', () => {
  it('allows a state to be re-entered when the policy is enabled', async () => {
    // The reason no unique index was placed on (token_id, state): §18 permits
    // this policy, and an index would block the second WATCHING outright.
    const withDowngrade = deps({
      transitions: { ...deps().transitions, downgradePolicyEnabled: true },
    });
    const { tokenId, poolId } = await seedPool();

    await addFeatureSet(tokenId, poolId, STRONG_FEATURES);
    await evaluateSignal(withDowngrade, poolId); // -> WATCHING
    await evaluateSignal(withDowngrade, poolId); // -> STRONG_SIGNAL

    await addFeatureSet(tokenId, poolId, WEAK_FEATURES);
    const down = await evaluateSignal(withDowngrade, poolId); // -> WATCHING again

    expect(down!.toState).toBe('WATCHING');
    expect(down!.reason).toBe('downgrade_policy');

    const watching = await db.execute<{ n: string }>(
      sql`SELECT count(*) AS n FROM ${signals} WHERE state = 'WATCHING'`,
    );
    expect(Number(watching[0]!.n)).toBe(2); // re-entry recorded, not rejected
  });
});

describe('8. cooldown baseline uses delivery status', () => {
  it('ignores a FAILED alert so the signal is not swallowed', async () => {
    const { tokenId, poolId } = await seedPool();
    await addFeatureSet(tokenId, poolId, INTERESTING_FEATURES);
    await evaluateSignal(deps(), poolId);
    await evaluateSignal(deps(), poolId); // FIRST_ALERT (PENDING)

    // §20: a failed send must not silently discard the signal.
    await db.execute(sql`UPDATE ${signalAlerts} SET status = 'FAILED'`);

    await addFeatureSet(tokenId, poolId, INTERESTING_FEATURES); // identical score
    const result = await evaluateSignal(deps(), poolId);

    // With no SENT/PENDING baseline, this is a first alert again rather than a
    // duplicate suppressed against a delivery that never happened.
    expect(result!.alertDecision!.status).toBe('PENDING');
    expect(result!.alertDecision!.reason).toBe('first_alert');
  });

  it('treats a SENT alert as the cooldown baseline', async () => {
    const { tokenId, poolId } = await seedPool();
    await addFeatureSet(tokenId, poolId, INTERESTING_FEATURES);
    await evaluateSignal(deps(), poolId);
    await evaluateSignal(deps(), poolId);

    await db.execute(sql`UPDATE ${signalAlerts} SET status = 'SENT', sent_at = now()`);

    await addFeatureSet(tokenId, poolId, INTERESTING_FEATURES);
    const result = await evaluateSignal(deps(), poolId);
    expect(result!.alertDecision!.status).toBe('SUPPRESSED');
  });
});
