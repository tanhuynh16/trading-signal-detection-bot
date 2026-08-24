import type { FeatureValue } from '@sdb/domain';
import { independentCount, type Cluster } from './clustering.js';

/**
 * Spec §15.5 smart-money features.
 *
 * MVP uses a manually seeded wallet list; autonomous discovery is deferred.
 * The list currently ships EMPTY, so every feature here returns null — which is
 * the correct outcome, not a gap: plan G1's coverage renormalisation divides the
 * alpha score by the weight actually present rather than scoring the missing
 * component zero. Scoring it zero is precisely the failure G1 exists to prevent,
 * since smart money carries 0.30 of the weight and would cap every token near 70.
 */

export type SmartWallet = {
  address: string;
  /** 0..100, from `walletAlphaScore`. Null until performance data exists. */
  alphaScore: number | null;
};

/** Component scores, each 0..100. §15.5's formula weights these. */
export type WalletPerformance = {
  historicalRoiScore: number;
  winRateScore: number;
  consistencyScore: number;
  earlyEntryAccuracyScore: number;
  recentPerformanceScore: number;
};

/**
 * §15.5's weights, verbatim:
 *
 *   0.20 * historical_roi + 0.15 * win_rate + 0.20 * consistency
 * + 0.25 * early_entry_accuracy + 0.20 * recent_performance
 *
 * The spec calls this "an initial hypothesis" and requires scores be versioned
 * and recalculable without losing historical values — hence
 * `wallets.alpha_score_version` alongside the value.
 */
export const WALLET_ALPHA_WEIGHTS = {
  historicalRoiScore: 0.2,
  winRateScore: 0.15,
  consistencyScore: 0.2,
  earlyEntryAccuracyScore: 0.25,
  recentPerformanceScore: 0.2,
} as const;

export const WALLET_ALPHA_VERSION = 'wallet-alpha-v1';

export function walletAlphaScore(performance: WalletPerformance): number {
  let total = 0;
  for (const [key, weight] of Object.entries(WALLET_ALPHA_WEIGHTS)) {
    const value = performance[key as keyof WalletPerformance];
    total += clamp01(value / 100) * weight;
  }
  return total * 100;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** A smart wallet's observed entry into the token being scored. */
export type SmartEntry = { wallet: string; enteredAt: Date };

/**
 * §15.5: count of smart wallets *after clustering related wallets*.
 *
 * The clustering step is the whole point. Ten wallets funded by one source is
 * one actor; counting them as ten is how a manufactured launch passes for
 * organic interest.
 *
 * Null when no smart wallets are configured at all — that is "we cannot
 * measure this", not "no smart money is present".
 */
export function independentSmartWalletCount(
  entries: readonly SmartEntry[],
  clusters: readonly Cluster[],
  seededWalletCount: number,
): FeatureValue {
  if (seededWalletCount === 0) return null;
  if (entries.length === 0) return 0;
  return independentCount(
    entries.map((e) => e.wallet),
    clusters,
  );
}

/**
 * §15.5: how recently smart wallets entered, in minutes since the most recent
 * entry. Lower is fresher.
 */
export function smartWalletEntryRecency(
  entries: readonly SmartEntry[],
  now: Date,
  seededWalletCount: number,
): FeatureValue {
  if (seededWalletCount === 0) return null;
  if (entries.length === 0) return null;

  const latest = entries.reduce(
    (max, entry) => (entry.enteredAt > max ? entry.enteredAt : max),
    entries[0]!.enteredAt,
  );
  return (now.getTime() - latest.getTime()) / 60_000;
}

/**
 * §15.5: "aggregate of wallet alpha scores".
 *
 * Mean of the entrants' scores, ignoring wallets with no score yet. Null when
 * nothing is scorable — an unscored wallet contributes no information, and
 * treating it as 0 would penalise a token for our own missing data.
 */
export function smartWalletQuality(
  entries: readonly SmartEntry[],
  scores: ReadonlyMap<string, number | null>,
  seededWalletCount: number,
): FeatureValue {
  if (seededWalletCount === 0) return null;

  const values = entries
    .map((entry) => scores.get(entry.wallet.toLowerCase()))
    .filter((value): value is number => value !== null && value !== undefined);

  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
