import type { AlphaScore, FeatureSet, ScoreComponent } from '@sdb/domain';
import {
  DEFAULT_COMPONENTS,
  DEFAULT_PENALTIES,
  type ComponentName,
  type ComponentSpec,
  type PenaltySpec,
} from './feature-map.js';
import { normalize } from './normalize.js';

/**
 * Spec §17 alpha scoring: explainable and deterministic.
 *
 * The central rule is plan G1, applied at BOTH levels. A component is an
 * average over features that may be null, and the alpha score is an average
 * over components that may be null. At each level the weights are renormalised
 * over what is actually present.
 *
 * The inner renormalisation is not a refinement — it is load-bearing.
 * `volume_acceleration_5m` is null for roughly the first 20 minutes of every
 * token's life, so a momentum component holding three of four features is the
 * common case. Without renormalising, that component would be diluted by an
 * implicit zero and momentum would read as weak precisely when a token is
 * newest — reintroducing the null-as-zero failure the whole pipeline exists to
 * avoid.
 */

export type ScoringWeights = Record<ComponentName, number>;

export type ScoringConfig = {
  weights: ScoringWeights;
  /** §16: whether missing data excludes a feature or takes a neutral score. */
  nullPolicy: 'renormalize' | 'neutral' | 'zero';
  /** Below this weight coverage a signal cannot exceed INTERESTING. */
  minCoverage: number;
  strategyVersion: string;
  components?: ComponentSpec[];
  penalties?: PenaltySpec[];
};

const NEUTRAL_SCORE = 50;

/**
 * Score one component from its features.
 *
 * Returns null only when EVERY feature is null — a component with one usable
 * feature reports that feature's score, not a quarter of it.
 */
export function scoreComponent(
  features: FeatureSet,
  spec: ComponentSpec,
  nullPolicy: ScoringConfig['nullPolicy'],
): number | null {
  let weighted = 0;
  let available = 0;

  for (const f of spec.features) {
    const raw = features[f.feature] ?? null;
    let scored = normalize(raw, f.normalizer);

    if (scored === null) {
      if (nullPolicy === 'neutral') scored = NEUTRAL_SCORE;
      else if (nullPolicy === 'zero') scored = 0;
      else continue; // 'renormalize': drop it from both numerator and divisor
    }

    weighted += scored * f.weight;
    available += f.weight;
  }

  if (available <= 0) return null;
  return weighted / available;
}

/** §17's `- configured_penalties`. Null features apply no penalty. */
export function scorePenalties(features: FeatureSet, specs: PenaltySpec[]): number {
  let total = 0;
  for (const spec of specs) {
    const raw = features[spec.feature] ?? null;
    const severity = normalize(raw, spec.normalizer);
    // Absence of evidence is not evidence: an undetected cluster is not a
    // clean bill of health, but it is not grounds for a penalty either.
    if (severity === null) continue;
    total += (severity / 100) * spec.maxPenalty;
  }
  return total;
}

export function calculateAlphaScore(
  features: FeatureSet,
  config: ScoringConfig,
): AlphaScore {
  const specs = config.components ?? DEFAULT_COMPONENTS;
  const penaltySpecs = config.penalties ?? DEFAULT_PENALTIES;

  const components: ScoreComponent[] = specs.map((spec) => ({
    name: spec.name,
    raw: scoreComponent(features, spec, config.nullPolicy),
    weight: config.weights[spec.name] ?? 0,
  }));

  let weighted = 0;
  let coverage = 0;
  for (const component of components) {
    if (component.raw === null) continue;
    weighted += component.raw * component.weight;
    coverage += component.weight;
  }

  const penalties = scorePenalties(features, penaltySpecs);

  // Renormalise over the weight actually present, then subtract penalties.
  // Scoring a missing component as 0 instead would cap every token: with an
  // empty smart-money seed list (0.30 of the weight) nothing could exceed 70,
  // and strongThreshold of 75 would be unreachable — the failure G1 exists for.
  const base = coverage > 0 ? weighted / coverage : 0;
  const score = clamp(base - penalties);

  return {
    score,
    components,
    penalties,
    coverage,
    strategyVersion: config.strategyVersion,
  };
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 100 ? 100 : value;
}

/**
 * Is there enough evidence for this score to be trusted at the top band?
 *
 * A token scored on one component out of four might score 95, but that is 95
 * on a quarter of the picture. §17's bands assume a full assessment, so thin
 * evidence is capped at INTERESTING rather than presented as high conviction.
 */
export function hasSufficientCoverage(score: AlphaScore, config: ScoringConfig): boolean {
  return score.coverage >= config.minCoverage;
}
