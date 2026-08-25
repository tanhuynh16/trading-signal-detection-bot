import type { AlertLevel, RiskStatus, SignalState } from '@sdb/domain';

/**
 * Spec §18 signal state machine.
 *
 *   NEW ──risk PASS/WARNING + min discovery──▶ WATCHING
 *   WATCHING ──alpha >= interestingThreshold──▶ INTERESTING
 *   INTERESTING ──alpha >= strongThreshold────▶ STRONG_SIGNAL
 *   any active ──risk FAIL / age / inactivity / liquidity collapse──▶ EXPIRED
 *
 * Pure and deterministic: §27 requires that identical inputs and config version
 * produce identical transitions, which is what makes a signal reproducible
 * months later from stored feature values.
 */

export type TransitionConfig = {
  interestingThreshold: number;
  strongThreshold: number;
  /** §18: v1 does not downgrade unless this is switched on. */
  downgradePolicyEnabled: boolean;
  /** §19 maxTokenAgeMinutes. */
  maxTokenAgeMinutes: number;
  /** §19 inactiveExpiryMinutes. */
  inactiveExpiryMinutes: number;
  /** Liquidity below this fraction of its peak counts as collapse. */
  liquidityCollapseFraction: number;
};

export type TransitionInput = {
  currentState: SignalState;
  alphaScore: number;
  /** False when coverage is below the floor; caps the token at INTERESTING. */
  hasSufficientCoverage: boolean;
  riskStatus: RiskStatus;
  ageMinutes: number;
  minutesSinceLastTrade: number | null;
  liquidityUsd: number | null;
  peakLiquidityUsd: number | null;
};

export type TransitionResult = {
  state: SignalState;
  changed: boolean;
  reason: string;
};

const ACTIVE: readonly SignalState[] = ['NEW', 'WATCHING', 'INTERESTING', 'STRONG_SIGNAL'];

/** Ordering for upgrade/downgrade comparisons. EXPIRED is terminal, not ranked. */
const RANK: Record<SignalState, number> = {
  NEW: 0,
  WATCHING: 1,
  INTERESTING: 2,
  STRONG_SIGNAL: 3,
  EXPIRED: -1,
};

export function nextState(
  input: TransitionInput,
  config: TransitionConfig,
): TransitionResult {
  const current = input.currentState;

  // EXPIRED is terminal. §18 offers no path back, and resurrecting a token
  // whose liquidity collapsed would re-alert on a corpse.
  if (current === 'EXPIRED') {
    return { state: 'EXPIRED', changed: false, reason: 'already_expired' };
  }

  // §18: "Any active state --risk FAIL--> EXPIRED". Checked first because it
  // overrides every other consideration, and §27 requires a FAIL to prevent
  // alpha alerting entirely.
  if (input.riskStatus === 'FAIL' && ACTIVE.includes(current)) {
    return { state: 'EXPIRED', changed: true, reason: 'risk_fail' };
  }

  const expiry = expiryReason(input, config);
  if (expiry) return { state: 'EXPIRED', changed: true, reason: expiry };

  // NEW -> WATCHING requires only that risk let it through; §18 gates this on
  // risk status and discovery requirements, NOT on a score. A token must be
  // watched before it can be scored meaningfully.
  if (current === 'NEW') {
    return { state: 'WATCHING', changed: true, reason: 'risk_cleared' };
  }

  const target = targetState(input, config);

  if (RANK[target] > RANK[current]) {
    return { state: target, changed: true, reason: `alpha_${target.toLowerCase()}` };
  }

  // §18: "A token may upgrade but should not downgrade by default in v1."
  if (RANK[target] < RANK[current] && config.downgradePolicyEnabled) {
    return { state: target, changed: true, reason: 'downgrade_policy' };
  }

  return { state: current, changed: false, reason: 'no_change' };
}

/**
 * The state this score alone would justify.
 *
 * §17's band table calls 0–39 "Ignore", but §18 has no Ignore state — a token
 * that scores poorly simply never upgrades past WATCHING.
 */
function targetState(input: TransitionInput, config: TransitionConfig): SignalState {
  const { alphaScore } = input;

  if (alphaScore >= config.strongThreshold) {
    // Thin evidence can produce a high score on a fraction of the picture.
    // §17's bands assume a full assessment, so cap rather than overstate.
    return input.hasSufficientCoverage ? 'STRONG_SIGNAL' : 'INTERESTING';
  }
  if (alphaScore >= config.interestingThreshold) return 'INTERESTING';
  return 'WATCHING';
}

/** §18 expiry conditions other than risk FAIL. */
function expiryReason(input: TransitionInput, config: TransitionConfig): string | null {
  if (input.ageMinutes > config.maxTokenAgeMinutes) return 'age_limit';

  if (
    input.minutesSinceLastTrade !== null &&
    input.minutesSinceLastTrade > config.inactiveExpiryMinutes
  ) {
    return 'inactivity';
  }

  // Liquidity collapse: a pool that has lost most of its depth relative to its
  // own peak has been drained, whatever its score says.
  if (
    input.liquidityUsd !== null &&
    input.peakLiquidityUsd !== null &&
    input.peakLiquidityUsd > 0 &&
    input.liquidityUsd < input.peakLiquidityUsd * config.liquidityCollapseFraction
  ) {
    return 'liquidity_collapse';
  }

  return null;
}

/** The alert level a state implies, before deduplication. */
export function alertLevelFor(state: SignalState): AlertLevel {
  switch (state) {
    case 'STRONG_SIGNAL':
      return 'STRONG';
    case 'INTERESTING':
      return 'INTERESTING';
    default:
      return 'NONE';
  }
}

export function isActive(state: SignalState): boolean {
  return ACTIVE.includes(state);
}
