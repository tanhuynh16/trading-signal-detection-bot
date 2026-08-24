import { Worker, type Job, type Queue } from 'bullmq';
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
import { isRetryable, withContext, type Logger } from '@sdb/shared';
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
  config: {
    minLiquidityUsd: number;
    liquidityGraceMinutes: number;
    riskRules: RiskRuleConfig;
    /** Snapshot offsets at which risk is (re-)evaluated. */
    riskOffsets: readonly string[];
    riskProbeWei: bigint;
    features: FeatureConfig;
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
  handler: (job: Job) => Promise<void>,
): (job: Job) => Promise<void> {
  return async (job: Job) => {
    try {
      await handler(job);
    } catch (error) {
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
        { db: deps.db, logger: deps.logger, config: deps.config.features, http: deps.http },
        poolId,
        offset,
      );
      if (!features) return; // pool vanished; nothing to compute

      await persistFeatures(deps.db, features);

      const { measured, total } = coverage(features.values);
      withContext(logger, { correlationId: poolId, poolId }).info(
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
    }),
    { connection, concurrency: 4 },
  );

  for (const [worker, name] of [
    [discoveryWorker, QUEUE_NAMES.discoveryAnalysis],
    [snapshotWorker, QUEUE_NAMES.snapshot],
    [riskWorker, QUEUE_NAMES.riskAnalysis],
    [featureWorker, QUEUE_NAMES.featureCalculation],
  ] as const) {
    worker.on('failed', (job, error) => {
      logger.error(
        { queue: name, jobId: job?.id, attempts: job?.attemptsMade, err: error.message },
        'job failed',
      );
    });
  }

  return [discoveryWorker, snapshotWorker, riskWorker, featureWorker];
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
