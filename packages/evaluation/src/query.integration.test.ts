import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  createDatabase,
  featureSets,
  pools,
  riskResults,
  signalAlerts,
  signalOutcomes,
  signalTransitions,
  signals,
  tokenSnapshots,
  tokens,
} from '@sdb/database';
import { byBandAndHorizon } from './aggregate.js';
import { scoreBands } from './bands.js';
import { horizonsPresent, loadSamples, strategyVersions } from './query.js';

/** Requires: docker compose up -d postgres */
const url = process.env.TEST_DATABASE_URL ?? 'postgres://sdb:sdb@localhost:5432/sdb';
const { db, close } = createDatabase(url, { max: 4 });

const CHAIN = 8453;
const WETH = '0x4200000000000000000000000000000000000006';
const bands = scoreBands({ interestingThreshold: 60, strongThreshold: 75 });

let seq = 0;
const addr = (n: number) => `0x0${n.toString(16).padStart(39, '0')}`;

async function seedOutcome(over: {
  alphaScore: number;
  returnPct: number | null;
  horizon?: string;
  strategyVersion?: string;
  tokenId?: string;
  failureReason?: string;
  coverage?: string;
  components?: unknown;
}) {
  seq += 1;
  let tokenId = over.tokenId;
  if (!tokenId) {
    const [token] = await db
      .insert(tokens)
      .values({
        chainId: CHAIN,
        address: addr(6000 + seq),
        symbol: `EVAL${seq}`,
        firstSeenAt: new Date(),
        decimals: 18,
      })
      .returning({ id: tokens.id });
    tokenId = token!.id;
  }
  const [pool] = await db
    .insert(pools)
    .values({
      tokenId,
      chainId: CHAIN,
      dex: 'uniswap-v2',
      address: `0xe${(6000 + seq).toString(16).padStart(39, '0')}`,
      quoteTokenAddress: WETH,
      discoveredAt: new Date(),
      blockNumber: 1n,
      transactionHash: `0x${(6000 + seq).toString(16).padStart(64, '0')}`,
    })
    .returning({ id: pools.id });
  const [signal] = await db
    .insert(signals)
    .values({
      tokenId,
      poolId: pool!.id,
      state: 'WATCHING',
      alphaScore: over.alphaScore.toFixed(3),
      components: over.components ?? [
        { name: 'liquidity', raw: over.alphaScore, weight: 0.2 },
        { name: 'smartMoney', raw: null, weight: 0.3 },
      ],
      coverage: over.coverage ?? '0.7000',
      strategyVersion: over.strategyVersion ?? 'base-meme-v1',
      alertLevel: 'NONE',
      signalPriceUsd: '1000',
    })
    .returning({ id: signals.id });

  await db.insert(signalOutcomes).values({
    signalId: signal!.id,
    horizon: over.horizon ?? '1m',
    evaluatedAt: new Date(),
    returnPct: over.returnPct === null ? null : over.returnPct.toFixed(6),
    maxRunupPct: over.returnPct === null ? null : Math.max(0, over.returnPct).toFixed(6),
    maxDrawdownPct: over.returnPct === null ? null : Math.min(0, over.returnPct).toFixed(6),
    tradeCount: over.returnPct === null ? null : 5,
    failureReason: over.failureReason ?? null,
  });

  return { tokenId, signalId: signal!.id };
}

const truncate = sql`TRUNCATE ${signalOutcomes}, ${signalAlerts}, ${signalTransitions},
  ${signals}, ${riskResults}, ${featureSets}, ${tokenSnapshots}, ${pools}, ${tokens}
  RESTART IDENTITY CASCADE`;

beforeEach(async () => {
  await db.execute(truncate);
});
afterAll(async () => {
  await db.execute(truncate);
  await close();
});

describe('loadSamples', () => {
  it('joins outcomes to the frozen signal that produced them', async () => {
    await seedOutcome({ alphaScore: 82, returnPct: 25 });
    const [row] = await loadSamples(db);

    expect(row!.alphaScore).toBeCloseTo(82, 3);
    expect(row!.returnPct).toBeCloseTo(25, 6);
    expect(row!.horizon).toBe('1m');
    expect(row!.strategyVersion).toBe('base-meme-v1');
  });

  it('keeps an unmeasured component null rather than zero', async () => {
    // §15 carried into analysis: `smartMoney: null` must not become a 0 that
    // then gets correlated against returns.
    await seedOutcome({ alphaScore: 50, returnPct: 5 });
    const [row] = await loadSamples(db);

    expect(row!.components['liquidity']).toBeCloseTo(50, 6);
    expect(row!.components['smartMoney']).toBeNull();
  });

  it('carries an unmeasurable outcome through with its reason', async () => {
    await seedOutcome({
      alphaScore: 50,
      returnPct: null,
      failureReason: 'incomplete_tail_coverage',
    });
    const [row] = await loadSamples(db);

    expect(row!.returnPct).toBeNull();
    expect(row!.failureReason).toBe('incomplete_tail_coverage');
  });

  it('filters by strategy version, horizon and date', async () => {
    await seedOutcome({ alphaScore: 50, returnPct: 1, strategyVersion: 'other-v2' });
    await seedOutcome({ alphaScore: 50, returnPct: 2, horizon: '5m' });

    expect(await loadSamples(db, { strategyVersion: 'other-v2' })).toHaveLength(1);
    expect(await loadSamples(db, { horizon: '5m' })).toHaveLength(1);
    expect(await loadSamples(db, { since: new Date(Date.now() + 60_000) })).toHaveLength(0);
  });
});

describe('strategy versions are never pooled', () => {
  it('lists each version present so the report can separate them', async () => {
    await seedOutcome({ alphaScore: 50, returnPct: 1 });
    await seedOutcome({ alphaScore: 50, returnPct: 2, strategyVersion: 'other-v2' });

    expect(await strategyVersions(db)).toEqual(['base-meme-v1', 'other-v2']);
  });

  it('keeps outcomes from different versions in separate samples', async () => {
    // Signals scored under different weights are not comparable evidence.
    await seedOutcome({ alphaScore: 50, returnPct: 100 });
    await seedOutcome({ alphaScore: 50, returnPct: -100, strategyVersion: 'other-v2' });

    const base = await loadSamples(db, { strategyVersion: 'base-meme-v1' });
    expect(base).toHaveLength(1);
    expect(base[0]!.returnPct).toBeCloseTo(100, 6);
  });
});

describe('horizonsPresent', () => {
  it('orders horizons by real duration, not alphabetically', async () => {
    // '15m' sorts before '1m' as a string; the report must not claim 15m came
    // first in time.
    for (const horizon of ['15m', '1m', '5m']) {
      await seedOutcome({ alphaScore: 50, returnPct: 1, horizon });
    }
    expect(await horizonsPresent(db)).toEqual(['1m', '5m', '15m']);
  });
});

describe('end to end over real rows', () => {
  it('bands real outcomes and applies the sample guard', async () => {
    for (const score of [45, 47, 49]) {
      await seedOutcome({ alphaScore: score, returnPct: 10 });
    }
    await seedOutcome({ alphaScore: 80, returnPct: 50 });

    const samples = await loadSamples(db);
    const cells = byBandAndHorizon(samples, bands, ['1m'], { minSampleSize: 3 });

    const watching = cells.find((c) => c.band === 'WATCHING')!;
    expect(watching.n).toBe(3);
    expect(watching.sufficient).toBe(true);
    expect(watching.returns.median).toBeCloseTo(10, 6);

    const strong = cells.find((c) => c.band === 'STRONG')!;
    expect(strong.n).toBe(1);
    expect(strong.sufficient).toBe(false);
  });

  it('reports one token with several signals as one token', async () => {
    const { tokenId } = await seedOutcome({ alphaScore: 50, returnPct: 1 });
    await seedOutcome({ alphaScore: 50, returnPct: 2, tokenId });
    await seedOutcome({ alphaScore: 50, returnPct: 3, tokenId });

    const cells = byBandAndHorizon(await loadSamples(db), bands, ['1m'], {
      minSampleSize: 3,
    });
    expect(cells[0]!.n).toBe(3);
    expect(cells[0]!.tokens).toBe(1);
  });

  it('cross-checks the median against a SQL percentile_cont', async () => {
    // The report interpolates quantiles the same way Postgres does, so a
    // hand-written aggregate has to agree with it.
    for (const value of [-30, -5, 2, 18, 44]) {
      await seedOutcome({ alphaScore: 50, returnPct: value });
    }

    const cells = byBandAndHorizon(await loadSamples(db), bands, ['1m'], {
      minSampleSize: 1,
    });
    const [row] = await db.execute<{ p50: string; p25: string }>(sql`
      SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY return_pct) AS p50,
             percentile_cont(0.25) WITHIN GROUP (ORDER BY return_pct) AS p25
      FROM signal_outcomes WHERE return_pct IS NOT NULL`);

    expect(cells[0]!.returns.median).toBeCloseTo(Number(row!.p50), 6);
    expect(cells[0]!.returns.p25).toBeCloseTo(Number(row!.p25), 6);
  });
});
