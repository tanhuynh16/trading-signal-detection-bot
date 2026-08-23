import { describe, expect, it } from 'vitest';
import { AERODROME_FACTORY, FACTORIES, UNISWAP_V2_FACTORY, UNISWAP_V3_FACTORY } from './factories.js';
import fixtures from './__fixtures__/factory-logs.json' with { type: 'json' };

/**
 * These are regression pins, not decoration. A wrong factory address or a
 * mistyped event signature produces a filter that matches nothing, and the
 * worker then runs cleanly forever while discovering zero pools — the failure
 * mode §29 warns about. Each expectation below is cross-checked against a log
 * captured from Base mainnet (see __fixtures__/factory-logs.json).
 */
describe('factory definitions', () => {
  it('pins addresses to the values published by each protocol', () => {
    expect(UNISWAP_V2_FACTORY.address).toBe('0x8909dc15e40173ff4699343b6eb8132c65e18ec6');
    expect(UNISWAP_V3_FACTORY.address).toBe('0x33128a8fc17869897dce68ed026d694621f6fdfd');
    expect(AERODROME_FACTORY.address).toBe('0x420dd381b31aef6683db6b902084cb0ffece40da');
  });

  it('stores addresses lowercase, per spec §11 canonical form', () => {
    for (const factory of FACTORIES) {
      expect(factory.address).toBe(factory.address.toLowerCase());
    }
  });

  it('derives event selectors that match logs emitted on Base', () => {
    expect(UNISWAP_V2_FACTORY.topic0).toBe(fixtures['uniswap-v2'].topics[0]);
    expect(UNISWAP_V3_FACTORY.topic0).toBe(fixtures['uniswap-v3'].topics[0]);
    expect(AERODROME_FACTORY.topic0).toBe(fixtures['aerodrome'].topics[0]);
  });

  it('targets the factory that actually emitted each captured log', () => {
    expect(fixtures['uniswap-v2'].address.toLowerCase()).toBe(UNISWAP_V2_FACTORY.address);
    expect(fixtures['uniswap-v3'].address.toLowerCase()).toBe(UNISWAP_V3_FACTORY.address);
    expect(fixtures['aerodrome'].address.toLowerCase()).toBe(AERODROME_FACTORY.address);
  });

  it('keeps every source key unique — it is the discovery_cursors primary key', () => {
    const sources = FACTORIES.map((f) => f.source);
    expect(new Set(sources).size).toBe(sources.length);
  });

  it('records provenance beside every address', () => {
    for (const factory of FACTORIES) {
      expect(factory.provenance.length).toBeGreaterThan(10);
    }
  });
});
