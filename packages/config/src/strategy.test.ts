import { describe, expect, it } from 'vitest';
import { ConfigurationError } from '@sdb/shared';
import {
  BASE_MEME_V1,
  BASE_MEME_V2,
  SMART_MONEY_SEED_WALLETS_V2,
  getStrategyConfig,
  parseStrategyConfig,
} from './strategy.js';

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

describe('base-meme-v2 smart-money seeding (§15.5, §22)', () => {
  it('leaves base-meme-v1 unseeded', () => {
    // §22 in test form. v1 labels 1,242 recorded signals whose smartMoney
    // component is null and whose coverage is 0.50 or 0.70. Seeding wallets
    // into it would leave past and future rows sharing one strategy_version
    // while meaning different things, which is exactly what
    // registerStrategyConfig refuses at runtime.
    expect(BASE_MEME_V1.smartMoney.seedWallets).toEqual([]);
  });

  it('registers both versions so historical rows still resolve', () => {
    expect(getStrategyConfig('base-meme-v1').smartMoney.seedWallets).toEqual([]);
    expect(getStrategyConfig('base-meme-v2').smartMoney.seedWallets).toHaveLength(58);
  });

  it('carries a clean seed list', () => {
    expect(SMART_MONEY_SEED_WALLETS_V2).toHaveLength(58);
    for (const wallet of SMART_MONEY_SEED_WALLETS_V2) {
      expect(wallet).toMatch(/^0x[0-9a-f]{40}$/);
    }
    // A duplicate would silently double-count one actor as two in
    // independentSmartWalletCount, which is the number §15.5 clusters to avoid.
    expect(new Set(SMART_MONEY_SEED_WALLETS_V2).size).toBe(
      SMART_MONEY_SEED_WALLETS_V2.length,
    );
  });

  it('differs from v1 only in version and seed list', () => {
    const { strategyVersion: _v1, smartMoney: _s1, ...restV1 } = BASE_MEME_V1;
    const { strategyVersion: _v2, smartMoney: _s2, ...restV2 } = BASE_MEME_V2;
    expect(restV2).toEqual(restV1);
    expect(BASE_MEME_V2.smartMoney.minIndependentWallets).toBe(
      BASE_MEME_V1.smartMoney.minIndependentWallets,
    );
  });

  it('is not the default — switching to it is an explicit .env change', () => {
    // Seeding lowers every score whose pools no seed wallet touched, so v2 must
    // not become active merely by existing. See the constant's own comment for
    // the replayed numbers.
    expect(BASE_MEME_V1.strategyVersion).toBe('base-meme-v1');
  });
});
