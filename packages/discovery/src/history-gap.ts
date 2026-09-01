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
