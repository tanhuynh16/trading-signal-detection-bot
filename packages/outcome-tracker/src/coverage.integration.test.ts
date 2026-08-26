import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { inArray, sql } from 'drizzle-orm';
import {
  createDatabase,
  discoveryCursors,
  featureSets,
  pools,
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
import { advanceCursor, readCursorState } from '@sdb/discovery';
import { SWAP_TAIL_SOURCE } from '@sdb/snapshot-engine';
import { ONE_USD } from '@sdb/market-data';
import { parseScaled } from '@sdb/shared';
import { evaluateOutcome, type QuoteInfo } from './outcome.js';
import { damagedOutcomes } from './repair.js';
import { recordQuoteSample } from './quote-samples.js';

/** Requires: docker compose up -d postgres */
const url = process.env.TEST_DATABASE_URL ?? 'postgres://sdb:sdb@localhost:5432/sdb';
const { db, close } = createDatabase(url, { max: 4 });

const CHAIN = 8453;
const WETH = '0x4200000000000000000000000000000000000006';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

const quotes: QuoteInfo = {
  decimalsFor: (a) => (a.toLowerCase() === USDC ? 6 : 18),
  fixedUsdFor: (a) => (a.toLowerCase() === USDC ? ONE_USD : null),
};

const gate = { enabled: true, deferIntervalMs: 30_000, maxDeferMs: 1_800_000 };
const config = { minQuoteCoverage: 0.8, maxSampleAgeMs: 300_000, coverage: gate };

let seq = 0;
const addr = (n: number) => `0x0${n.toString(16).padStart(39, '0')}`;

async function seedSignal(over: { createdAt?: Date; signalPriceUsd?: string } = {}) {
  seq += 1;
  const [token] = await db
    .insert(tokens)
    .values({
      chainId: CHAIN,
      address: addr(4000 + seq),
      symbol: `COV${seq}`,
      firstSeenAt: new Date(),
      decimals: 18,
    })
    .returning({ id: tokens.id });
  const [pool] = await db
    .insert(pools)
    .values({
      tokenId: token!.id,
      chainId: CHAIN,
      dex: 'uniswap-v2',
      address: `0xf${(4000 + seq).toString(16).padStart(39, '0')}`,
      quoteTokenAddress: WETH,
      discoveredAt: new Date(),
      blockNumber: 1n,
      transactionHash: `0x${(4000 + seq).toString(16).padStart(64, '0')}`,
    })
    .returning({ id: pools.id });
  const [signal] = await db
    .insert(signals)
    .values({
      tokenId: token!.id,
      poolId: pool!.id,
      state: 'STRONG_SIGNAL',
      alphaScore: '84.000',
      components: [],
      coverage: '0.7000',
      strategyVersion: 'base-meme-v1',
      alertLevel: 'STRONG',
      signalPriceUsd: over.signalPriceUsd ?? '1000',
      ...(over.createdAt ? { createdAt: over.createdAt } : {}),
    })
    .returning({ id: signals.id, createdAt: signals.createdAt });

  return { signalId: signal!.id, poolId: pool!.id, createdAt: signal!.createdAt };
}

/** One swap: `tokens` out for `eth` in. Candidate sorts below WETH, so token0. */
async function seedTrade(
  poolId: string,
  input: { tokens: string; eth: string; occurredAt: Date; block: number },
) {
  await db.insert(trades).values({
    poolId,
    txHash: `0x${input.block.toString(16).padStart(64, '0')}`,
    logIndex: input.block,
    wallet: addr(1),
    side: 'OUT0',
    blockNumber: BigInt(input.block),
    occurredAt: input.occurredAt,
    baseAmountRaw: `-${parseScaled(input.tokens).toString()}`,
    quoteAmountRaw: parseScaled(input.eth).toString(),
  });
}

/** Pretend the swap tail has indexed up to this block time. */
const setWatermark = (time: Date, block = 1000n) =>
  advanceCursor(db, SWAP_TAIL_SOURCE, block, time);

const truncate = sql`TRUNCATE ${signalOutcomes}, ${signalAlerts}, ${signalTransitions},
  ${signals}, ${riskResults}, ${featureSets}, ${tokenSnapshots}, ${trades}, ${pools},
  ${tokens}, ${quotePriceSamples} RESTART IDENTITY CASCADE`;

/** Only the cursor rows this file owns; the table is shared. */
const cleanCursors = () =>
  db.delete(discoveryCursors).where(inArray(discoveryCursors.source, [SWAP_TAIL_SOURCE, 'cursor-without-time']));

beforeEach(async () => {
  await db.execute(truncate);
  await cleanCursors();
});
afterAll(async () => {
  await db.execute(truncate);
  await cleanCursors();
  await close();
});

describe('the Phase 7 defect, reproduced and closed', () => {
  it('defers instead of finalising a window the tail has not reached', async () => {
    // The measured failure: signal 36dccbb0's 1m outcome was written with
    // trade_count 0 and return_pct 0.000000 -- a "measured flat return" -- while
    // four trades worth +4.95% sat un-ingested. The gate must refuse to write.
    const { signalId, createdAt } = await seedSignal();
    await setWatermark(new Date(createdAt.getTime() + 30_000)); // tail 30s short

    const result = await evaluateOutcome(db, quotes, config, { signalId, horizon: '1m' });

    expect(result.status).toBe('deferred');
    expect(await db.select().from(signalOutcomes)).toHaveLength(0);
  });

  it('measures the true value once the tail catches up', async () => {
    const { signalId, poolId, createdAt } = await seedSignal();
    await recordQuoteSample(db, {
      chainId: CHAIN,
      tokenAddress: WETH,
      priceUsd: parseScaled('2000'),
      observedAt: new Date(createdAt.getTime() + 30_000),
    });
    // 1 token for 0.75 WETH at $2000 = $1500, a 50% gain on a $1000 entry.
    await seedTrade(poolId, {
      tokens: '1',
      eth: '0.75',
      occurredAt: new Date(createdAt.getTime() + 30_000),
      block: 10,
    });

    await setWatermark(new Date(createdAt.getTime() + 30_000));
    expect((await evaluateOutcome(db, quotes, config, { signalId, horizon: '1m' })).status)
      .toBe('deferred');

    await setWatermark(new Date(createdAt.getTime() + 60_000));
    const result = await evaluateOutcome(db, quotes, config, { signalId, horizon: '1m' });

    expect(result.status).toBe('recorded');
    if (result.status === 'recorded') {
      expect(result.metrics.returnPct).toBe('50');
      expect(result.metrics.tradeCount).toBe(1);
    }
  });

  it('records a reason rather than a number once it gives up waiting', async () => {
    // A stalled tail must not leave the horizon unrecorded forever, but it must
    // not publish a figure derived from a window known to be short either.
    const createdAt = new Date(Date.now() - 60 * 60_000);
    const { signalId } = await seedSignal({ createdAt });
    await setWatermark(new Date(createdAt.getTime() + 10_000));

    const result = await evaluateOutcome(db, quotes, config, { signalId, horizon: '1m' });

    expect(result.status).toBe('recorded');
    if (result.status === 'recorded') {
      expect(result.metrics.failureReason).toBe('incomplete_tail_coverage');
      expect(result.metrics.returnPct).toBeNull();
      expect(result.metrics.maxRunupPct).toBeNull();
    }
  });

  it('measures immediately when the gate is disabled', async () => {
    // The escape hatch is honest about what it restores: pre-gate behaviour.
    const { signalId } = await seedSignal();
    const off = { ...config, coverage: { ...gate, enabled: false } };
    expect((await evaluateOutcome(db, quotes, off, { signalId, horizon: '1m' })).status)
      .toBe('recorded');
  });
});

describe('watermark bookkeeping', () => {
  it('never walks the time watermark backwards', async () => {
    // A drain finishing out of order must not make coverage look smaller than
    // it is -- or, worse, larger.
    const later = new Date('2026-08-26T12:05:00Z');
    await setWatermark(later, 2000n);
    await setWatermark(new Date('2026-08-26T12:00:00Z'), 1000n);

    const state = await readCursorState(db, SWAP_TAIL_SOURCE);
    expect(state!.lastProcessedBlockTime).toEqual(later);
    expect(state!.lastProcessedBlock).toBe(2000n);
  });

  it('leaves the time untouched when a caller does not know it', async () => {
    // The factories and transfer-tail advance without a time; that must not
    // erase a watermark the swap tail established.
    const known = new Date('2026-08-26T12:00:00Z');
    await setWatermark(known, 1000n);
    await advanceCursor(db, SWAP_TAIL_SOURCE, 2000n);

    const state = await readCursorState(db, SWAP_TAIL_SOURCE);
    expect(state!.lastProcessedBlockTime).toEqual(known);
    expect(state!.lastProcessedBlock).toBe(2000n);
  });

  it('records nothing for a source that never stamps a time', async () => {
    await advanceCursor(db, 'cursor-without-time', 500n);
    const state = await readCursorState(db, 'cursor-without-time');
    expect(state!.lastProcessedBlockTime).toBeNull();
  });
});

describe('repair sweep', () => {
  const repairConfig = { lookbackMs: 48 * 3_600_000, limit: 100 };

  it('finds an outcome whose window gained trades after it was evaluated', async () => {
    // Exactly how the original 13 were found.
    const createdAt = new Date(Date.now() - 30 * 60_000);
    const { signalId, poolId } = await seedSignal({ createdAt });
    await setWatermark(new Date(createdAt.getTime() + 60_000));
    await evaluateOutcome(db, quotes, config, {
      signalId,
      horizon: '1m',
      now: new Date(createdAt.getTime() + 60_000),
    });

    // A trade for that window lands afterwards.
    await seedTrade(poolId, {
      tokens: '1',
      eth: '0.75',
      occurredAt: new Date(createdAt.getTime() + 30_000),
      block: 11,
    });

    const damaged = await damagedOutcomes(db, repairConfig);
    expect(damaged).toEqual([{ signalId, horizon: '1m', reason: 'late_trades' }]);
  });

  it('does not flag an outcome whose history was already complete', async () => {
    const createdAt = new Date(Date.now() - 30 * 60_000);
    const { signalId, poolId } = await seedSignal({ createdAt });
    await seedTrade(poolId, {
      tokens: '1',
      eth: '0.75',
      occurredAt: new Date(createdAt.getTime() + 30_000),
      block: 12,
    });
    await recordQuoteSample(db, {
      chainId: CHAIN,
      tokenAddress: WETH,
      priceUsd: parseScaled('2000'),
      observedAt: new Date(createdAt.getTime() + 30_000),
    });
    await setWatermark(new Date(createdAt.getTime() + 60_000));
    await evaluateOutcome(db, quotes, config, { signalId, horizon: '1m' });

    expect(await damagedOutcomes(db, repairConfig)).toEqual([]);
  });

  it('flags a row the gate gave up on, so it is retried when coverage lands', async () => {
    const createdAt = new Date(Date.now() - 60 * 60_000);
    const { signalId } = await seedSignal({ createdAt });
    await setWatermark(new Date(createdAt.getTime() + 10_000));
    await evaluateOutcome(db, quotes, config, { signalId, horizon: '1m' });

    const damaged = await damagedOutcomes(db, repairConfig);
    expect(damaged).toEqual([
      { signalId, horizon: '1m', reason: 'incomplete_tail_coverage' },
    ]);
  });

  it('restates the metrics in place and bumps the revision', async () => {
    const createdAt = new Date(Date.now() - 30 * 60_000);
    const { signalId, poolId } = await seedSignal({ createdAt });
    await setWatermark(new Date(createdAt.getTime() + 60_000));

    // Measured with nothing indexed: a "flat" return, exactly the Phase 7 shape.
    const first = await evaluateOutcome(db, quotes, config, {
      signalId,
      horizon: '1m',
      now: new Date(createdAt.getTime() + 60_000),
    });
    expect(first.status === 'recorded' && first.metrics.returnPct).toBe('0');

    await seedTrade(poolId, {
      tokens: '1',
      eth: '0.75',
      occurredAt: new Date(createdAt.getTime() + 30_000),
      block: 13,
    });
    await recordQuoteSample(db, {
      chainId: CHAIN,
      tokenAddress: WETH,
      priceUsd: parseScaled('2000'),
      observedAt: new Date(createdAt.getTime() + 30_000),
    });

    const repaired = await evaluateOutcome(db, quotes, config, {
      signalId,
      horizon: '1m',
      replace: true,
    });
    expect(repaired.status === 'recorded' && repaired.metrics.returnPct).toBe('50');

    const rows = await db.select().from(signalOutcomes);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.returnPct)).toBe(50);
    expect(rows[0]!.revision).toBe(1);
    expect(rows[0]!.tradeCount).toBe(1);

    // And the row stops being damaged, so the sweep terminates.
    expect(await damagedOutcomes(db, repairConfig)).toEqual([]);
  });

  it('leaves the row alone while coverage is still short', async () => {
    // Repairing from a short window would swap one wrong number for another.
    const createdAt = new Date(Date.now() - 30 * 60_000);
    const { signalId } = await seedSignal({ createdAt });
    await setWatermark(new Date(createdAt.getTime() + 60_000));
    await evaluateOutcome(db, quotes, config, { signalId, horizon: '5m' });

    await db.execute(sql`DELETE FROM ${discoveryCursors}`);
    await setWatermark(new Date(createdAt.getTime() + 60_000));

    const result = await evaluateOutcome(db, quotes, config, {
      signalId,
      horizon: '15m',
      replace: true,
      now: createdAt,
    });
    expect(result.status).toBe('deferred');
  });

  it('ignores damage older than the lookback', async () => {
    const createdAt = new Date(Date.now() - 96 * 3_600_000);
    const { signalId } = await seedSignal({ createdAt });
    await setWatermark(new Date(createdAt.getTime() + 10_000));
    await evaluateOutcome(db, quotes, config, { signalId, horizon: '1m' });

    expect(await damagedOutcomes(db, { lookbackMs: 48 * 3_600_000, limit: 100 })).toEqual([]);
  });
});
