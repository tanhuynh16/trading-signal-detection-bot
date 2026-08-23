/**
 * Plan G4: money and token amounts never touch IEEE floats.
 *
 * Postgres stores prices/USD as numeric(38,18) and raw uint256 token amounts as
 * numeric(78,0); the pg driver hands both back as strings. These helpers move
 * between those strings, bigint raw amounts, and a fixed-point representation.
 *
 * Convention: a "scaled" value is a bigint carrying SCALE decimal places.
 */
export const SCALE = 18;
export const ONE = 10n ** BigInt(SCALE);

function pow10(n: number): bigint {
  return 10n ** BigInt(n);
}

/** Parse a decimal string ("1234.5678") into a scaled bigint. Throws on junk. */
export function parseScaled(value: string, scale: number = SCALE): bigint {
  const trimmed = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new TypeError(`not a decimal string: ${value}`);
  }
  const negative = trimmed.startsWith('-');
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [whole = '0', fraction = ''] = unsigned.split('.');
  // Truncate rather than round: we never want to invent precision we lack.
  const padded = (fraction + '0'.repeat(scale)).slice(0, scale);
  const result = BigInt(whole) * pow10(scale) + BigInt(padded || '0');
  return negative ? -result : result;
}

/** Render a scaled bigint back to a decimal string suitable for numeric(38,18). */
export function formatScaled(value: bigint, scale: number = SCALE): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const divisor = pow10(scale);
  const whole = abs / divisor;
  const fraction = (abs % divisor).toString().padStart(scale, '0').replace(/0+$/, '');
  const body = fraction.length > 0 ? `${whole}.${fraction}` : whole.toString();
  return negative ? `-${body}` : body;
}

/** Convert a raw on-chain amount with `decimals` into a scaled bigint. */
export function fromRaw(raw: bigint, decimals: number): bigint {
  if (decimals === SCALE) return raw;
  return decimals < SCALE ? raw * pow10(SCALE - decimals) : raw / pow10(decimals - SCALE);
}

export function mul(a: bigint, b: bigint): bigint {
  return (a * b) / ONE;
}

/**
 * Division guarded against a zero denominator. The spec's formulas repeatedly
 * use max(x, epsilon); callers pass the epsilon explicitly so the guard value
 * stays configuration-visible rather than hidden in here.
 */
export function div(a: bigint, b: bigint): bigint | null {
  if (b === 0n) return null;
  return (a * ONE) / b;
}

/**
 * Escape hatch to JS number for scoring/normalization only, where values are
 * bounded ratios in the 0..100 range and float error is irrelevant. Never use
 * this on token amounts or market caps.
 */
export function toNumber(value: bigint, scale: number = SCALE): number {
  return Number(formatScaled(value, scale));
}
