import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { inArray, sql } from 'drizzle-orm';
import {
  createDatabase,
  featureSets,
  pools,
  discoveryCursors,
  quotePriceSamples,
  riskResults,
  signalAlerts,
  signalOutcomes,
  signalTransitions,
  signals,
  tokenSnapshots,
  tokens,
  trades,
} from '@sdb/database';
import { ONE_USD } from '@sdb/market-data';
import { parseScaled } from '@sdb/shared';
import { advanceCursor } from '@sdb/discovery';
import { SWAP_TAIL_SOURCE, trackedPools } from '@sdb/snapshot-engine';
import { evaluateOutcome, type QuoteInfo } from './outcome.js';
import { dueOutcomes } from './reconcile.js';
import { recordQuoteSample } from './quote-samples.js';

/** Requires: docker compose up -d postgres */
const url = process.env.TEST_DATABASE_URL ?? 'postgres://sdb:sdb@localhost:5432/sdb';
const { db, close } = createDatabase(url, { max: 4 });

const CHAIN = 8453;
const WETH = '0x4200000000000000000000000000000000000006';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const HOUR = 3_600_000;

/** WETH is priced from the series; USDC is pegged and never sampled. */
const quotes: QuoteInfo = {
  decimalsFor: (address) => (address.toLowerCase() === USDC ? 6 : 18),
  fixedUsdFor: (address) => (address.toLowerCase() === USDC ? ONE_USD : null),
};

const config = {
  minQuoteCoverage: 0.8,
  maxSampleAgeMs: 300_000,
  // These cases are about metric correctness, not coverage, so the tail is
  // primed as fully caught up rather than switching the gate off — the suite
  // should exercise the same guard production runs with (ADR 0020).
  coverage: { enabled: true, deferIntervalMs: 30_000, maxDeferMs: 1_800_000 },
};

/** The swap tail has indexed everything these cases could ask about. */
const FULLY_INDEXED = new Date('2099-01-01T00:00:00Z');

let seq = 0;
/** A token below the quote address, so the candidate is token0. */
const tokenAddress = (n: number) => `0x0${n.toString(16).padStart(39, '0')}`;

async function seedSignal(
  over: {
    signalPriceUsd?: string | null;
    state?: string;
    createdAt?: Date;
    discoveredAt?: Date;
    quoteToken?: string;
    decimals?: number | null;
  } = {},
) {
  seq += 1;
  const quoteToken = over.quoteToken ?? WETH;
  const [token] = await db
    .insert(tokens)
    .values({
      chainId: CHAIN,
      address: tokenAddress(7000 + seq),
      symbol: `OUT${seq}`,
      firstSeenAt: new Date(),
      decimals: over.decimals === undefined ? 18 : over.decimals,
    })
    .returning({ id: tokens.id });
  const [pool] = await db
    .insert(pools)
    .values({
      tokenId: token!.id,
      chainId: CHAIN,
      dex: 'uniswap-v2',
      address: `0xf${(9000 + seq).toString(16).padStart(39, '0')}`,
      quoteTokenAddress: quoteToken,
      discoveredAt: over.discoveredAt ?? new Date(),
      blockNumber: 1n,
      transactionHash: `0x${(9000 + seq).toString(16).padStart(64, '0')}`,
    })
    .returning({ id: pools.id });
  const [signal] = await db
    .insert(signals)
    .values({
      tokenId: token!.id,
      poolId: pool!.id,
      state: over.state ?? 'STRONG_SIGNAL',
      alphaScore: '84.000',
      components: [],
      coverage: '0.7000',
      strategyVersion: 'base-meme-v1',
      alertLevel: 'STRONG',
      signalPriceUsd: over.signalPriceUsd === undefined ? '1' : over.signalPriceUsd,
      ...(over.createdAt ? { createdAt: over.createdAt } : {}),
    })
    .returning({ id: signals.id, createdAt: signals.createdAt });

  return { signalId: signal!.id, poolId: pool!.id, createdAt: signal!.createdAt };
}

/** One swap: `baseAmount` of the candidate token out for `quoteAmount` in. */
async function seedTrade(
  poolId: string,
  input: { baseAmount: string; quoteAmount: string; occurredAt: Date; block: number },
) {
  await db.insert(trades).values({
    poolId,
    txHash: `0x${input.block.toString(16).padStart(64, '0')}`,
    logIndex: input.block,
    wallet: tokenAddress(1),
    side: 'OUT0',
    blockNumber: BigInt(input.block),
    occurredAt: input.occurredAt,
    // The tail stores unoriented amount0/amount1 under these column names.
    baseAmountRaw: `-${input.baseAmount}`,
    quoteAmountRaw: input.quoteAmount,
  });
}

const ONE_TOKEN = 10n ** 18n;
const wei = (eth: string) => parseScaled(eth).toString();

const truncate = sql`TRUNCATE ${signalOutcomes}, ${signalAlerts}, ${signalTransitions},
  ${signals}, ${riskResults}, ${featureSets}, ${tokenSnapshots}, ${trades}, ${pools},
  ${tokens}, ${quotePriceSamples} RESTART IDENTITY CASCADE`;

/** Only the cursor rows this file owns; the table is shared. */
const cleanCursors = () =>
  db.delete(discoveryCursors).where(inArray(discoveryCursors.source, [SWAP_TAIL_SOURCE]));

beforeEach(async () => {
  await db.execute(truncate);
  await cleanCursors();
  await advanceCursor(db, SWAP_TAIL_SOURCE, 1n, FULLY_INDEXED);
});
afterAll(async () => {
  await db.execute(truncate);
  await cleanCursors();
  await close();
});

describe('evaluateOutcome — §21 end to end', () => {
  it('measures a real price path out of indexed swaps', async () => {
    const { signalId, poolId, createdAt } = await seedSignal({ signalPriceUsd: '1000' });
    await recordQuoteSample(db, {
      chainId: CHAIN,
      tokenAddress: WETH,
      priceUsd: parseScaled('2000'),
      observedAt: new Date(createdAt.getTime() + 10_000),
    });
    // 1 token out for 1 WETH -> $2000, a 100% gain on a $1000 signal price.
    await seedTrade(poolId, {
      baseAmount: ONE_TOKEN.toString(),
      quoteAmount: wei('1'),
      occurredAt: new Date(createdAt.getTime() + 10_000),
      block: 10,
    });

    const result = await evaluateOutcome(db, quotes, config, { signalId, horizon: '5m' });

    expect(result.created).toBe(true);
    expect(result.metrics.returnPct).toBe('100');
    expect(result.metrics.maxRunupPct).toBe('100');
    expect(result.metrics.maxDrawdownPct).toBe('0');
    expect(result.metrics.tradeCount).toBe(1);
    expect(result.metrics.failureReason).toBeNull();

    const [row] = await db.select().from(signalOutcomes);
    expect(row!.horizon).toBe('5m');
    expect(Number(row!.returnPct)).toBe(100);
    expect(row!.tradeCount).toBe(1);
  });

  it('ignores swaps beyond the horizon window', async () => {
    // The 1m outcome must not see a trade that happened at 10m, or every
    // horizon would collapse into the same number.
    const { signalId, poolId, createdAt } = await seedSignal({ signalPriceUsd: '1000' });
    for (const minutes of [0.5, 10]) {
      await recordQuoteSample(db, {
        chainId: CHAIN,
        tokenAddress: WETH,
        priceUsd: parseScaled('2000'),
        observedAt: new Date(createdAt.getTime() + minutes * 60_000),
      });
    }
    await seedTrade(poolId, {
      baseAmount: ONE_TOKEN.toString(),
      quoteAmount: wei('1'),
      occurredAt: new Date(createdAt.getTime() + 30_000),
      block: 10,
    });
    await seedTrade(poolId, {
      baseAmount: ONE_TOKEN.toString(),
      quoteAmount: wei('5'),
      occurredAt: new Date(createdAt.getTime() + 10 * 60_000),
      block: 20,
    });

    const oneMinute = await evaluateOutcome(db, quotes, config, { signalId, horizon: '1m' });
    expect(oneMinute.metrics.tradeCount).toBe(1);
    expect(oneMinute.metrics.returnPct).toBe('100');

    const fifteen = await evaluateOutcome(db, quotes, config, { signalId, horizon: '15m' });
    expect(fifteen.metrics.tradeCount).toBe(2);
    expect(fifteen.metrics.returnPct).toBe('900');
    expect(fifteen.metrics.maxRunupPct).toBe('900');
  });

  it('is idempotent: a replayed horizon writes nothing new', async () => {
    // Both the delayed job and the reconciler can fire for the same horizon.
    const { signalId } = await seedSignal();
    const first = await evaluateOutcome(db, quotes, config, { signalId, horizon: '1m' });
    const second = await evaluateOutcome(db, quotes, config, { signalId, horizon: '1m' });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    const rows = await db.select().from(signalOutcomes);
    expect(rows).toHaveLength(1);
  });

  it('records a flat return when nothing traded, not a failure', async () => {
    const { signalId } = await seedSignal({ signalPriceUsd: '1000' });
    const result = await evaluateOutcome(db, quotes, config, { signalId, horizon: '1m' });

    expect(result.metrics.returnPct).toBe('0');
    expect(result.metrics.tradeCount).toBe(0);
    expect(result.metrics.failureReason).toBeNull();
  });

  it('records a reason when the signal was never priced', async () => {
    // §27: the row exists and says why, rather than being silently skipped.
    const { signalId } = await seedSignal({ signalPriceUsd: null });
    const result = await evaluateOutcome(db, quotes, config, { signalId, horizon: '1m' });

    expect(result.metrics.failureReason).toBe('no_signal_price');
    const [row] = await db.select().from(signalOutcomes);
    expect(row!.returnPct).toBeNull();
    expect(row!.failureReason).toBe('no_signal_price');
  });

  it('records a reason when the quote series has a gap over the window', async () => {
    // The worker was down, so no ETH price is near these trades. A number from
    // whatever survived would look authoritative and be wrong.
    const { signalId, poolId, createdAt } = await seedSignal({ signalPriceUsd: '1000' });
    await seedTrade(poolId, {
      baseAmount: ONE_TOKEN.toString(),
      quoteAmount: wei('1'),
      occurredAt: new Date(createdAt.getTime() + 10_000),
      block: 10,
    });

    const result = await evaluateOutcome(db, quotes, config, { signalId, horizon: '5m' });
    expect(result.metrics.failureReason).toBe('insufficient_quote_coverage');
    expect(result.metrics.tradeCount).toBe(1);
  });

  it('needs no samples at all for a pegged quote token', async () => {
    // USDC is $1 at every point in the past as well as now.
    const { signalId, poolId, createdAt } = await seedSignal({
      signalPriceUsd: '1',
      quoteToken: USDC,
    });
    await seedTrade(poolId, {
      baseAmount: ONE_TOKEN.toString(),
      quoteAmount: '3000000', // 3 USDC, 6 decimals
      occurredAt: new Date(createdAt.getTime() + 10_000),
      block: 10,
    });

    const result = await evaluateOutcome(db, quotes, config, { signalId, horizon: '5m' });
    expect(result.metrics.failureReason).toBeNull();
    expect(result.metrics.returnPct).toBe('200');
  });

  it('refuses to guess when the token decimals were never resolved', async () => {
    const { signalId } = await seedSignal({ decimals: null });
    const result = await evaluateOutcome(db, quotes, config, { signalId, horizon: '1m' });
    expect(result.metrics.failureReason).toBe('no_token_decimals');
  });

  it('rejects a horizon that is not one of ours', async () => {
    const { signalId } = await seedSignal();
    await expect(
      evaluateOutcome(db, quotes, config, { signalId, horizon: '7m' }),
    ).rejects.toMatchObject({ retryable: false });
  });
});

describe('dueOutcomes — the reconciler is the durability guarantee', () => {
  const reconcile = { lookbackMs: 48 * HOUR, limitPerHorizon: 100 };

  it('finds horizons that elapsed while nothing was listening', async () => {
    // A 24h delayed job does not survive a Redis FLUSHALL; the signals table does.
    const { signalId } = await seedSignal({ createdAt: new Date(Date.now() - 20 * 60_000) });
    const due = await dueOutcomes(db, reconcile);

    expect(due.filter((d) => d.signalId === signalId).map((d) => d.horizon)).toEqual([
      '1m',
      '5m',
      '15m',
    ]);
  });

  it('stops reporting a horizon once it has been evaluated', async () => {
    const { signalId } = await seedSignal({ createdAt: new Date(Date.now() - 20 * 60_000) });
    await evaluateOutcome(db, quotes, config, { signalId, horizon: '5m' });

    const due = await dueOutcomes(db, reconcile);
    expect(due.map((d) => d.horizon)).not.toContain('5m');
    expect(due.map((d) => d.horizon)).toContain('1m');
  });

  it('never reports a horizon that has not come due yet', async () => {
    await seedSignal({ createdAt: new Date(Date.now() - 30_000) });
    expect(await dueOutcomes(db, reconcile)).toEqual([]);
  });

  it('skips EXPIRED signals, which are never scheduled either', async () => {
    // Without this the sweep would manufacture outcomes for every expiry ever
    // recorded — measuring the return of an expiry event, which means nothing.
    await seedSignal({ state: 'EXPIRED', createdAt: new Date(Date.now() - 20 * 60_000) });
    expect(await dueOutcomes(db, reconcile)).toEqual([]);
  });

  it('ignores signals older than the lookback window', async () => {
    await seedSignal({ createdAt: new Date(Date.now() - 96 * HOUR) });
    expect(await dueOutcomes(db, { lookbackMs: 48 * HOUR, limitPerHorizon: 100 })).toEqual([]);
  });

  it('caps each sweep so a backlog drains steadily', async () => {
    for (let i = 0; i < 3; i += 1) {
      await seedSignal({ createdAt: new Date(Date.now() - 20 * 60_000) });
    }
    const due = await dueOutcomes(db, { lookbackMs: 48 * HOUR, limitPerHorizon: 2 });
    expect(due.filter((d) => d.horizon === '1m')).toHaveLength(2);
  });
});

describe('trackedPools — retention for outcome measurement (§21)', () => {
  const tailConfig = { chainId: CHAIN, maxTokenAgeMinutes: 360, outcomeRetentionHours: 25 };

  it('keeps indexing a pool past discovery while a signal is still being measured', async () => {
    // Without this the 24h horizon has no trades at all: discovery retention is
    // 6h, and backfilling by eth_getLogs is ~4,300 requests per pool.
    const { poolId } = await seedSignal({
      discoveredAt: new Date(Date.now() - 20 * HOUR),
      createdAt: new Date(Date.now() - 20 * HOUR),
    });
    const tracked = await trackedPools(db, tailConfig);
    expect(tracked.map((p) => p.id)).toContain(poolId);
  });

  it('drops a pool past discovery with no signal to measure', async () => {
    const { poolId } = await seedSignal({ discoveredAt: new Date(Date.now() - 20 * HOUR) });
    await db.execute(sql`DELETE FROM ${signals}`);

    const tracked = await trackedPools(db, tailConfig);
    expect(tracked.map((p) => p.id)).not.toContain(poolId);
  });

  it('drops a pool once its signal is older than the retention', async () => {
    await seedSignal({
      discoveredAt: new Date(Date.now() - 40 * HOUR),
      createdAt: new Date(Date.now() - 30 * HOUR),
    });
    expect(await trackedPools(db, tailConfig)).toHaveLength(0);
  });

  it('still keeps a freshly discovered pool that has no signal yet', async () => {
    const { poolId } = await seedSignal({ discoveredAt: new Date() });
    await db.execute(sql`DELETE FROM ${signals}`);

    const tracked = await trackedPools(db, tailConfig);
    expect(tracked.map((p) => p.id)).toContain(poolId);
  });

  it('does not retain a pool for an EXPIRED signal', async () => {
    await seedSignal({
      state: 'EXPIRED',
      discoveredAt: new Date(Date.now() - 20 * HOUR),
      createdAt: new Date(Date.now() - 20 * HOUR),
    });
    expect(await trackedPools(db, tailConfig)).toHaveLength(0);
  });
});
