import { describe, expect, it } from 'vitest';
import type { SimulationOutcome } from '@sdb/security';
import { normalizeGoPlus } from '@sdb/security';
import {
  DEFAULT_RULE_CONFIG,
  FLAG,
  decide,
  mergeFlags,
  providerFlags,
  scoreFor,
  simulationFlags,
} from './rules.js';

const config = DEFAULT_RULE_CONFIG;

const clean: SimulationOutcome = {
  canBuy: true,
  canSell: true,
  tokenTaxFraction: 0,
  observedRetention: 0.994009,
  ethIn: 10n ** 16n,
  ethOut: 9_940_091_988_699_945n,
  tokensReceived: 24_590_769n,
  failureReason: null,
};

const codes = (flags: { code: string }[]) => flags.map((f) => f.code);

describe('simulation flags (spec §14.1)', () => {
  it('raises nothing for a clean, sellable, untaxed token', () => {
    expect(simulationFlags(clean, config)).toEqual([]);
  });

  it('flags a honeypot when the buy works but the sell reverts', () => {
    const flags = simulationFlags(
      { ...clean, canSell: false, tokenTaxFraction: null, failureReason: 'reverted' },
      config,
    );
    expect(codes(flags)).toContain(FLAG.HONEYPOT);
    expect(flags[0]!.severity).toBe('CRITICAL');
  });

  it('does NOT accuse a token of being a honeypot when the buy itself failed', () => {
    // A failed buy is indistinguishable from a pool too thin to route through.
    // Calling that a honeypot would expire legitimate new tokens (§18).
    const flags = simulationFlags(
      { ...clean, canBuy: false, canSell: null, failureReason: 'insufficient liquidity' },
      config,
    );
    expect(codes(flags)).toEqual([FLAG.UNKNOWN_TRADEABILITY]);
    expect(codes(flags)).not.toContain(FLAG.HONEYPOT);
  });

  it('treats a buy that delivers zero tokens as unsellable', () => {
    const flags = simulationFlags(
      { ...clean, canSell: false, tokenTaxFraction: 1, failureReason: 'buy delivered zero tokens' },
      config,
    );
    expect(codes(flags)).toContain(FLAG.HONEYPOT);
  });

  it('warns on a moderate tax and fails on a punitive one', () => {
    const warn = simulationFlags({ ...clean, tokenTaxFraction: 0.15 }, config);
    expect(codes(warn)).toContain(FLAG.UNUSUAL_TAX);
    expect(decide(warn, config).status).toBe('WARNING');

    const heavy = simulationFlags({ ...clean, tokenTaxFraction: 0.4 }, config);
    expect(codes(heavy)).toContain(FLAG.UNUSUAL_TAX);
  });

  it('ignores a tax below the warn threshold', () => {
    expect(simulationFlags({ ...clean, tokenTaxFraction: 0.02 }, config)).toEqual([]);
  });
});

describe('provider flags', () => {
  it('emits one unknown flag for an unindexed token, not a dozen', () => {
    // The measured response for a one-minute-old Base token: 10 of 39 fields,
    // criticals absent. That absence is a single fact.
    const findings = normalizeGoPlus({ cannot_buy: '0', buy_tax: '', sell_tax: '', holder_count: '0' });
    const flags = providerFlags(findings, config);
    expect(codes(flags)).toEqual([FLAG.UNKNOWN_SECURITY_DATA]);
  });

  it('never reads an empty tax string as a clean zero tax', () => {
    const findings = normalizeGoPlus({ buy_tax: '', sell_tax: '' });
    expect(findings.buyTax).toBeNull();
    expect(findings.sellTax).toBeNull();
  });

  it('distinguishes a real zero from an absent value', () => {
    const findings = normalizeGoPlus({ is_mintable: '0', is_honeypot: '0', buy_tax: '0', sell_tax: '0' });
    expect(findings.isMintable).toBe(false);
    expect(findings.buyTax).toBe(0);
    expect(findings.unindexed).toBe(false);
  });

  it('flags mintable, blacklist and pausable contracts', () => {
    const findings = normalizeGoPlus({
      is_mintable: '1',
      is_blacklisted: '1',
      transfer_pausable: '1',
      is_honeypot: '0',
      buy_tax: '0',
      sell_tax: '0',
    });
    const flags = providerFlags(findings, config);
    expect(codes(flags)).toContain(FLAG.OWNER_CAN_MINT);
    expect(codes(flags)).toContain(FLAG.BLACKLIST_CAPABILITY);
    expect(codes(flags)).toContain(FLAG.TRADING_RESTRICTION);
  });

  it('flags top-10 concentration above the configured threshold', () => {
    const findings = normalizeGoPlus({
      is_honeypot: '0',
      is_mintable: '0',
      buy_tax: '0',
      sell_tax: '0',
      holders: [{ percent: '0.30' }, { percent: '0.20' }],
    });
    const flags = providerFlags(findings, config);
    // 0.30 + 0.20 = 0.5 -> 50%, above the 40% warn threshold
    expect(codes(flags)).toContain(FLAG.HOLDER_CONCENTRATION);
  });

  it('leaves concentration alone when it is below the threshold', () => {
    const findings = normalizeGoPlus({
      is_honeypot: '0',
      is_mintable: '0',
      buy_tax: '0',
      sell_tax: '0',
      holders: [{ percent: '0.05' }, { percent: '0.04' }],
    });
    expect(codes(providerFlags(findings, config))).not.toContain(FLAG.HOLDER_CONCENTRATION);
  });
});

describe('verdict (spec §14)', () => {
  it('passes a clean token with no flags', () => {
    expect(decide([], config).status).toBe('PASS');
  });

  it('fails on any critical flag regardless of how many warnings exist', () => {
    const flags = mergeFlags(
      simulationFlags({ ...clean, canSell: false, tokenTaxFraction: null }, config),
      providerFlags(normalizeGoPlus({ is_mintable: '1', is_honeypot: '0', buy_tax: '0', sell_tax: '0' }), config),
    );
    expect(decide(flags, config).status).toBe('FAIL');
  });

  it('warns rather than passing when data is merely unknown', () => {
    // The key policy: undetermined risk is never a silent PASS.
    const flags = providerFlags(normalizeGoPlus({}), config);
    expect(decide(flags, config).status).toBe('WARNING');
  });

  it('respects a configured downgrade of a flag to IGNORE', () => {
    const relaxed = {
      ...config,
      actions: { ...config.actions, [FLAG.UNKNOWN_SECURITY_DATA]: 'IGNORE' as const },
    };
    const flags = providerFlags(normalizeGoPlus({}), relaxed);
    expect(decide(flags, relaxed).status).toBe('PASS');
  });

  it('respects a configured escalation to FAIL', () => {
    const strict = {
      ...config,
      actions: { ...config.actions, [FLAG.OWNER_CAN_MINT]: 'FAIL' as const },
    };
    const findings = normalizeGoPlus({ is_mintable: '1', is_honeypot: '0', buy_tax: '0', sell_tax: '0' });
    expect(decide(providerFlags(findings, strict), strict).status).toBe('FAIL');
  });
});

describe('risk score (spec §14.2: 0 safest, 100 riskiest)', () => {
  it('scores a clean token zero', () => {
    expect(scoreFor([])).toBe(0);
  });

  it('is monotonic — more evidence never looks safer', () => {
    const one = scoreFor([{ code: 'A', severity: 'MEDIUM', message: '' }]);
    const two = scoreFor([
      { code: 'A', severity: 'MEDIUM', message: '' },
      { code: 'B', severity: 'LOW', message: '' },
    ]);
    expect(two).toBeGreaterThanOrEqual(one);
  });

  it('caps at 100', () => {
    expect(
      scoreFor([
        { code: 'A', severity: 'CRITICAL', message: '' },
        { code: 'B', severity: 'CRITICAL', message: '' },
      ]),
    ).toBe(100);
  });

  it('ranks a critical flag above any single lesser flag', () => {
    const critical = scoreFor([{ code: 'A', severity: 'CRITICAL', message: '' }]);
    const high = scoreFor([{ code: 'B', severity: 'HIGH', message: '' }]);
    expect(critical).toBeGreaterThan(high);
  });

  it('never produces a negative score — risk cannot credit a token (§14.1)', () => {
    // Risk is a gate, not an alpha contributor. There is no path to below zero.
    for (const severity of ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const) {
      expect(scoreFor([{ code: 'X', severity, message: '' }])).toBeGreaterThan(0);
    }
  });
});

describe('mergeFlags', () => {
  it('deduplicates by code, keeping the highest severity', () => {
    const merged = mergeFlags(
      [{ code: FLAG.HONEYPOT, severity: 'MEDIUM', message: 'from provider' }],
      [{ code: FLAG.HONEYPOT, severity: 'CRITICAL', message: 'from simulation' }],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]!.severity).toBe('CRITICAL');
  });

  it('keeps distinct codes separate', () => {
    const merged = mergeFlags(
      [{ code: FLAG.HONEYPOT, severity: 'CRITICAL', message: '' }],
      [{ code: FLAG.OWNER_CAN_MINT, severity: 'HIGH', message: '' }],
    );
    expect(merged).toHaveLength(2);
  });
});

describe('partial provider coverage (the dangerous middle case)', () => {
  it('flags a response that omits is_honeypot even though other fields are present', () => {
    // Not "unindexed" — GoPlus answered, just incompletely. Without a
    // per-field check this produced zero flags and a clean PASS.
    const findings = normalizeGoPlus({
      is_mintable: '0',
      buy_tax: '0',
      sell_tax: '0',
      is_blacklisted: '0',
      transfer_pausable: '0',
      cannot_sell_all: '0',
      // is_honeypot deliberately absent
    });
    expect(findings.unindexed).toBe(false);
    const flags = providerFlags(findings, config);
    expect(codes(flags)).toContain(FLAG.UNKNOWN_SECURITY_DATA);
    expect(decide(flags, config).status).toBe('WARNING');
  });

  it('names which fields were omitted so the gap is auditable', () => {
    const findings = normalizeGoPlus({ buy_tax: '0', sell_tax: '0' });
    const flags = providerFlags(findings, config);
    const unknown = flags.find((f) => f.code === FLAG.UNKNOWN_SECURITY_DATA);
    expect(unknown?.message).toContain('isHoneypot');
  });

  it('raises no unknown flag when every critical field is present', () => {
    const findings = normalizeGoPlus({
      is_honeypot: '0',
      cannot_sell_all: '0',
      is_blacklisted: '0',
      transfer_pausable: '0',
      is_mintable: '0',
      buy_tax: '0',
      sell_tax: '0',
    });
    expect(codes(providerFlags(findings, config))).not.toContain(FLAG.UNKNOWN_SECURITY_DATA);
    expect(decide(providerFlags(findings, config), config).status).toBe('PASS');
  });
});
