import { eq, sql } from 'drizzle-orm';
import type { Database } from '@sdb/database';
import { discoveryCursors } from '@sdb/database';

/**
 * Spec §10.2/§10.3: the persisted block cursor is what makes "restarting the
 * worker does not permanently skip blocks" true. It is the source of truth for
 * where each factory has been read up to; the WebSocket only decides *when* to
 * read next.
 */

export type CursorPlan = {
  fromBlock: bigint;
  toBlock: bigint;
  /** True when no cursor existed and we seeded one. */
  seeded: boolean;
};

/**
 * Where should this factory resume?
 *
 * - First start: `head - firstStartBackfill`, so the pipeline produces real
 *   pools within minutes instead of idling until a launch happens.
 * - Restart: `lastProcessed + 1 - overlap`. The overlap deliberately re-reads
 *   blocks already seen, because re-reading is free (dedupe is atomic) while
 *   skipping is unrecoverable.
 */
export function planRange(input: {
  lastProcessed: bigint | null;
  head: bigint;
  overlapBlocks: number;
  firstStartBackfillBlocks: number;
  /**
   * Apply the replay overlap only on the first drain after startup.
   *
   * The overlap exists to cover the gap a crash can leave between "logs
   * fetched" and "cursor committed" — a risk that only exists across a
   * restart. Re-applying it on every steady-state drain re-reads the same
   * blocks forever, and with a provider capping eth_getLogs at 10 blocks a
   * 50-block overlap turns one request per factory into six.
   */
  isFirstDrain?: boolean;
}): CursorPlan {
  const { lastProcessed, head } = input;

  if (lastProcessed === null) {
    const backfill = BigInt(Math.max(0, input.firstStartBackfillBlocks));
    const from = head > backfill ? head - backfill : 0n;
    return { fromBlock: from, toBlock: head, seeded: true };
  }

  const overlap = input.isFirstDrain === false ? 0n : BigInt(Math.max(0, input.overlapBlocks));
  const next = lastProcessed + 1n;
  const rewound = next > overlap ? next - overlap : 0n;
  return { fromBlock: rewound, toBlock: head, seeded: false };
}

export async function readCursor(db: Database, source: string): Promise<bigint | null> {
  const rows = await db
    .select({ lastProcessedBlock: discoveryCursors.lastProcessedBlock })
    .from(discoveryCursors)
    .where(eq(discoveryCursors.source, source))
    .limit(1);
  return rows[0]?.lastProcessedBlock ?? null;
}

export type CursorState = {
  lastProcessedBlock: bigint;
  /** Block time of the watermark; null for sources that do not stamp it. */
  lastProcessedBlockTime: Date | null;
};

/**
 * The watermark in both dimensions.
 *
 * §21 needs to ask "has ingestion covered this INSTANT?", which the block
 * number alone cannot answer. Consumers that care about completeness in time —
 * outcome measurement — read this instead of `readCursor`.
 */
export async function readCursorState(
  db: Database,
  source: string,
): Promise<CursorState | null> {
  const rows = await db
    .select({
      lastProcessedBlock: discoveryCursors.lastProcessedBlock,
      lastProcessedBlockTime: discoveryCursors.lastProcessedBlockTime,
    })
    .from(discoveryCursors)
    .where(eq(discoveryCursors.source, source))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Advance the cursor, never rewind it. A retried or overlapping chunk must not
 * move the watermark backwards, or a concurrent drain could reopen a gap.
 *
 * `blockTime` is the timestamp of `block`, supplied only by callers that can
 * prove they have covered everything up to it. It is guarded by the same
 * `greatest()` as the block number: a late drain finishing out of order must
 * not walk the time watermark backwards either, since a consumer would then
 * believe less is covered than actually is — or worse, if it could move
 * forward wrongly, more.
 *
 * Passing it as `null` leaves whatever is stored untouched rather than
 * clearing it, so a caller that does not know the time cannot erase a
 * watermark another pass established.
 */
export async function advanceCursor(
  db: Database,
  source: string,
  block: bigint,
  blockTime?: Date,
): Promise<void> {
  const now = new Date();
  await db
    .insert(discoveryCursors)
    .values({
      source,
      lastProcessedBlock: block,
      lastProcessedBlockTime: blockTime ?? null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: discoveryCursors.source,
      set: {
        lastProcessedBlock: sql`greatest(${discoveryCursors.lastProcessedBlock}, excluded.last_processed_block)`,
        // ISO string with an explicit cast: the driver cannot bind a JS Date
        // through a raw sql`` parameter (ADR 0014).
        lastProcessedBlockTime:
          blockTime === undefined
            ? sql`${discoveryCursors.lastProcessedBlockTime}`
            : sql`greatest(${discoveryCursors.lastProcessedBlockTime}, ${blockTime.toISOString()}::timestamptz)`,
        updatedAt: now,
      },
    });
}
