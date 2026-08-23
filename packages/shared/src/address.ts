/**
 * Spec §11: token/pool addresses are persisted in one canonical representation
 * consistently. This project stores lowercase everywhere and checksums only at
 * display time (Telegram messages, API responses).
 */
export type Address = `0x${string}`;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;

/** A 32-byte hash: transaction or block. Distinct from a 20-byte Address. */
export type Hash = `0x${string}`;

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

/**
 * Canonical form for 32-byte hashes. Kept separate from `canonicalize` because
 * feeding a tx hash to the address validator is a real and easy mistake — it
 * passes type-checking (both are `0x${string}`) and fails only at runtime.
 */
export function canonicalizeHash(value: string): Hash {
  const trimmed = value.trim();
  if (!HASH_RE.test(trimmed)) {
    throw new TypeError(`not a 32-byte hash: ${value}`);
  }
  return trimmed.toLowerCase() as Hash;
}

export function isHash(value: string): value is Hash {
  return HASH_RE.test(value);
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
