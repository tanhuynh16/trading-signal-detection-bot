import { describe, expect, it } from 'vitest';
import { shouldAlert, type PreviousAlert } from './dedupe.js';

const config = { rescoreDelta: 10, cooldownMinutes: 60 };
const at = (min: number) => new Date(Date.UTC(2026, 7, 25, 12, min, 0));

const previous = (over: Partial<PreviousAlert> = {}): PreviousAlert => ({
  level: 'INTERESTING',
  alphaScore: 65,
  sentAt: at(0),
  ...over,
});

describe('alert dedup (spec §18)', () => {
  it('sends the first alert for a token', () => {
    const d = shouldAlert({ level: 'INTERESTING', alphaScore: 65, previous: null }, config);
    expect(d.shouldAlert).toBe(true);
    expect(d.reason).toBe('first_alert');
  });

  it('suppresses a repeat at the same level with a similar score', () => {
    // Without this the pipeline re-alerts on every snapshot — eight times an
    // hour for the same fact.
    const d = shouldAlert(
      { level: 'INTERESTING', alphaScore: 66, previous: previous(), now: at(5) },
      config,
    );
    expect(d.shouldAlert).toBe(false);
    expect(d.reason).toBe('suppressed_duplicate');
  });

  it('always sends a genuine level upgrade', () => {
    // INTERESTING then STRONG are different claims, not a repeat.
    const d = shouldAlert(
      { level: 'STRONG', alphaScore: 66, previous: previous(), now: at(1) },
      config,
    );
    expect(d.shouldAlert).toBe(true);
    expect(d.reason).toBe('level_upgraded');
  });

  it('re-alerts when the score moves by the configured delta', () => {
    const d = shouldAlert(
      { level: 'INTERESTING', alphaScore: 75, previous: previous(), now: at(1) },
      config,
    );
    expect(d.shouldAlert).toBe(true);
    expect(d.reason).toBe('score_moved');
  });

  it('re-alerts on a large downward move too', () => {
    // A collapsing score is information worth sending.
    const d = shouldAlert(
      { level: 'INTERESTING', alphaScore: 50, previous: previous(), now: at(1) },
      config,
    );
    expect(d.shouldAlert).toBe(true);
  });

  it('does not re-alert just below the delta', () => {
    const d = shouldAlert(
      { level: 'INTERESTING', alphaScore: 74.9, previous: previous(), now: at(1) },
      config,
    );
    expect(d.shouldAlert).toBe(false);
  });

  it('re-alerts once the cooldown has elapsed', () => {
    const d = shouldAlert(
      { level: 'INTERESTING', alphaScore: 65, previous: previous(), now: at(60) },
      config,
    );
    expect(d.shouldAlert).toBe(true);
    expect(d.reason).toBe('cooldown_elapsed');
  });

  it('stays suppressed just inside the cooldown', () => {
    const d = shouldAlert(
      { level: 'INTERESTING', alphaScore: 65, previous: previous(), now: at(59) },
      config,
    );
    expect(d.shouldAlert).toBe(false);
  });

  it('never alerts at level NONE', () => {
    const d = shouldAlert({ level: 'NONE', alphaScore: 90, previous: null }, config);
    expect(d.shouldAlert).toBe(false);
    expect(d.reason).toBe('no_alert_level');
  });

  it('does not treat a downgrade as an upgrade', () => {
    const d = shouldAlert(
      { level: 'INTERESTING', alphaScore: 65, previous: previous({ level: 'STRONG' }), now: at(1) },
      config,
    );
    expect(d.shouldAlert).toBe(false);
  });
});
