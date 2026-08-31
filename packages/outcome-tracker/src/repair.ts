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
  reason: 'late_trades' | 'incomplete_tail_coverage' | 'reorg_rollback';
};

/**
 * Where the outcome window starts, on the chain's clock.
 *
 * Must match `evaluateOutcome`'s anchor exactly, or this sweep reconstructs a
 * different window than the one that was measured and either misses damage or
 * invents it (ADR 0022).
 */
const WINDOW_START = sql`coalesce(signals.signal_block_time, signals.created_at)`;

const HORIZON_INTERVAL = sql`(CASE signal_outcomes.horizon
  WHEN '1m'  THEN interval '1 minute'
  WHEN '5m'  THEN interval '5 minutes'
  WHEN '15m' THEN interval '15 minutes'
  WHEN '30m' THEN interval '30 minutes'
  WHEN '1h'  THEN interval '1 hour'
  WHEN '4h'  THEN interval '4 hours'
  WHEN '24h' THEN interval '24 hours'
END)`;

/**
 * Was this outcome measured from trades a reorg later deleted?
 *
 * Most reorg damage needs no special case: the canonical replacement swaps are
 * re-ingested with a fresh `created_at`, so the `late_trades` clause below
 * already catches them. This closes the one case it cannot see — the reorg
 * removed trades and the canonical chain has none to put back, so nothing is
 * re-inserted and nothing looks late. That is also the case where the number is
 * most wrong, because it was computed from swaps that never happened.
 *
 * A rollback deletes everything above its rewind point, so any window reaching
 * past `rewound_to_block_time` may have lost content. A null rewind time means
 * the bound could not be read, and an unknown bound is treated as overlapping
 * — re-measuring a healthy outcome costs one recomputation, while skipping a
 * damaged one leaves a wrong number in the evaluation forever.
 */
const REORG_OVERLAP = sql`EXISTS (
  SELECT 1 FROM reorg_events
  WHERE reorg_events.occurred_at > signal_outcomes.evaluated_at
    AND (
      reorg_events.rewound_to_block_time IS NULL
      OR coalesce(signals.signal_block_time, signals.created_at) + ${HORIZON_INTERVAL}
         >= reorg_events.rewound_to_block_time
    )
)`;

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
           CASE
             WHEN ${REORG_OVERLAP} THEN 'reorg_rollback'
             WHEN signal_outcomes.failure_reason = 'incomplete_tail_coverage'
               THEN 'incomplete_tail_coverage'
             ELSE 'late_trades'
           END AS reason
    FROM signal_outcomes
    JOIN signals ON signals.id = signal_outcomes.signal_id
    WHERE signals.created_at >= ${cutoff}::timestamptz
      AND (
        signal_outcomes.failure_reason = 'incomplete_tail_coverage'
        OR ${REORG_OVERLAP}
        OR EXISTS (
          SELECT 1 FROM trades
          WHERE trades.pool_id = signals.pool_id
            AND trades.created_at > signal_outcomes.evaluated_at
            AND trades.occurred_at >= ${WINDOW_START}
            AND trades.occurred_at <= ${WINDOW_START} + ${HORIZON_INTERVAL}
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
