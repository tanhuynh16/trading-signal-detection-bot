/**
 * Spec §3: the system must distinguish discovery time, event/block time,
 * snapshot time, signal time and outcome time. Nothing here collapses them —
 * these are only conversion and window helpers.
 */
export const SECOND_MS = 1_000;
export const MINUTE_MS = 60 * SECOND_MS;
export const HOUR_MS = 60 * MINUTE_MS;

/** Solidity block timestamps are unix seconds. */
export function fromUnixSeconds(seconds: bigint | number): Date {
  return new Date(Number(seconds) * 1000);
}

export function toUnixSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

/** Spec §13 snapshot offsets, in milliseconds from discovery time. */
export const SNAPSHOT_OFFSETS_MS = [
  0,
  30 * SECOND_MS,
  1 * MINUTE_MS,
  2 * MINUTE_MS,
  5 * MINUTE_MS,
  10 * MINUTE_MS,
  30 * MINUTE_MS,
  1 * HOUR_MS,
] as const;

/** Spec §21 outcome horizons, in milliseconds from signal time. */
export const OUTCOME_HORIZONS_MS = [
  1 * MINUTE_MS,
  5 * MINUTE_MS,
  15 * MINUTE_MS,
  30 * MINUTE_MS,
  1 * HOUR_MS,
  4 * HOUR_MS,
  24 * HOUR_MS,
] as const;

/** Stable label used in job IDs and the signal_outcomes.horizon column. */
export function offsetLabel(ms: number): string {
  if (ms === 0) return 'T0';
  if (ms % HOUR_MS === 0) return `${ms / HOUR_MS}h`;
  if (ms % MINUTE_MS === 0) return `${ms / MINUTE_MS}m`;
  return `${ms / SECOND_MS}s`;
}

export function ageMinutes(from: Date, now: Date = new Date()): number {
  return (now.getTime() - from.getTime()) / MINUTE_MS;
}
