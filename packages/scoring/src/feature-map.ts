import type { NormalizerSpec } from './normalize.js';

/**
 * Which §15 features feed which §17 component, and how each is scaled.
 *
 * §17 names four components but never says what feeds them. §15's own section
 * structure answers it: 15.1 is liquidity, 15.2 momentum, 15.3 holder quality,
 * 15.5 smart money. §15.4 (wallet clustering) maps to no component at all —
 * which is precisely why §17's formula ends `- configured_penalties`.
 * Coordinated wallets holding a large share is evidence of a manufactured
 * launch, so it subtracts rather than contributing.
 *
 * Every bound below is an initial hypothesis, exactly as §17 and §19 insist.
 * They live in strategy config so a change mints a new strategyVersion (§22)
 * rather than silently reinterpreting past scores.
 */

export type ComponentName = 'liquidity' | 'momentum' | 'holder' | 'smartMoney';

export type FeatureSpec = {
  feature: string;
  /** Weight within its component. Renormalised over whatever is non-null. */
  weight: number;
  normalizer: NormalizerSpec;
};

export type ComponentSpec = {
  name: ComponentName;
  features: FeatureSpec[];
};

export const DEFAULT_COMPONENTS: ComponentSpec[] = [
  {
    name: 'liquidity',
    features: [
      {
        // $1k to $1M on a log scale: linear would compress every new pool into
        // the bottom tenth, which is where all of them start.
        feature: 'liquidity_usd',
        weight: 0.4,
        normalizer: { kind: 'log', min: 1_000, max: 1_000_000 },
      },
      {
        // Flat is neutral; doubling in five minutes saturates.
        feature: 'liquidity_growth_5m',
        weight: 0.2,
        normalizer: { kind: 'minMax', min: -0.5, max: 1 },
      },
      {
        feature: 'liquidity_stability',
        weight: 0.2,
        normalizer: { kind: 'minMax', min: 0, max: 1 },
      },
      {
        // Market cap far above tradeable depth means holders cannot exit.
        feature: 'mc_liquidity_ratio',
        weight: 0.2,
        normalizer: { kind: 'log', min: 1, max: 100, direction: 'lower_is_better' },
      },
    ],
  },
  {
    name: 'momentum',
    features: [
      {
        // §19's minVolumeAcceleration is 3.0; saturating at 5 keeps that
        // threshold inside the informative part of the curve.
        feature: 'volume_acceleration_5m',
        weight: 0.4,
        normalizer: { kind: 'boundedRatio', neutral: 1, saturate: 5 },
      },
      {
        // §19's minBuySellRatio is 1.2. Balanced flow is neutral by definition.
        feature: 'buy_sell_ratio',
        weight: 0.3,
        normalizer: { kind: 'boundedRatio', neutral: 1, saturate: 3 },
      },
      {
        feature: 'trade_velocity',
        weight: 0.2,
        normalizer: { kind: 'log', min: 0.1, max: 50 },
      },
      {
        feature: 'unique_buyer_growth',
        weight: 0.1,
        normalizer: { kind: 'boundedRatio', neutral: 1, saturate: 3 },
      },
    ],
  },
  {
    name: 'holder',
    features: [
      {
        feature: 'holder_count',
        weight: 0.3,
        normalizer: { kind: 'log', min: 10, max: 2_000 },
      },
      {
        // §19 wants 20 unique buyers per 5m, i.e. ~4 holders/minute.
        feature: 'holder_growth_rate',
        weight: 0.3,
        normalizer: { kind: 'minMax', min: 0, max: 20 },
      },
      {
        // §14.1 warns at 40%; concentration above that is a rug risk.
        feature: 'top10_concentration',
        weight: 0.25,
        normalizer: { kind: 'minMax', min: 0.1, max: 0.8, direction: 'lower_is_better' },
      },
      {
        feature: 'holder_retention',
        weight: 0.15,
        normalizer: { kind: 'minMax', min: 0, max: 1 },
      },
    ],
  },
  {
    name: 'smartMoney',
    features: [
      {
        // §19's minIndependentWallets is 2; 5 independent actors saturates.
        feature: 'independent_smart_wallet_count',
        weight: 0.5,
        normalizer: { kind: 'minMax', min: 0, max: 5 },
      },
      {
        // Minutes since the most recent entry — fresher is stronger.
        feature: 'smart_wallet_entry_recency',
        weight: 0.2,
        normalizer: { kind: 'minMax', min: 0, max: 60, direction: 'lower_is_better' },
      },
      {
        feature: 'smart_wallet_quality',
        weight: 0.3,
        normalizer: { kind: 'minMax', min: 0, max: 100 },
      },
    ],
  },
];

export type PenaltySpec = {
  feature: string;
  /** Points subtracted at full severity. */
  maxPenalty: number;
  normalizer: NormalizerSpec;
};

/**
 * §17's `- configured_penalties`.
 *
 * §15.4's cluster_concentration is the only §15 feature belonging to no
 * component, and it is inherently negative: a large share of supply held by one
 * detected cluster means the "organic interest" is one actor. Null (no cluster
 * detected) applies no penalty — absence of evidence is not evidence.
 */
export const DEFAULT_PENALTIES: PenaltySpec[] = [
  {
    feature: 'cluster_concentration',
    maxPenalty: 25,
    normalizer: { kind: 'minMax', min: 0.1, max: 0.6 },
  },
];
