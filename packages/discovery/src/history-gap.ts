import { and, eq, isNull, lte } from 'drizzle-orm';
import { ingestionGaps, jobsAudit, type Database } from '@sdb/database';
import { reseedCursor } from './cursor.js';

/**
 * What to do when the provider no longer holds the blocks the cursor sits on.
 *
 * There is exactly one way forward — skip to a block the provider can serve —
 * and exactly one thing that must not happen while doing it: quietly pretending
 * the skipped range was read. §21's coverage watermark is a single instant that
 * ADR 0020 defines as proof of complete ingestion up to it, so a silent skip
 * would let outcomes be finalised from history that was never fetched.
 *
 * So a skip is three writes that belong together:
 *   1. the gap, so the coverage gate can refuse windows that overlap it;
 *   2. a §23 audit row, so a skip is visible in the same place every other
 *      permanent failure is, rather than only in a log line that scrolls away;
 *   3. the cursor move itself, last — if either record fails, the cursor stays
 *      put and the next drain tries again rather than losing the range silently.
 */
export type SkippedRange = {
  source: string;
  /** First block not read. */
  fromBlock: bigint;
  /** Last block not read. */
  toBlock: bigint;
  /** Block-time bounds, when the caller can read them. */
  fromTime?: Date | null;
  toTime?: Date | null;
  reason: string;
  /** Where the cursor lands; the first block the provider can still serve. */
  reseedTo: bigint;
};

export async function recordHistoryGap(db: Database, input: SkippedRange): Promise<void> {
  // An empty or backwards range is not a gap. Guarded because the arithmetic
  // that produces it (cursor + 1 .. reseed - 1) collapses whenever the cursor
  // is already inside the window, and a zero-width row would make every
  // overlapping-window check true for an instant that was never missed.
  if (input.toBlock >= input.fromBlock) {
    await db.insert(ingestionGaps).values({
      source: input.source,
      fromBlock: input.fromBlock,
      toBlock: input.toBlock,
      fromTime: input.fromTime ?? null,
      toTime: input.toTime ?? null,
      reason: input.reason,
    });

    await db.insert(jobsAudit).values({
      queue: input.source,
      jobId: `history-gap:${input.fromBlock}-${input.toBlock}`,
      correlationId: null,
      status: 'permanent_failure',
      attempts: 1,
      errorCode: 'PROVIDER_HISTORY_UNAVAILABLE',
      errorMessage: input.reason,
      payload: {
        source: input.source,
        fromBlock: input.fromBlock.toString(),
        toBlock: input.toBlock.toString(),
        reseedTo: input.reseedTo.toString(),
      },
    });
  }

  await reseedCursor(db, input.source, input.reseedTo);
}


/**
 * Give a gap an end time once the tail has demonstrably moved past it.
 *
 * `to_time` is read from the reseed target's header when the gap is recorded,
 * which normally works — that block sits at the confirmed head. When it does
 * not, the gap is stored with BOTH bounds null, and `gapOverlaps` reads a null
 * bound as overlapping (correctly: an unknown edge must not be resolved in
 * favour of "covered"). The result is a row that vetoes every outcome window
 * ever, long after the tail has fully recovered. Measured on live data: two such
 * rows made 583 of 583 outcomes in eight hours report
 * `incomplete_tail_coverage` while the watermark sat 15 seconds behind head.
 *
 * The repair is to stamp the watermark's block time on any gap the watermark has
 * now passed. That instant is at or after the gap's true end — the tail cannot
 * have committed a later block without covering everything the gap describes —
 * so it errs in the safe direction: it can only ever shrink the window a gap
 * blocks, never claim coverage the tail does not have.
 *
 * Only null values are filled. A bound that was read from the chain is evidence
 * and is never overwritten.
 */
export async function backfillGapEnd(
  db: Database,
  input: { source: string; watermarkBlock: bigint; watermarkTime: Date },
): Promise<number> {
  const rows = await db
    .update(ingestionGaps)
    .set({ toTime: input.watermarkTime })
    .where(
      and(
        eq(ingestionGaps.source, input.source),
        isNull(ingestionGaps.toTime),
        lte(ingestionGaps.toBlock, input.watermarkBlock),
      ),
    )
    .returning({ id: ingestionGaps.id });
  return rows.length;
}
