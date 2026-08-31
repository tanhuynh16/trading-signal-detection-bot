import { describe, expect, it } from 'vitest';
import { planRange } from './cursor.js';

/**
 * Spec §10.3: "restarting the worker does not permanently skip blocks."
 * These cases are the arithmetic that makes that true.
 */
describe('cursor range planning', () => {
  it('seeds a bounded backfill on first start instead of scanning from genesis', () => {
    const plan = planRange({
      lastProcessed: null,
      head: 50_000_000n,
      overlapBlocks: 50,
      firstStartBackfillBlocks: 300,
    });
    expect(plan.seeded).toBe(true);
    expect(plan.fromBlock).toBe(49_999_700n);
    expect(plan.toBlock).toBe(50_000_000n);
  });

  it('rewinds by the overlap on restart, re-reading rather than risking a gap', () => {
    const plan = planRange({
      lastProcessed: 1_000n,
      head: 1_100n,
      overlapBlocks: 50,
      firstStartBackfillBlocks: 300,
    });
    // next would be 1001; overlap pulls it back to 951.
    expect(plan.fromBlock).toBe(951n);
    expect(plan.toBlock).toBe(1_100n);
    expect(plan.seeded).toBe(false);
  });

  it('never rewinds below block zero', () => {
    const plan = planRange({
      lastProcessed: 5n,
      head: 100n,
      overlapBlocks: 500,
      firstStartBackfillBlocks: 300,
    });
    expect(plan.fromBlock).toBe(0n);
  });

  it('never seeds below block zero on a short chain', () => {
    const plan = planRange({
      lastProcessed: null,
      head: 100n,
      overlapBlocks: 50,
      firstStartBackfillBlocks: 300,
    });
    expect(plan.fromBlock).toBe(0n);
  });

  it('produces an empty range when already caught up to head', () => {
    const plan = planRange({
      lastProcessed: 1_000n,
      head: 1_000n,
      overlapBlocks: 0,
      firstStartBackfillBlocks: 300,
    });
    // from = 1001 > to = 1000, so the caller skips the drain entirely.
    expect(plan.fromBlock).toBeGreaterThan(plan.toBlock);
  });

  it('re-reads the last block when overlap is zero, never skipping one', () => {
    const plan = planRange({
      lastProcessed: 1_000n,
      head: 1_005n,
      overlapBlocks: 0,
      firstStartBackfillBlocks: 300,
    });
    expect(plan.fromBlock).toBe(1_001n);
  });

  it('treats a zero-block backfill as start-at-head', () => {
    const plan = planRange({
      lastProcessed: null,
      head: 500n,
      overlapBlocks: 0,
      firstStartBackfillBlocks: 0,
    });
    expect(plan.fromBlock).toBe(500n);
    expect(plan.toBlock).toBe(500n);
  });
});

describe('overlap is startup-only', () => {
  const common = { head: 1_100n, overlapBlocks: 50, firstStartBackfillBlocks: 300 };

  it('applies the overlap on the first drain after a restart', () => {
    const plan = planRange({ lastProcessed: 1_000n, ...common, isFirstDrain: true });
    expect(plan.fromBlock).toBe(951n);
  });

  it('does not re-apply it on steady-state drains', () => {
    // Re-reading 50 blocks every drain multiplies request count against a
    // provider that caps eth_getLogs at 10 blocks per call.
    const plan = planRange({ lastProcessed: 1_000n, ...common, isFirstDrain: false });
    expect(plan.fromBlock).toBe(1_001n);
  });

  it('still never skips a block in steady state', () => {
    const plan = planRange({ lastProcessed: 1_000n, ...common, isFirstDrain: false });
    // Resumes exactly one past the committed watermark: no gap, no re-read.
    expect(plan.fromBlock).toBe(1_000n + 1n);
  });

  it('defaults to applying the overlap when the flag is omitted', () => {
    const plan = planRange({ lastProcessed: 1_000n, ...common });
    expect(plan.fromBlock).toBe(951n);
  });
});

/**
 * Reading to `head` means writing rows from blocks that can still be reorged
 * out. The depth is per source on purpose (ADR 0022): discovery keeps 0 because
 * §10 wants a pool found within seconds, while the swap tail waits because its
 * rows feed §21 outcome math that is never recomputed.
 */
describe('confirmations keep a drain behind the head', () => {
  it('stops short of head by the configured depth', () => {
    const plan = planRange({
      lastProcessed: 1_000n,
      head: 1_100n,
      overlapBlocks: 0,
      firstStartBackfillBlocks: 0,
      confirmations: 5,
    });
    expect(plan.toBlock).toBe(1_095n);
  });

  it('defaults to reading all the way to head', () => {
    // Omitting the option must not silently change discovery's behaviour.
    const plan = planRange({
      lastProcessed: 1_000n,
      head: 1_100n,
      overlapBlocks: 0,
      firstStartBackfillBlocks: 0,
    });
    expect(plan.toBlock).toBe(1_100n);
  });

  it('applies the depth to a first-start backfill too', () => {
    const plan = planRange({
      lastProcessed: null,
      head: 1_000n,
      overlapBlocks: 0,
      firstStartBackfillBlocks: 100,
      confirmations: 10,
    });
    expect(plan.toBlock).toBe(990n);
    expect(plan.fromBlock).toBe(890n);
  });

  it('clamps at genesis rather than going negative', () => {
    const plan = planRange({
      lastProcessed: null,
      head: 3n,
      overlapBlocks: 0,
      firstStartBackfillBlocks: 0,
      confirmations: 10,
    });
    expect(plan.toBlock).toBe(0n);
    expect(plan.fromBlock).toBe(0n);
  });

  it('produces an empty range when the cursor is already past the safe head', () => {
    // The caller checks `fromBlock > toBlock` and skips; the tail must not be
    // asked to fetch a backwards range while it waits for confirmations.
    const plan = planRange({
      lastProcessed: 1_099n,
      head: 1_100n,
      overlapBlocks: 0,
      firstStartBackfillBlocks: 0,
      confirmations: 5,
      isFirstDrain: false,
    });
    expect(plan.fromBlock > plan.toBlock).toBe(true);
  });
});
