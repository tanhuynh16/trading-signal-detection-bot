import { describe, expect, it } from 'vitest';
import { decideCoverage, type CoverageConfig } from './coverage.js';

const config: CoverageConfig = {
  enabled: true,
  deferIntervalMs: 30_000,
  maxDeferMs: 1_800_000,
};

const at = (min: number) => new Date(Date.UTC(2026, 7, 26, 12, min, 0));

describe('decideCoverage — never measure a window the tail has not indexed', () => {
  it('is ready once the watermark reaches the window end', () => {
    const d = decideCoverage({ watermarkTime: at(5), windowEnd: at(5), config, now: at(5) });
    expect(d.ready).toBe(true);
  });

  it('is ready when the watermark is past the window end', () => {
    expect(decideCoverage({ watermarkTime: at(9), windowEnd: at(5), config, now: at(9) }).ready)
      .toBe(true);
  });

  it('defers while the watermark is short, however close', () => {
    // One second short is still short: the missing block may hold the trade
    // that sets max_runup_pct.
    const windowEnd = at(5);
    const watermarkTime = new Date(windowEnd.getTime() - 1000);
    const d = decideCoverage({ watermarkTime, windowEnd, config, now: at(5) });

    expect(d.ready).toBe(false);
    if (!d.ready && !d.giveUp) {
      expect(d.retryAt.getTime()).toBe(at(5).getTime() + config.deferIntervalMs);
    }
  });

  it('defers when the watermark is unknown', () => {
    // A null watermark means "we have no idea", which is the one thing that
    // must never be mistaken for completeness.
    const d = decideCoverage({ watermarkTime: null, windowEnd: at(5), config, now: at(5) });
    expect(d.ready).toBe(false);
    if (!d.ready) expect(d.giveUp).toBe(false);
  });

  it('gives up exactly at the cap, not before', () => {
    const windowEnd = at(0);
    const deadline = new Date(windowEnd.getTime() + config.maxDeferMs);
    const justBefore = new Date(deadline.getTime() - 1);

    const waiting = decideCoverage({ watermarkTime: null, windowEnd, config, now: justBefore });
    expect(waiting.ready).toBe(false);
    if (!waiting.ready) expect(waiting.giveUp).toBe(false);

    const done = decideCoverage({ watermarkTime: null, windowEnd, config, now: deadline });
    expect(done.ready).toBe(false);
    if (!done.ready) expect(done.giveUp).toBe(true);
  });

  it('still gives up when the tail has stalled far short', () => {
    // A stalled drain, or a pool aged out of retention. §27 wants the failure
    // written down, not a horizon deferring forever with nothing recorded.
    const d = decideCoverage({
      watermarkTime: at(0),
      windowEnd: at(5),
      config,
      now: at(60),
    });
    expect(d.ready).toBe(false);
    if (!d.ready) expect(d.giveUp).toBe(true);
  });

  it('is always ready when the gate is disabled', () => {
    // The escape hatch restores pre-gate behaviour without a code change.
    const off = { ...config, enabled: false };
    expect(decideCoverage({ watermarkTime: null, windowEnd: at(5), config: off, now: at(0) }).ready)
      .toBe(true);
  });
});
