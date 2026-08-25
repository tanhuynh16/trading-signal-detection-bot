import type { FeatureValue } from '@sdb/domain';

/**
 * Spec §16 normalizers.
 *
 * "Raw features must not be directly summed when scales differ." Liquidity is
 * measured in dollars spanning six orders of magnitude, buy/sell ratio sits
 * near 1, and holder counts are small integers. Adding those directly would let
 * whichever feature happens to have the largest units dominate the score.
 *
 * Every normalizer maps to 0..100, propagates null (§16: "Null feature values
 * must be explicitly represented"), and can never emit NaN or Infinity — a
 * non-finite score would poison the weighted average silently.
 */

export type Direction = 'higher_is_better' | 'lower_is_better';

const clamp = (value: number, lo = 0, hi = 100): number =>
  value < lo ? lo : value > hi ? hi : value;

/** Apply direction after scaling, so every normalizer can assume "up is good". */
function orient(score: number, direction: Direction): number {
  return direction === 'lower_is_better' ? 100 - score : score;
}

export type MinMaxParams = { min: number; max: number; direction?: Direction };

/**
 * Linear min-max with clipping. For features already on a bounded scale —
 * ratios in 0..1, percentages, stability scores.
 *
 * Values outside [min, max] clip rather than extrapolate: a token with 300%
 * holder retention is a data error, not thirty times better than one at 100%.
 */
export function minMax(value: FeatureValue, params: MinMaxParams): FeatureValue {
  if (value === null || !Number.isFinite(value)) return null;
  const span = params.max - params.min;
  if (span <= 0) return null;
  const scaled = ((value - params.min) / span) * 100;
  return clamp(orient(clamp(scaled), params.direction ?? 'higher_is_better'));
}

export type LogParams = { min: number; max: number; direction?: Direction };

/**
 * Logarithmic scaling, for features spanning orders of magnitude.
 *
 * Liquidity between $1k and $1M is the range that matters, and linear scaling
 * would compress everything below $100k into the bottom tenth — which is where
 * essentially every brand-new pool lives. On a log scale $10k and $100k are as
 * far apart as $100k and $1M, which is how a trader actually reads them.
 */
export function logScale(value: FeatureValue, params: LogParams): FeatureValue {
  if (value === null || !Number.isFinite(value)) return null;
  // log is undefined at or below zero; floor at min so a dead pool scores 0
  // rather than producing -Infinity.
  const min = Math.max(params.min, Number.EPSILON);
  const max = Math.max(params.max, min * 10);
  const v = Math.max(value, min);

  const scaled = ((Math.log10(v) - Math.log10(min)) / (Math.log10(max) - Math.log10(min))) * 100;
  return clamp(orient(clamp(scaled), params.direction ?? 'higher_is_better'));
}

export type BoundedRatioParams = {
  /** Ratio treated as neutral, scoring `neutralScore`. Usually 1.0. */
  neutral: number;
  /** Ratio at which the feature saturates at 100. */
  saturate: number;
  neutralScore?: number;
  direction?: Direction;
};

/**
 * Scoring for ratio features centred on a neutral point (§16 "bounded ratio
 * scoring").
 *
 * `buy_sell_ratio` and `volume_acceleration_5m` are multiples where 1.0 means
 * "no change". What matters is how far above or below neutral the value sits,
 * and min-max would treat 1.0 as an arbitrary point rather than the meaningful
 * centre. Below neutral scores proportionally down toward 0; above neutral
 * scores up toward 100 at `saturate`.
 */
export function boundedRatio(value: FeatureValue, params: BoundedRatioParams): FeatureValue {
  if (value === null || !Number.isFinite(value) || value < 0) return null;

  const neutralScore = params.neutralScore ?? 50;
  const { neutral, saturate } = params;
  if (neutral <= 0 || saturate <= neutral) return null;

  let scaled: number;
  if (value >= neutral) {
    const above = (value - neutral) / (saturate - neutral);
    scaled = neutralScore + above * (100 - neutralScore);
  } else {
    scaled = (value / neutral) * neutralScore;
  }

  return clamp(orient(clamp(scaled), params.direction ?? 'higher_is_better'));
}

/** Discriminated normalizer spec, so the whole mapping lives in config. */
export type NormalizerSpec =
  | ({ kind: 'minMax' } & MinMaxParams)
  | ({ kind: 'log' } & LogParams)
  | ({ kind: 'boundedRatio' } & BoundedRatioParams);

export function normalize(value: FeatureValue, spec: NormalizerSpec): FeatureValue {
  switch (spec.kind) {
    case 'minMax':
      return minMax(value, spec);
    case 'log':
      return logScale(value, spec);
    case 'boundedRatio':
      return boundedRatio(value, spec);
  }
}
