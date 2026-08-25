import { DelayedError, Worker, type Job, type Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { PublicClient } from 'viem';
import type { Database } from '@sdb/database';
import { jobsAudit } from '@sdb/database';
import type { QuotePriceResolver } from '@sdb/market-data';
import {
  captureSnapshot,
  enrichToken,
  planSnapshots,
  recentSnapshots,
  shouldStopTracking,
} from '@sdb/snapshot-engine';
import { evaluateRisk, persistRisk, type RiskRuleConfig } from '@sdb/risk-engine';
import {
  calculateFeatures,
  coverage,
  persistFeatures,
  type FeatureConfig,
} from '@sdb/feature-engine';
import { evaluateSignal, type DedupeConfig, type TransitionConfig } from '@sdb/signal-engine';
import type { ScoringConfig } from '@sdb/scoring';
import {
  decide,
  failureCodeOf,
  isGlobalFailure,
  loadAlertPayload,
  markFailed,
  markSent,
  onFailure,
  onSuccess,
  readCircuit,
  renderAlert,
  writeCircuit,
  type CircuitConfig,
  type Notifier,
} from '@sdb/notifications';
import { InvalidDataError, isRetryable, withContext, type Logger } from '@sdb/shared';
import type { GoPlusSecurityProvider } from '@sdb/security';
import { DEFAULT_JOB_OPTIONS, QUEUE_NAMES, jobId } from './queues.js';

export type ProcessorDeps = {
  db: Database;
  http: PublicClient;
  connection: Redis;
  queues: Record<string, Queue>;
  quotePrices: QuotePriceResolver;
  logger: Logger;
  goplus: GoPlusSecurityProvider | null;
  /** Null when no credentials are configured; alerts then stay PENDING. */
  notifier: Notifier | null;
  config: {
    minLiquidityUsd: number;
    liquidityGraceMinutes: number;
    riskRules: RiskRuleConfig;
    /** Snapshot offsets at which risk is (re-)evaluated. */
    riskOffsets: readonly string[];
    riskProbeWei: bigint;
    circuit: CircuitConfig;
    features: FeatureConfig;
    scoring: ScoringConfig;
    transitions: TransitionConfig;
    dedupe: DedupeConfig;
  };
};

/**
 * Spec §23: permanent errors go to audit storage, never back onto the retry
 * loop. A job whose pool no longer exists will fail identically forever, so
 * retrying it only burns attempts and hides real failures behind noise.
 */
async function auditFailure(
  deps: ProcessorDeps,
  queue: string,
  job: Job,
  error: unknown,
): Promise<void> {
  await deps.db.insert(jobsAudit).values({
    queue,
    jobId: job.id ?? 'unknown',
    correlationId: (job.data as { poolId?: string }).poolId ?? null,
    status: isRetryable(error) ? 'retry_exhausted' : 'permanent_failure',
    attempts: job.attemptsMade + 1,
    errorCode: error instanceof Error ? error.name : 'UnknownError',
    errorMessage: error instanceof Error ? error.message : String(error),
    payload: job.data as Record<string, unknown>,
  });
}

/**
 * Wrap a processor so permanent failures are recorded and swallowed, while
 * transient ones rethrow and let BullMQ's bounded backoff do its work.
 */
function guarded(
  deps: ProcessorDeps,
  queue: string,
  handler: (job: Job, token?: string) => Promise<void>,
): (job: Job, token?: string) => Promise<void> {
  return async (job: Job, token?: string) => {
    try {
      await handler(job, token);
    } catch (error) {
      // DelayedError is BullMQ's signal that the job was rescheduled, not that
      // it failed. Swallowing it here would mark the job complete and orphan
      // the alert it was holding.
      if (error instanceof DelayedError) throw error;
      if (isRetryable(error)) throw error;
      await auditFailure(deps, queue, job, error);
      deps.logger.warn(
        {
          queue,
          jobId: job.id,
          err: error instanceof Error ? error.message : String(error),
        },
        'permanent job failure recorded to audit; not retrying',
      );
    }
  };
}

export function startProcessors(deps: ProcessorDeps): Worker[] {
  const { connection, queues, logger } = deps;
  const snapshotQueue = queues[QUEUE_NAMES.snapshot]!;

  /**
   * discovery-analysis: enrich the token, then schedule the whole §13 series.
   */
  const discoveryWorker = new Worker(
    QUEUE_NAMES.discoveryAnalysis,
    guarded(deps, QUEUE_NAMES.discoveryAnalysis, async (job) => {
      const { poolId } = job.data as { poolId: string };
      const result = await enrichToken(deps, poolId);
      const log = withContext(logger, {
        correlationId: poolId,
        poolId,
        tokenId: result.tokenId,
      });

      // All eight at once. §13 forbids a job scheduling its successor.
      const planned = planSnapshots();
      await Promise.all(
        planned.map((snapshot) =>
          snapshotQueue.add(
            'capture',
            { poolId, offset: snapshot.offset, windowMs: snapshot.windowMs },
            {
              ...DEFAULT_JOB_OPTIONS,
              delay: snapshot.delayMs,
              jobId: jobId.snapshot(poolId, snapshot.offset),
            },
          ),
        ),
      );

      log.info(
        {
          symbol: result.symbol,
          decimals: result.decimals,
          scheduled: planned.length,
          reused: result.alreadyEnriched,
        },
        'token enriched; snapshot series scheduled',
      );
    }),
    { connection, concurrency: 4 },
  );

  /**
   * snapshot: capture one observation. Idempotent on (pool, offset).
   */
  const snapshotWorker = new Worker(
    QUEUE_NAMES.snapshot,
    guarded(deps, QUEUE_NAMES.snapshot, async (job) => {
      const { poolId, offset, windowMs } = job.data as {
        poolId: string;
        offset: string;
        windowMs: number;
      };

      const result = await captureSnapshot(deps, {
        poolId,
        scheduledOffset: offset,
        windowMs,
      });

      const log = withContext(logger, { correlationId: poolId, poolId });
      log.info(
        {
          offset,
          created: result.created,
          priceUsd: result.priceUsd,
          liquidityUsd: result.liquidityUsd,
        },
        result.created ? 'snapshot captured' : 'snapshot already existed',
      );

      // Features are recomputed after every snapshot: each new observation
      // extends the liquidity series and the trade windows §15 measures over.
      if (result.created) {
        await queues[QUEUE_NAMES.featureCalculation]!.add(
          'calculate',
          { poolId, offset },
          { ...DEFAULT_JOB_OPTIONS, jobId: jobId.featureCalculation(poolId, offset) },
        );
      }

      // Spec §14 + late-rug defence: a deployer can enable a tax or blacklist
      // after launch, so a single T+0 check is trivially defeated. The job ID
      // includes the offset so each re-check is its own idempotent unit.
      if (result.created && deps.config.riskOffsets.includes(offset)) {
        await queues[QUEUE_NAMES.riskAnalysis]!.add(
          'evaluate',
          { poolId, offset },
          { ...DEFAULT_JOB_OPTIONS, jobId: `risk.${poolId}.${offset}` },
        );
      }

      // §13 early-stop: drop the remaining series for a pool that never became
      // priceable or never reached the liquidity floor.
      const snapshots = await recentSnapshots(deps.db, poolId);
      const first = snapshots[0];
      if (!first) return;

      const verdict = shouldStopTracking({
        snapshots,
        discoveredAt: first.capturedAt,
        minLiquidityUsd: deps.config.minLiquidityUsd,
        graceMinutes: deps.config.liquidityGraceMinutes,
      });

      if (verdict.stop) {
        const removed = await removePendingSnapshots(snapshotQueue, poolId);
        log.info({ reason: verdict.reason, removed }, 'stopped tracking pool early');
      }
    }),
    { connection, concurrency: 4 },
  );

  /**
   * risk-analysis: gate the token per §14. A FAIL stops all further tracking —
   * §27 requires that a risk FAIL prevents alpha alerting entirely, and §13
   * allows early-stopping a token that has failed.
   */
  const riskWorker = new Worker(
    QUEUE_NAMES.riskAnalysis,
    guarded(deps, QUEUE_NAMES.riskAnalysis, async (job) => {
      const { poolId, offset } = job.data as { poolId: string; offset: string };

      const evaluation = await evaluateRisk(
        {
          db: deps.db,
          http: deps.http,
          goplus: deps.goplus,
          logger: deps.logger,
          rules: deps.config.riskRules,
          probeWei: deps.config.riskProbeWei,
        },
        poolId,
      );

      // §21: always an INSERT. The re-checks are separate observations of a
      // contract whose state can genuinely change between them.
      await persistRisk(deps.db, evaluation);

      const log = withContext(logger, { correlationId: poolId, poolId });
      log.info(
        {
          offset,
          status: evaluation.result.status,
          riskScore: evaluation.result.riskScore,
          flags: evaluation.result.flags.map((f) => f.code),
          canBuy: evaluation.simulation?.canBuy,
          canSell: evaluation.simulation?.canSell,
          tokenTax: evaluation.simulation?.tokenTaxFraction,
        },
        'risk evaluated',
      );

      if (evaluation.result.status === 'FAIL') {
        const removed = await removePendingSnapshots(snapshotQueue, poolId);
        log.warn(
          { removed, flags: evaluation.result.flags.map((f) => f.code) },
          'risk FAIL: tracking stopped, no alerting possible for this token',
        );
      }
    }),
    { connection, concurrency: 2 },
  );

  /**
   * feature-calculation: compute the §15 feature set from stored snapshots,
   * trades and holder balances. Pure computation over Postgres — no RPC.
   */
  const featureWorker = new Worker(
    QUEUE_NAMES.featureCalculation,
    guarded(deps, QUEUE_NAMES.featureCalculation, async (job) => {
      const { poolId, offset } = job.data as { poolId: string; offset: string };

      const features = await calculateFeatures(
        {
          db: deps.db,
          logger: deps.logger,
          config: deps.config.features,
          http: deps.http,
          quotePricing: deps.quotePrices,
        },
        poolId,
        offset,
      );
      if (!features) return; // pool vanished; nothing to compute

      await persistFeatures(deps.db, features);

      const { measured, total } = coverage(features.values);
      const log = withContext(logger, { correlationId: poolId, poolId });
      log.info(
        {
          offset,
          measured,
          total,
          liquidityUsd: features.values['liquidity_usd'],
          buySellRatio: features.values['buy_sell_ratio'],
          volumeAcceleration: features.values['volume_acceleration_5m'],
          holderCount: features.values['holder_count'],
          clusterConcentration: features.values['cluster_concentration'],
        },
        'features calculated',
      );

      // §17/§18: score and advance the state machine off the features we just
      // wrote. Pure computation over Postgres — no RPC, so this is cheap enough
      // to run after every snapshot.
      const signal = await evaluateSignal(
        {
          db: deps.db,
          logger: deps.logger,
          scoring: deps.config.scoring,
          transitions: deps.config.transitions,
          dedupe: deps.config.dedupe,
        },
        poolId,
      );

      // §20 delivery. Phase 5 only recorded the decision; a PENDING row is one
      // that survived dedup and is waiting to be sent.
      if (signal?.alertDecision?.status === 'PENDING' && signal.alertDecision.id) {
        await queues[QUEUE_NAMES.notification]!.add(
          'send',
          { alertId: signal.alertDecision.id },
          { ...DEFAULT_JOB_OPTIONS, jobId: jobId.notification(signal.alertDecision.id) },
        );
      }

      if (signal?.changed) {
        log.info(
          {
            from: signal.fromState,
            to: signal.toState,
            reason: signal.reason,
            alphaScore: Number(signal.alphaScore.toFixed(2)),
            coverage: Number(signal.coverage.toFixed(3)),
            alertLevel: signal.alertLevel,
          },
          'signal state changed',
        );
      }
    }),
    { connection, concurrency: 4 },
  );

  /**
   * notification: render and deliver one alert (§20).
   *
   * Concurrency 1: Telegram rate-limits per chat, and a burst of parallel sends
   * would manufacture the very failures the retry path exists to absorb.
   */
  const notificationWorker = new Worker(
    QUEUE_NAMES.notification,
    guarded(deps, QUEUE_NAMES.notification, async (job, token) => {
      const { alertId } = job.data as { alertId: string };
      const log = withContext(logger, { correlationId: alertId });

      if (!deps.notifier) {
        // No transport configured. Leave the row PENDING rather than marking it
        // FAILED — nothing was attempted, and FAILED would let dedup re-alert.
        log.warn({ alertId }, 'no notifier configured; alert left pending');
        return;
      }

      // §6.1: refuse to attempt delivery while the transport is known broken.
      // The alert stays PENDING — an obligation still owed — instead of
      // churning to FAILED and feeding the re-alert loop.
      const snapshot = await readCircuit(deps.db, deps.notifier.name);
      const verdict = decide(snapshot, deps.config.circuit);
      if (!verdict.allow) {
        log.warn(
          { alertId, retryAt: verdict.retryAt, failures: snapshot?.consecutiveFailures },
          'notifier circuit open; alert held pending',
        );
        // Reschedule without consuming a retry attempt (BullMQ treats
        // DelayedError as "rescheduled", not "failed").
        await job.moveToDelayed(verdict.retryAt.getTime(), token);
        throw new DelayedError();
      }

      const payload = await loadAlertPayload(deps.db, alertId);
      if (!payload) {
        throw new InvalidDataError(`alert ${alertId} no longer exists`, { alertId });
      }

      try {
        await deps.notifier.send(renderAlert(payload));
      } catch (error) {
        const exhausted = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
        const global = isGlobalFailure(error, exhausted);
        const transition = onFailure(snapshot, { global, config: deps.config.circuit });
        await writeCircuit(deps.db, deps.notifier.name, transition, {
          code: failureCodeOf(error),
          reason: error instanceof Error ? error.message : String(error),
        });

        if (transition.justOpened) {
          // Requirement 7: alerting going silent must never itself be silent.
          log.error(
            {
              notifier: deps.notifier!.name,
              failureCode: failureCodeOf(error),
              consecutiveFailures: transition.consecutiveFailures,
              probeAt: transition.reopenAfter,
            },
            'notifier circuit OPENED; alerts will be held pending until it recovers',
          );
          await deps.db.insert(jobsAudit).values({
            queue: QUEUE_NAMES.notification,
            jobId: job.id ?? 'unknown',
            correlationId: alertId,
            status: 'circuit_open',
            attempts: transition.consecutiveFailures,
            errorCode: failureCodeOf(error),
            errorMessage: error instanceof Error ? error.message : String(error),
            payload: job.data as Record<string, unknown>,
          });
        }

        // A globally-failing transport must not burn the alert: hold it PENDING
        // so the backlog drains once credentials are fixed. Only a per-message
        // rejection marks this particular alert FAILED.
        if (!isRetryable(error) && !global) await markFailed(deps.db, alertId);
        throw error;
      }

      // Requirement 6: any success closes the circuit and clears the counter.
      const success = onSuccess(snapshot);
      if (success.justClosed) {
        const downMs = snapshot?.openedAt ? Date.now() - snapshot.openedAt.getTime() : null;
        log.info(
          { notifier: deps.notifier.name, openForMs: downMs },
          'notifier circuit CLOSED; delivery recovered',
        );
      }
      await writeCircuit(deps.db, deps.notifier.name, success, null);

      // Guarded on PENDING, so a duplicate job cannot double-send.
      const marked = await markSent(deps.db, alertId);
      log.info(
        { alertId, level: payload.alertLevel, symbol: payload.symbol, firstTransition: marked },
        'alert sent',
      );
    }),
    { connection, concurrency: 1, limiter: { max: 20, duration: 60_000 } },
  );

  /**
   * §20: "Failure to send Telegram must not discard the signal." Once bounded
   * retries are exhausted the alert is marked FAILED — and Phase 5.1's dedup
   * counts only SENT/PENDING, so the token becomes eligible to alert again
   * rather than going silent.
   */
  notificationWorker.on('failed', (job, error) => {
    if (!job) return;
    const exhausted = job.attemptsMade >= (job.opts.attempts ?? 1);
    if (!exhausted) return;
    const { alertId } = job.data as { alertId: string };
    void markFailed(deps.db, alertId).then(() =>
      logger.error({ alertId, attempts: job.attemptsMade, err: error.message },
        'alert delivery failed permanently; token may re-alert'),
    );
  });

  for (const [worker, name] of [
    [discoveryWorker, QUEUE_NAMES.discoveryAnalysis],
    [snapshotWorker, QUEUE_NAMES.snapshot],
    [riskWorker, QUEUE_NAMES.riskAnalysis],
    [featureWorker, QUEUE_NAMES.featureCalculation],
    [notificationWorker, QUEUE_NAMES.notification],
  ] as const) {
    worker.on('failed', (job, error) => {
      logger.error(
        { queue: name, jobId: job?.id, attempts: job?.attemptsMade, err: error.message },
        'job failed',
      );
    });
  }

  return [discoveryWorker, snapshotWorker, riskWorker, featureWorker, notificationWorker];
}

/** Cancel a pool's not-yet-due snapshot jobs. */
async function removePendingSnapshots(queue: Queue, poolId: string): Promise<number> {
  const delayed = await queue.getDelayed();
  let removed = 0;
  for (const job of delayed) {
    if ((job.data as { poolId?: string }).poolId === poolId) {
      await job.remove();
      removed += 1;
    }
  }
  return removed;
}
