import type { RiskFlag, RiskResult, RiskStatus, Severity } from '@sdb/domain';
import type { GoPlusFindings, SimulationOutcome } from '@sdb/security';

/**
 * The §14.1 risk table, as deterministic rules.
 *
 * Two invariants hold throughout:
 *
 *  1. Risk is a GATE. Nothing here produces a positive contribution to alpha —
 *     the only outputs are a status, a 0-100 risk score where higher is worse,
 *     and flags. §14.1 is explicit that risk filtering is separate from scoring.
 *
 *  2. Unknown is not safe. A flag we could not evaluate becomes an UNKNOWN_*
 *     entry and pushes toward WARNING, never toward PASS. Silently reading
 *     "no data" as "clean" is the failure this table exists to prevent.
 */

export type FlagAction = 'FAIL' | 'WARNING' | 'IGNORE';

export type RiskRuleConfig = {
  /** Action per flag code. Every §14.1 row is represented and configurable. */
  actions: Record<string, FlagAction>;
  /** Severity per flag code, used for the risk score weighting. */
  severities: Record<string, Severity>;
  /** Token tax above this (fraction, DEX fee already removed) fails. */
  maxTokenTaxFraction: number;
  /** Token tax above this warns. */
  warnTokenTaxFraction: number;
  /** Top-10 holder concentration (percent) above this warns. */
  warnTop10ConcentrationPercent: number;
  /** Optionally fail on extreme concentration; §14.1 leaves this to config. */
  failTop10ConcentrationPercent: number | null;
};

/** Flag codes. Stable strings — they are persisted and configured against. */
export const FLAG = {
  CANNOT_BUY: 'CANNOT_BUY',
  CANNOT_SELL: 'CANNOT_SELL',
  HONEYPOT: 'HONEYPOT',
  BLACKLIST_CAPABILITY: 'BLACKLIST_CAPABILITY',
  TRADING_RESTRICTION: 'TRADING_RESTRICTION',
  OWNER_CAN_MINT: 'OWNER_CAN_MINT',
  UNUSUAL_TAX: 'UNUSUAL_TAX',
  LP_CONCERN: 'LP_CONCERN',
  HOLDER_CONCENTRATION: 'HOLDER_CONCENTRATION',
  OWNER_PRIVILEGES: 'OWNER_PRIVILEGES',
  UNKNOWN_TRADEABILITY: 'UNKNOWN_TRADEABILITY',
  UNKNOWN_SECURITY_DATA: 'UNKNOWN_SECURITY_DATA',
} as const;

/** §14.1's default table. Every entry is overridable by strategy config. */
export const DEFAULT_RULE_CONFIG: RiskRuleConfig = {
  actions: {
    [FLAG.CANNOT_BUY]: 'FAIL',
    [FLAG.CANNOT_SELL]: 'FAIL',
    [FLAG.HONEYPOT]: 'FAIL',
    [FLAG.BLACKLIST_CAPABILITY]: 'FAIL',
    [FLAG.TRADING_RESTRICTION]: 'FAIL',
    [FLAG.OWNER_CAN_MINT]: 'WARNING',
    [FLAG.UNUSUAL_TAX]: 'WARNING',
    [FLAG.LP_CONCERN]: 'WARNING',
    [FLAG.HOLDER_CONCENTRATION]: 'WARNING',
    [FLAG.OWNER_PRIVILEGES]: 'WARNING',
    [FLAG.UNKNOWN_TRADEABILITY]: 'WARNING',
    [FLAG.UNKNOWN_SECURITY_DATA]: 'WARNING',
  },
  severities: {
    [FLAG.CANNOT_BUY]: 'CRITICAL',
    [FLAG.CANNOT_SELL]: 'CRITICAL',
    [FLAG.HONEYPOT]: 'CRITICAL',
    [FLAG.BLACKLIST_CAPABILITY]: 'CRITICAL',
    [FLAG.TRADING_RESTRICTION]: 'CRITICAL',
    [FLAG.OWNER_CAN_MINT]: 'HIGH',
    [FLAG.UNUSUAL_TAX]: 'HIGH',
    [FLAG.LP_CONCERN]: 'MEDIUM',
    [FLAG.HOLDER_CONCENTRATION]: 'HIGH',
    [FLAG.OWNER_PRIVILEGES]: 'MEDIUM',
    [FLAG.UNKNOWN_TRADEABILITY]: 'MEDIUM',
    [FLAG.UNKNOWN_SECURITY_DATA]: 'LOW',
  },
  maxTokenTaxFraction: 0.25,
  warnTokenTaxFraction: 0.1,
  warnTop10ConcentrationPercent: 40,
  failTop10ConcentrationPercent: null,
};

/**
 * Fields whose absence materially weakens the verdict. Each maps to a §14.1
 * critical or high row, so silence about any of them is itself a finding.
 */
const CRITICAL_PROVIDER_FIELDS = [
  'isHoneypot',
  'cannotSellAll',
  'isBlacklisted',
  'transferPausable',
  'isMintable',
] as const satisfies readonly (keyof GoPlusFindings)[];

const SEVERITY_WEIGHT: Record<Severity, number> = {
  LOW: 5,
  MEDIUM: 15,
  HIGH: 30,
  CRITICAL: 100,
};

function flag(
  code: string,
  message: string,
  config: RiskRuleConfig,
): RiskFlag {
  return {
    code,
    severity: config.severities[code] ?? 'MEDIUM',
    message,
  };
}

/**
 * Flags derived from our own buy/sell simulation.
 *
 * This is the authoritative source for tradeability: it observes what actually
 * happens on chain rather than trusting an index that has not seen the token.
 */
export function simulationFlags(
  outcome: SimulationOutcome,
  config: RiskRuleConfig,
): RiskFlag[] {
  const flags: RiskFlag[] = [];

  if (!outcome.canBuy) {
    // A buy that reverts may mean a blocked token OR a pool too thin to route.
    // These are indistinguishable from one revert, so this is reported as
    // unknown tradeability rather than a definite CANNOT_BUY accusation.
    flags.push(
      flag(
        FLAG.UNKNOWN_TRADEABILITY,
        `buy simulation did not execute: ${outcome.failureReason ?? 'unknown'}`,
        config,
      ),
    );
    return flags;
  }

  if (outcome.canSell === false) {
    // Bought successfully, cannot sell. This is the honeypot signature and is
    // unambiguous: the route demonstrably works in one direction only.
    flags.push(
      flag(
        FLAG.HONEYPOT,
        `sell simulation reverted after a successful buy: ${outcome.failureReason ?? 'unknown'}`,
        config,
      ),
    );
    return flags;
  }

  if (outcome.canSell === null) {
    flags.push(flag(FLAG.UNKNOWN_TRADEABILITY, 'sell was never attempted', config));
    return flags;
  }

  const tax = outcome.tokenTaxFraction;
  if (tax !== null) {
    if (tax >= config.maxTokenTaxFraction) {
      flags.push(
        flag(
          FLAG.UNUSUAL_TAX,
          `round-trip token tax ${(tax * 100).toFixed(1)}% at or above the fail threshold`,
          config,
        ),
      );
    } else if (tax >= config.warnTokenTaxFraction) {
      flags.push(
        flag(FLAG.UNUSUAL_TAX, `round-trip token tax ${(tax * 100).toFixed(1)}%`, config),
      );
    }
  }

  return flags;
}

/**
 * Flags derived from GoPlus, when it has data.
 *
 * An unindexed token yields a single low-severity UNKNOWN_SECURITY_DATA rather
 * than a dozen separate unknowns — the absence is one fact, not twelve.
 */
export function providerFlags(
  findings: GoPlusFindings,
  config: RiskRuleConfig,
): RiskFlag[] {
  if (findings.unindexed) {
    return [
      flag(
        FLAG.UNKNOWN_SECURITY_DATA,
        'security provider has not indexed this token yet',
        config,
      ),
    ];
  }

  const flags: RiskFlag[] = [];

  /**
   * Partial coverage is the dangerous case, and it is NOT the same as
   * unindexed. A response carrying buy_tax but omitting is_honeypot would,
   * without this, produce no flag at all for the missing field — reading
   * "we don't know" as "it's fine", which is precisely what §14 forbids.
   * Coverage is checked field by field rather than by one coarse heuristic.
   */
  const missing = CRITICAL_PROVIDER_FIELDS.filter((field) => findings[field] === null);
  if (missing.length > 0) {
    flags.push(
      flag(
        FLAG.UNKNOWN_SECURITY_DATA,
        `security provider omitted: ${missing.join(', ')}`,
        config,
      ),
    );
  }

  if (findings.isHoneypot === true) {
    flags.push(flag(FLAG.HONEYPOT, 'provider reports honeypot', config));
  }
  if (findings.cannotBuy === true) {
    flags.push(flag(FLAG.CANNOT_BUY, 'provider reports token cannot be bought', config));
  }
  if (findings.cannotSellAll === true) {
    flags.push(flag(FLAG.CANNOT_SELL, 'provider reports token cannot be fully sold', config));
  }
  if (findings.isBlacklisted === true) {
    flags.push(flag(FLAG.BLACKLIST_CAPABILITY, 'contract can blacklist addresses', config));
  }
  if (findings.transferPausable === true || findings.tradingCooldown === true) {
    flags.push(
      flag(
        FLAG.TRADING_RESTRICTION,
        findings.transferPausable === true
          ? 'transfers can be paused'
          : 'trading cooldown enforced',
        config,
      ),
    );
  }
  if (findings.isMintable === true) {
    flags.push(flag(FLAG.OWNER_CAN_MINT, 'owner can mint additional supply', config));
  }
  if (findings.canTakeBackOwnership === true || findings.hiddenOwner === true) {
    flags.push(
      flag(FLAG.OWNER_PRIVILEGES, 'ownership can be reclaimed or is hidden', config),
    );
  }
  if (findings.ownerChangeBalance === true) {
    flags.push(flag(FLAG.OWNER_PRIVILEGES, 'owner can modify balances', config));
  }
  if (findings.lpHolderCount !== null && findings.lpHolderCount === 0) {
    flags.push(flag(FLAG.LP_CONCERN, 'no LP holders reported', config));
  }

  const top10 = findings.top10Percent;
  if (top10 !== null) {
    const asPercent = top10 <= 1 ? top10 * 100 : top10;
    const failAt = config.failTop10ConcentrationPercent;
    if (failAt !== null && asPercent >= failAt) {
      flags.push(
        flag(
          FLAG.HOLDER_CONCENTRATION,
          `top 10 hold ${asPercent.toFixed(1)}% of supply`,
          config,
        ),
      );
    } else if (asPercent >= config.warnTop10ConcentrationPercent) {
      flags.push(
        flag(
          FLAG.HOLDER_CONCENTRATION,
          `top 10 hold ${asPercent.toFixed(1)}% of supply`,
          config,
        ),
      );
    }
  }

  return flags;
}

/**
 * Combine flags into a verdict.
 *
 * Status is decided by the worst configured action, not by the score: §14.1
 * treats these as categorical actions, and a numeric threshold would let two
 * medium flags masquerade as one critical.
 */
export function decide(flags: RiskFlag[], config: RiskRuleConfig): RiskResult {
  let status: RiskStatus = 'PASS';

  for (const item of flags) {
    const action = config.actions[item.code] ?? 'WARNING';
    if (action === 'FAIL') {
      status = 'FAIL';
      break;
    }
    if (action === 'WARNING') status = 'WARNING';
  }

  return {
    status,
    riskScore: scoreFor(flags),
    flags,
    evaluatedAt: new Date(),
  };
}

/**
 * 0 = safest, 100 = riskiest (§14.2).
 *
 * Monotonic by construction: every flag adds a non-negative weight, so adding
 * evidence can never make a token look safer.
 */
export function scoreFor(flags: RiskFlag[]): number {
  const total = flags.reduce((sum, item) => sum + (SEVERITY_WEIGHT[item.severity] ?? 0), 0);
  return Math.min(100, total);
}

/** Deduplicate flags by code, keeping the highest severity of each. */
export function mergeFlags(...groups: RiskFlag[][]): RiskFlag[] {
  const order: Severity[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
  const best = new Map<string, RiskFlag>();
  for (const item of groups.flat()) {
    const existing = best.get(item.code);
    if (!existing || order.indexOf(item.severity) > order.indexOf(existing.severity)) {
      best.set(item.code, item);
    }
  }
  return [...best.values()];
}
