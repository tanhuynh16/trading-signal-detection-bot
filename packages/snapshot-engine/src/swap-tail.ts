import { and, eq, gte, sql } from 'drizzle-orm';
import type { Log, PublicClient } from 'viem';
import { AdaptiveChunkSize, fetchLogsChunked } from '@sdb/blockchain';
import { advanceCursor, planRange, readCursor } from '@sdb/discovery';
import { pools, trades, type Database } from '@sdb/database';
import { decodeSwapLog, SWAP_TOPICS } from '@sdb/market-data';
import { fromUnixSeconds, withContext, type Address, type Logger } from '@sdb/shared';

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
};

export type SwapTailDeps = {
  db: Database;
  http: PublicClient;
  logger: Logger;
  config: SwapTailConfig;
};

/**
 * Pools still worth watching: discovered recently enough to matter, and not
 * expired. Recomputed each drain so newly discovered pools join automatically
 * and stale ones drop out without bookkeeping.
 */
export async function trackedPools(
  db: Database,
  config: { chainId: number; maxTokenAgeMinutes: number },
): Promise<Array<{ id: string; address: Address; dex: string; tokenId: string }>> {
  const cutoff = new Date(Date.now() - config.maxTokenAgeMinutes * 60_000);
  const rows = await db
    .select({ id: pools.id, address: pools.address, dex: pools.dex, tokenId: pools.tokenId })
    .from(pools)
    .where(and(eq(pools.chainId, config.chainId), gte(pools.discoveredAt, cutoff)));
  return rows as Array<{ id: string; address: Address; dex: string; tokenId: string }>;
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

  async drain(head: bigint, isFirstDrain: boolean): Promise<{ swaps: number }> {
    if (this.draining) return { swaps: 0 };
    this.draining = true;
    const logger = withContext(this.deps.logger, { source: SWAP_TAIL_SOURCE });

    try {
      const tracked = await trackedPools(this.deps.db, this.deps.config);
      if (tracked.length === 0) {
        // Nothing to watch. Keep the cursor at head so that when pools do
        // appear we do not replay a long idle stretch.
        await advanceCursor(this.deps.db, SWAP_TAIL_SOURCE, head);
        return { swaps: 0 };
      }

      const byAddress = new Map(tracked.map((p) => [p.address, { id: p.id }]));
      const lastProcessed = await readCursor(this.deps.db, SWAP_TAIL_SOURCE);
      const plan = planRange({
        lastProcessed,
        head,
        overlapBlocks: 0,
        // On first sight, start at head: back-filling trades for pools we were
        // not tracking yet would be wasted requests.
        firstStartBackfillBlocks: 0,
        isFirstDrain,
      });
      if (plan.fromBlock > plan.toBlock) return { swaps: 0 };

      let total = 0;
      const batches = chunk(
        tracked.map((p) => p.address),
        this.deps.config.maxAddressesPerQuery,
      );

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

      if (total > 0) logger.info({ swaps: total, pools: tracked.length }, 'swap tail ingested');
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
