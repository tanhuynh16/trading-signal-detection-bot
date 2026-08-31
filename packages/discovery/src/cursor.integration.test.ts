import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { createDatabase, discoveryCursors } from '@sdb/database';
import {
  advanceCursor,
  planRange,
  readCursor,
  readCursorState,
  rewindCursor,
} from './cursor.js';

/**
 * Spec §10.3: "restarting the worker does not permanently skip blocks."
 * The cursor is the mechanism, so its persistence semantics are tested against
 * a real database, not a mock.
 */
const url = process.env.TEST_DATABASE_URL ?? 'postgres://sdb:sdb@localhost:5432/sdb';
const { db, close } = createDatabase(url, { max: 2 });
const SOURCE = 'test-factory';

/**
 * Delete only the rows this file owns.
 *
 * `discovery_cursors` is shared with the swap tail, whose watermark the §21
 * outcome suite depends on. Truncating the whole table raced that suite when
 * vitest ran the files in parallel, producing a flaky failure that looked like
 * a product bug.
 */
const OWNED = [SOURCE, 'uniswap-v2', 'aerodrome'];
const clean = () =>
  db.delete(discoveryCursors).where(inArray(discoveryCursors.source, OWNED));

beforeEach(async () => {
  await clean();
});

afterAll(async () => {
  await clean();
  await close();
});

describe('discovery cursor persistence', () => {
  it('returns null before the first drain, triggering a seeded backfill', async () => {
    expect(await readCursor(db, SOURCE)).toBeNull();
  });

  it('round-trips a block number without precision loss', async () => {
    // Block numbers are bigint; a float round-trip would corrupt these.
    await advanceCursor(db, SOURCE, 50_340_511n);
    expect(await readCursor(db, SOURCE)).toBe(50_340_511n);
  });

  it('advances forward', async () => {
    await advanceCursor(db, SOURCE, 100n);
    await advanceCursor(db, SOURCE, 200n);
    expect(await readCursor(db, SOURCE)).toBe(200n);
  });

  it('refuses to rewind — a replayed chunk must not reopen a gap', async () => {
    await advanceCursor(db, SOURCE, 500n);
    // An overlapping drain legitimately re-reads block 450 and finishes late.
    await advanceCursor(db, SOURCE, 450n);
    expect(await readCursor(db, SOURCE)).toBe(500n);
  });

  it('keeps each factory’s cursor independent', async () => {
    await advanceCursor(db, 'uniswap-v2', 100n);
    await advanceCursor(db, 'aerodrome', 900n);
    expect(await readCursor(db, 'uniswap-v2')).toBe(100n);
    expect(await readCursor(db, 'aerodrome')).toBe(900n);
  });

  it('resumes behind the watermark after a restart, never ahead of it', async () => {
    await advanceCursor(db, SOURCE, 1_000n);
    const lastProcessed = await readCursor(db, SOURCE);

    const plan = planRange({
      lastProcessed,
      head: 1_050n,
      overlapBlocks: 50,
      firstStartBackfillBlocks: 300,
    });

    // Must not start past the watermark+1, or blocks are skipped for good.
    expect(plan.fromBlock).toBeLessThanOrEqual(lastProcessed! + 1n);
    expect(plan.fromBlock).toBe(951n);
  });
});

/**
 * The block hash is what makes a reorg detectable — a block NUMBER always
 * exists after one, it is simply a different block. These cases guard the
 * pairing between the two, because a hash describing a block the cursor is not
 * on reads as a mismatch and deletes good data (ADR 0022).
 */
describe('block hash pairing', () => {
  it('stores the hash alongside the block it describes', async () => {
    await advanceCursor(db, SOURCE, 100n, new Date('2026-01-01T00:00:00Z'), '0xaaa');

    const state = await readCursorState(db, SOURCE);
    expect(state?.lastProcessedBlock).toBe(100n);
    expect(state?.lastProcessedBlockHash).toBe('0xaaa');
  });

  it('clears the hash when the block advances without one', async () => {
    // A mid-drain chunk commit moves the block but knows no hash. Keeping the
    // old one would leave the cursor claiming a hash for a block behind it,
    // and the very next reorg check would roll back healthy history.
    await advanceCursor(db, SOURCE, 100n, undefined, '0xaaa');
    await advanceCursor(db, SOURCE, 150n);

    const state = await readCursorState(db, SOURCE);
    expect(state?.lastProcessedBlock).toBe(150n);
    expect(state?.lastProcessedBlockHash).toBeNull();
  });

  it('keeps the hash when a late drain fails to move the block', async () => {
    await advanceCursor(db, SOURCE, 200n, undefined, '0xaaa');
    await advanceCursor(db, SOURCE, 150n);

    const state = await readCursorState(db, SOURCE);
    expect(state?.lastProcessedBlock).toBe(200n);
    expect(state?.lastProcessedBlockHash).toBe('0xaaa');
  });

  it('refuses a hash from a drain that lost the greatest() race', async () => {
    // 150 is behind the stored 200, so its hash is not ours to write.
    await advanceCursor(db, SOURCE, 200n, undefined, '0xaaa');
    await advanceCursor(db, SOURCE, 150n, undefined, '0xbbb');

    const state = await readCursorState(db, SOURCE);
    expect(state?.lastProcessedBlockHash).toBe('0xaaa');
  });

  it('re-stamps the hash when the end-of-drain write lands on the same block', async () => {
    // The normal case: the last chunk advanced to N with no hash, then the
    // watermark write stamps N with one. Requiring strictly-greater here would
    // leave the hash permanently null and disable detection entirely.
    await advanceCursor(db, SOURCE, 300n);
    await advanceCursor(db, SOURCE, 300n, new Date('2026-01-01T00:00:00Z'), '0xccc');

    const state = await readCursorState(db, SOURCE);
    expect(state?.lastProcessedBlockHash).toBe('0xccc');
  });
});

describe('rewindCursor — the one case advanceCursor refuses', () => {
  it('moves block and time backwards together', async () => {
    await advanceCursor(db, SOURCE, 500n, new Date('2026-01-01T01:00:00Z'), '0xaaa');
    await rewindCursor(db, SOURCE, 400n, new Date('2026-01-01T00:30:00Z'));

    const state = await readCursorState(db, SOURCE);
    expect(state?.lastProcessedBlock).toBe(400n);
    expect(state?.lastProcessedBlockTime?.toISOString()).toBe('2026-01-01T00:30:00.000Z');
  });

  it('drops the time watermark, not just the block', async () => {
    // The load-bearing half. §21's coverage gate reads the time watermark as
    // proof that every block up to that instant is committed; leaving it
    // forward after deleting the trades underneath would let an outcome be
    // finalised from a window whose contents were just removed.
    await advanceCursor(db, SOURCE, 500n, new Date('2026-01-01T01:00:00Z'), '0xaaa');
    const before = await readCursorState(db, SOURCE);

    await rewindCursor(db, SOURCE, 400n, new Date('2026-01-01T00:30:00Z'));
    const after = await readCursorState(db, SOURCE);

    expect(after!.lastProcessedBlockTime!.getTime()).toBeLessThan(
      before!.lastProcessedBlockTime!.getTime(),
    );
  });

  it('clears the hash, because the stored one is known wrong', async () => {
    await advanceCursor(db, SOURCE, 500n, new Date('2026-01-01T01:00:00Z'), '0xaaa');
    await rewindCursor(db, SOURCE, 400n, null);

    const state = await readCursorState(db, SOURCE);
    expect(state?.lastProcessedBlockHash).toBeNull();
  });

  it('accepts a null time when the rewind target could not be read', async () => {
    // Null reads as "coverage unknown", which the gate treats as not covered —
    // the conservative direction.
    await advanceCursor(db, SOURCE, 500n, new Date('2026-01-01T01:00:00Z'), '0xaaa');
    await rewindCursor(db, SOURCE, 400n, null);

    const state = await readCursorState(db, SOURCE);
    expect(state?.lastProcessedBlockTime).toBeNull();
  });

  it('leaves other sources untouched', async () => {
    await advanceCursor(db, SOURCE, 500n);
    await advanceCursor(db, 'uniswap-v2', 900n);
    await rewindCursor(db, SOURCE, 400n, null);

    expect(await readCursor(db, 'uniswap-v2')).toBe(900n);
  });
});
