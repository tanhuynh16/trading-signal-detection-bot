import { bandFor, type ScoreBand } from './bands.js';
import {
  distribution,
  median,
  pairMeasured,
  profitFactor,
  spearman,
  winRate,
  type Distribution,
  type WinRate,
} from './stats.js';
import type { OutcomeSample } from './query.js';

/**
 * Turn samples into the §22 tables.
 *
 * The one rule everything else follows from: a cell that cannot support a
 * conclusion reports that it cannot, rather than reporting a number with a
 * caveat. §22 warns against tuning on averages from skewed data, and a win rate
 * of 60% from five outcomes is exactly the shape of number that gets acted on
 * anyway. `sufficient` is therefore a property of every cell, and the renderer
 * omits the metrics entirely when it is false.
 */

export type CellStats = {
  band: string;
  horizon: string;
  /** Outcomes in this cell. */
  n: number;
  /**
   * Distinct tokens behind those outcomes.
   *
   * Not the same as `n`: one token re-entering a state produces several signals
   * and therefore several outcomes, which are correlated. This is the number
   * that reflects how much independent evidence there really is.
   */
  tokens: number;
  /** Outcomes with a usable return. */
  measured: number;
  /** Outcomes excluded because they could not be measured, by reason. */
  excluded: Record<string, number>;
  sufficient: boolean;
  winRate: WinRate;
  returns: Distribution;
  medianRunup: number | null;
  medianDrawdown: number | null;
  /** Null = no trades; Infinity = no losing trades yet. */
  profitFactor: number | null;
};

export type FeatureStats = {
  feature: string;
  horizon: string;
  /** Samples where the component was actually measured. */
  measured: number;
  /** Samples considered, measured or not. */
  total: number;
  sufficient: boolean;
  /** Spearman rank correlation against return_pct. */
  correlation: number | null;
};

export type EvaluationConfig = {
  /** Below this an cell reports INSUFFICIENT instead of its metrics. */
  minSampleSize: number;
};

const countBy = <T>(items: readonly T[], key: (item: T) => string): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const item of items) {
    const k = key(item);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
};

function cell(
  band: string,
  horizon: string,
  samples: readonly OutcomeSample[],
  config: EvaluationConfig,
): CellStats {
  const measurable = samples.filter(
    (s): s is OutcomeSample & { returnPct: number } => s.returnPct !== null,
  );
  const returns = measurable.map((s) => s.returnPct);

  return {
    band,
    horizon,
    n: samples.length,
    tokens: new Set(samples.map((s) => s.tokenId)).size,
    measured: measurable.length,
    excluded: countBy(
      samples.filter((s) => s.returnPct === null),
      (s) => s.failureReason ?? 'unknown',
    ),
    // Judged on measured outcomes: rows we could not measure are not evidence.
    sufficient: measurable.length >= config.minSampleSize,
    winRate: winRate(returns),
    returns: distribution(returns),
    medianRunup: median(
      measurable.map((s) => s.maxRunupPct).filter((v): v is number => v !== null),
    ),
    medianDrawdown: median(
      measurable.map((s) => s.maxDrawdownPct).filter((v): v is number => v !== null),
    ),
    profitFactor: profitFactor(returns),
  };
}

export function byBandAndHorizon(
  samples: readonly OutcomeSample[],
  bands: readonly ScoreBand[],
  horizons: readonly string[],
  config: EvaluationConfig,
): CellStats[] {
  const out: CellStats[] = [];
  for (const band of bands) {
    for (const horizon of horizons) {
      const inCell = samples.filter(
        (s) => s.horizon === horizon && bandFor(s.alphaScore, bands)?.label === band.label,
      );
      // Only emit bands that actually occurred; a table of empty rows for score
      // ranges nothing reached is noise.
      if (inCell.length > 0) out.push(cell(band.label, horizon, inCell, config));
    }
  }
  return out;
}

/**
 * Per-feature rank correlation against return.
 *
 * This is §22's "individual feature contribution" in the only form the data can
 * honestly support. It measures association, not causation, and says nothing
 * about what a feature would contribute if the weights changed.
 */
export function featureContribution(
  samples: readonly OutcomeSample[],
  horizons: readonly string[],
  config: EvaluationConfig,
): FeatureStats[] {
  const names = [...new Set(samples.flatMap((s) => Object.keys(s.components)))].sort();
  const out: FeatureStats[] = [];

  for (const feature of names) {
    for (const horizon of horizons) {
      const inHorizon = samples.filter(
        (s): s is OutcomeSample & { returnPct: number } =>
          s.horizon === horizon && s.returnPct !== null,
      );
      if (inHorizon.length === 0) continue;

      const { xs, ys, measured, total } = pairMeasured(
        inHorizon.map((s) => ({
          feature: s.components[feature] ?? null,
          outcome: s.returnPct,
        })),
      );

      out.push({
        feature,
        horizon,
        measured,
        total,
        sufficient: measured >= config.minSampleSize,
        correlation: spearman(xs, ys),
      });
    }
  }
  return out;
}

/**
 * Outcomes split by evidence coverage (§22's "combinations").
 *
 * Full feature attribution needs far more data than exists, but coverage is a
 * combination question the sample can speak to: did signals scored on more of
 * the evidence do better than signals scored on less? G1 renormalises to the
 * weight actually present, so a high score from thin coverage is exactly the
 * case worth watching.
 */
export function byCoverage(
  samples: readonly OutcomeSample[],
  horizon: string,
  config: EvaluationConfig,
): CellStats[] {
  const buckets: Array<{ label: string; test: (c: number) => boolean }> = [
    { label: 'coverage <0.5', test: (c) => c < 0.5 },
    { label: 'coverage 0.5-0.8', test: (c) => c >= 0.5 && c < 0.8 },
    { label: 'coverage >=0.8', test: (c) => c >= 0.8 },
  ];

  return buckets
    .map((bucket) => ({
      bucket,
      rows: samples.filter((s) => s.horizon === horizon && bucket.test(s.coverage)),
    }))
    .filter(({ rows }) => rows.length > 0)
    .map(({ bucket, rows }) => cell(bucket.label, horizon, rows, config));
}
