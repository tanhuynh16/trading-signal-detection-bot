import { desc, eq, sql } from 'drizzle-orm';
import {
  pools,
  riskResults,
  signalAlerts,
  signals,
  tokenSnapshots,
  tokens,
  type Database,
} from '@sdb/database';
import type { AlertLevel, AlertTriggerReason, RiskFlag, ScoreComponent } from '@sdb/domain';
import { ageMinutes } from '@sdb/shared';
import type { AlertPayload } from './format.js';

/**
 * Assemble everything §20 requires for one alert.
 *
 * Reads the alert, its canonical signal (score and component breakdown), the
 * token and pool, the latest snapshot for market cap and liquidity, and the
 * latest risk verdict for warnings.
 */
export async function loadAlertPayload(
  db: Database,
  alertId: string,
): Promise<AlertPayload | null> {
  const rows = await db
    .select({
      alertLevel: signalAlerts.alertLevel,
      triggerReason: signalAlerts.triggerReason,
      alphaScore: signalAlerts.alphaScore,
      tokenId: signalAlerts.tokenId,
      components: signals.components,
      coverage: signals.coverage,
      poolId: signals.poolId,
      symbol: tokens.symbol,
      tokenAddress: tokens.address,
      poolAddress: pools.address,
      discoveredAt: pools.discoveredAt,
    })
    .from(signalAlerts)
    .innerJoin(signals, eq(signalAlerts.signalId, signals.id))
    .innerJoin(tokens, eq(signalAlerts.tokenId, tokens.id))
    .innerJoin(pools, eq(signals.poolId, pools.id))
    .where(eq(signalAlerts.id, alertId))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  const [snapshot] = await db
    .select({
      marketCapUsd: tokenSnapshots.marketCapUsd,
      liquidityUsd: tokenSnapshots.liquidityUsd,
    })
    .from(tokenSnapshots)
    .where(eq(tokenSnapshots.poolId, row.poolId))
    .orderBy(desc(tokenSnapshots.capturedAt))
    .limit(1);

  const [risk] = await db
    .select({ status: riskResults.status, flags: riskResults.flags })
    .from(riskResults)
    .where(eq(riskResults.tokenId, row.tokenId))
    .orderBy(desc(riskResults.evaluatedAt))
    .limit(1);

  return {
    alertLevel: row.alertLevel as AlertLevel,
    symbol: row.symbol,
    tokenAddress: row.tokenAddress,
    poolAddress: row.poolAddress,
    ageMinutes: ageMinutes(row.discoveredAt),
    // Null stays null all the way to the message, which prints "not measured"
    // rather than $0 (§15's discipline, carried through to the alert).
    marketCapUsd: snapshot?.marketCapUsd != null ? Number(snapshot.marketCapUsd) : null,
    liquidityUsd: snapshot?.liquidityUsd != null ? Number(snapshot.liquidityUsd) : null,
    alphaScore: Number(row.alphaScore),
    coverage: Number(row.coverage),
    components: (row.components ?? []) as ScoreComponent[],
    riskStatus: risk?.status ?? null,
    riskFlags: (risk?.flags ?? []) as RiskFlag[],
    triggerReason: row.triggerReason as AlertTriggerReason | null,
  };
}

/**
 * Mark an alert delivered.
 *
 * Guarded on the current status so a duplicate job cannot re-send: only a
 * PENDING row transitions, and `sent_at` becomes the cooldown baseline §18
 * measures against.
 */
export async function markSent(db: Database, alertId: string): Promise<boolean> {
  const rows = await db
    .update(signalAlerts)
    .set({ status: 'SENT', sentAt: new Date() })
    .where(sql`${signalAlerts.id} = ${alertId} AND ${signalAlerts.status} = 'PENDING'`)
    .returning({ id: signalAlerts.id });
  return rows.length > 0;
}

/**
 * Mark an alert permanently undeliverable, after bounded retries.
 *
 * §20 requires that the signal is not discarded. It is not: Phase 5.1's dedup
 * counts only SENT and PENDING, so a FAILED alert makes the token eligible to
 * alert again on the next evaluation rather than going silent.
 */
export async function markFailed(db: Database, alertId: string): Promise<boolean> {
  const rows = await db
    .update(signalAlerts)
    .set({ status: 'FAILED' })
    .where(sql`${signalAlerts.id} = ${alertId} AND ${signalAlerts.status} = 'PENDING'`)
    .returning({ id: signalAlerts.id });
  return rows.length > 0;
}

/** Alerts left PENDING — used to requeue after a restart. */
export async function pendingAlerts(db: Database, limit = 100): Promise<string[]> {
  const rows = await db
    .select({ id: signalAlerts.id })
    .from(signalAlerts)
    .where(eq(signalAlerts.status, 'PENDING'))
    .orderBy(signalAlerts.seq)
    .limit(limit);
  return rows.map((row) => row.id);
}
