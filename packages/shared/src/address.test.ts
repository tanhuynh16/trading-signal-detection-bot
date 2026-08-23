import { describe, expect, it } from 'vitest';
import { canonicalize, equalsAddress, isAddress, shortenAddress } from './address.js';

const CHECKSUMMED = '0x4200000000000000000000000000000000000006';

describe('address', () => {
  it('canonicalizes to lowercase (spec §11: one storage form)', () => {
    expect(canonicalize('0xABCdef0000000000000000000000000000000001')).toBe(
      '0xabcdef0000000000000000000000000000000001',
    );
  });

  it('throws on malformed input rather than persisting garbage', () => {
    expect(() => canonicalize('0x123')).toThrow(TypeError);
    expect(() => canonicalize('not-an-address')).toThrow(TypeError);
  });

  it('compares case-insensitively', () => {
    expect(equalsAddress(CHECKSUMMED, CHECKSUMMED.toUpperCase().replace('0X', '0x'))).toBe(true);
  });

  it('validates', () => {
    expect(isAddress(CHECKSUMMED)).toBe(true);
    expect(isAddress('0xzz')).toBe(false);
  });

  it('shortens for display only', () => {
    expect(shortenAddress(CHECKSUMMED)).toBe('0x4200…0006');
  });
});
