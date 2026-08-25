import { and, desc, eq, sql } from 'drizzle-orm';
import {
  featureSets,
  pools,
  riskResults,
  signalTransitions,
  signals,
  tokenSnapshots,
  trades,
  type Database,
} from '@sdb/database';
import type { AlertLevel, AlphaScore, RiskStatus, SignalState } from '@sdb/domain';
import type { PreviousAlert } from './dedupe.js';

/**
 * Reads and writes for the signal state machine.
 *
 * A `signals` row is written on each STATE ENTRY, not on each evaluation, and
 * is never updated afterwards. §21 needs a frozen reference price per emitted
 * signal to compute returns against, and §22 requires that changing strategy
 * config cannot alter what a historical signal meant. Mutating a row in place
 * would destroy both.
 */

export type CurrentSignal = {
  id: string;
  state: SignalState;
  alphaScore: number;
  alertLevel: AlertLevel;
  createdAt: Date;
};

/** The token's most recent signal row, i.e. its current state. */
export async function currentSignal(
  db: Database,
  tokenId: string,
): Promise<CurrentSignal | null> {
  const rows = await db
    .select({
      id: signals.id,
      state: signals.state,
      alphaScore: signals.alphaScore,
      alertLevel: signals.alertLevel,
      createdAt: signals.createdAt,
    })
    .from(signals)
    .where(eq(signals.tokenId, tokenId))
    .orderBy(desc(signals.createdAt))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    state: row.state as SignalState,
    alphaScore: Number(row.alphaScore),
    alertLevel: row.alertLevel as AlertLevel,
    createdAt: row.createdAt,
  };
}

/** Most recent signal that actually carried an alert, for §18 dedup. */
export async function lastAlert(db: Database, tokenId: string): Promise<PreviousAlert | null> {
  const rows = await db
    .select({
      alertLevel: signals.alertLevel,
      alphaScore: signals.alphaScore,
      createdAt: signals.createdAt,
    })
    .from(signals)
    .where(and(eq(signals.tokenId, tokenId), sql`${signals.alertLevel} <> 'NONE'`))
    .orderBy(desc(signals.createdAt))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  return {
    level: row.alertLevel as AlertLevel,
    alphaScore: Number(row.alphaScore),
    sentAt: row.createdAt,
  };
}

/** Latest risk verdict. Absent means not yet evaluated — treated as unknown. */
export async function latestRiskStatus(
  db: Database,
  tokenId: string,
): Promise<RiskStatus | null> {
  const rows = await db
    .select({ status: riskResults.status })
    .from(riskResults)
    .where(eq(riskResults.tokenId, tokenId))
    .orderBy(desc(riskResults.evaluatedAt))
    .limit(1);
  return (rows[0]?.status as RiskStatus | undefined) ?? null;
}

export type PoolContext = {
  tokenId: string;
  poolId: string;
  discoveredAt: Date;
  liquidityUsd: number | null;
  peakLiquidityUsd: number | null;
  priceUsd: string | null;
  blockNumber: bigint | null;
  minutesSinceLastTrade: number | null;
};

/**
 * Everything the state machine needs about a pool, in one round trip each.
 *
 * Peak liquidity comes from the full snapshot history rather than the latest
 * reading, because §18's "liquidity collapse" is relative to what the pool
 * once held.
 */
export async function loadPoolContext(
  db: Database,
  poolId: string,
): Promise<PoolContext | null> {
  const rows = await db
    .select({ tokenId: pools.tokenId, poolId: pools.id, discoveredAt: pools.discoveredAt })
    .from(pools)
    .where(eq(pools.id, poolId))
    .limit(1);
  const pool = rows[0];
  if (!pool) return null;

  const [latest] = await db
    .select({
      liquidityUsd: tokenSnapshots.liquidityUsd,
      priceUsd: tokenSnapshots.priceUsd,
      blockNumber: tokenSnapshots.blockNumber,
    })
    .from(tokenSnapshots)
    .where(eq(tokenSnapshots.poolId, poolId))
    .orderBy(desc(tokenSnapshots.capturedAt))
    .limit(1);

  const peak = await db.execute<{ peak: string | null }>(
    sql`SELECT max(${tokenSnapshots.liquidityUsd}) AS peak
        FROM ${tokenSnapshots} WHERE ${tokenSnapshots.poolId} = ${poolId}`,
  );

  const lastTrade = await db.execute<{ last_at: string | null }>(
    sql`SELECT max(${trades.occurredAt}) AS last_at
        FROM ${trades} WHERE ${trades.poolId} = ${poolId}`,
  );
  const lastAt = lastTrade[0]?.last_at ? new Date(lastTrade[0].last_at) : null;

  return {
    tokenId: pool.tokenId,
    poolId: pool.poolId,
    discoveredAt: pool.discoveredAt,
    liquidityUsd: latest?.liquidityUsd != null ? Number(latest.liquidityUsd) : null,
    peakLiquidityUsd: peak[0]?.peak != null ? Number(peak[0].peak) : null,
    priceUsd: latest?.priceUsd ?? null,
    blockNumber: latest?.blockNumber ?? null,
    minutesSinceLastTrade:
      lastAt === null ? null : (Date.now() - lastAt.getTime()) / 60_000,
  };
}

/** Most recent feature set for a pool, and its id for provenance. */
export async function latestFeatureSet(
  db: Database,
  poolId: string,
): Promise<{ id: string; values: Record<string, number | null> } | null> {
  const rows = await db
    .select({ id: featureSets.id, values: featureSets.values })
    .from(featureSets)
    .where(eq(featureSets.poolId, poolId))
    .orderBy(desc(featureSets.calculatedAt))
    .limit(1);

  const row = rows[0];
  return row ? { id: row.id, values: row.values as Record<string, number | null> } : null;
}

/**
 * Record a state entry: one immutable `signals` row plus its transition.
 *
 * Both are written in one transaction — a signal without its transition would
 * break the §18 audit trail, and a transition pointing at a missing signal
 * would break the §21 outcome join.
 */
export async function recordStateEntry(
  db: Database,
  input: {
    context: PoolContext;
    fromState: SignalState | null;
    toState: SignalState;
    reason: string;
    score: AlphaScore;
    alertLevel: AlertLevel;
    featureSetId: string | null;
  },
): Promise<string> {
  return db.transaction(async (tx) => {
    const [signal] = await tx
      .insert(signals)
      .values({
        tokenId: input.context.tokenId,
        poolId: input.context.poolId,
        state: input.toState,
        alphaScore: input.score.score.toFixed(3),
        components: input.score.components,
        coverage: input.score.coverage.toFixed(4),
        strategyVersion: input.score.strategyVersion,
        featureSetId: input.featureSetId,
        alertLevel: input.alertLevel,
        // Frozen at emission; §21 computes every return against this.
        signalPriceUsd: input.context.priceUsd,
        signalBlockNumber: input.context.blockNumber,
      })
      .returning({ id: signals.id });

    await tx.insert(signalTransitions).values({
      signalId: signal!.id,
      fromState: input.fromState,
      toState: input.toState,
      reason: input.reason,
      alphaScore: input.score.score.toFixed(3),
      occurredAt: new Date(),
    });

    return signal!.id;
  });
}
