import type { FeatureValue } from '@sdb/domain';

/**
 * Spec §15.1 liquidity features.
 *
 * Every function here is pure and returns `null` when the inputs cannot support
 * an honest answer. §15 is explicit: "Do not silently substitute zero for
 * unavailable data." A zero growth rate and an unknown growth rate mean
 * completely different things to a scorer.
 */

/** One liquidity observation. `usd` is null when the pool had no USD path. */
export type LiquiditySample = { usd: number | null; at: Date };

/**
 * Relative change over the window, per §15.1:
 *   (current - past) / max(past, epsilon)
 *
 * The epsilon guard is the spec's, and it matters: new pools start at or near
 * zero liquidity, so an unguarded denominator produces Infinity for exactly the
 * tokens we care most about. A past value at or below epsilon is treated as
 * unmeasurable rather than as a near-infinite gain.
 */
export function liquidityGrowth(
  current: number | null,
  past: number | null,
  epsilon = 1,
): FeatureValue {
  if (current === null || past === null) return null;
  if (past < epsilon) return null;
  return (current - past) / past;
}

/**
 * §15.1: "1 - normalized absolute change volatility across recent liquidity
 * samples". Reported on 0..1, where 1 is perfectly stable.
 *
 * Volatility is measured on *relative* step changes so a $1M pool and a $10k
 * pool are comparable. Fewer than three samples cannot describe variability, so
 * the result is null rather than a flattering 1.0.
 */
export function liquidityStability(samples: readonly LiquiditySample[]): FeatureValue {
  const usable = samples.map((s) => s.usd).filter((v): v is number => v !== null && v > 0);
  if (usable.length < 3) return null;

  const steps: number[] = [];
  for (let i = 1; i < usable.length; i += 1) {
    const previous = usable[i - 1]!;
    steps.push(Math.abs(usable[i]! - previous) / previous);
  }
  if (steps.length === 0) return null;

  const meanAbsChange = steps.reduce((sum, s) => sum + s, 0) / steps.length;
  // A mean step of 0 is perfectly stable (1); 100% average swings score 0.
  return Math.max(0, 1 - Math.min(1, meanAbsChange));
}

/**
 * §15.1: market_cap_usd / max(liquidity_usd, epsilon).
 *
 * A high ratio means most of the notional value is not backed by tradeable
 * depth. Null when either side is unknown — computing it against a defaulted
 * zero would produce either 0 or Infinity, both of them fiction.
 */
export function mcLiquidityRatio(
  marketCapUsd: number | null,
  liquidityUsd: number | null,
  epsilon = 1,
): FeatureValue {
  if (marketCapUsd === null || liquidityUsd === null) return null;
  return marketCapUsd / Math.max(liquidityUsd, epsilon);
}

/**
 * Pick the sample closest to `target`, within `toleranceMs`.
 *
 * Snapshots land on the §13 schedule, not on exact feature boundaries, so
 * "liquidity 5 minutes ago" means the nearest observation to that instant. If
 * nothing is close enough the caller gets null rather than a stale reading
 * silently presented as current.
 */
export function sampleNear(
  samples: readonly LiquiditySample[],
  target: Date,
  toleranceMs: number,
): LiquiditySample | null {
  let best: LiquiditySample | null = null;
  let bestDelta = Number.POSITIVE_INFINITY;

  for (const sample of samples) {
    const delta = Math.abs(sample.at.getTime() - target.getTime());
    if (delta < bestDelta) {
      bestDelta = delta;
      best = sample;
    }
  }
  return bestDelta <= toleranceMs ? best : null;
}
