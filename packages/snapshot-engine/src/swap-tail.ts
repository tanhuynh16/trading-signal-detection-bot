import { and, eq, exists, gt, gte, ne, or, sql } from 'drizzle-orm';
import type { Log, PublicClient } from 'viem';
import { AdaptiveChunkSize, fetchLogsChunked } from '@sdb/blockchain';
import {
  advanceCursor,
  planRange,
  readCursorState,
  recordHistoryGap,
  rewindCursor,
} from '@sdb/discovery';
import { pools, reorgEvents, signals, trades, type Database } from '@sdb/database';
import { decodeSwapLog, SWAP_TOPICS } from '@sdb/market-data';
import {
  ProviderHistoryUnavailableError,
  fromUnixSeconds,
  withContext,
  type Address,
  type Logger,
} from '@sdb/shared';

export const SWAP_TAIL_SOURCE = 'swap-tail';

/**
 * Tails Swap logs for every tracked pool at once.
 *
 * The naive alternative is for each snapshot job to fetch its own window of
 * trades. On a provider capping eth_getLogs at 10 blocks, a 5-minute window is
 * 150 blocks — 15 requests per snapshot, times eight snapshots, times every
 * tracked pool. Filtering one query by an ADDRESS ARRAY plus an OR of the three
 * Swap topics costs ~1 request per window no matter how many pools are tracked,
 * and leaves the trades in Postgres where snapshots read them for free.
 *
 * Cursor semantics are Phase 1's, reused wholesale: commit rows, then advance.
 */
export type SwapTailConfig = {
  chainId: number;
  logChunkBlocks: number;
  /** Pools older than this stop being tracked (§19 maxTokenAgeMinutes). */
  maxTokenAgeMinutes: number;
  /** Cap on addresses per eth_getLogs call; the list is batched to fit. */
  maxAddressesPerQuery: number;
  /**
   * Keep indexing a pool this long after it produced a signal (§21).
   *
   * The 24h outcome horizon needs trades that `maxTokenAgeMinutes` (6h) would
   * have stopped collecting. Backfilling at horizon time is not an option: at
   * the measured 10-block eth_getLogs cap, 24h of one pool is ~4,300 requests.
   * Staying in the tail costs no extra requests at all — the same block ranges
   * are already being scanned, the filter just carries more addresses.
   */
  outcomeRetentionHours: number;
  /**
   * Blocks to stay behind head.
   *
   * The tail pays this latency where discovery does not, because its rows are
   * what §21 measures and §22 evaluates, and an outcome is never recomputed
   * once written. The cost is that the coverage watermark trails head by this
   * many blocks; Phase 7.1's deferral absorbs it with no new code.
   */
  confirmations: number;
  /** How far back to rewind when a reorg is detected. */
  reorgDepth: number;
};

export type SwapTailDeps = {
  db: Database;
  http: PublicClient;
  logger: Logger;
  config: SwapTailConfig;
};

/**
 * Pools still worth watching: discovered recently enough to matter, or still
 * owed outcome measurements. Recomputed each drain so newly discovered pools
 * join automatically and stale ones drop out without bookkeeping.
 *
 * The second clause is what makes §21's 24h horizon measurable. A pool whose
 * discovery window has closed stays indexed while any non-expired signal on it
 * is younger than the retention, because that signal's price path is still
 * being written.
 */
export async function trackedPools(
  db: Database,
  config: { chainId: number; maxTokenAgeMinutes: number; outcomeRetentionHours: number },
): Promise<Array<{ id: string; address: Address; dex: string; tokenId: string }>> {
  const discoveryCutoff = new Date(Date.now() - config.maxTokenAgeMinutes * 60_000);
  const outcomeCutoff = new Date(Date.now() - config.outcomeRetentionHours * 3_600_000);

  const rows = await db
    .select({ id: pools.id, address: pools.address, dex: pools.dex, tokenId: pools.tokenId })
    .from(pools)
    .where(
      and(
        eq(pools.chainId, config.chainId),
        or(
          gte(pools.discoveredAt, discoveryCutoff),
          exists(
            db
              .select({ one: signals.id })
              .from(signals)
              .where(
                and(
                  eq(signals.poolId, pools.id),
                  ne(signals.state, 'EXPIRED'),
                  gte(signals.createdAt, outcomeCutoff),
                ),
              ),
          ),
        ),
      ),
    );
  return rows as Array<{ id: string; address: Address; dex: string; tokenId: string }>;
}

/**
 * The deepest block this source is willing to treat as settled.
 *
 * `planRange` applies the same rule to the drain range; this exists for the
 * two places that need the number without planning a range — the idle-cursor
 * advance, which must not claim coverage of blocks the tail deliberately has
 * not read.
 */
export function confirmedHead(head: bigint, confirmations: number): bigint {
  const depth = BigInt(Math.max(0, confirmations));
  return head > depth ? head - depth : 0n;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Persist decoded swaps.
 *
 * Uniqueness is (tx_hash, log_index) — the identity of a log on chain — so
 * re-reading an overlapping range is a no-op rather than a duplicate trade.
 * USD valuation is deliberately NOT done here: it would require a price lookup
 * per trade. Snapshots value the window in aggregate instead.
 */
async function persistSwaps(
  db: Database,
  logs: Log[],
  poolsByAddress: Map<string, { id: string }>,
  blockTimes: Map<string, Date>,
): Promise<number> {
  const rows = [];
  for (const log of logs) {
    const swap = decodeSwapLog(log);
    if (!swap) continue;
    const pool = poolsByAddress.get(swap.poolAddress);
    if (!pool) continue; // a log for a pool we no longer track

    const occurredAt = blockTimes.get(swap.blockNumber.toString());
    if (!occurredAt) continue;

    rows.push({
      poolId: pool.id,
      txHash: swap.txHash,
      logIndex: swap.logIndex,
      wallet: swap.wallet,
      // Direction needs to know which side is the candidate token; that is
      // resolved at snapshot time, where token0/token1 are known. Storing the
      // signed amounts keeps this write cheap and loses nothing.
      side: swap.amount0 < 0n ? 'OUT0' : 'OUT1',
      blockNumber: swap.blockNumber,
      occurredAt,
      baseAmountRaw: swap.amount0.toString(),
      quoteAmountRaw: swap.amount1.toString(),
      usdValue: null,
      priceUsd: null,
    });
  }

  if (rows.length === 0) return 0;
  await db.insert(trades).values(rows).onConflictDoNothing({
    target: [trades.txHash, trades.logIndex],
  });
  return rows.length;
}

/**
 * Block timestamps for a set of blocks, fetched once per drain.
 *
 * Spec §3 requires event time to be distinct from observation time, and a
 * trade's economic time is its block's. Blocks are deduplicated because a busy
 * window yields many logs from few blocks.
 */
/**
 * Timestamp and hash of a single block, for the coverage watermark and for
 * reorg detection.
 *
 * One extra getBlock per completed drain — measured cadence is ~5.8s, so about
 * 620 calls an hour, roughly 1% of the free-tier budget. Cheap next to the
 * alternative of an outcome job fetching its own window at horizon time. The
 * hash rides along for free: this call was already being made.
 */
async function blockHeader(
  client: PublicClient,
  block: bigint,
): Promise<{ time: Date; hash: string }> {
  const header = await client.getBlock({ blockNumber: block, includeTransactions: false });
  if (header.hash === null) {
    // Only a pending block has a null hash, and we never ask for one.
    throw new Error(`block ${block} returned without a hash`);
  }
  return { time: fromUnixSeconds(header.timestamp), hash: header.hash };
}

export type RollbackResult = {
  rewoundTo: bigint;
  deletedTrades: number;
  expectedHash: string;
  actualHash: string;
};

/**
 * Has the chain under the cursor changed since we read it?
 *
 * A cursor holding only a block number cannot tell: number N always exists,
 * it is simply a different block after a reorg. Comparing the stored hash makes
 * this a check rather than an assumption. Confirmations make a reorg rare; only
 * this makes one detectable.
 *
 * Returns null when there is nothing to check — no cursor, or no stored hash
 * (the first drain after this shipped, or the drain after a rollback). "We
 * cannot tell" must never be reported as "unchanged", but it is also not
 * grounds to delete data, so the caller simply proceeds and the next drain
 * establishes the hash.
 */
export async function detectReorg(
  db: Database,
  http: PublicClient,
  source: string,
  config: { reorgDepth: number },
): Promise<RollbackResult | null> {
  const state = await readCursorState(db, source);
  if (!state || state.lastProcessedBlockHash === null) return null;

  const current = await blockHeader(http, state.lastProcessedBlock);
  if (current.hash === state.lastProcessedBlockHash) return null;

  const depth = BigInt(Math.max(1, config.reorgDepth));
  const rewoundTo =
    state.lastProcessedBlock > depth ? state.lastProcessedBlock - depth : 0n;

  // Read the rewind target's time from the chain rather than reusing anything
  // stored: the stored watermark belongs to blocks we are about to disown.
  // A failure here is not fatal — a null time reads as "coverage unknown",
  // which the gate treats as not-covered, the conservative direction.
  let rewoundToTime: Date | null = null;
  try {
    rewoundToTime = (await blockHeader(http, rewoundTo)).time;
  } catch {
    rewoundToTime = null;
  }

  // Delete first, then rewind. The other order would leave a window in which
  // the cursor claims less coverage than it has while phantom trades are still
  // readable — harmless, but the reverse of the invariant everywhere else in
  // this file, which is "commit rows, then move the watermark".
  const deleted = await db
    .delete(trades)
    .where(gt(trades.blockNumber, rewoundTo))
    .returning({ id: trades.id });

  await rewindCursor(db, source, rewoundTo, rewoundToTime);

  await db.insert(reorgEvents).values({
    source,
    detectedAtBlock: state.lastProcessedBlock,
    rewoundToBlock: rewoundTo,
    rewoundToBlockTime: rewoundToTime,
    expectedHash: state.lastProcessedBlockHash,
    actualHash: current.hash,
    deletedTrades: deleted.length,
  });

  return {
    rewoundTo,
    deletedTrades: deleted.length,
    expectedHash: state.lastProcessedBlockHash,
    actualHash: current.hash,
  };
}

async function blockTimestamps(client: PublicClient, logs: Log[]): Promise<Map<string, Date>> {
  const unique = [...new Set(logs.map((l) => l.blockNumber).filter((b): b is bigint => b !== null))];
  const entries = await Promise.all(
    unique.map(async (blockNumber) => {
      const block = await client.getBlock({ blockNumber, includeTransactions: false });
      return [blockNumber.toString(), fromUnixSeconds(block.timestamp)] as const;
    }),
  );
  return new Map(entries);
}

export class SwapTail {
  private readonly sizer: AdaptiveChunkSize;
  private draining = false;

  constructor(private readonly deps: SwapTailDeps) {
    this.sizer = new AdaptiveChunkSize(deps.config.logChunkBlocks);
  }

  /**
   * The provider no longer holds the blocks this cursor is waiting on.
   *
   * Skipping is the only way forward, but for the tail a bare skip is unsafe:
   * §21's coverage watermark is a single instant meaning "everything up to here
   * was read and committed", and letting it advance over a range the tail never
   * fetched would certify outcome windows built from missing trades. So the
   * skipped range is recorded with its BLOCK-TIME bounds — the clock the
   * coverage gate and `trades.occurred_at` both use — and `reseedCursor`
   * deliberately leaves the time watermark where it was.
   *
   * The bounds are best-effort: if either boundary block cannot be read, the
   * bound stays null, which the gate treats as overlapping. Re-measuring a
   * healthy outcome costs one recomputation; certifying a damaged one is
   * permanent.
   */
  private async skipUnservable(
    fromBlock: bigint,
    head: bigint,
    logger: Logger,
  ): Promise<void> {
    const reseedTo = confirmedHead(head, this.deps.config.confirmations);
    const bound = async (block: bigint): Promise<Date | null> => {
      try {
        return (await blockHeader(this.deps.http, block)).time;
      } catch {
        return null;
      }
    };
    const [fromTime, toTime] = await Promise.all([bound(fromBlock), bound(reseedTo)]);

    logger.warn(
      { fromBlock, toBlock: reseedTo, fromTime, toTime },
      'swap tail range beyond provider history; skipping forward and recording the gap',
    );

    await recordHistoryGap(this.deps.db, {
      source: SWAP_TAIL_SOURCE,
      fromBlock,
      toBlock: reseedTo,
      fromTime,
      toTime,
      reason: 'provider history window exceeded',
      reseedTo,
    });
  }

  async drain(head: bigint, isFirstDrain: boolean): Promise<{ swaps: number }> {
    if (this.draining) return { swaps: 0 };
    this.draining = true;
    const logger = withContext(this.deps.logger, { source: SWAP_TAIL_SOURCE });

    try {
      // Before anything else: is the chain we already indexed still the chain?
      // Doing this first means a drain never appends to a history it is about
      // to disown.
      const rollback = await detectReorg(
        this.deps.db,
        this.deps.http,
        SWAP_TAIL_SOURCE,
        this.deps.config,
      );
      if (rollback) {
        logger.warn(
          {
            rewoundTo: rollback.rewoundTo,
            deletedTrades: rollback.deletedTrades,
            expectedHash: rollback.expectedHash,
            actualHash: rollback.actualHash,
          },
          'reorg detected; rolled back swap tail and deleted affected trades',
        );
      }

      const tracked = await trackedPools(this.deps.db, this.deps.config);
      if (tracked.length === 0) {
        // Nothing to watch. Keep the cursor near head so that when pools do
        // appear we do not replay a long idle stretch. Coverage up to there is
        // still complete — vacuously, since there was nothing to collect — so
        // the time watermark advances too (§21). It stops at the confirmed
        // head, not the raw one, or the watermark would claim coverage of
        // blocks the tail has deliberately not read yet.
        const idle = confirmedHead(head, this.deps.config.confirmations);
        const header = await blockHeader(this.deps.http, idle);
        await advanceCursor(
          this.deps.db,
          SWAP_TAIL_SOURCE,
          idle,
          header.time,
          header.hash,
        );
        return { swaps: 0 };
      }

      const byAddress = new Map(tracked.map((p) => [p.address, { id: p.id }]));
      const cursor = await readCursorState(this.deps.db, SWAP_TAIL_SOURCE);
      const plan = planRange({
        lastProcessed: cursor?.lastProcessedBlock ?? null,
        head,
        overlapBlocks: 0,
        // On first sight, start at head: back-filling trades for pools we were
        // not tracking yet would be wasted requests.
        firstStartBackfillBlocks: 0,
        isFirstDrain,
        confirmations: this.deps.config.confirmations,
      });
      if (plan.fromBlock > plan.toBlock) return { swaps: 0 };

      let total = 0;
      const batches = chunk(
        tracked.map((p) => p.address),
        this.deps.config.maxAddressesPerQuery,
      );

      try {
        for (const addresses of batches) {
          await fetchLogsChunked(
          this.deps.http,
          {
            address: addresses,
            // One OR-filter over all three Swap selectors: a single query
            // covers every DEX across every tracked pool.
            topics: [[...SWAP_TOPICS]],
            fromBlock: plan.fromBlock,
            toBlock: plan.toBlock,
          },
          {
            maxChunk: this.deps.config.logChunkBlocks,
            chunkSize: this.sizer,
            onChunkShrink: (from, to) =>
              logger.warn({ from, to }, 'provider rejected range; shrinking swap-tail chunk'),
            onRetry: (attempt, delayMs) =>
              logger.warn({ attempt, delayMs }, 'swap tail throttled; backing off'),
          },
          async (logs, range) => {
            if (logs.length > 0) {
              const times = await blockTimestamps(this.deps.http, logs);
              total += await persistSwaps(this.deps.db, logs, byAddress, times);
            }
            // Only the last address batch may move the cursor, or a later batch
            // would skip the range an earlier one has not covered yet.
            if (addresses === batches[batches.length - 1]) {
              await advanceCursor(this.deps.db, SWAP_TAIL_SOURCE, range.toBlock);
            }
          },
          );
        }
      } catch (error) {
        if (!(error instanceof ProviderHistoryUnavailableError)) throw error;
        await this.skipUnservable(plan.fromBlock, head, logger);
        return { swaps: total };
      }

      // Every batch finished without throwing, so coverage really does reach
      // plan.toBlock. Only now is it safe to stamp the time watermark: §21
      // outcome measurement gates on it, and claiming coverage the tail does
      // not have would let an outcome be finalised from an incomplete price
      // path — the exact defect this guards (ADR 0020). A mid-drain failure
      // throws before reaching here and leaves the older, conservative value in
      // place. The hash is stamped in the same write, so the next drain can ask
      // whether this block is still the one we read.
      const watermark = await blockHeader(this.deps.http, plan.toBlock);
      await advanceCursor(
        this.deps.db,
        SWAP_TAIL_SOURCE,
        plan.toBlock,
        watermark.time,
        watermark.hash,
      );

      // Outcome retention (§21) keeps pools in the filter long after discovery,
      // and each batch past the first is a real extra request per block chunk.
      // Log it so that cost is measurable rather than inferred.
      if (batches.length > 1) {
        logger.warn(
          { pools: tracked.length, batches: batches.length, maxPerQuery: this.deps.config.maxAddressesPerQuery },
          'tracked pool count exceeds one eth_getLogs filter; requests per chunk multiplied',
        );
      }
      if (total > 0) {
        logger.info(
          { swaps: total, pools: tracked.length, batches: batches.length },
          'swap tail ingested',
        );
      }
      return { swaps: total };
    } finally {
      this.draining = false;
    }
  }
}

/** Trade counts and volume for a window, read from Postgres — no RPC. */
export async function tradeWindowStats(
  db: Database,
  input: { poolId: string; from: Date; to: Date; baseIsToken0: boolean },
): Promise<{
  buyCount: number;
  sellCount: number;
  uniqueBuyers: number;
  quoteVolumeRaw: bigint;
} | null> {
  // `side` was stored as which side left the pool; resolve it to BUY/SELL now
  // that we know which token is the candidate.
  const buyMarker = input.baseIsToken0 ? 'OUT0' : 'OUT1';

  // Dates must be passed as ISO strings with an explicit cast: the postgres
  // driver does not serialize a JS Date through a raw sql`` parameter, and
  // fails at bind time rather than returning wrong data.
  const from = input.from.toISOString();
  const to = input.to.toISOString();

  const rows = await db.execute<{
    buy_count: string;
    sell_count: string;
    unique_buyers: string;
    quote_volume: string | null;
  }>(sql`
    SELECT
      count(*) FILTER (WHERE side = ${buyMarker})                    AS buy_count,
      count(*) FILTER (WHERE side <> ${buyMarker})                   AS sell_count,
      count(DISTINCT wallet) FILTER (WHERE side = ${buyMarker})      AS unique_buyers,
      sum(abs(${input.baseIsToken0 ? trades.quoteAmountRaw : trades.baseAmountRaw})) AS quote_volume
    FROM ${trades}
    WHERE ${trades.poolId} = ${input.poolId}
      AND ${trades.occurredAt} > ${from}::timestamptz
      AND ${trades.occurredAt} <= ${to}::timestamptz
  `);

  const row = rows[0];
  // Spec §15: no trades in the window is a real zero for counts, but volume
  // with no observations is genuinely unknown, so it stays null.
  if (!row) return null;
  return {
    buyCount: Number(row.buy_count ?? 0),
    sellCount: Number(row.sell_count ?? 0),
    uniqueBuyers: Number(row.unique_buyers ?? 0),
    quoteVolumeRaw: row.quote_volume ? BigInt(row.quote_volume) : 0n,
  };
}
