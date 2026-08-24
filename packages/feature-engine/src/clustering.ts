import type { FeatureValue } from '@sdb/domain';
import type { HolderBalance } from './holders.js';

/**
 * Spec §15.4 wallet clustering.
 *
 * Deterministic heuristics only — §28 forbids a graph database for MVP, and
 * these four signals need nothing more than each wallet's first inbound
 * funding. That data comes from `alchemy_getAssetTransfers`, which was
 * confirmed available on the free tier and returns `from`, `value`, `hash` and
 * a block timestamp: precisely the four fields the four heuristics need.
 *
 * The point of clustering is that ten wallets funded by one source in one
 * minute are one actor wearing ten hats. Counting them as ten independent
 * buyers is how a manufactured launch looks organic.
 */

/** First inbound native transfer for a wallet. Immutable once observed. */
export type WalletFunding = {
  wallet: string;
  /** Address that sent the first funds. */
  funder: string;
  /** Transaction that delivered them. */
  txHash: string;
  fundedAt: Date;
  /** Native amount in wei. */
  valueWei: bigint;
};

export type ClusterOptions = {
  /** §15.4: "similar_funding_time: configurable time proximity." */
  timeProximityMs: number;
  /** §15.4: "similar_funding_amount: configurable percentage tolerance." */
  amountTolerance: number;
  /** Below this many members, a grouping is not evidence of coordination. */
  minClusterSize: number;
};

export type Cluster = {
  key: string;
  wallets: string[];
  evidence: ClusterEvidence[];
};

export type ClusterEvidence =
  | { type: 'same_funder'; funder: string }
  | { type: 'same_funding_tx'; txHash: string }
  | { type: 'similar_funding_time'; windowMs: number }
  | { type: 'similar_funding_amount'; tolerance: number };

/**
 * Group wallets that share a funding source.
 *
 * Each heuristic is applied independently and the results merged, so a pair of
 * wallets funded by the same address in the same transaction produces one
 * cluster carrying both pieces of evidence rather than two clusters.
 */
export function clusterWallets(
  fundings: readonly WalletFunding[],
  options: ClusterOptions,
): Cluster[] {
  const groups = new Map<string, { wallets: Set<string>; evidence: ClusterEvidence[] }>();

  const add = (key: string, wallet: string, evidence: ClusterEvidence) => {
    let group = groups.get(key);
    if (!group) {
      group = { wallets: new Set(), evidence: [] };
      groups.set(key, group);
    }
    group.wallets.add(wallet);
    if (!group.evidence.some((e) => e.type === evidence.type)) group.evidence.push(evidence);
  };

  // same_funder — the strongest and cheapest signal.
  for (const funding of fundings) {
    add(`funder:${funding.funder}`, funding.wallet, {
      type: 'same_funder',
      funder: funding.funder,
    });
  }

  // same_funding_tx — one transaction paying several wallets is unambiguous.
  for (const funding of fundings) {
    add(`tx:${funding.txHash}`, funding.wallet, {
      type: 'same_funding_tx',
      txHash: funding.txHash,
    });
  }

  // similar_funding_time + similar_funding_amount, over wallets sharing neither
  // funder nor tx: a batch script funding fresh wallets with equal amounts
  // moments apart still looks like one actor.
  const sorted = [...fundings].sort((a, b) => a.fundedAt.getTime() - b.fundedAt.getTime());
  for (let i = 0; i < sorted.length; i += 1) {
    const anchor = sorted[i]!;
    for (let j = i + 1; j < sorted.length; j += 1) {
      const other = sorted[j]!;
      const gap = other.fundedAt.getTime() - anchor.fundedAt.getTime();
      if (gap > options.timeProximityMs) break; // sorted, so no later one qualifies

      if (!withinTolerance(anchor.valueWei, other.valueWei, options.amountTolerance)) continue;

      const key = `batch:${anchor.wallet}`;
      add(key, anchor.wallet, { type: 'similar_funding_time', windowMs: options.timeProximityMs });
      add(key, other.wallet, { type: 'similar_funding_amount', tolerance: options.amountTolerance });
    }
  }

  return [...groups.entries()]
    .filter(([, group]) => group.wallets.size >= options.minClusterSize)
    .map(([key, group]) => ({
      key,
      wallets: [...group.wallets].sort(),
      evidence: group.evidence,
    }));
}

/** Relative difference within tolerance, on bigint so wei never hits a float. */
export function withinTolerance(a: bigint, b: bigint, tolerance: number): boolean {
  if (a === b) return true;
  if (a === 0n || b === 0n) return false;
  const larger = a > b ? a : b;
  const smaller = a > b ? b : a;
  // (larger - smaller) / larger <= tolerance, scaled to stay in integers.
  const scaled = ((larger - smaller) * 1_000_000n) / larger;
  return Number(scaled) / 1_000_000 <= tolerance;
}

/**
 * §15.4 cluster_concentration: the share of tracked-token holdings
 * attributable to the largest detected cluster.
 *
 * Null when no cluster was detected — that is genuinely "no coordination
 * found", which a scorer should treat differently from a measured 0%.
 */
export function clusterConcentration(
  clusters: readonly Cluster[],
  balances: readonly HolderBalance[],
): FeatureValue {
  if (clusters.length === 0) return null;

  /**
   * Only positive balances count.
   *
   * The Transfer indexer starts tracking a token mid-life, so a wallet that
   * received tokens before tracking began and then sold shows a NEGATIVE
   * balance — an artifact of incomplete history, not a real position. Summing
   * those into the denominator dragged the total to zero and made this feature
   * silently null for every token.
   */
  const positive = balances.filter((b) => b.balanceRaw > 0n);
  const total = positive.reduce((sum, b) => sum + b.balanceRaw, 0n);
  if (total <= 0n) return null;

  const byWallet = new Map(positive.map((b) => [b.wallet.toLowerCase(), b.balanceRaw]));
  let largest = 0n;

  for (const cluster of clusters) {
    const held = cluster.wallets.reduce(
      (sum, wallet) => sum + (byWallet.get(wallet.toLowerCase()) ?? 0n),
      0n,
    );
    if (held > largest) largest = held;
  }

  const scaled = (largest * 1_000_000n) / total;
  return Number(scaled) / 1_000_000;
}

/**
 * Count of independent actors among a set of wallets: cluster members collapse
 * to one, unclustered wallets count individually.
 *
 * This is what §15.5's `independent_smart_wallet_count` needs — "count of smart
 * wallets after clustering related wallets".
 */
export function independentCount(
  wallets: readonly string[],
  clusters: readonly Cluster[],
): number {
  const seen = new Set(wallets.map((w) => w.toLowerCase()));
  let independent = 0;

  for (const cluster of clusters) {
    const members = cluster.wallets.map((w) => w.toLowerCase()).filter((w) => seen.has(w));
    if (members.length === 0) continue;
    for (const member of members) seen.delete(member);
    independent += 1; // the whole cluster is one actor
  }

  return independent + seen.size;
}
