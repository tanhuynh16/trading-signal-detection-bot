/**
 * Spec §23 queue inventory. Declared in Phase 0 so queue names and job-ID
 * conventions are fixed before any producer exists; the processors themselves
 * arrive in their respective phases.
 */
export const QUEUE_NAMES = {
  discoveryAnalysis: 'discovery-analysis',
  snapshot: 'snapshot',
  riskAnalysis: 'risk-analysis',
  featureCalculation: 'feature-calculation',
  notification: 'notification',
  outcome: 'outcome',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/**
 * Spec §23: jobs must be idempotent. BullMQ deduplicates on job ID, so identity
 * is derived from the work itself — never from a timestamp or random value.
 *
 * Separator is '.' because BullMQ rejects ':' in custom job IDs (it reserves
 * the colon for its own Redis key namespacing).
 */
export const jobId = {
  discoveryAnalysis: (poolId: string) => `discovery.${poolId}`,
  snapshot: (poolId: string, offsetLabel: string) => `snapshot.${poolId}.${offsetLabel}`,
  riskAnalysis: (tokenId: string, poolId: string) => `risk.${tokenId}.${poolId}`,
  featureCalculation: (poolId: string, offsetLabel: string) => `features.${poolId}.${offsetLabel}`,
  /**
   * Keyed on the ALERT, not the signal. Phase 5.1 lets one signal produce
   * several alert decisions (FIRST_ALERT, then SCORE_MOVED, then
   * COOLDOWN_ELAPSED) all at the same level; keying on signal+level would
   * collide and BullMQ would silently drop every re-alert.
   */
  notification: (alertId: string) => `notify.${alertId}`,
  outcome: (signalId: string, horizon: string) => `outcome.${signalId}.${horizon}`,
};

/** Spec §23: bounded exponential backoff, never infinite retry. */
export const DEFAULT_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 2_000 },
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 86_400 },
};
