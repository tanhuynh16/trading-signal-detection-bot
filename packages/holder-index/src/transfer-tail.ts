import { and, eq, gte, sql } from 'drizzle-orm';
import { decodeEventLog, parseAbiItem, toEventSelector, type Hex, type Log, type PublicClient } from 'viem';
import { AdaptiveChunkSize, fetchLogsChunked } from '@sdb/blockchain';
import { advanceCursor, planRange, readCursor } from '@sdb/discovery';
import { appliedTransfers, holderBalances, pools, tokens, type Database } from '@sdb/database';
import {
  canonicalize,
  DEAD_ADDRESS,
  fromUnixSeconds,
  withContext,
  ZERO_ADDRESS,
  type Address,
  type Logger,
} from '@sdb/shared';

export const TRANSFER_TAIL_SOURCE = 'transfer-tail';

/**
 * ERC-20 Transfer. Selector derived rather than pasted, for the same reason the
 * factory selectors are: a mistyped signature produces a filter that matches
 * nothing and the indexer runs cleanly forever while learning nothing.
 */
export const TRANSFER_EVENT = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
);
export const TRANSFER_TOPIC: Hex = toEventSelector(TRANSFER_EVENT);

/**
 * Maintains `holder_balances` by tailing Transfer logs for tracked tokens.
 *
 * ADR 0005: holder features are unobtainable from plain RPC — there is no "list
 * holders" call — and third-party holder APIs are stale for minutes-old tokens
 * and not reproducible from stored data (§3, §27). Replaying transfers is the
 * only source that satisfies both.
 *
 * Structurally this is the swap tail again: one address-filtered eth_getLogs per
 * block window, cursor-driven, commit-then-advance. Measured cost for a real new
 * token was 1 Transfer log per 10 blocks.
 */
export type TransferTailConfig = {
  chainId: number;
  logChunkBlocks: number;
  maxTokenAgeMinutes: number;
  maxAddressesPerQuery: number;
};

export type TransferTailDeps = {
  db: Database;
  http: PublicClient;
  logger: Logger;
  config: TransferTailConfig;
};

export type TrackedToken = { tokenId: string; address: Address };

/** Tokens young enough to still matter, recomputed each drain. */
export async function trackedTokens(
  db: Database,
  config: { chainId: number; maxTokenAgeMinutes: number },
): Promise<TrackedToken[]> {
  const cutoff = new Date(Date.now() - config.maxTokenAgeMinutes * 60_000);
  const rows = await db
    .selectDistinct({ tokenId: tokens.id, address: tokens.address })
    .from(tokens)
    .innerJoin(pools, eq(pools.tokenId, tokens.id))
    .where(and(eq(tokens.chainId, config.chainId), gte(pools.discoveredAt, cutoff)));
  return rows as TrackedToken[];
}

export type DecodedTransfer = {
  token: Address;
  from: Address;
  to: Address;
  value: bigint;
  blockNumber: bigint;
  /**
   * Log identity, carried so `applyTransfers` can be idempotent. A balance is a
   * running sum: without this, re-reading a block range re-applies every delta.
   */
  txHash: string;
  logIndex: number;
};

export function decodeTransfer(log: Log): DecodedTransfer | null {
  if (log.topics[0] !== TRANSFER_TOPIC || log.blockNumber === null) return null;
  // A pending log has no identity, so it cannot be recorded as applied — and an
  // unrecordable transfer would be re-applied on the next pass.
  if (log.transactionHash === null || log.logIndex === null) return null;
  try {
    const { args } = decodeEventLog({
      abi: [TRANSFER_EVENT],
      data: log.data,
      topics: log.topics,
    }) as unknown as { args: { from: string; to: string; value: bigint } };
    return {
      token: canonicalize(log.address),
      from: canonicalize(args.from),
      to: canonicalize(args.to),
      value: args.value,
      blockNumber: log.blockNumber,
      txHash: log.transactionHash,
      logIndex: log.logIndex,
    };
  } catch {
    // A non-standard Transfer (e.g. ERC-721's indexed tokenId) will not decode
    // against the ERC-20 ABI. Skipping is correct: it is not a balance change
    // we can interpret.
    return null;
  }
}

/**
 * Addresses that are never "holders" for concentration purposes.
 *
 * The zero address is mint/burn and the dead address is a burn sink; counting
 * either inflates holder_count and distorts top-10 concentration, which §15.3
 * explicitly says to adjust for.
 */
export const NON_HOLDER_ADDRESSES: ReadonlySet<string> = new Set([ZERO_ADDRESS, DEAD_ADDRESS]);

/**
 * Apply transfers to balances.
 *
 * Balances are `numeric(78,0)` and handled as bigint throughout — a uint256
 * balance cannot survive a float (G4). The update is expressed as a SQL delta
 * rather than read-modify-write so concurrent drains cannot lose an update.
 */
export async function applyTransfers(
  db: Database,
  tokenIdByAddress: Map<string, string>,
  transfers: readonly DecodedTransfer[],
  occurredAt: Map<string, Date>,
): Promise<number> {
  if (transfers.length === 0) return 0;

  // Claim each Transfer BEFORE its delta is applied. A balance is a running sum,
  // so applying one twice is permanent corruption, not a duplicate row — and the
  // startup replay overlap re-reads blocks by design. Only the transfers this
  // call actually inserted are ours to apply; the rest were already counted.
  const claimed = new Set<string>();
  const identity = (t: DecodedTransfer) => `${t.txHash}:${t.logIndex}`;
  const unique = new Map<string, DecodedTransfer>();
  for (const t of transfers) unique.set(identity(t), t);

  const inserted = await db
    .insert(appliedTransfers)
    .values(
      [...unique.values()].map((t) => ({
        txHash: t.txHash,
        logIndex: t.logIndex,
        blockNumber: t.blockNumber,
      })),
    )
    .onConflictDoNothing({ target: [appliedTransfers.txHash, appliedTransfers.logIndex] })
    .returning({ txHash: appliedTransfers.txHash, logIndex: appliedTransfers.logIndex });

  for (const row of inserted) claimed.add(`${row.txHash}:${row.logIndex}`);
  if (claimed.size === 0) return 0;

  type Delta = { tokenId: string; wallet: string; delta: bigint; block: bigint; at: Date };
  const deltas = new Map<string, Delta>();

  const bump = (tokenId: string, wallet: string, delta: bigint, block: bigint, at: Date) => {
    if (NON_HOLDER_ADDRESSES.has(wallet)) return;
    const key = `${tokenId}:${wallet}`;
    const existing = deltas.get(key);
    if (existing) {
      existing.delta += delta;
      if (block > existing.block) existing.block = block;
    } else {
      deltas.set(key, { tokenId, wallet, delta, block, at });
    }
  };

  for (const transfer of unique.values()) {
    if (!claimed.has(identity(transfer))) continue; // already applied on an earlier pass
    const tokenId = tokenIdByAddress.get(transfer.token);
    if (!tokenId) continue;
    const at = occurredAt.get(transfer.blockNumber.toString());
    if (!at) continue;
    bump(tokenId, transfer.from, -transfer.value, transfer.blockNumber, at);
    bump(tokenId, transfer.to, transfer.value, transfer.blockNumber, at);
  }

  if (deltas.size === 0) return 0;

  for (const d of deltas.values()) {
    const delta = d.delta.toString();
    // A balance can only go negative when we applied a transfer OUT whose
    // matching transfer IN happened before this tail's cursor — the wallet was
    // funded before we started reading. That is missing history, not a debt.
    //
    // Clamp at zero and record that the row is a lower bound rather than a
    // measurement. `partially_observed` is the null §15 would have used if the
    // column had a null to spare.
    const clamped = sql`greatest(0, ${holderBalances.balanceRaw} + ${delta}::numeric)`;
    const wouldGoNegative = sql`(${holderBalances.balanceRaw} + ${delta}::numeric) < 0`;

    await db
      .insert(holderBalances)
      .values({
        tokenId: d.tokenId,
        wallet: d.wallet,
        // A first sighting that is already an outflow is the same missing-inbound
        // case, just with no row to update yet.
        balanceRaw: (d.delta < 0n ? 0n : d.delta).toString(),
        partiallyObserved: d.delta < 0n,
        firstAcquiredAt: d.at,
        lastUpdatedBlock: d.block,
      })
      .onConflictDoUpdate({
        target: [holderBalances.tokenId, holderBalances.wallet],
        set: {
          balanceRaw: clamped,
          // Sticky: once a wallet's inbound history is known to be incomplete,
          // no later transfer makes it complete again.
          partiallyObserved: sql`${holderBalances.partiallyObserved} OR ${wouldGoNegative}`,
          lastUpdatedBlock: sql`greatest(${holderBalances.lastUpdatedBlock}, ${d.block})`,
        },
      });
  }

  return deltas.size;
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

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export class TransferTail {
  private readonly sizer: AdaptiveChunkSize;
  private draining = false;

  constructor(private readonly deps: TransferTailDeps) {
    this.sizer = new AdaptiveChunkSize(deps.config.logChunkBlocks);
  }

  async drain(head: bigint, isFirstDrain: boolean): Promise<{ updates: number }> {
    if (this.draining) return { updates: 0 };
    this.draining = true;
    const logger = withContext(this.deps.logger, { source: TRANSFER_TAIL_SOURCE });

    try {
      const tracked = await trackedTokens(this.deps.db, this.deps.config);
      if (tracked.length === 0) {
        await advanceCursor(this.deps.db, TRANSFER_TAIL_SOURCE, head);
        return { updates: 0 };
      }

      const byAddress = new Map(tracked.map((t) => [t.address, t.tokenId]));
      const lastProcessed = await readCursor(this.deps.db, TRANSFER_TAIL_SOURCE);
      const plan = planRange({
        lastProcessed,
        head,
        overlapBlocks: 0,
        // Start at head: transfers for tokens we were not yet tracking are not
        // worth backfilling, and balances would be wrong without the full
        // history anyway (see the known limitation in the ADR).
        firstStartBackfillBlocks: 0,
        isFirstDrain,
      });
      if (plan.fromBlock > plan.toBlock) return { updates: 0 };

      let updates = 0;
      const batches = chunk(
        tracked.map((t) => t.address),
        this.deps.config.maxAddressesPerQuery,
      );

      for (const addresses of batches) {
        await fetchLogsChunked(
          this.deps.http,
          {
            address: addresses,
            topics: [TRANSFER_TOPIC],
            fromBlock: plan.fromBlock,
            toBlock: plan.toBlock,
          },
          {
            maxChunk: this.deps.config.logChunkBlocks,
            chunkSize: this.sizer,
            onChunkShrink: (from, to) =>
              logger.warn({ from, to }, 'provider rejected range; shrinking transfer-tail chunk'),
            onRetry: (attempt, delayMs) =>
              logger.warn({ attempt, delayMs }, 'transfer tail throttled; backing off'),
          },
          async (logs, range) => {
            if (logs.length > 0) {
              const times = await blockTimestamps(this.deps.http, logs);
              const decoded = logs
                .map(decodeTransfer)
                .filter((t): t is DecodedTransfer => t !== null);
              updates += await applyTransfers(this.deps.db, byAddress, decoded, times);
            }
            if (addresses === batches[batches.length - 1]) {
              await advanceCursor(this.deps.db, TRANSFER_TAIL_SOURCE, range.toBlock);
            }
          },
        );
      }

      if (updates > 0) {
        logger.info({ updates, tokens: tracked.length }, 'transfer tail applied balance updates');
      }
      return { updates };
    } finally {
      this.draining = false;
    }
  }
}
