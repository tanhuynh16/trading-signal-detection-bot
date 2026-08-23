import { describe, expect, it } from 'vitest';
import { div, formatScaled, fromRaw, mul, parseScaled, SCALE } from './decimal.js';

describe('decimal', () => {
  it('round-trips decimal strings without float error', () => {
    const value = '12345678901234.123456789012345678';
    expect(formatScaled(parseScaled(value))).toBe(value);
  });

  it('preserves precision beyond 2^53, where floats fail', () => {
    const huge = '9007199254740993'; // 2^53 + 1
    expect(formatScaled(parseScaled(huge))).toBe(huge);
    expect(String(Number(huge))).not.toBe(huge); // proves the float would lose it
  });

  it('truncates rather than inventing precision', () => {
    const tooPrecise = '1.1234567890123456789';
    expect(formatScaled(parseScaled(tooPrecise))).toBe('1.123456789012345678');
  });

  it('rejects non-numeric input instead of coercing', () => {
    expect(() => parseScaled('12abc')).toThrow(TypeError);
    expect(() => parseScaled('')).toThrow(TypeError);
  });

  it('handles negatives', () => {
    expect(formatScaled(parseScaled('-0.5'))).toBe('-0.5');
  });

  it('scales raw token amounts by decimals in both directions', () => {
    expect(formatScaled(fromRaw(1_000_000n, 6))).toBe('1'); // USDC
    expect(formatScaled(fromRaw(10n ** 18n, 18))).toBe('1'); // WETH
  });

  it('multiplies and divides in fixed point', () => {
    expect(formatScaled(mul(parseScaled('1.5'), parseScaled('4')))).toBe('6');
    expect(formatScaled(div(parseScaled('1'), parseScaled('4'))!)).toBe('0.25');
  });

  it('returns null on divide-by-zero rather than Infinity', () => {
    expect(div(parseScaled('1'), 0n)).toBeNull();
  });

  it('uses an 18-place scale', () => {
    expect(SCALE).toBe(18);
  });
});
