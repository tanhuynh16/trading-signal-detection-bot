import { and, desc, eq, sql } from 'drizzle-orm';
import type { PublicClient } from 'viem';
import { holderBalances, walletClusters, wallets, type Database } from '@sdb/database';
import { canonicalize, TransientProviderError, type Logger } from '@sdb/shared';
import { clusterWallets, type Cluster, type ClusterOptions, type WalletFunding } from './clustering.js';

/**
 * Funding lookup and cluster detection (§15.4).
 *
 * Native ETH funding is a transaction, not a log, so `eth_getLogs` can never
 * answer "who funded this wallet". `alchemy_getAssetTransfers` can, and was
 * confirmed available on the free tier — it returns `from`, `value`, `hash` and
 * a block timestamp, which is exactly the four fields the four §15.4 heuristics
 * need.
 */

export type FundingLookupConfig = {
  /** Cap on wallets clustered per token; each costs at most one lookup ever. */
  maxWallets: number;
  cluster: ClusterOptions;
};

type AssetTransfer = {
  from: string;
  value: number | null;
  hash: string;
  metadata?: { blockTimestamp?: string };
};

/**
 * First inbound native transfer for a wallet.
 *
 * Returns null when the wallet has no external funding we can see — a contract,
 * or an account funded by an internal transfer. Null is correct: unknown
 * provenance is not evidence of independence.
 */
async function fetchFirstFunding(
  client: PublicClient,
  wallet: string,
): Promise<WalletFunding | null> {
  let response: { transfers?: AssetTransfer[] };
  try {
    response = (await client.request({
      method: 'alchemy_getAssetTransfers' as never,
      params: [
        {
          toAddress: wallet,
          category: ['external'],
          order: 'asc',
          maxCount: '0x1',
          withMetadata: true,
        },
      ] as never,
    })) as { transfers?: AssetTransfer[] };
  } catch (error) {
    throw new TransientProviderError('getAssetTransfers failed', {
      cause: error instanceof Error ? error.message : String(error),
      wallet,
    });
  }

  const first = response.transfers?.[0];
  if (!first) return null;

  const timestamp = first.metadata?.blockTimestamp;
  if (!timestamp) return null;

  return {
    wallet: canonicalize(wallet),
    funder: canonicalize(first.from),
    txHash: first.hash,
    fundedAt: new Date(timestamp),
    // `value` arrives as a decimal ETH number; convert to wei without a float
    // round-trip on the significant digits.
    valueWei: ethToWei(first.value),
  };
}

function ethToWei(value: number | null): bigint {
  if (value === null || !Number.isFinite(value) || value <= 0) return 0n;
  // 9 decimal places is ample to distinguish funding amounts and keeps the
  // intermediate inside a safe integer.
  return BigInt(Math.round(value * 1e9)) * 10n ** 9n;
}

/**
 * Funding for a set of wallets, cached permanently.
 *
 * A wallet's FIRST funding never changes, so a wallet is looked up at most once
 * in the lifetime of the database. That is what makes clustering affordable on
 * a rate-limited plan.
 */
export async function loadFundings(
  deps: { db: Database; http: PublicClient; logger: Logger; chainId: number },
  walletAddresses: readonly string[],
): Promise<WalletFunding[]> {
  if (walletAddresses.length === 0) return [];

  const cached = await deps.db
    .select({ address: wallets.address, metrics: wallets.metrics })
    .from(wallets)
    .where(eq(wallets.chainId, deps.chainId));

  const cache = new Map(cached.map((row) => [row.address, row.metrics as unknown]));
  const results: WalletFunding[] = [];
  const toFetch: string[] = [];

  for (const wallet of walletAddresses) {
    const entry = cache.get(wallet) as { funding?: SerializedFunding } | undefined;
    if (entry?.funding) {
      results.push(deserialize(entry.funding));
    } else if (!cache.has(wallet)) {
      toFetch.push(wallet);
    }
    // A cached row with no funding means "looked up, none found" — do not retry.
  }

  for (const wallet of toFetch) {
    try {
      const funding = await fetchFirstFunding(deps.http, wallet);
      await deps.db
        .insert(wallets)
        .values({
          chainId: deps.chainId,
          address: wallet,
          source: 'observed',
          metrics: funding ? { funding: serialize(funding) } : {},
          lastEvaluatedAt: new Date(),
        })
        .onConflictDoNothing({ target: [wallets.chainId, wallets.address] });
      if (funding) results.push(funding);
    } catch (error) {
      // One wallet failing must not abandon the whole cluster computation.
      deps.logger.debug(
        { wallet, err: error instanceof Error ? error.message : String(error) },
        'funding lookup failed; wallet excluded from clustering',
      );
    }
  }

  return results;
}

type SerializedFunding = {
  wallet: string;
  funder: string;
  txHash: string;
  fundedAt: string;
  valueWei: string;
};

const serialize = (f: WalletFunding): SerializedFunding => ({
  wallet: f.wallet,
  funder: f.funder,
  txHash: f.txHash,
  fundedAt: f.fundedAt.toISOString(),
  valueWei: f.valueWei.toString(),
});

const deserialize = (f: SerializedFunding): WalletFunding => ({
  wallet: f.wallet,
  funder: f.funder,
  txHash: f.txHash,
  fundedAt: new Date(f.fundedAt),
  valueWei: BigInt(f.valueWei),
});

/** Top holders by balance — the only wallets worth the lookup budget. */
export async function topHolders(
  db: Database,
  tokenId: string,
  limit: number,
): Promise<string[]> {
  const rows = await db
    .select({ wallet: holderBalances.wallet })
    .from(holderBalances)
    .where(and(eq(holderBalances.tokenId, tokenId), sql`${holderBalances.balanceRaw} > 0`))
    .orderBy(desc(sql`${holderBalances.balanceRaw}::numeric`))
    .limit(limit);
  return rows.map((r) => r.wallet);
}

/**
 * Detect and persist clusters for a token.
 *
 * Persistence is idempotent on (cluster_key, wallet), so re-running as holders
 * change adds members without duplicating them.
 */
export async function detectClusters(
  deps: { db: Database; http: PublicClient; logger: Logger; chainId: number },
  tokenId: string,
  config: FundingLookupConfig,
): Promise<Cluster[]> {
  const holders = await topHolders(deps.db, tokenId, config.maxWallets);
  if (holders.length < config.cluster.minClusterSize) return [];

  const fundings = await loadFundings(deps, holders);
  const clusters = clusterWallets(fundings, config.cluster);
  if (clusters.length === 0) return [];

  const detectedAt = new Date();
  for (const cluster of clusters) {
    for (const wallet of cluster.wallets) {
      await deps.db
        .insert(walletClusters)
        .values({
          clusterKey: cluster.key,
          walletAddress: wallet,
          evidenceType: cluster.evidence[0]?.type ?? 'same_funder',
          evidence: cluster.evidence,
          detectedAt,
        })
        .onConflictDoNothing({
          target: [walletClusters.clusterKey, walletClusters.walletAddress],
        });
    }
  }

  return clusters;
}
