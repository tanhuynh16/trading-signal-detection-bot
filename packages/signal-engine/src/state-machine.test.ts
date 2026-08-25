import { describe, expect, it } from 'vitest';
import type { SignalState } from '@sdb/domain';
import { alertLevelFor, isActive, nextState, type TransitionInput } from './state-machine.js';

const config = {
  interestingThreshold: 60,
  strongThreshold: 75,
  downgradePolicyEnabled: false,
  maxTokenAgeMinutes: 360,
  inactiveExpiryMinutes: 30,
  liquidityCollapseFraction: 0.2,
};

const input = (over: Partial<TransitionInput> = {}): TransitionInput => ({
  currentState: 'WATCHING',
  alphaScore: 50,
  hasSufficientCoverage: true,
  riskStatus: 'PASS',
  ageMinutes: 10,
  minutesSinceLastTrade: 1,
  liquidityUsd: 50_000,
  peakLiquidityUsd: 60_000,
  ...over,
});

describe('§18 upgrades', () => {
  it('moves NEW to WATCHING once risk clears, regardless of score', () => {
    // §18 gates this on risk + discovery requirements, not on alpha. A token
    // must be watched before it can be scored meaningfully.
    const result = nextState(input({ currentState: 'NEW', alphaScore: 0 }), config);
    expect(result.state).toBe('WATCHING');
    expect(result.changed).toBe(true);
  });

  it('moves NEW to WATCHING on a risk WARNING too', () => {
    expect(nextState(input({ currentState: 'NEW', riskStatus: 'WARNING' }), config).state).toBe(
      'WATCHING',
    );
  });

  it('upgrades WATCHING to INTERESTING at the threshold', () => {
    expect(nextState(input({ alphaScore: 60 }), config).state).toBe('INTERESTING');
  });

  it('holds at WATCHING one point below the threshold', () => {
    expect(nextState(input({ alphaScore: 59.9 }), config).state).toBe('WATCHING');
  });

  it('upgrades INTERESTING to STRONG_SIGNAL at the threshold', () => {
    const result = nextState(input({ currentState: 'INTERESTING', alphaScore: 75 }), config);
    expect(result.state).toBe('STRONG_SIGNAL');
  });

  it('holds at INTERESTING one point below strong', () => {
    expect(
      nextState(input({ currentState: 'INTERESTING', alphaScore: 74.9 }), config).state,
    ).toBe('INTERESTING');
  });

  it('can skip a level when the score jumps', () => {
    // A token can go straight from WATCHING to STRONG_SIGNAL.
    expect(nextState(input({ alphaScore: 90 }), config).state).toBe('STRONG_SIGNAL');
  });

  it('caps a high score at INTERESTING when coverage is thin', () => {
    // 95 on a quarter of the picture is not high conviction (§17 bands assume
    // a full assessment).
    const result = nextState(input({ alphaScore: 95, hasSufficientCoverage: false }), config);
    expect(result.state).toBe('INTERESTING');
  });

  it('leaves a low-scoring token in WATCHING — §18 has no Ignore state', () => {
    const result = nextState(input({ alphaScore: 5 }), config);
    expect(result.state).toBe('WATCHING');
    expect(result.changed).toBe(false);
  });
});

describe('§18 no downgrade by default', () => {
  it('keeps STRONG_SIGNAL when the score falls back', () => {
    const result = nextState(input({ currentState: 'STRONG_SIGNAL', alphaScore: 10 }), config);
    expect(result.state).toBe('STRONG_SIGNAL');
    expect(result.changed).toBe(false);
  });

  it('keeps INTERESTING when the score falls back', () => {
    expect(
      nextState(input({ currentState: 'INTERESTING', alphaScore: 20 }), config).state,
    ).toBe('INTERESTING');
  });

  it('downgrades only when the policy is enabled', () => {
    const enabled = { ...config, downgradePolicyEnabled: true };
    const result = nextState(input({ currentState: 'STRONG_SIGNAL', alphaScore: 10 }), enabled);
    expect(result.state).toBe('WATCHING');
    expect(result.reason).toBe('downgrade_policy');
  });
});

describe('§18 expiry', () => {
  const states: SignalState[] = ['NEW', 'WATCHING', 'INTERESTING', 'STRONG_SIGNAL'];

  it('expires from EVERY active state on risk FAIL', () => {
    // §27: a risk FAIL must prevent alpha alerting entirely.
    for (const state of states) {
      const result = nextState(input({ currentState: state, riskStatus: 'FAIL' }), config);
      expect(result.state).toBe('EXPIRED');
      expect(result.reason).toBe('risk_fail');
    }
  });

  it('risk FAIL overrides a maximal score', () => {
    const result = nextState(input({ alphaScore: 100, riskStatus: 'FAIL' }), config);
    expect(result.state).toBe('EXPIRED');
  });

  it('expires past the age limit', () => {
    expect(nextState(input({ ageMinutes: 361 }), config).reason).toBe('age_limit');
  });

  it('expires on inactivity', () => {
    expect(nextState(input({ minutesSinceLastTrade: 31 }), config).reason).toBe('inactivity');
  });

  it('does not expire for inactivity when no trade time is known', () => {
    // Null is unknown, not stale — the same discipline features follow.
    expect(nextState(input({ minutesSinceLastTrade: null }), config).state).not.toBe('EXPIRED');
  });

  it('expires on liquidity collapse relative to its own peak', () => {
    const result = nextState(
      input({ liquidityUsd: 5_000, peakLiquidityUsd: 100_000 }),
      config,
    );
    expect(result.reason).toBe('liquidity_collapse');
  });

  it('does not expire on a modest liquidity dip', () => {
    expect(
      nextState(input({ liquidityUsd: 50_000, peakLiquidityUsd: 100_000 }), config).state,
    ).not.toBe('EXPIRED');
  });

  it('treats EXPIRED as terminal', () => {
    // No path back: resurrecting a token whose liquidity collapsed would
    // re-alert on a corpse.
    const result = nextState(input({ currentState: 'EXPIRED', alphaScore: 100 }), config);
    expect(result.state).toBe('EXPIRED');
    expect(result.changed).toBe(false);
  });
});

describe('determinism (spec §27)', () => {
  it('produces identical transitions for identical inputs', () => {
    const i = input({ alphaScore: 77 });
    expect(nextState(i, config)).toEqual(nextState(i, config));
  });
});

describe('alertLevelFor', () => {
  it('maps states to alert levels', () => {
    expect(alertLevelFor('STRONG_SIGNAL')).toBe('STRONG');
    expect(alertLevelFor('INTERESTING')).toBe('INTERESTING');
    expect(alertLevelFor('WATCHING')).toBe('NONE');
    expect(alertLevelFor('NEW')).toBe('NONE');
    expect(alertLevelFor('EXPIRED')).toBe('NONE');
  });

  it('knows which states are active', () => {
    expect(isActive('STRONG_SIGNAL')).toBe(true);
    expect(isActive('EXPIRED')).toBe(false);
  });
});
