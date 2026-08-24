import type { FeatureValue } from '@sdb/domain';

/**
 * Spec §15.2 momentum features.
 *
 * These are the features most likely to be quietly wrong, because every one of
 * them has a tempting default that looks like data: an acceleration of 1.0, a
 * buy/sell ratio of 0, a velocity of 0. §15 requires null instead — a token six
 * minutes old genuinely has no measurable acceleration, and saying otherwise
 * invents momentum the scorer will act on.
 */

/** Aggregates for one window, as produced by the SQL in `windows.ts`. */
export type TradeWindow = {
  volumeUsd: number | null;
  buyCount: number;
  sellCount: number;
  uniqueBuyers: number;
  durationMinutes: number;
};

/**
 * §15.2 volume acceleration:
 *   current 5m volume / average(previous three comparable 5m windows)
 *
 * The spec's worked example: current 50k against 10k/12k/8k averages 10k, so
 * acceleration is 5.0.
 *
 * Requires exactly three prior windows. With fewer, this returns null — a token
 * must be roughly 20 minutes old before acceleration means anything, and
 * reporting 1.0 ("no acceleration") for a five-minute-old token would be a
 * statement we have no basis for.
 */
export function volumeAcceleration(
  currentVolume: number | null,
  priorVolumes: readonly (number | null)[],
  requiredPriorWindows = 3,
): FeatureValue {
  if (currentVolume === null) return null;

  const usable = priorVolumes.filter((v): v is number => v !== null);
  if (usable.length < requiredPriorWindows) return null;

  const window = usable.slice(0, requiredPriorWindows);
  const mean = window.reduce((sum, v) => sum + v, 0) / window.length;

  // Every prior window empty: the token has no baseline to accelerate from.
  // A ratio against zero is undefined, not infinite growth.
  if (mean <= 0) return null;

  return currentVolume / mean;
}

/**
 * §15.2: buy_count / max(sell_count, 1).
 *
 * The max() is the spec's own guard. Note it makes 3 buys / 0 sells read as
 * 3.0, identical to 3 buys / 1 sell — a deliberate flattening the spec chose
 * over an infinity.
 *
 * A window with no trades at all returns null: no trading is not the same as
 * balanced trading.
 */
export function buySellRatio(window: TradeWindow): FeatureValue {
  if (window.buyCount === 0 && window.sellCount === 0) return null;
  return window.buyCount / Math.max(window.sellCount, 1);
}

/** §15.2: number of trades / window duration, in trades per minute. */
export function tradeVelocity(window: TradeWindow): FeatureValue {
  if (window.durationMinutes <= 0) return null;
  return (window.buyCount + window.sellCount) / window.durationMinutes;
}

/**
 * §15.2: unique buyers in the current window relative to the previous window.
 *
 * Expressed as a ratio, so 2.0 means the buyer base doubled. Null without a
 * previous window, and null when the previous window had no buyers — growth
 * from zero is undefined, not infinite.
 */
export function uniqueBuyerGrowth(
  current: TradeWindow,
  previous: TradeWindow | null,
): FeatureValue {
  if (previous === null) return null;
  if (previous.uniqueBuyers === 0) return null;
  return current.uniqueBuyers / previous.uniqueBuyers;
}

/** Convenience: is this window usable at all? */
export function hasTrades(window: TradeWindow): boolean {
  return window.buyCount > 0 || window.sellCount > 0;
}
