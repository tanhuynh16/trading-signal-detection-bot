import { sql } from 'drizzle-orm';
import type { Database } from '@sdb/database';

/**
 * Find outcomes that were measured before their trade history was complete.
 *
 * Phase 7 finalised 13 of 176 rows from short windows, and nothing could ever
 * revisit them: `onConflictDoNothing` refuses to rewrite, and the reconciler's
 * `notExists` filter skips any signal/horizon that already has a row, correct
 * or not. The coverage gate stops new rows being written that way; this repairs
 * the ones already wrong, and the `incomplete_tail_coverage` rows the gate
 * itself records when it gives up waiting.
 *
 * Detection needs no bookkeeping — the tables already know. A trade carrying a
 * `created_at` later than the outcome's `evaluated_at` is proof that the row
 * was computed without it. This is the exact query that found the original 13.
 *
 * Self-terminating: once repaired under full coverage, `evaluated_at` moves
 * past every trade's `created_at` and the row stops matching. The lookback
 * bound stops the sweep trawling ancient history forever.
 */

export type RepairConfig = {
  /** How far back to look for damage. */
  lookbackMs: number;
  /** Cap per sweep, so a backlog drains steadily rather than all at once. */
  limit: number;
};

export type DamagedOutcome = {
  signalId: string;
  horizon: string;
  reason: 'late_trades' | 'incomplete_tail_coverage';
};

const HORIZON_INTERVAL = sql`(CASE signal_outcomes.horizon
  WHEN '1m'  THEN interval '1 minute'
  WHEN '5m'  THEN interval '5 minutes'
  WHEN '15m' THEN interval '15 minutes'
  WHEN '30m' THEN interval '30 minutes'
  WHEN '1h'  THEN interval '1 hour'
  WHEN '4h'  THEN interval '4 hours'
  WHEN '24h' THEN interval '24 hours'
END)`;

export async function damagedOutcomes(
  db: Database,
  config: RepairConfig,
  now: Date = new Date(),
): Promise<DamagedOutcome[]> {
  const cutoff = new Date(now.getTime() - config.lookbackMs).toISOString();

  // Raw SQL: the horizon label has to become an interval to reconstruct each
  // window, which the query builder cannot express.
  const rows = await db.execute<{
    signal_id: string;
    horizon: string;
    reason: DamagedOutcome['reason'];
  }>(sql`
    SELECT signal_outcomes.signal_id,
           signal_outcomes.horizon,
           CASE WHEN signal_outcomes.failure_reason = 'incomplete_tail_coverage'
                THEN 'incomplete_tail_coverage' ELSE 'late_trades' END AS reason
    FROM signal_outcomes
    JOIN signals ON signals.id = signal_outcomes.signal_id
    WHERE signals.created_at >= ${cutoff}::timestamptz
      AND (
        signal_outcomes.failure_reason = 'incomplete_tail_coverage'
        OR EXISTS (
          SELECT 1 FROM trades
          WHERE trades.pool_id = signals.pool_id
            AND trades.created_at > signal_outcomes.evaluated_at
            AND trades.occurred_at >= signals.created_at
            AND trades.occurred_at <= signals.created_at + ${HORIZON_INTERVAL}
        )
      )
    ORDER BY signals.created_at ASC
    LIMIT ${config.limit}
  `);

  return rows.map((row) => ({
    signalId: row.signal_id,
    horizon: row.horizon,
    reason: row.reason,
  }));
}
