import { MINUTE_MS, offsetLabel, SNAPSHOT_OFFSETS_MS } from '@sdb/shared';

/**
 * The §13 snapshot schedule: T+0, 30s, 1m, 2m, 5m, 10m, 30m, 1h.
 *
 * All eight jobs are enqueued at once when a candidate is accepted. Spec §13 is
 * explicit that jobs must not recursively create more jobs — a self-scheduling
 * chain has no upper bound and a single stuck job silently ends the series.
 */
export type PlannedSnapshot = {
  /** Stable label, also the `token_snapshots.scheduled_offset` value. */
  offset: string;
  /** Delay from discovery time, milliseconds. */
  delayMs: number;
  /** Window for trade aggregation at this offset. */
  windowMs: number;
};

/**
 * Trade windows widen with the offset.
 *
 * At T+30s there is only 30s of history to aggregate, so a fixed 5-minute
 * window would report a rate over a period that mostly predates the pool.
 * Capping the window at the elapsed time keeps every count honest, and §15.2's
 * volume_acceleration compares like-sized windows in Phase 4.
 */
export function windowFor(delayMs: number): number {
  const FIVE_MINUTES = 5 * MINUTE_MS;
  if (delayMs === 0) return 0;
  return Math.min(delayMs, FIVE_MINUTES);
}

export function planSnapshots(): PlannedSnapshot[] {
  return SNAPSHOT_OFFSETS_MS.map((delayMs) => ({
    offset: offsetLabel(delayMs),
    delayMs,
    windowMs: windowFor(delayMs),
  }));
}

/**
 * Should tracking stop early? Spec §13 allows stopping when a pool is
 * unavailable for a configurable duration or the token has expired.
 *
 * Liquidity is deliberately NOT checked at T+0 alone: pools are frequently
 * created empty and funded a minute or two later, and a single early reading
 * would discard exactly the launches worth watching. Instead a pool is
 * abandoned only once it has stayed below the floor past the grace period.
 */
export function shouldStopTracking(input: {
  snapshots: Array<{ liquidityUsd: string | null; capturedAt: Date }>;
  discoveredAt: Date;
  minLiquidityUsd: number;
  graceMinutes: number;
  now?: Date;
}): { stop: boolean; reason: string | null } {
  const now = input.now ?? new Date();
  const ageMs = now.getTime() - input.discoveredAt.getTime();
  if (ageMs < input.graceMinutes * MINUTE_MS) {
    return { stop: false, reason: null };
  }

  const withReadings = input.snapshots.filter((s) => s.liquidityUsd !== null);
  // No USD reading at all past the grace period means we cannot price this pool
  // — usually an unrecognised quote token. Nothing downstream can score it.
  if (withReadings.length === 0) {
    return { stop: true, reason: 'no_priceable_liquidity' };
  }

  const everMetFloor = withReadings.some(
    (s) => Number(s.liquidityUsd) >= input.minLiquidityUsd,
  );
  if (!everMetFloor) {
    return { stop: true, reason: 'liquidity_below_floor' };
  }

  return { stop: false, reason: null };
}
