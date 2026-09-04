import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import {
  createDatabase,
  discoveryCursors,
  ingestionGaps,
  pools,
  reorgEvents,
  tokens,
  trades,
} from '@sdb/database';
import type { PublicClient } from 'viem';
import { advanceCursor, backfillGapEnd, readCursorState } from '@sdb/discovery';
import { ProviderHistoryUnavailableError } from '@sdb/shared';
import { confirmedHead, detectReorg, SwapTail, SWAP_TAIL_SOURCE } from './swap-tail.js';

/**
 * Requires the compose stack: docker compose up -d postgres
 *
 * The swap tail indexed to `head` with zero confirmations and never removed a
 * swap whose block left the canonical chain — and `trades` is what §21 measures
 * outcomes from and §22 evaluates. These cases cover both halves of the fix:
 * that a genuine reorg is detected and rolled back, and — at least as important
 * — that a healthy chain is never rolled back, since a false positive deletes
 * good data (ADR 0022).
 */
const url = process.env.TEST_DATABASE_URL ?? 'postgres://sdb:sdb@localhost:5432/sdb';
const { db, close } = createDatabase(url, { max: 4 });

const CHAIN = 8453;
const WETH = '0x4200000000000000000000000000000000000006';
const SOURCE = 'reorg-test-tail';
const config = { reorgDepth: 32 };

/** A chain whose block hashes are `0x<block>-<fork>`, so a fork is one edit. */
function fakeChain(fork = 'a', overrides: Record<string, string> = {}) {
  let calls = 0;
  const client = {
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => {
      calls += 1;
      const key = blockNumber.toString();
      return {
        hash: overrides[key] ?? `0x${key}-${fork}`,
        // 2s blocks from a fixed epoch, so block time is derivable and stable.
        timestamp: BigInt(1_760_000_000) + blockNumber * 2n,
      };
    },
  } as unknown as PublicClient;
  return { client, calls: () => calls };
}

async function seedPool() {
  const [token] = await db
    .insert(tokens)
    .values({ chainId: CHAIN, address: `0xaaa${'0'.repeat(37)}1`, firstSeenAt: new Date() })
    .returning({ id: tokens.id });
  const [pool] = await db
    .insert(pools)
    .values({
      tokenId: token!.id,
      chainId: CHAIN,
      dex: 'uniswap-v2',
      address: `0xccc${'0'.repeat(37)}1`,
      quoteTokenAddress: WETH,
      discoveredAt: new Date(),
      blockNumber: 1n,
      transactionHash: `0x${'1'.repeat(64)}`,
    })
    .returning({ id: pools.id });
  return pool!.id;
}

async function seedTrade(poolId: string, blockNumber: bigint) {
  await db.insert(trades).values({
    poolId,
    txHash: `0x${blockNumber.toString(16).padStart(64, '0')}`,
    logIndex: 0,
    wallet: `0xdddd${'0'.repeat(36)}`,
    side: 'OUT0',
    blockNumber,
    occurredAt: new Date(Number(1_760_000_000n + blockNumber * 2n) * 1000),
    baseAmountRaw: '1000',
    quoteAmountRaw: '2000',
  });
}

const clean = async () => {
  await db.execute(sql`TRUNCATE ${trades}, ${pools}, ${tokens} RESTART IDENTITY CASCADE`);
  await db.delete(reorgEvents).where(eq(reorgEvents.source, SOURCE));
  // Only the cursor row this file owns: `discovery_cursors` is shared with the
  // live swap tail and the §21 outcome suite.
  // SWAP_TAIL_SOURCE is included because the drain test below exercises a real
  // SwapTail, which hardcodes it. `fileParallelism: false` makes that safe, but
  // the rows still must not leak into the next file.
  await db
    .delete(discoveryCursors)
    .where(inArray(discoveryCursors.source, [SOURCE, SWAP_TAIL_SOURCE]));
  await db.delete(ingestionGaps).where(eq(ingestionGaps.source, SWAP_TAIL_SOURCE));
};

beforeEach(clean);
afterAll(async () => {
  await clean();
  await close();
});

describe('detectReorg — quiet on a healthy chain', () => {
  it('does nothing when the stored hash still matches', async () => {
    const poolId = await seedPool();
    await seedTrade(poolId, 1_000n);
    await advanceCursor(db, SOURCE, 1_000n, new Date(), '0x1000-a');

    const { client } = fakeChain('a');
    expect(await detectReorg(db, client, SOURCE, config)).toBeNull();

    expect(await db.select().from(trades)).toHaveLength(1);
    expect(await db.select().from(reorgEvents)).toHaveLength(0);
  });

  it('stays quiet across repeated drains', async () => {
    // A false positive is worse than the bug it fixes: it deletes real data on
    // every drain. Detection must be stable, not merely correct once.
    const poolId = await seedPool();
    await seedTrade(poolId, 1_000n);
    await advanceCursor(db, SOURCE, 1_000n, new Date(), '0x1000-a');

    const { client } = fakeChain('a');
    for (let i = 0; i < 5; i += 1) {
      expect(await detectReorg(db, client, SOURCE, config)).toBeNull();
    }
    expect(await db.select().from(trades)).toHaveLength(1);
  });

  it('cannot check without a stored hash, and does not guess', async () => {
    // "We cannot tell" is not "unchanged", but it is also not grounds to
    // delete. The next completed drain establishes the hash.
    const poolId = await seedPool();
    await seedTrade(poolId, 1_000n);
    await advanceCursor(db, SOURCE, 1_000n, new Date());

    const { client, calls } = fakeChain('b');
    expect(await detectReorg(db, client, SOURCE, config)).toBeNull();
    expect(calls()).toBe(0); // not even worth an RPC call
    expect(await db.select().from(trades)).toHaveLength(1);
  });

  it('does nothing when no cursor exists at all', async () => {
    const { client } = fakeChain('a');
    expect(await detectReorg(db, client, SOURCE, config)).toBeNull();
  });
});

describe('detectReorg — rollback on a hash mismatch', () => {
  it('rewinds the cursor by the configured depth', async () => {
    await advanceCursor(db, SOURCE, 1_000n, new Date('2026-01-01T00:00:00Z'), '0x1000-a');

    const { client } = fakeChain('b');
    const result = await detectReorg(db, client, SOURCE, config);

    expect(result?.rewoundTo).toBe(968n);
    expect((await readCursorState(db, SOURCE))?.lastProcessedBlock).toBe(968n);
  });

  it('deletes exactly the trades above the rewind point', async () => {
    const poolId = await seedPool();
    for (const block of [950n, 968n, 969n, 1_000n]) await seedTrade(poolId, block);
    await advanceCursor(db, SOURCE, 1_000n, new Date(), '0x1000-a');

    const { client } = fakeChain('b');
    const result = await detectReorg(db, client, SOURCE, config);

    expect(result?.deletedTrades).toBe(2);
    const left = await db.select({ blockNumber: trades.blockNumber }).from(trades);
    // The rewind point itself survives: it is the last block still trusted.
    expect(left.map((r) => r.blockNumber).sort()).toEqual([950n, 968n]);
  });

  it('drags the time watermark back with the block', async () => {
    // Leaving it forward would let §21's coverage gate certify a window whose
    // trades were just deleted.
    await advanceCursor(db, SOURCE, 1_000n, new Date('2026-06-01T00:00:00Z'), '0x1000-a');

    const { client } = fakeChain('b');
    await detectReorg(db, client, SOURCE, config);

    const state = await readCursorState(db, SOURCE);
    // Block 968 on the fake chain, not the wall-clock time we stored.
    expect(state?.lastProcessedBlockTime?.getTime()).toBe(
      Number(1_760_000_000n + 968n * 2n) * 1000,
    );
    expect(state?.lastProcessedBlockTime!.getTime()).toBeLessThan(
      new Date('2026-06-01T00:00:00Z').getTime(),
    );
  });

  it('clears the hash so the next drain re-establishes it', async () => {
    await advanceCursor(db, SOURCE, 1_000n, new Date(), '0x1000-a');
    const { client } = fakeChain('b');
    await detectReorg(db, client, SOURCE, config);

    expect((await readCursorState(db, SOURCE))?.lastProcessedBlockHash).toBeNull();
  });

  it('records one audited event carrying both hashes', async () => {
    const poolId = await seedPool();
    await seedTrade(poolId, 1_000n);
    await advanceCursor(db, SOURCE, 1_000n, new Date(), '0x1000-a');

    const { client } = fakeChain('b');
    await detectReorg(db, client, SOURCE, config);

    const [event] = await db.select().from(reorgEvents).where(eq(reorgEvents.source, SOURCE));
    expect(event?.detectedAtBlock).toBe(1_000n);
    expect(event?.rewoundToBlock).toBe(968n);
    expect(event?.expectedHash).toBe('0x1000-a');
    expect(event?.actualHash).toBe('0x1000-b');
    expect(event?.deletedTrades).toBe(1);
  });

  it('settles after one rollback rather than cascading', async () => {
    // The rewind clears the hash, so the immediate re-check has nothing to
    // compare and returns null — a mismatch must not roll back forever.
    await advanceCursor(db, SOURCE, 1_000n, new Date(), '0x1000-a');
    const { client } = fakeChain('b');

    expect(await detectReorg(db, client, SOURCE, config)).not.toBeNull();
    expect(await detectReorg(db, client, SOURCE, config)).toBeNull();
    expect(await db.select().from(reorgEvents).where(eq(reorgEvents.source, SOURCE))).toHaveLength(1);
  });

  it('clamps the rewind at genesis on a shallow chain', async () => {
    await advanceCursor(db, SOURCE, 10n, new Date(), '0x10-a');
    const { client } = fakeChain('b');

    expect((await detectReorg(db, client, SOURCE, config))?.rewoundTo).toBe(0n);
  });

  it('re-ingestion after a rollback is idempotent against the log identity', async () => {
    const poolId = await seedPool();
    await seedTrade(poolId, 1_000n);
    await advanceCursor(db, SOURCE, 1_000n, new Date(), '0x1000-a');

    const { client } = fakeChain('b');
    await detectReorg(db, client, SOURCE, config);
    expect(await db.select().from(trades)).toHaveLength(0);

    // The next drain re-reads the range. Re-inserting goes through the same
    // (tx_hash, log_index) conflict target `persistSwaps` uses, so an
    // overlapping re-read restores the swap exactly once rather than doubling
    // the price path it feeds into §21.
    const row = {
      poolId,
      txHash: `0x${(1_000n).toString(16).padStart(64, '0')}`,
      logIndex: 0,
      wallet: `0xdddd${'0'.repeat(36)}`,
      side: 'OUT0',
      blockNumber: 1_000n,
      occurredAt: new Date(Number(1_760_000_000n + 2_000n) * 1000),
      baseAmountRaw: '1000',
      quoteAmountRaw: '2000',
    };
    for (let i = 0; i < 3; i += 1) {
      await db
        .insert(trades)
        .values(row)
        .onConflictDoNothing({ target: [trades.txHash, trades.logIndex] });
    }
    expect(await db.select().from(trades)).toHaveLength(1);
  });
});

describe('confirmedHead', () => {
  it('stays the configured depth behind', () => {
    expect(confirmedHead(1_000n, 5)).toBe(995n);
  });

  it('is head itself at depth zero', () => {
    expect(confirmedHead(1_000n, 0)).toBe(1_000n);
  });

  it('clamps at genesis', () => {
    expect(confirmedHead(3n, 10)).toBe(0n);
  });
});


/**
 * A chain that has pruned everything below `prunedBelow`, answering exactly as
 * Chainstack does. This is the shape that wedged the live tail: the block under
 * the cursor was 86,779 behind head and could not be read at all.
 */
function prunedChain(prunedBelow: bigint, fork = 'a') {
  const client = {
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => {
      if (blockNumber < prunedBelow) {
        throw new Error(
          'Requested resource not available. Details: Archive, Debug and Trace ' +
            'requests are not available on your current plan.',
        );
      }
      return {
        hash: `0x${blockNumber.toString()}-${fork}`,
        timestamp: BigInt(1_760_000_000) + blockNumber * 2n,
      };
    },
    getLogs: async () => [],
  } as unknown as PublicClient;
  return client;
}

const silentLogger = (() => {
  const self: Record<string, unknown> = {};
  for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal']) {
    self[level] = () => undefined;
  }
  self['child'] = () => self;
  return self as never;
})();

describe('a cursor older than the provider history window', () => {
  it('surfaces a TYPED error from detectReorg, not a raw provider error', async () => {
    // drain()'s recovery keys on the error TYPE, so an unclassified provider
    // string is what made the tail retry forever instead of skipping forward.
    await advanceCursor(db, SOURCE, 1_000n, new Date(), '0x1000-a');

    await expect(
      detectReorg(db, prunedChain(900_000n), SOURCE, config),
    ).rejects.toBeInstanceOf(ProviderHistoryUnavailableError);
  });

  it('self-heals: records the gap and reseeds forward instead of wedging', async () => {
    // The live regression. The swap tail sat at 50,734,485 with a stored hash
    // while head was 86,779 blocks ahead; detectReorg read that block first,
    // the raw error escaped the history handling, and the tail never recovered.
    const stale = 50_734_485n;
    const head = 50_821_264n;
    await advanceCursor(db, SWAP_TAIL_SOURCE, stale, new Date(), '0x28323bb6');

    const tail = new SwapTail({
      db,
      http: prunedChain(head - 128n),
      logger: silentLogger,
      config: {
        chainId: CHAIN,
        logChunkBlocks: 100,
        maxTokenAgeMinutes: 360,
        maxAddressesPerQuery: 100,
        outcomeRetentionHours: 26,
        confirmations: 5,
        reorgDepth: 32,
      },
    });

    await expect(tail.drain(head, false)).resolves.toEqual({ swaps: 0 });

    const gaps = await db
      .select({ fromBlock: ingestionGaps.fromBlock, toBlock: ingestionGaps.toBlock })
      .from(ingestionGaps)
      .where(eq(ingestionGaps.source, SWAP_TAIL_SOURCE));
    expect(gaps).toHaveLength(1);
    // The gap starts at the cursor's OWN block: we could not read even the
    // block we claimed to have processed.
    expect(gaps[0]!.fromBlock).toBe(stale);
    expect(gaps[0]!.toBlock).toBe(confirmedHead(head, 5));

    const after = await readCursorState(db, SWAP_TAIL_SOURCE);
    expect(after!.lastProcessedBlock).toBe(confirmedHead(head, 5));
    // The hash is cleared: it described a block we are no longer on and could
    // not verify.
    expect(after!.lastProcessedBlockHash).toBeNull();
  });

  it('still detects a real reorg on a block the provider can serve', async () => {
    // The guard must not have turned every mismatch into a skip.
    const poolId = await seedPool();
    await seedTrade(poolId, 1_000n);
    await advanceCursor(db, SOURCE, 1_000n, new Date(), '0xdifferent');

    const rollback = await detectReorg(db, prunedChain(1n), SOURCE, config);

    expect(rollback).not.toBeNull();
    expect(rollback!.actualHash).toBe('0x1000-a');
  });
});


describe('a history gap must not veto outcome measurement forever', () => {
  /** `gapOverlaps`' rule, inlined so the test states the semantics it depends on. */
  const blocks = (gap: { fromTime: Date | null; toTime: Date | null }, w: { start: Date; end: Date }) =>
    (gap.fromTime === null || gap.fromTime <= w.end) &&
    (gap.toTime === null || gap.toTime >= w.start);

  it('bounds the gap by the watermark, not by the unreadable block', async () => {
    // The old code read `fromBlock`'s header — but that block being pruned is
    // the whole reason we are recording a gap, so from_time was ALWAYS null.
    const stale = 50_734_485n;
    const head = 50_830_690n;
    const watermarkTime = new Date('2026-09-03T15:40:00Z');
    await advanceCursor(db, SWAP_TAIL_SOURCE, stale, watermarkTime, '0xdeadbeef');

    const tail = new SwapTail({
      db,
      http: prunedChain(head - 128n),
      logger: silentLogger,
      config: {
        chainId: CHAIN,
        logChunkBlocks: 100,
        maxTokenAgeMinutes: 360,
        maxAddressesPerQuery: 100,
        outcomeRetentionHours: 26,
        confirmations: 5,
        reorgDepth: 32,
      },
    });
    await tail.drain(head, false);

    const [gap] = await db
      .select({ fromTime: ingestionGaps.fromTime, toTime: ingestionGaps.toTime })
      .from(ingestionGaps)
      .where(eq(ingestionGaps.source, SWAP_TAIL_SOURCE));

    // The watermark is where coverage provably ended, so it is where the hole
    // begins — and it costs no RPC.
    expect(gap!.fromTime?.toISOString()).toBe(watermarkTime.toISOString());
    expect(gap!.toTime).not.toBeNull();
  });

  it('a doubly-unbounded gap blocks every window until the end is backfilled', async () => {
    // The exact live deadlock: two rows with both bounds null made 583 of 583
    // outcomes report incomplete_tail_coverage while the tail ran 15s behind head.
    await db.insert(ingestionGaps).values({
      source: SWAP_TAIL_SOURCE,
      fromBlock: 50_833_040n,
      toBlock: 50_833_040n,
      fromTime: null,
      toTime: null,
      reason: 'provider history window exceeded',
    });

    const laterWindow = {
      start: new Date('2026-09-04T08:00:00Z'),
      end: new Date('2026-09-04T08:15:00Z'),
    };

    const [before] = await db
      .select({ fromTime: ingestionGaps.fromTime, toTime: ingestionGaps.toTime })
      .from(ingestionGaps)
      .where(eq(ingestionGaps.source, SWAP_TAIL_SOURCE));
    expect(blocks(before!, laterWindow)).toBe(true); // vetoes a window hours later

    const repaired = await backfillGapEnd(db, {
      source: SWAP_TAIL_SOURCE,
      watermarkBlock: 50_861_265n,
      watermarkTime: new Date('2026-09-04T02:00:00Z'),
    });
    expect(repaired).toBe(1);

    const [after] = await db
      .select({ fromTime: ingestionGaps.fromTime, toTime: ingestionGaps.toTime })
      .from(ingestionGaps)
      .where(eq(ingestionGaps.source, SWAP_TAIL_SOURCE));
    expect(blocks(after!, laterWindow)).toBe(false);
  });

  it('never touches a gap the watermark has not passed', async () => {
    await db.insert(ingestionGaps).values({
      source: SWAP_TAIL_SOURCE,
      fromBlock: 50_900_000n,
      toBlock: 50_900_500n,
      fromTime: null,
      toTime: null,
      reason: 'provider history window exceeded',
    });

    const repaired = await backfillGapEnd(db, {
      source: SWAP_TAIL_SOURCE,
      watermarkBlock: 50_861_265n,
      watermarkTime: new Date('2026-09-04T02:00:00Z'),
    });

    // Still ahead of the watermark, so its end is genuinely unknown and must
    // keep reading as overlapping (ADR 0020).
    expect(repaired).toBe(0);
  });

  it('never overwrites an end time that was actually observed', async () => {
    const observed = new Date('2026-09-03T15:47:51Z');
    await db.insert(ingestionGaps).values({
      source: SWAP_TAIL_SOURCE,
      fromBlock: 50_734_485n,
      toBlock: 50_830_562n,
      fromTime: null,
      toTime: observed,
      reason: 'provider history window exceeded',
    });

    await backfillGapEnd(db, {
      source: SWAP_TAIL_SOURCE,
      watermarkBlock: 50_861_265n,
      watermarkTime: new Date('2026-09-04T02:00:00Z'),
    });

    const [row] = await db
      .select({ toTime: ingestionGaps.toTime })
      .from(ingestionGaps)
      .where(eq(ingestionGaps.source, SWAP_TAIL_SOURCE));
    expect(row!.toTime?.toISOString()).toBe(observed.toISOString());
  });
});
