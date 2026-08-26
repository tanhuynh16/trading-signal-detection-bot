import { OUTCOME_HORIZONS_MS, offsetLabel } from '@sdb/shared';

/**
 * The §21 horizon schedule: 1m, 5m, 15m, 30m, 1h, 4h, 24h from signal time.
 *
 * All seven jobs are enqueued at once when a signal state entry is recorded.
 * §13's rule that jobs must not recursively schedule more jobs applies here
 * too: a self-scheduling chain has no upper bound, and one stuck job silently
 * ends the series — which for a 24h horizon would not be noticed for a day.
 */
export type PlannedOutcome = {
  /** Stable label, also the `signal_outcomes.horizon` value. */
  horizon: string;
  /** Delay from signal time, milliseconds. */
  delayMs: number;
};

export function planOutcomes(): PlannedOutcome[] {
  return OUTCOME_HORIZONS_MS.map((delayMs) => ({
    horizon: offsetLabel(delayMs),
    delayMs,
  }));
}

/** Milliseconds for a horizon label, or null if it is not one of ours. */
export function horizonMs(label: string): number | null {
  const found = planOutcomes().find((plan) => plan.horizon === label);
  return found?.delayMs ?? null;
}
