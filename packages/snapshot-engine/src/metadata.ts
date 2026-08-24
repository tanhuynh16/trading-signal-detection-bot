import { eq } from 'drizzle-orm';
import type { PublicClient } from 'viem';
import { pools, tokens, type Database } from '@sdb/database';
import { readTokenMetadata } from '@sdb/market-data';
import { ResourceGoneError, type Address } from '@sdb/shared';

/**
 * The `discovery-analysis` processor.
 *
 * Phase 1 deliberately persisted only a token skeleton — spec §10.1 requires
 * the discovery event to be stored before any expensive analysis, so the RPC
 * reads happen here, off the hot discovery path.
 */
export type EnrichResult = {
  tokenId: string;
  poolId: string;
  symbol: string | null;
  decimals: number;
  alreadyEnriched: boolean;
};

export async function enrichToken(
  deps: { db: Database; http: PublicClient },
  poolId: string,
): Promise<EnrichResult> {
  const rows = await deps.db
    .select({
      poolId: pools.id,
      tokenId: tokens.id,
      address: tokens.address,
      symbol: tokens.symbol,
      decimals: tokens.decimals,
    })
    .from(pools)
    .innerJoin(tokens, eq(pools.tokenId, tokens.id))
    .where(eq(pools.id, poolId))
    .limit(1);

  const row = rows[0];
  // The pool is gone — truncated, or cleaned up. Permanent: no number of
  // retries brings it back, so §23 routes this to the audit table instead.
  if (!row) {
    throw new ResourceGoneError(`pool ${poolId} no longer exists`, { poolId });
  }

  // Already enriched by another pool of the same token; metadata is immutable
  // for a deployed ERC-20, so re-reading it would be a wasted RPC call.
  if (row.decimals !== null) {
    return {
      tokenId: row.tokenId,
      poolId: row.poolId,
      symbol: row.symbol,
      decimals: row.decimals,
      alreadyEnriched: true,
    };
  }

  const meta = await readTokenMetadata(deps.http, row.address as Address);

  await deps.db
    .update(tokens)
    .set({
      symbol: meta.symbol,
      name: meta.name,
      decimals: meta.decimals,
      totalSupplyRaw: meta.totalSupplyRaw.toString(),
    })
    .where(eq(tokens.id, row.tokenId));

  return {
    tokenId: row.tokenId,
    poolId: row.poolId,
    symbol: meta.symbol,
    decimals: meta.decimals,
    alreadyEnriched: false,
  };
}
