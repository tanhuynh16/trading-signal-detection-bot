import { and, asc, eq, gte, lte, sql } from 'drizzle-orm';
import {
  pools,
  quotePriceSamples,
  signalOutcomes,
  signals,
  tokens,
  trades,
  type Database,
} from '@sdb/database';
import { toColumn } from '@sdb/market-data';
import { InvalidDataError, parseScaled } from '@sdb/shared';
import { decideCoverage, tailWatermark, type CoverageConfig } from './coverage.js';
import { horizonMs } from './horizons.js';
import {
  baseIsToken0,
  buildPriceSeries,
  computeMetrics,
  type OutcomeMetrics,
} from './price-path.js';

/**
 * Everything needed to price a quote asset historically.
 *
 * Implemented by `QuotePriceResolver`, but taken as an interface so the pure
 * evaluation never depends on a live RPC client.
 */
export type QuoteInfo = {
  decimalsFor(tokenAddress: string): number;
  /** Constant USD value for a pegged quote asset; null means use the series. */
  fixedUsdFor(tokenAddress: string): bigint | null;
};

export type OutcomeConfig = {
  /** Fraction of swaps that must be priceable for a result to be reported. */
  minQuoteCoverage: number;
  /** How far a quote sample may be from a trade before it is unusable. */
  maxSampleAgeMs: number;
  /** §21: refuse to measure a window the tail has not finished indexing. */
  coverage: CoverageConfig;
};

export type OutcomeResult =
  | { status: 'recorded'; created: boolean; metrics: OutcomeMetrics; horizon: string }
  /** The tail has not reached the window end yet; try again at `retryAt`. */
  | {
      status: 'deferred';
      horizon: string;
      retryAt: Date;
      windowEnd: Date;
      watermarkTime: Date | null;
    };

/**
 * Evaluate one signal at one horizon (§21).
 *
 * Idempotent by construction: the unique `(signal_id, horizon)` index means a
 * replayed job is a no-op, so a duplicated delayed job and the reconciler can
 * both fire without producing conflicting history. §21 also requires the record
 * be immutable once written — it is inserted, never updated.
 */
export async function evaluateOutcome(
  db: Database,
  quotes: QuoteInfo,
  config: OutcomeConfig,
  input: {
    signalId: string;
    horizon: string;
    /**
     * Overwrite an existing row instead of leaving it alone.
     *
     * Only the repair sweep passes this. Normal evaluation stays insert-only so
     * a replayed job can never rewrite history.
     */
    replace?: boolean;
    now?: Date;
  },
): Promise<OutcomeResult> {
  const elapsedMs = horizonMs(input.horizon);
  if (elapsedMs === null) {
    throw new InvalidDataError(`unknown outcome horizon '${input.horizon}'`, {
      horizon: input.horizon,
    });
  }

  const [row] = await db
    .select({
      signalId: signals.id,
      createdAt: signals.createdAt,
      signalBlockTime: signals.signalBlockTime,
      signalPriceUsd: signals.signalPriceUsd,
      poolId: pools.id,
      quoteTokenAddress: pools.quoteTokenAddress,
      tokenAddress: tokens.address,
      tokenDecimals: tokens.decimals,
    })
    .from(signals)
    .innerJoin(pools, eq(pools.id, signals.poolId))
    .innerJoin(tokens, eq(tokens.id, signals.tokenId))
    .where(eq(signals.id, input.signalId))
    .limit(1);

  if (!row) {
    // Permanent: a deleted signal cannot be evaluated by any number of retries.
    throw new InvalidDataError(`signal ${input.signalId} no longer exists`, {
      signalId: input.signalId,
    });
  }

  // Anchor the window on BLOCK time, the same clock the trades inside it are
  // stamped with and the same clock the tail's coverage watermark uses.
  // `created_at` is Postgres wall time; measured minimum ingestion latency was
  // −63.2s, so a window built from it could be a minute out at both edges,
  // silently including trades from before the signal or excluding trades from
  // just before the horizon. Rows written before `signal_block_time` existed
  // fall back to `created_at` — they do not gain precision retroactively.
  const windowStart = row.signalBlockTime ?? row.createdAt;
  const windowEnd = new Date(windowStart.getTime() + elapsedMs);

  // §21: measure only what the tail has provably finished indexing. Without
  // this the result is finalised from whatever happened to be committed at the
  // instant the horizon elapsed, which is never the whole window (ADR 0020).
  const watermarkTime = await tailWatermark(db);
  const coverage = decideCoverage({
    watermarkTime,
    windowEnd,
    config: config.coverage,
    ...(input.now ? { now: input.now } : {}),
  });

  if (!coverage.ready && !coverage.giveUp) {
    return {
      status: 'deferred',
      horizon: input.horizon,
      retryAt: coverage.retryAt,
      windowEnd,
      watermarkTime,
    };
  }

  const swaps = await db
    .select({
      // The tail stores unoriented amount0/amount1 under these column names.
      amount0Raw: trades.baseAmountRaw,
      amount1Raw: trades.quoteAmountRaw,
      occurredAt: trades.occurredAt,
    })
    .from(trades)
    .where(
      and(
        eq(trades.poolId, row.poolId),
        gte(trades.occurredAt, windowStart),
        lte(trades.occurredAt, windowEnd),
      ),
    )
    // Chronological by chain order, not by wall clock: several swaps share a
    // block, and their sequence within it is the log index.
    .orderBy(asc(trades.blockNumber), asc(trades.logIndex));

  const fixedQuoteUsd = quotes.fixedUsdFor(row.quoteTokenAddress);
  const samples =
    fixedQuoteUsd === null
      ? await loadSamples(db, row.quoteTokenAddress, windowStart, windowEnd, config.maxSampleAgeMs)
      : [];

  const metrics = !coverage.ready
    ? // Waited past the cap and the tail never got there — a stalled drain, or
      // a pool aged out of retention. Record why rather than publishing a
      // number derived from a window we know is short (§27).
      unmeasurable('incomplete_tail_coverage', swaps.length)
    : row.tokenDecimals === null
      ? // Without decimals every amount is off by an unknown power of ten.
        // Defaulting to 18 would produce a confident, wrong price path.
        unmeasurable('no_token_decimals', swaps.length)
      : computeMetrics({
          signalPriceUsd:
            row.signalPriceUsd === null ? null : parseScaled(row.signalPriceUsd),
          series: buildPriceSeries({
            swaps,
            samples,
            baseIsToken0: baseIsToken0(row.tokenAddress, row.quoteTokenAddress),
            baseDecimals: row.tokenDecimals,
            quoteDecimals: quotes.decimalsFor(row.quoteTokenAddress),
            fixedQuoteUsd,
            maxSampleAgeMs: config.maxSampleAgeMs,
          }),
          minCoverage: config.minQuoteCoverage,
        });

  const values = {
    signalId: row.signalId,
    horizon: input.horizon,
    // Postgres' clock, not the app's. The repair sweep detects damage by
    // comparing this against `trades.created_at`, which the database stamps;
    // taking one side from a different clock would let skew hide genuinely
    // late trades. Tests inject an explicit time instead.
    evaluatedAt: input.now ?? sql`now()`,
    priceUsd: toColumn(metrics.priceUsd),
    returnPct: metrics.returnPct,
    maxRunupPct: metrics.maxRunupPct,
    maxDrawdownPct: metrics.maxDrawdownPct,
    tradeCount: metrics.tradeCount,
    failureReason: metrics.failureReason,
  };

  const target = [signalOutcomes.signalId, signalOutcomes.horizon];
  const written = input.replace
    ? await db
        .insert(signalOutcomes)
        .values(values)
        .onConflictDoUpdate({
          target,
          // Every correction is visible: the revision counts how many times a
          // measurement has been restated, and evaluated_at moves with it.
          set: { ...values, revision: sql`${signalOutcomes.revision} + 1` },
        })
        .returning({ id: signalOutcomes.id })
    : await db
        .insert(signalOutcomes)
        .values(values)
        .onConflictDoNothing({ target })
        .returning({ id: signalOutcomes.id });

  return {
    status: 'recorded',
    created: written.length > 0,
    metrics,
    horizon: input.horizon,
  };
}

/**
 * Quote-price samples covering the window, widened by the tolerance so a trade
 * at either edge can still find its nearest neighbour.
 */
async function loadSamples(
  db: Database,
  tokenAddress: string,
  windowStart: Date,
  windowEnd: Date,
  maxSampleAgeMs: number,
): Promise<Array<{ observedAt: Date; priceUsd: bigint }>> {
  const rows = await db
    .select({ observedAt: quotePriceSamples.observedAt, priceUsd: quotePriceSamples.priceUsd })
    .from(quotePriceSamples)
    .where(
      and(
        eq(quotePriceSamples.tokenAddress, tokenAddress.toLowerCase()),
        gte(quotePriceSamples.observedAt, new Date(windowStart.getTime() - maxSampleAgeMs)),
        lte(quotePriceSamples.observedAt, new Date(windowEnd.getTime() + maxSampleAgeMs)),
      ),
    )
    .orderBy(asc(quotePriceSamples.observedAt));

  return rows.map((row) => ({
    observedAt: row.observedAt,
    priceUsd: parseScaled(row.priceUsd),
  }));
}

/** §27: an unmeasurable outcome is recorded with its reason, never as a zero. */
function unmeasurable(reason: string, tradeCount: number): OutcomeMetrics {
  return {
    priceUsd: null,
    returnPct: null,
    maxRunupPct: null,
    maxDrawdownPct: null,
    tradeCount,
    failureReason: reason,
  };
}
