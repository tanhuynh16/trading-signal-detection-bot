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
  /**
   * Stop this many blocks short of the head.
   *
   * A block at the head can still be reorged out, and a consumer that has
   * already written rows from it has no way to notice. The depth is per source
   * because the two consumers value latency completely differently: discovery
   * defaults to 0 because §10 wants a new pool found within seconds and the
   * worst case there is a phantom `pools` row that produces no snapshots, while
   * the swap tail waits, because its rows feed §21 outcome math that is never
   * recomputed once written.
   */
  confirmations?: number;
}): CursorPlan {
  const { lastProcessed, head } = input;
  const confirmations = BigInt(Math.max(0, input.confirmations ?? 0));
  const safeHead = head > confirmations ? head - confirmations : 0n;

  if (lastProcessed === null) {
    const backfill = BigInt(Math.max(0, input.firstStartBackfillBlocks));
    const from = safeHead > backfill ? safeHead - backfill : 0n;
    return { fromBlock: from, toBlock: safeHead, seeded: true };
  }

  const overlap = input.isFirstDrain === false ? 0n : BigInt(Math.max(0, input.overlapBlocks));
  const next = lastProcessed + 1n;
  const rewound = next > overlap ? next - overlap : 0n;
  return { fromBlock: rewound, toBlock: safeHead, seeded: false };
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
  /** Hash of the watermark block; null for sources that do not stamp it. */
  lastProcessedBlockHash: string | null;
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
      lastProcessedBlockHash: discoveryCursors.lastProcessedBlockHash,
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
  blockHash?: string,
): Promise<void> {
  const now = new Date();
  await db
    .insert(discoveryCursors)
    .values({
      source,
      lastProcessedBlock: block,
      lastProcessedBlockTime: blockTime ?? null,
      lastProcessedBlockHash: blockHash ?? null,
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
        // The hash must stay paired with the block it describes, or the reorg
        // detector compares the hash of one block against the hash of another
        // and rolls back good data every time.
        //
        // Two ways that pairing can break, and both are handled here:
        //   - the block moves forward with no hash supplied (a mid-drain chunk
        //     commit), so the stored hash now describes a block behind the
        //     cursor — it is CLEARED, and the detector reads a null hash as
        //     "cannot tell", which is neither a mismatch nor a guarantee;
        //   - `greatest()` keeps the stored block because this call carries a
        //     lower one, in which case the incoming hash is not ours to write.
        lastProcessedBlockHash:
          blockHash === undefined
            ? sql`CASE WHEN excluded.last_processed_block > ${discoveryCursors.lastProcessedBlock}
                       THEN NULL
                       ELSE ${discoveryCursors.lastProcessedBlockHash} END`
            : sql`CASE WHEN excluded.last_processed_block >= ${discoveryCursors.lastProcessedBlock}
                       THEN excluded.last_processed_block_hash
                       ELSE ${discoveryCursors.lastProcessedBlockHash} END`,
        updatedAt: now,
      },
    });
}

/**
 * Move the cursor BACKWARDS after a reorg, the one case `advanceCursor` refuses.
 *
 * Both dimensions are hard-set, not `greatest()`-ed. The time watermark is the
 * load-bearing half: §21's coverage gate treats it as proof that every block up
 * to that instant has been read and committed, so leaving it forward after
 * deleting the trades underneath it would let an outcome be finalised from a
 * window whose contents were just removed — the precise defect ADR 0020 exists
 * to prevent, arriving by a different route.
 *
 * The hash is cleared rather than rewritten: we know the stored one was wrong,
 * and we have not yet read the block we are rewinding to. The next drain
 * re-reads the range and re-establishes it.
 */
/**
 * Skip the cursor FORWARD over blocks the provider can no longer serve.
 *
 * The second deliberate exception to `advanceCursor`'s forward-only rule, and
 * the opposite of `rewindCursor`: that one disowns blocks we read, this one
 * gives up on blocks we never will. A non-archive provider prunes state — the
 * measured window on Chainstack's plan is ~128 blocks, about 4.3 minutes on
 * Base — so a cursor left behind by a longer outage can only ever fail, and
 * retrying it forever is what a `TransientProviderError` would have done.
 *
 * **No time watermark is written.** The caller has read nothing, so claiming
 * coverage up to the new position would be a lie of exactly the kind §21's gate
 * exists to prevent. The watermark stays where it was and advances only when a
 * real drain commits rows; the skipped range is recorded separately in
 * `ingestion_gaps` so consumers can see the hole rather than infer none.
 *
 * The hash is cleared for the same reason it is on a rewind: it described a
 * block the cursor is no longer on.
 */
export async function reseedCursor(
  db: Database,
  source: string,
  block: bigint,
): Promise<void> {
  await db
    .insert(discoveryCursors)
    .values({
      source,
      lastProcessedBlock: block,
      lastProcessedBlockTime: null,
      lastProcessedBlockHash: null,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: discoveryCursors.source,
      set: {
        lastProcessedBlock: block,
        // Left untouched, not advanced: see above.
        lastProcessedBlockTime: sql`${discoveryCursors.lastProcessedBlockTime}`,
        lastProcessedBlockHash: null,
        updatedAt: new Date(),
      },
    });
}

export async function rewindCursor(
  db: Database,
  source: string,
  block: bigint,
  blockTime: Date | null,
): Promise<void> {
  await db
    .update(discoveryCursors)
    .set({
      lastProcessedBlock: block,
      lastProcessedBlockTime: blockTime,
      lastProcessedBlockHash: null,
      updatedAt: new Date(),
    })
    .where(eq(discoveryCursors.source, source));
}
