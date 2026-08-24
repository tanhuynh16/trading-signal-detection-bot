import { describe, expect, it } from 'vitest';
import { MINUTE_MS } from '@sdb/shared';
import { planSnapshots, shouldStopTracking, windowFor } from './schedule.js';

describe('snapshot schedule (spec §13)', () => {
  it('plans exactly the eight offsets the spec lists', () => {
    expect(planSnapshots().map((p) => p.offset)).toEqual([
      'T0',
      '30s',
      '1m',
      '2m',
      '5m',
      '10m',
      '30m',
      '1h',
    ]);
  });

  it('gives every job a distinct identity — they key the idempotency index', () => {
    const offsets = planSnapshots().map((p) => p.offset);
    expect(new Set(offsets).size).toBe(offsets.length);
  });

  it('schedules delays that increase monotonically from discovery', () => {
    const delays = planSnapshots().map((p) => p.delayMs);
    for (let i = 1; i < delays.length; i += 1) {
      expect(delays[i]!).toBeGreaterThan(delays[i - 1]!);
    }
    expect(delays[0]).toBe(0);
  });

  it('never lets a trade window exceed the elapsed time', () => {
    // At T+30s only 30s of history exists; a fixed 5m window would report a
    // rate over a period that mostly predates the pool.
    for (const { delayMs, windowMs } of planSnapshots()) {
      expect(windowMs).toBeLessThanOrEqual(Math.max(delayMs, 0));
    }
  });

  it('caps the window at five minutes for late offsets', () => {
    expect(windowFor(60 * MINUTE_MS)).toBe(5 * MINUTE_MS);
    expect(windowFor(30 * MINUTE_MS)).toBe(5 * MINUTE_MS);
    expect(windowFor(2 * MINUTE_MS)).toBe(2 * MINUTE_MS);
    expect(windowFor(0)).toBe(0);
  });
});

describe('early stop (spec §13)', () => {
  const discoveredAt = new Date('2026-08-24T12:00:00Z');
  const at = (min: number) => new Date(discoveredAt.getTime() + min * MINUTE_MS);
  const base = { discoveredAt, minLiquidityUsd: 10_000, graceMinutes: 5 };

  it('keeps tracking inside the grace period even with zero liquidity', () => {
    // Pools are routinely created empty and funded a minute or two later.
    // Judging at T+0 would discard exactly the launches worth watching.
    const verdict = shouldStopTracking({
      ...base,
      snapshots: [{ liquidityUsd: '0', capturedAt: discoveredAt }],
      now: at(2),
    });
    expect(verdict.stop).toBe(false);
  });

  it('keeps tracking a pool funded late, after a dry start', () => {
    const verdict = shouldStopTracking({
      ...base,
      snapshots: [
        { liquidityUsd: '0', capturedAt: discoveredAt },
        { liquidityUsd: '45000', capturedAt: at(3) },
      ],
      now: at(10),
    });
    expect(verdict.stop).toBe(false);
  });

  it('stops a pool that never reached the floor past the grace period', () => {
    const verdict = shouldStopTracking({
      ...base,
      snapshots: [
        { liquidityUsd: '120', capturedAt: discoveredAt },
        { liquidityUsd: '95', capturedAt: at(3) },
      ],
      now: at(10),
    });
    expect(verdict.stop).toBe(true);
    expect(verdict.reason).toBe('liquidity_below_floor');
  });

  it('stops a pool that never became priceable at all', () => {
    // Null liquidity means no USD path — usually an unrecognised quote token.
    // Nothing downstream can score it, so tracking is wasted RPC.
    const verdict = shouldStopTracking({
      ...base,
      snapshots: [
        { liquidityUsd: null, capturedAt: discoveredAt },
        { liquidityUsd: null, capturedAt: at(3) },
      ],
      now: at(10),
    });
    expect(verdict.stop).toBe(true);
    expect(verdict.reason).toBe('no_priceable_liquidity');
  });

  it('treats a single past reading above the floor as qualifying', () => {
    // Liquidity that spiked then drained still deserves its full series; the
    // drain itself is signal that Phase 4 features need to see.
    const verdict = shouldStopTracking({
      ...base,
      snapshots: [
        { liquidityUsd: '50000', capturedAt: discoveredAt },
        { liquidityUsd: '10', capturedAt: at(6) },
      ],
      now: at(10),
    });
    expect(verdict.stop).toBe(false);
  });

  it('does not stop when there are no snapshots to judge yet', () => {
    const verdict = shouldStopTracking({ ...base, snapshots: [], now: at(2) });
    expect(verdict.stop).toBe(false);
  });
});
