import type { AlertLevel } from '@sdb/domain';

/**
 * Spec §18 alert deduplication:
 * "at most one alert per level per token unless score changes by configured
 * delta or cooldown expires."
 *
 * Without this the pipeline re-alerts on every snapshot — eight times per token
 * per hour for the same fact — and a channel that cries wolf is one nobody
 * reads.
 */

export type DedupeConfig = {
  /** Re-alert if the score moved at least this much. */
  rescoreDelta: number;
  /** Re-alert once this long has passed at the same level. */
  cooldownMinutes: number;
};

export type PreviousAlert = {
  level: AlertLevel;
  alphaScore: number;
  sentAt: Date;
};

export type DedupeDecision = {
  shouldAlert: boolean;
  reason:
    | 'first_alert'
    | 'level_upgraded'
    | 'score_moved'
    | 'cooldown_elapsed'
    | 'suppressed_duplicate'
    | 'no_alert_level';
};

const LEVEL_RANK: Record<AlertLevel, number> = { NONE: 0, INTERESTING: 1, STRONG: 2 };

export function shouldAlert(
  input: {
    level: AlertLevel;
    alphaScore: number;
    previous: PreviousAlert | null;
    now?: Date;
  },
  config: DedupeConfig,
): DedupeDecision {
  if (input.level === 'NONE') {
    return { shouldAlert: false, reason: 'no_alert_level' };
  }

  const previous = input.previous;
  if (!previous) {
    return { shouldAlert: true, reason: 'first_alert' };
  }

  // A genuine upgrade is always worth sending: INTERESTING then STRONG are
  // different claims, not a repeat of the same one.
  if (LEVEL_RANK[input.level] > LEVEL_RANK[previous.level]) {
    return { shouldAlert: true, reason: 'level_upgraded' };
  }

  if (Math.abs(input.alphaScore - previous.alphaScore) >= config.rescoreDelta) {
    return { shouldAlert: true, reason: 'score_moved' };
  }

  const now = input.now ?? new Date();
  const elapsedMinutes = (now.getTime() - previous.sentAt.getTime()) / 60_000;
  if (elapsedMinutes >= config.cooldownMinutes) {
    return { shouldAlert: true, reason: 'cooldown_elapsed' };
  }

  return { shouldAlert: false, reason: 'suppressed_duplicate' };
}
