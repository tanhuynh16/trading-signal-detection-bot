import type { Database } from '@sdb/database';
import type { AlertLevel, AlertStatus, AlertTriggerReason, SignalState } from '@sdb/domain';
import { calculateAlphaScore, hasSufficientCoverage, type ScoringConfig } from '@sdb/scoring';
import { ageMinutes, type Logger } from '@sdb/shared';
import { shouldAlert, type DedupeConfig, type DedupeDecision } from './dedupe.js';
import {
  currentSignal,
  lastAlert,
  latestFeatureSet,
  latestRiskStatus,
  loadPoolContext,
  lockToken,
  recordAlertDecision,
  recordStateEntry,
} from './persist.js';
import { alertLevelFor, nextState, type TransitionConfig } from './state-machine.js';

/**
 * Score a pool and advance its signal state (§17, §18).
 *
 * The whole read-decide-write sequence runs in ONE transaction holding a
 * per-token advisory lock. Without it, two concurrent evaluations both read
 * WATCHING, both compute INTERESTING, and both insert — a duplicate state entry
 * that would become a duplicate alert in Phase 6 and a duplicate outcome series
 * in Phase 7.
 *
 * Phase 5.1 records alert DECISIONS; sending is Phase 6, so emitted decisions
 * are written as PENDING and nothing is enqueued to the notification queue.
 */
export type SignalEvaluationDeps = {
  db: Database;
  logger: Logger;
  scoring: ScoringConfig;
  transitions: TransitionConfig;
  dedupe: DedupeConfig;
};

export type SignalEvaluation = {
  poolId: string;
  fromState: SignalState | null;
  toState: SignalState;
  changed: boolean;
  reason: string;
  alphaScore: number;
  coverage: number;
  alertLevel: AlertLevel;
  signalId: string | null;
  /** Null when the state carried no alert level, so no decision was recorded. */
  alertDecision: { id: string | null; status: AlertStatus; reason: string } | null;
};

/** Map a dedup outcome onto the persisted trigger reason. */
const TRIGGER: Partial<Record<DedupeDecision['reason'], AlertTriggerReason>> = {
  first_alert: 'FIRST_ALERT',
  level_upgraded: 'LEVEL_UPGRADED',
  score_moved: 'SCORE_MOVED',
  cooldown_elapsed: 'COOLDOWN_ELAPSED',
};

export async function evaluateSignal(
  deps: SignalEvaluationDeps,
  poolId: string,
): Promise<SignalEvaluation | null> {
  return deps.db.transaction(async (tx) => {
    // Identify the token before locking; everything after is read under it.
    const pre = await loadPoolContext(tx, poolId);
    if (!pre) return null;

    await lockToken(tx, pre.tokenId);

    // Re-read under the lock. A racer that queued behind us must observe what
    // the winner committed, not the stale view it loaded before waiting.
    const context = await loadPoolContext(tx, poolId);
    if (!context) return null;

    const featureSet = await latestFeatureSet(tx, poolId);
    if (!featureSet) return null; // nothing scored yet

    const score = calculateAlphaScore(featureSet.values, deps.scoring);
    const existing = await currentSignal(tx, context.tokenId);
    const riskStatus = await latestRiskStatus(tx, context.tokenId);

    const transition = nextState(
      {
        currentState: existing?.state ?? 'NEW',
        alphaScore: score.score,
        hasSufficientCoverage: hasSufficientCoverage(score, deps.scoring),
        // No risk verdict yet is treated as WARNING rather than PASS: §14 makes
        // risk a gate, and an unevaluated token has not passed it.
        riskStatus: riskStatus ?? 'WARNING',
        ageMinutes: ageMinutes(context.discoveredAt),
        minutesSinceLastTrade: context.minutesSinceLastTrade,
        liquidityUsd: context.liquidityUsd,
        peakLiquidityUsd: context.peakLiquidityUsd,
      },
      deps.transitions,
    );

    // A signals row is written only on a state entry. ADR 0015 keeps it the
    // canonical state-transition entity — re-alerts must not add rows here, or
    // both the state history and the §21 outcome series are corrupted.
    let signalId = existing?.id ?? null;
    if (transition.changed) {
      signalId = await recordStateEntry(tx, {
        context,
        fromState: existing?.state ?? null,
        toState: transition.state,
        reason: transition.reason,
        score,
        alertLevel: alertLevelFor(transition.state),
        featureSetId: featureSet.id,
      });
    }

    const base: SignalEvaluation = {
      poolId,
      fromState: existing?.state ?? null,
      toState: transition.state,
      changed: transition.changed,
      reason: transition.reason,
      alphaScore: score.score,
      coverage: score.coverage,
      alertLevel: 'NONE',
      signalId,
      alertDecision: null,
    };

    const candidateLevel = alertLevelFor(transition.state);

    // §27: a risk FAIL, and an expired token generally, can never alert.
    if (candidateLevel === 'NONE' || transition.state === 'EXPIRED' || signalId === null) {
      return base;
    }

    // Dedup runs whether or not the state changed. Gating it behind a state
    // change made §18's "unless score changes by delta or cooldown expires"
    // unreachable: with no-downgrade each state is entered once, so the only
    // outcomes were first_alert and level_upgraded.
    const previous = await lastAlert(tx, context.tokenId);
    const decision = shouldAlert(
      { level: candidateLevel, alphaScore: score.score, previous },
      deps.dedupe,
    );

    const status: AlertStatus = decision.shouldAlert ? 'PENDING' : 'SUPPRESSED';
    const decisionId = await recordAlertDecision(tx, {
      signalId,
      tokenId: context.tokenId,
      featureSetId: featureSet.id,
      alertLevel: candidateLevel,
      status,
      triggerReason: decision.shouldAlert ? (TRIGGER[decision.reason] ?? null) : null,
      suppressionReason: decision.shouldAlert ? null : decision.reason,
      alphaScore: score.score,
    });

    return {
      ...base,
      alertLevel: decision.shouldAlert ? candidateLevel : 'NONE',
      alertDecision: { id: decisionId, status, reason: decision.reason },
    };
  });
}
