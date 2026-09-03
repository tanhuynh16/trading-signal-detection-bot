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
    /**
     * §18 "liquidity collapse": liquidity below this fraction of the pool's own
     * peak. Relative rather than absolute, because a pool that never held much
     * has not collapsed — it was always thin.
     */
    liquidityCollapseFraction: z.number().min(0).max(1).default(0.2),
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
  tracking: {
    inactiveExpiryMinutes: 30,
    poolUnavailableExpiryMinutes: 10,
    liquidityCollapseFraction: 0.2,
  },
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

/**
 * §15.5 manually seeded smart-money wallets, supplied by the operator.
 *
 * All 58 were verified as live Base accounts before being written here — every
 * one has a non-zero nonce (range 1–114,882), so this is a real Base list rather
 * than addresses copied from another chain, which is the failure mode that would
 * otherwise be undetectable: a wrong-chain address is still valid hex and simply
 * never matches a trade.
 *
 * Kept as a module constant rather than env because §22 makes the seed list
 * part of a strategy's identity: changing who counts as smart money changes what
 * every subsequent score means, so it must arrive with a new strategyVersion.
 */
export const SMART_MONEY_SEED_WALLETS_V2: readonly string[] = [
  '0x07591d902e68503c113ac4beca8abb3e3f6b0ab3',
  '0x07cdaf0140c60a0c34681065abf49bb8d85b8cbe',
  '0x0f84d2da979180394fbf9c4499febd0f602a6767',
  '0x202cab0460a9cc210dd6312a7e528380d2fe4036',
  '0x24bd6c97ffe8696d2c35cd200823caf839e4bd66',
  '0x2a36148a416cba81699b555120bd65f4682bdfd2',
  '0x2b4267f7ff3dd14099bd2195d2042f4a9ace9a7e',
  '0x2b5e2cfa2ede2fc969a8184a42414fcaef603816',
  '0x2ce9d43d1cba6ae31d7f07bfe0098dfa2d833373',
  '0x2f84ebb2f7f8edcf8e83a75a12f32bd8d99de3e0',
  '0x30bf20a8439af6c991eecdb12cd8d89a8eb81bab',
  '0x3391a39a1b508e54a361924a26056c01c1c2c07d',
  '0x347ffc6db9acc54ac2019795173b9599e8b82bd9',
  '0x3618fc0114c06865472cc32e6843db835ededbaf',
  '0x371903abb32f5f69b536b77495e92adedfea25da',
  '0x38e4203f12b1e74d87deb0083d3c8b51ad9a104e',
  '0x3c5083022114ea14fb3d8d06f5931c629c2bedd6',
  '0x41ccc209d3ba4e81ef0c1fcb6d191127fb5b42f5',
  '0x498581ff718922c3f8e6a244956af099b2652b2b',
  '0x4d9644d05fe2123b4eafa8d7fd31b0ea430726f3',
  '0x4eb3d06c16f8e40b0f9585895b2d106c1104079f',
  '0x59905d5d085e0caf031ba883b821ba354e51f95e',
  '0x5d6b8c45a83a766e790410d6b2d8810bd8f19c27',
  '0x6078ee8a93697c6d67863fcbff77141d9ab358b2',
  '0x61fd0d043d519f5a2bd05785000f30db96809429',
  '0x62e5332dcb286f1753d245707c91a38821bb5645',
  '0x674495201f43139c559568910726121e572c81e4',
  '0x6a79ad5b3568e15eb2b04375577aa6b303f34e59',
  '0x749fe1885440ba5ec7381c9fde06fd05b83c4c5c',
  '0x762229e03ac76d5df17447eef0c3e5caf60d9709',
  '0x7a2363a401b2340c7941dd2eeff0196a5078d2e6',
  '0x7b3d8e939ee08b52d06ab5e6f85791a6007e8d61',
  '0x85d4011854d4a73e7a4a4a596b4d52745f7d75d7',
  '0x8d73a36d78e2ae4a437053c9ce3be70d483ab74d',
  '0x990636ecb3ff04d33d92e970d3d588bf5cd8d086',
  '0x9d34151abe8d1594e74f463d350840119ab0689b',
  '0x9dbfded199ee3a6b291c223e65f97d387156aada',
  '0xa42ba514ed8e2504e63eee4b8a36e3a122bfc00f',
  '0xa83b73f5644cde337b61da79589f10ea15548811',
  '0xa9c0cded336699547aac4f9de5a11ada979bc59a',
  '0xadcc96b0bd79388ad549edd638a3137587ed07d0',
  '0xb3f0bf16c2c72d81f4b0f8a7ff81bc5c98f28a23',
  '0xb4beddf1b828aaed9638601f7145b0f6093f2d3f',
  '0xb90d9ea599c2634069ae4d5eecc5ab7234a81a05',
  '0xbd994acb9c906100dc4b8c08d2b6c28cb543425d',
  '0xbf004bff64725914ee36d03b87d6965b0ced4903',
  '0xc2c6acd377458010713e733e1b21dd6f670d091c',
  '0xc652368b05a27dd70d135f636536714e2806bd9a',
  '0xc848a7530ed12eb545a01eaa906de55f9491fb59',
  '0xca1a2fb7f3179d887504966b25d1606978adcd42',
  '0xcd83f4c3a4b96d56367e482a3774802877b82e13',
  '0xd01a73bef8d17aa02466754fe43e99342ae30043',
  '0xddac928a240bdace3994c2cc0783d4e29a002127',
  '0xddbcdf710c21219dc5e56a6e1e8576fb4aa99d96',
  '0xe28601398a5448d1147e6e8b0e0c6d686f0d216d',
  '0xeeefff8ce2710fa490e0fcb794235e873c252d2e',
  '0xeff07c10eca0575ffa021601c138152efbe9657d',
  '0xfe2d9cb4cdf37dc1fe9d6962b6976530f6d77117',
];

/**
 * base-meme-v1 with §15.5 smart money actually seeded.
 *
 * NOT the default, and deliberately so. Seeding flips the smart-money component
 * from null (unmeasured, renormalised away by G1) to a measured 0 for every pool
 * none of these wallets bought — see `independentSmartWalletCount`, which
 * returns null only when the seed list is EMPTY. That moves 0.30 of weight into
 * the denominator carrying a zero, so an untouched pool scores
 *
 *     score_v2 = score_v1 * coverage_v1 / (coverage_v1 + 0.30)
 *
 * Replayed against the 1,242 signals recorded under v1: mean 10.77 -> 7.54, best
 * 74.345 -> 46.466, and signals clearing interestingThreshold 5 -> 0. Exactly ONE
 * signal in that history had a seeded wallet buy the pool first, and even it went
 * DOWN, 22.243 -> 19.856: one wallet of 58 normalises to 20/100 on
 * `independent_smart_wallet_count` (minMax 0..5) and its entry was 197 minutes
 * stale against a 0..60 minute recency window.
 *
 * Two caveats on that replay, both of which say "not yet measurable" rather than
 * "these wallets are worthless":
 *
 *   - 828 of the 1,242 signals (67%) were scored on days when neither tail
 *     ingested a single row, so most of the sample could not have shown a hit
 *     from anyone. On the 414 signals from days that did ingest, 5 (1.21%) had a
 *     seed wallet touch the pool.
 *   - Growing the list 22 -> 58 moved the mean by 0.01 and added one touched
 *     signal, which is a statement about the sample, not about the wallets.
 *
 * Registered so the list is under version control and replayable. Switching
 * STRATEGY_VERSION to it needs thresholds and the smart-money normalizers
 * re-derived from a soak with working tails first (§19 calls them hypotheses).
 */
export const BASE_MEME_V2: StrategyConfig = parseStrategyConfig({
  ...BASE_MEME_V1,
  strategyVersion: 'base-meme-v2',
  smartMoney: {
    minIndependentWallets: BASE_MEME_V1.smartMoney.minIndependentWallets,
    seedWallets: SMART_MONEY_SEED_WALLETS_V2,
  },
});

const REGISTRY = new Map<string, StrategyConfig>([
  [BASE_MEME_V1.strategyVersion, BASE_MEME_V1],
  [BASE_MEME_V2.strategyVersion, BASE_MEME_V2],
]);

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
