import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { createDatabase, discoveryCursors } from '@sdb/database';
import { advanceCursor, planRange, readCursor } from './cursor.js';

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
