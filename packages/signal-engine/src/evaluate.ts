import type { Database } from '@sdb/database';
import type { AlertLevel, SignalState } from '@sdb/domain';
import { calculateAlphaScore, hasSufficientCoverage, type ScoringConfig } from '@sdb/scoring';
import { ageMinutes, type Logger } from '@sdb/shared';
import { shouldAlert, type DedupeConfig } from './dedupe.js';
import {
  currentSignal,
  lastAlert,
  latestFeatureSet,
  latestRiskStatus,
  loadPoolContext,
  recordStateEntry,
} from './persist.js';
import { alertLevelFor, nextState, type TransitionConfig } from './state-machine.js';

/**
 * Score a pool and advance its signal state (§17, §18).
 *
 * Runs after every feature calculation. Scoring itself is pure computation over
 * data already in Postgres, so this costs no RPC.
 *
 * Phase 5 decides the alert level and stops there. Sending is Phase 6, and §29
 * forbids implementing ahead — nothing is enqueued to the notification queue.
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
};

export async function evaluateSignal(
  deps: SignalEvaluationDeps,
  poolId: string,
): Promise<SignalEvaluation | null> {
  const context = await loadPoolContext(deps.db, poolId);
  if (!context) return null;

  const featureSet = await latestFeatureSet(deps.db, poolId);
  if (!featureSet) return null; // nothing scored yet

  const score = calculateAlphaScore(featureSet.values, deps.scoring);
  const existing = await currentSignal(deps.db, context.tokenId);
  const riskStatus = await latestRiskStatus(deps.db, context.tokenId);

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

  const base: SignalEvaluation = {
    poolId,
    fromState: existing?.state ?? null,
    toState: transition.state,
    changed: transition.changed,
    reason: transition.reason,
    alphaScore: score.score,
    coverage: score.coverage,
    alertLevel: 'NONE',
    signalId: null,
  };

  // No state change means no new signal row. Re-recording an unchanged state on
  // every snapshot would bury the real transitions in noise and multiply the
  // rows §21 attaches outcomes to.
  if (!transition.changed) return base;

  const candidateLevel = alertLevelFor(transition.state);
  const previous = await lastAlert(deps.db, context.tokenId);
  const decision = shouldAlert(
    { level: candidateLevel, alphaScore: score.score, previous },
    deps.dedupe,
  );

  // §27: a risk FAIL prevents alerting entirely, whatever the score says.
  const alertLevel: AlertLevel =
    transition.state === 'EXPIRED' || !decision.shouldAlert ? 'NONE' : candidateLevel;

  const signalId = await recordStateEntry(deps.db, {
    context,
    fromState: existing?.state ?? null,
    toState: transition.state,
    reason: transition.reason,
    score,
    alertLevel,
    featureSetId: featureSet.id,
  });

  return { ...base, alertLevel, signalId };
}
