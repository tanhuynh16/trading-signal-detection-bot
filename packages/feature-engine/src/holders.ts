import type { FeatureValue } from '@sdb/domain';

/**
 * Spec §15.3 holder-quality features, computed over `holder_balances` as
 * maintained by the Transfer indexer.
 */

export type HolderBalance = {
  wallet: string;
  /** uint256 balance. Kept as bigint — a float loses large supplies (G4). */
  balanceRaw: bigint;
  firstAcquiredAt: Date;
};

export type HolderOptions = {
  /**
   * §15.3: "Dust threshold must be configuration-driven." Expressed in raw
   * token units so it needs no price and works for any decimals.
   */
  dustThresholdRaw: bigint;
  /**
   * §15.3: top-10 concentration is "adjusted to exclude known LP/burn addresses
   * where configured". Without this the pool itself is the largest holder of
   * every new token and concentration reads ~100% for all of them — the metric
   * would carry no information at all.
   */
  excludedAddresses: ReadonlySet<string>;
};

function eligible(
  balances: readonly HolderBalance[],
  options: HolderOptions,
): HolderBalance[] {
  return balances.filter(
    (b) =>
      b.balanceRaw > options.dustThresholdRaw &&
      !options.excludedAddresses.has(b.wallet.toLowerCase()),
  );
}

/** §15.3: current number of non-zero (non-dust) holders. */
export function holderCount(
  balances: readonly HolderBalance[],
  options: HolderOptions,
): FeatureValue {
  return eligible(balances, options).length;
}

/**
 * §15.3: (holders_now - holders_previous) / elapsed_minutes.
 *
 * Null without a previous observation — the first calculation for a token has
 * no rate, and reporting 0 would claim the holder base is flat when we simply
 * have not watched it yet.
 */
export function holderGrowthRate(
  holdersNow: number | null,
  holdersPrevious: number | null,
  elapsedMinutes: number,
): FeatureValue {
  if (holdersNow === null || holdersPrevious === null) return null;
  if (elapsedMinutes <= 0) return null;
  return (holdersNow - holdersPrevious) / elapsedMinutes;
}

/**
 * §15.3: sum of the top 10 balances / total supply.
 *
 * Returned as a fraction in 0..1. Null when supply is unknown — dividing by a
 * defaulted zero would yield Infinity, and by a defaulted one, nonsense.
 */
export function top10Concentration(
  balances: readonly HolderBalance[],
  totalSupplyRaw: bigint | null,
  options: HolderOptions,
): FeatureValue {
  if (totalSupplyRaw === null || totalSupplyRaw <= 0n) return null;

  const ranked = eligible(balances, options)
    .slice()
    .sort((a, b) => (b.balanceRaw > a.balanceRaw ? 1 : b.balanceRaw < a.balanceRaw ? -1 : 0));
  if (ranked.length === 0) return null;

  const top = ranked.slice(0, 10).reduce((sum, b) => sum + b.balanceRaw, 0n);

  // Ratio of two uint256 values. Scale before dividing so the fraction is not
  // truncated to 0 by integer division.
  const scaled = (top * 1_000_000n) / totalSupplyRaw;
  return Number(scaled) / 1_000_000;
}

/**
 * §15.3 holder retention: of the wallets that acquired before a horizon, what
 * fraction still hold a non-dust balance?
 *
 * The cohort is defined by `first_acquired_at`, and "still holding" is read from
 * the current balance. Null when the cohort is empty — a retention rate over
 * zero holders is undefined, not 0% and not 100%.
 */
export function holderRetention(
  balances: readonly HolderBalance[],
  input: { cohortBefore: Date; options: HolderOptions },
): FeatureValue {
  const cohort = balances.filter(
    (b) =>
      b.firstAcquiredAt <= input.cohortBefore &&
      !input.options.excludedAddresses.has(b.wallet.toLowerCase()),
  );
  if (cohort.length === 0) return null;

  const retained = cohort.filter((b) => b.balanceRaw > input.options.dustThresholdRaw).length;
  return retained / cohort.length;
}
