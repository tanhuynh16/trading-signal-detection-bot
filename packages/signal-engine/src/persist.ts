import { and, desc, eq, sql } from 'drizzle-orm';
import {
  featureSets,
  pools,
  riskResults,
  signalAlerts,
  signalTransitions,
  signals,
  tokenSnapshots,
  trades,
  type DbOrTx,
} from '@sdb/database';
import type {
  AlertLevel,
  AlertStatus,
  AlertTriggerReason,
  AlphaScore,
  RiskStatus,
  SignalState,
} from '@sdb/domain';
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

/**
 * Serialise every state decision for one token.
 *
 * The race this closes: two concurrent evaluations both read WATCHING, both
 * compute INTERESTING, and both insert. A unique index on (token_id, state)
 * would stop it but would also block legitimate re-entry — with
 * `downgradePolicyEnabled` a token may go STRONG_SIGNAL -> WATCHING ->
 * INTERESTING -> WATCHING, which §18 explicitly permits. Serialising the
 * read-decide-write sequence closes the race without narrowing the spec.
 *
 * The lock is transaction-scoped, so it is released on commit OR rollback with
 * no cleanup path to get wrong. `hashtext` maps the uuid into the int4 the lock
 * API takes; a collision merely serialises two unrelated tokens, which costs
 * contention and never correctness.
 */
export async function lockToken(tx: DbOrTx, tokenId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${tokenId}))`);
}

export type CurrentSignal = {
  id: string;
  state: SignalState;
  alphaScore: number;
  alertLevel: AlertLevel;
  createdAt: Date;
};

/** The token's most recent signal row, i.e. its current state. */
export async function currentSignal(
  db: DbOrTx,
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
    // Order by insert sequence, not created_at: now() is transaction-start
    // time, so overlapping transactions can invert the apparent order and
    // return a stale state.
    .orderBy(desc(signals.seq))
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

/**
 * The baseline §18 dedup measures against: the most recent alert that was
 * actually delivered or is on its way.
 *
 * SENT is delivery. PENDING is in flight and counts too — otherwise a second
 * alert would be queued for the same fact before the first is sent, and until
 * Phase 6 exists nothing ever reaches SENT so every evaluation would re-alert.
 *
 * FAILED and SUPPRESSED are deliberately excluded: a failed delivery must
 * become re-alertable rather than silently swallowing the signal (§20), and a
 * suppressed decision was never an alert at all.
 */
export async function lastAlert(db: DbOrTx, tokenId: string): Promise<PreviousAlert | null> {
  const rows = await db
    .select({
      alertLevel: signalAlerts.alertLevel,
      alphaScore: signalAlerts.alphaScore,
      createdAt: signalAlerts.createdAt,
      sentAt: signalAlerts.sentAt,
    })
    .from(signalAlerts)
    .where(
      and(
        eq(signalAlerts.tokenId, tokenId),
        sql`${signalAlerts.status} IN ('SENT', 'PENDING')`,
      ),
    )
    .orderBy(desc(signalAlerts.seq))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  return {
    level: row.alertLevel as AlertLevel,
    alphaScore: Number(row.alphaScore),
    // Cooldown runs from delivery when we have it, else from the decision.
    sentAt: row.sentAt ?? row.createdAt,
  };
}

export type AlertDecisionInput = {
  signalId: string;
  tokenId: string;
  featureSetId: string;
  alertLevel: AlertLevel;
  status: AlertStatus;
  triggerReason: AlertTriggerReason | null;
  suppressionReason: string | null;
  alphaScore: number;
};

/**
 * Record one alert decision, emitted or suppressed.
 *
 * Conflict-safe on (signal_id, feature_set_id): a retried job re-reads the same
 * feature set and its insert is a no-op, so retries cannot multiply alerts.
 * Returns null when the decision already existed.
 */
export async function recordAlertDecision(
  tx: DbOrTx,
  input: AlertDecisionInput,
): Promise<string | null> {
  const rows = await tx
    .insert(signalAlerts)
    .values({
      signalId: input.signalId,
      tokenId: input.tokenId,
      featureSetId: input.featureSetId,
      alertLevel: input.alertLevel,
      status: input.status,
      triggerReason: input.triggerReason,
      suppressionReason: input.suppressionReason,
      alphaScore: input.alphaScore.toFixed(3),
    })
    .onConflictDoNothing({
      target: [signalAlerts.signalId, signalAlerts.featureSetId],
    })
    .returning({ id: signalAlerts.id });
  return rows[0]?.id ?? null;
}

/** Latest risk verdict. Absent means not yet evaluated — treated as unknown. */
export async function latestRiskStatus(
  db: DbOrTx,
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
  /**
   * Block time of `blockNumber` — the chain's clock, not ours.
   *
   * §21 outcome windows are anchored on this rather than on the signal row's
   * `created_at`, because the trades that fill those windows are timestamped in
   * block time and the two clocks were measured to disagree by up to 63s.
   */
  blockTime: Date | null;
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
  db: DbOrTx,
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
      observedAt: tokenSnapshots.observedAt,
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
    blockTime: latest?.observedAt ?? null,
    minutesSinceLastTrade:
      lastAt === null ? null : (Date.now() - lastAt.getTime()) / 60_000,
  };
}

/** Most recent feature set for a pool, and its id for provenance. */
export async function latestFeatureSet(
  db: DbOrTx,
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
  tx: DbOrTx,
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
  // Runs inside the caller's transaction, which already holds the per-token
  // advisory lock. Opening a nested transaction here would release nothing and
  // only obscure where the lock is held.
  {
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
        signalBlockTime: input.context.blockTime,
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
  }
}
