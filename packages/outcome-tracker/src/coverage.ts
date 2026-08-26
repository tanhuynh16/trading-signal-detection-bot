import type { Database } from '@sdb/database';
import { readCursorState } from '@sdb/discovery';
import { SWAP_TAIL_SOURCE } from '@sdb/snapshot-engine';

/**
 * Is the indexed trade history complete enough to measure this window?
 *
 * Phase 7 shipped without asking. The outcome job fires at wall-clock
 * `T0 + horizon` and queries trades with `occurred_at <= T0 + horizon`, but
 * `occurred_at` is BLOCK time — blocks at that instant are only just being
 * produced, so the tail's coverage is by construction short of the window end
 * at every evaluation. Measured on real data: 13 of 176 outcomes were finalised
 * from incomplete history, one of them reporting `max_runup_pct` of 33.97 where
 * the truth was 79.02, and another reporting a flat 0.00% return over a window
 * that actually contained four trades and moved +4.95%.
 *
 * Nothing self-corrected, because `onConflictDoNothing` plus the reconciler's
 * `notExists` filter make the first write permanent.
 *
 * The fix is not a heuristic delay. The swap tail already maintains a sound
 * watermark — it persists trades BEFORE advancing the cursor, so the cursor is
 * a conservative lower bound on what is stored — and the tail now stamps that
 * watermark's block time. Measuring only once the watermark has passed the
 * window end turns "probably complete" into "provably complete".
 */

export type CoverageConfig = {
  enabled: boolean;
  /** How long to wait between re-checks while the tail catches up. */
  deferIntervalMs: number;
  /**
   * How long past a window end to keep waiting before giving up.
   *
   * Bounded on purpose: a stalled tail, or a pool that has aged out of
   * retention, must not leave a horizon deferring forever with nothing
   * recorded. §27 wants the failure written down, not silently skipped.
   */
  maxDeferMs: number;
};

export type CoverageDecision =
  | { ready: true }
  | { ready: false; giveUp: false; retryAt: Date }
  | { ready: false; giveUp: true };

export function decideCoverage(input: {
  /** Block time the swap tail has provably indexed up to; null if unknown. */
  watermarkTime: Date | null;
  windowEnd: Date;
  config: CoverageConfig;
  now?: Date;
}): CoverageDecision {
  if (!input.config.enabled) return { ready: true };

  const now = input.now ?? new Date();

  // A watermark at or past the window end means every block that could hold a
  // trade in this window has been read and its swaps committed.
  if (input.watermarkTime !== null && input.watermarkTime >= input.windowEnd) {
    return { ready: true };
  }

  // A null watermark is not "covered" — it is "we have no idea", which is the
  // one thing that must never be mistaken for completeness.
  const deadline = new Date(input.windowEnd.getTime() + input.config.maxDeferMs);
  if (now >= deadline) return { ready: false, giveUp: true };

  return {
    ready: false,
    giveUp: false,
    retryAt: new Date(now.getTime() + input.config.deferIntervalMs),
  };
}

/** Block time the swap tail has provably indexed up to. */
export async function tailWatermark(db: Database): Promise<Date | null> {
  const state = await readCursorState(db, SWAP_TAIL_SOURCE);
  return state?.lastProcessedBlockTime ?? null;
}
