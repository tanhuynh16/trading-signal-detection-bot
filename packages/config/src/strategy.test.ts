import { describe, expect, it } from 'vitest';
import { ConfigurationError } from '@sdb/shared';
import { BASE_MEME_V1, getStrategyConfig, parseStrategyConfig } from './strategy.js';

const valid = structuredClone(BASE_MEME_V1) as unknown as Record<string, unknown>;

function withScoring(overrides: Record<string, unknown>) {
  const base = structuredClone(BASE_MEME_V1);
  return { ...base, scoring: { ...base.scoring, ...overrides } };
}

describe('strategy config', () => {
  it('accepts the spec §19 defaults', () => {
    const config = parseStrategyConfig(valid);
    expect(config.strategyVersion).toBe('base-meme-v1');
    expect(config.scoring.interestingThreshold).toBe(60);
    expect(config.scoring.strongThreshold).toBe(75);
  });

  it('defaults to coverage renormalization (plan G1)', () => {
    expect(BASE_MEME_V1.scoring.nullPolicy).toBe('renormalize');
    expect(BASE_MEME_V1.scoring.minCoverage).toBe(0.6);
  });

  it('rejects weights that do not sum to 1', () => {
    expect(() =>
      parseStrategyConfig(
        withScoring({ weights: { liquidity: 0.5, momentum: 0.5, holder: 0.5, smartMoney: 0.5 } }),
      ),
    ).toThrow(ConfigurationError);
  });

  it('rejects a strong threshold at or below the interesting threshold', () => {
    expect(() =>
      parseStrategyConfig(withScoring({ interestingThreshold: 80, strongThreshold: 75 })),
    ).toThrow(/strongThreshold/);
  });

  it('reports every validation problem, not just the first', () => {
    let message = '';
    try {
      parseStrategyConfig({ strategyVersion: 'x' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message.split('\n').length).toBeGreaterThan(2);
  });

  it('refuses an unknown strategy version rather than falling back', () => {
    expect(() => getStrategyConfig('does-not-exist')).toThrow(ConfigurationError);
  });
});
