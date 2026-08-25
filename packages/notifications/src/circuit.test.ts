import { describe, expect, it } from 'vitest';
import { InvalidDataError, TransientProviderError } from '@sdb/shared';
import {
  decide,
  failureCodeOf,
  isGlobalFailure,
  onFailure,
  onSuccess,
  type CircuitConfig,
  type CircuitSnapshot,
} from './circuit.js';

const config: CircuitConfig = {
  enabled: true,
  failureThreshold: 3,
  openDurationMs: 300_000,
};

const at = (min: number) => new Date(Date.UTC(2026, 7, 25, 12, min, 0));

const snap = (over: Partial<CircuitSnapshot> = {}): CircuitSnapshot => ({
  notifier: 'telegram',
  state: 'CLOSED',
  consecutiveFailures: 0,
  openedAt: null,
  reopenAfter: null,
  lastFailureCode: null,
  lastFailureReason: null,
  lastSuccessAt: null,
  ...over,
});

const httpError = (status: number, transient = false) =>
  transient
    ? new TransientProviderError(`telegram responded ${status}`, { httpStatus: status })
    : new InvalidDataError(`telegram rejected the message (${status})`, { httpStatus: status });

describe('isGlobalFailure — which faults are the transport, not the message', () => {
  it('counts 401: the token is revoked, every alert will fail identically', () => {
    expect(isGlobalFailure(httpError(401), false)).toBe(true);
  });

  it('counts 403: chat inaccessible or bot not started', () => {
    // The exact failure hit in the Phase 6 closeout run.
    expect(isGlobalFailure(httpError(403), false)).toBe(true);
  });

  it('does NOT count 400: that is one malformed message, not a broken transport', () => {
    // A token whose symbol produces bad markup must not silence alerting for
    // every other token.
    expect(isGlobalFailure(httpError(400), false)).toBe(false);
  });

  it('counts a transient only once its retry budget is exhausted', () => {
    const outage = httpError(503, true);
    expect(isGlobalFailure(outage, false)).toBe(false);
    expect(isGlobalFailure(outage, true)).toBe(true);
  });

  it('counts an exhausted network failure that never reached Telegram', () => {
    const network = new TransientProviderError('telegram request failed');
    expect(isGlobalFailure(network, true)).toBe(true);
    expect(isGlobalFailure(network, false)).toBe(false);
  });

  it('does not count an exhausted permanent 400', () => {
    // Exhaustion is irrelevant: a 400 is never retried into a global fault.
    expect(isGlobalFailure(httpError(400), true)).toBe(false);
  });
});

describe('isGlobalFailure — the transport classifies its own faults', () => {
  const hinted = (status: number, global: boolean) =>
    new InvalidDataError(`telegram rejected the message (${status})`, {
      httpStatus: status,
      global,
    });

  it('opens on a 400 the transport marks global — a wrong chat id', () => {
    // Measured live: a wrong chat id is 400 "chat not found", not 401/403.
    // Without the hint the breaker would never open on the very
    // misconfiguration this phase exists to contain.
    expect(isGlobalFailure(hinted(400, true), false)).toBe(true);
  });

  it('opens on a 404 the transport marks global — a revoked bot token', () => {
    expect(isGlobalFailure(hinted(404, true), false)).toBe(true);
  });

  it('respects a hint that a permanent failure is only per-message', () => {
    expect(isGlobalFailure(hinted(400, false), true)).toBe(false);
  });

  it('never lets a transport hint override the retry budget', () => {
    // A transport cannot know how many attempts remain, so exhaustion alone
    // decides for a transient — otherwise one blip would open the circuit.
    const blip = new TransientProviderError('telegram responded 503', {
      httpStatus: 503,
      global: false,
    });
    expect(isGlobalFailure(blip, false)).toBe(false);
    expect(isGlobalFailure(blip, true)).toBe(true);
  });

  it('falls back to the status when a transport offers no hint', () => {
    expect(isGlobalFailure(httpError(403), false)).toBe(true);
    expect(isGlobalFailure(httpError(400), false)).toBe(false);
  });
});

describe('failureCodeOf', () => {
  it('names the HTTP status when there is one', () => {
    expect(failureCodeOf(httpError(403))).toBe('HTTP_403');
  });

  it('falls back to the error name', () => {
    expect(failureCodeOf(new TransientProviderError('boom'))).toBe('TransientProviderError');
  });
});

describe('onFailure — opening', () => {
  it('opens at exactly the threshold, not before', () => {
    let state = snap();
    for (let i = 1; i < config.failureThreshold; i += 1) {
      const t = onFailure(state, { global: true, config, now: at(0) });
      expect(t.next).toBe('CLOSED');
      expect(t.justOpened).toBe(false);
      state = snap({ state: t.next, consecutiveFailures: t.consecutiveFailures });
    }
    const opening = onFailure(state, { global: true, config, now: at(0) });
    expect(opening.next).toBe('OPEN');
    expect(opening.justOpened).toBe(true);
    expect(opening.consecutiveFailures).toBe(3);
  });

  it('sets a reopen window when it opens', () => {
    const t = onFailure(snap({ consecutiveFailures: 2 }), { global: true, config, now: at(0) });
    expect(t.reopenAfter!.getTime()).toBe(at(0).getTime() + config.openDurationMs);
  });

  it('never increments on a non-global failure', () => {
    // Otherwise a scatter of per-message 400s would accumulate into an opening.
    const t = onFailure(snap({ consecutiveFailures: 2 }), { global: false, config, now: at(0) });
    expect(t.consecutiveFailures).toBe(2);
    expect(t.next).toBe('CLOSED');
  });

  it('reports justOpened only on the edge, so the audit fires once', () => {
    const opened = snap({ state: 'OPEN', consecutiveFailures: 3, reopenAfter: at(5) });
    const again = onFailure(opened, { global: true, config, now: at(1) });
    expect(again.next).toBe('OPEN');
    expect(again.justOpened).toBe(false);
  });

  it('never opens when disabled', () => {
    const disabled = { ...config, enabled: false };
    const t = onFailure(snap({ consecutiveFailures: 99 }), { global: true, config: disabled });
    expect(t.next).toBe('CLOSED');
    expect(t.justOpened).toBe(false);
  });
});

describe('onSuccess — recovery (requirement 6)', () => {
  it('clears the counter from CLOSED', () => {
    const t = onSuccess(snap({ consecutiveFailures: 2 }));
    expect(t.next).toBe('CLOSED');
    expect(t.consecutiveFailures).toBe(0);
    expect(t.justClosed).toBe(false);
  });

  it('closes an OPEN circuit and reports the edge', () => {
    const t = onSuccess(snap({ state: 'OPEN', consecutiveFailures: 5, reopenAfter: at(5) }));
    expect(t.next).toBe('CLOSED');
    expect(t.consecutiveFailures).toBe(0);
    expect(t.justClosed).toBe(true);
    expect(t.reopenAfter).toBeNull();
  });

  it('closes from HALF_OPEN after a successful probe', () => {
    const t = onSuccess(snap({ state: 'HALF_OPEN', consecutiveFailures: 3 }));
    expect(t.next).toBe('CLOSED');
    expect(t.justClosed).toBe(true);
  });

  it('handles a first-ever success with no prior row', () => {
    const t = onSuccess(null);
    expect(t.next).toBe('CLOSED');
    expect(t.justClosed).toBe(false);
  });
});

describe('decide — admission', () => {
  it('allows everything while closed', () => {
    expect(decide(snap(), config, at(0))).toEqual({ allow: true, probe: false });
    expect(decide(null, config, at(0))).toEqual({ allow: true, probe: false });
  });

  it('refuses while open and inside the window', () => {
    const d = decide(snap({ state: 'OPEN', reopenAfter: at(5) }), config, at(1));
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.retryAt).toEqual(at(5));
  });

  it('admits exactly one probe once the window elapses', () => {
    const d = decide(snap({ state: 'OPEN', reopenAfter: at(5) }), config, at(5));
    expect(d).toEqual({ allow: true, probe: true });
  });

  it('allows everything when disabled, whatever the stored state', () => {
    const disabled = { ...config, enabled: false };
    const d = decide(snap({ state: 'OPEN', reopenAfter: at(99) }), disabled, at(0));
    expect(d.allow).toBe(true);
  });

  it('admits a probe when open with no window recorded', () => {
    // Defensive: a row without reopen_after must not wedge shut forever.
    const d = decide(snap({ state: 'OPEN', reopenAfter: null }), config, at(0));
    expect(d.allow).toBe(true);
  });
});

describe('failed probe re-opens with a fresh window', () => {
  it('does not retry immediately after a probe fails', () => {
    const halfOpen = snap({ state: 'HALF_OPEN', consecutiveFailures: 3, reopenAfter: at(5) });
    const t = onFailure(halfOpen, { global: true, config, now: at(5) });

    expect(t.next).toBe('OPEN');
    expect(t.justOpened).toBe(false);
    expect(t.reopenAfter!.getTime()).toBe(at(5).getTime() + config.openDurationMs);
    expect(t.reopenAfter!.getTime()).toBeGreaterThan(at(5).getTime());
  });
});

describe('the defect this phase fixes', () => {
  it('caps failed attempts at the threshold instead of one per evaluation', () => {
    // Phase 6 measured 5 evaluations -> 5 failed sends. With the breaker, the
    // 4th and 5th are refused before any delivery is attempted.
    let state: CircuitSnapshot | null = null;
    let attempted = 0;

    for (let evaluation = 1; evaluation <= 5; evaluation += 1) {
      const verdict = decide(state, config, at(0));
      if (!verdict.allow) continue;
      attempted += 1;
      const t = onFailure(state, { global: true, config, now: at(0) });
      state = snap({
        state: t.next,
        consecutiveFailures: t.consecutiveFailures,
        reopenAfter: t.reopenAfter,
      });
    }

    expect(attempted).toBe(3);
    expect(state!.state).toBe('OPEN');
  });
});
