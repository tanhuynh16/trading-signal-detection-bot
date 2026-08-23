/**
 * Spec §11: token/pool addresses are persisted in one canonical representation
 * consistently. This project stores lowercase everywhere and checksums only at
 * display time (Telegram messages, API responses).
 */
export type Address = `0x${string}`;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export function isAddress(value: string): value is Address {
  return ADDRESS_RE.test(value);
}

/** Canonical storage form. Throws rather than silently persisting garbage. */
export function canonicalize(value: string): Address {
  const trimmed = value.trim();
  if (!ADDRESS_RE.test(trimmed)) {
    throw new TypeError(`not an address: ${value}`);
  }
  return trimmed.toLowerCase() as Address;
}

export function equalsAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** Display-only shortening for alerts: 0x1234…abcd */
export function shortenAddress(value: string, lead = 6, tail = 4): string {
  return value.length <= lead + tail ? value : `${value.slice(0, lead)}…${value.slice(-tail)}`;
}

export const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000';
/** Common burn sink; excluded from holder/concentration math per spec §15.3. */
export const DEAD_ADDRESS: Address = '0x000000000000000000000000000000000000dead';
