import { z } from 'zod';
import { ConfigurationError } from '@sdb/shared';

/**
 * Spec §19 strategy configuration. Every number below is an initial hypothesis,
 * not a claim about profitability (§17, §28). Spec §22 requires that any change
 * mints a new strategyVersion rather than mutating the meaning of past signals,
 * so configs are loaded by version and treated as immutable once used.
 */

export const strategyConfigSchema = z.object({
  strategyVersion: z.string().min(1),

  discovery: z.object({
    minLiquidityUsd: z.number().nonnegative(),
    maxTokenAgeMinutes: z.number().positive(),
  }),

  tracking: z.object({
    inactiveExpiryMinutes: z.number().positive(),
    /** Spec §13: stop tracking once a pool has been unreadable this long. */
    poolUnavailableExpiryMinutes: z.number().positive().default(10),
  }),

  momentum: z.object({
    minVolumeAcceleration: z.number().nonnegative(),
    minUniqueBuyers5m: z.number().int().nonnegative(),
    minBuySellRatio: z.number().nonnegative(),
  }),

  smartMoney: z.object({
    minIndependentWallets: z.number().int().nonnegative(),
    /**
     * §15.5: MVP uses a manually seeded wallet list. Empty by default — the
     * smart-money features then report null, which G1's coverage
     * renormalisation handles correctly rather than scoring the component 0.
     */
    seedWallets: z.array(z.string().regex(/^0x[0-9a-f]{40}$/)).default([]),
  }),

  holders: z.object({
    /** Spec §15.3: the dust threshold must be configuration-driven. */
    dustThresholdUsd: z.number().nonnegative().default(1),
    /**
     * Dust in RAW token units. Preferred over the USD threshold because it
     * needs no price — a token with no USD path still has holders.
     */
    dustThresholdRaw: z.string().regex(/^\d+$/).default('0'),
    /** Excluded from top10_concentration: LP contracts, burn sinks (§15.3). */
    excludedAddresses: z.array(z.string().regex(/^0x[0-9a-f]{40}$/)).default([]),
  }),

  /**
   * Spec §14.1: the exact interpretation of each flag must be configurable.
   * Kept in strategy config (not env) so a change mints a new strategyVersion
   * and historical verdicts keep their original meaning (§22).
   */
  risk: z
    .object({
      actions: z.record(z.string(), z.enum(['FAIL', 'WARNING', 'IGNORE'])).default({}),
      severities: z.record(z.string(), z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'])).default({}),
      maxTokenTaxFraction: z.number().min(0).max(1).default(0.25),
      warnTokenTaxFraction: z.number().min(0).max(1).default(0.1),
      warnTop10ConcentrationPercent: z.number().min(0).max(100).default(40),
      failTop10ConcentrationPercent: z.number().min(0).max(100).nullable().default(null),
      /** Offsets at which risk is re-evaluated (§14 + late-rug defence). */
      evaluateAtOffsets: z.array(z.string()).default(['T0', '5m', '30m']),
    })
    .default({}),

  /** §15.4 clustering tolerances. Deterministic heuristics only (§28). */
  clustering: z
    .object({
      timeProximityMs: z.number().int().positive().default(300_000),
      amountTolerance: z.number().min(0).max(1).default(0.05),
      minClusterSize: z.number().int().min(2).default(2),
    })
    .default({}),

  scoring: z.object({
    interestingThreshold: z.number().min(0).max(100),
    strongThreshold: z.number().min(0).max(100),
    weights: z
      .object({
        liquidity: z.number().min(0).max(1),
        momentum: z.number().min(0).max(1),
        holder: z.number().min(0).max(1),
        smartMoney: z.number().min(0).max(1),
      })
      .default({ liquidity: 0.2, momentum: 0.3, holder: 0.2, smartMoney: 0.3 }),
    /**
     * Plan G1. Implemented literally, a seeded-only smart-money list zeroes 30%
     * of the weight and makes strongThreshold unreachable. 'renormalize'
     * divides by the weight actually present; 'neutral' scores missing
     * components at 50; 'zero' is the literal spec reading, kept for comparison.
     */
    nullPolicy: z.enum(['renormalize', 'neutral', 'zero']).default('renormalize'),
    /** Below this weight coverage, a signal cannot exceed INTERESTING. */
    minCoverage: z.number().min(0).max(1).default(0.6),
  }),

  alerts: z.object({
    /** Spec §18: re-alert only past this score delta or after the cooldown. */
    rescoreDelta: z.number().min(0).default(10),
    cooldownMinutes: z.number().nonnegative().default(60),
    /** Spec §18: v1 does not downgrade a signal unless this is enabled. */
    downgradePolicyEnabled: z.boolean().default(false),
  }),
});

export type StrategyConfig = z.infer<typeof strategyConfigSchema>;

export function parseStrategyConfig(input: unknown): StrategyConfig {
  const parsed = strategyConfigSchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new ConfigurationError(`Invalid strategy configuration:\n${issues}`);
  }
  const config = parsed.data;

  if (config.scoring.strongThreshold <= config.scoring.interestingThreshold) {
    throw new ConfigurationError(
      `strongThreshold (${config.scoring.strongThreshold}) must exceed ` +
        `interestingThreshold (${config.scoring.interestingThreshold})`,
    );
  }

  const weightSum = Object.values(config.scoring.weights).reduce((a, b) => a + b, 0);
  if (Math.abs(weightSum - 1) > 1e-9) {
    throw new ConfigurationError(`scoring weights must sum to 1, got ${weightSum}`);
  }

  return config;
}

/** Spec §19 defaults verbatim, plus the fields this plan added. */
export const BASE_MEME_V1: StrategyConfig = parseStrategyConfig({
  strategyVersion: 'base-meme-v1',
  discovery: { minLiquidityUsd: 10000, maxTokenAgeMinutes: 360 },
  tracking: { inactiveExpiryMinutes: 30, poolUnavailableExpiryMinutes: 10 },
  momentum: { minVolumeAcceleration: 3.0, minUniqueBuyers5m: 20, minBuySellRatio: 1.2 },
  smartMoney: { minIndependentWallets: 2, seedWallets: [] },
  clustering: { timeProximityMs: 300_000, amountTolerance: 0.05, minClusterSize: 2 },
  risk: {
    actions: {},
    severities: {},
    maxTokenTaxFraction: 0.25,
    warnTokenTaxFraction: 0.1,
    warnTop10ConcentrationPercent: 40,
    failTop10ConcentrationPercent: null,
    evaluateAtOffsets: ['T0', '5m', '30m'],
  },
  holders: { dustThresholdUsd: 1, dustThresholdRaw: '0', excludedAddresses: [] },
  scoring: {
    interestingThreshold: 60,
    strongThreshold: 75,
    weights: { liquidity: 0.2, momentum: 0.3, holder: 0.2, smartMoney: 0.3 },
    nullPolicy: 'renormalize',
    minCoverage: 0.6,
  },
  alerts: { rescoreDelta: 10, cooldownMinutes: 60, downgradePolicyEnabled: false },
});

const REGISTRY = new Map<string, StrategyConfig>([[BASE_MEME_V1.strategyVersion, BASE_MEME_V1]]);

export function getStrategyConfig(version: string): StrategyConfig {
  const config = REGISTRY.get(version);
  if (!config) {
    throw new ConfigurationError(`unknown strategyVersion: ${version}`, {
      known: [...REGISTRY.keys()],
    });
  }
  return config;
}

export function registerStrategyConfig(config: StrategyConfig): void {
  if (REGISTRY.has(config.strategyVersion)) {
    throw new ConfigurationError(
      `strategyVersion ${config.strategyVersion} already registered; ` +
        `changing a strategy requires a new version (spec §22)`,
    );
  }
  REGISTRY.set(config.strategyVersion, config);
}
