import { quotePriceSamples, type Database } from '@sdb/database';
import { toColumn } from '@sdb/market-data';

/**
 * Persist one quote-asset price observation (§21).
 *
 * The resolver already fetches WETH/USD on a TTL for snapshots, so recording
 * each refresh builds a historical curve at zero additional RPC cost. That
 * curve is what lets a 24h outcome be priced at the ETH rate that actually
 * held at each point, rather than one spot rate applied to the whole window —
 * which would let an ETH move contaminate every return and rescale the runup
 * and drawdown extrema.
 *
 * Best-effort by design: a failed sample must never fail the snapshot that
 * triggered it. A gap simply shows up later as reduced coverage, which the
 * outcome records honestly instead of guessing through.
 */
export async function recordQuoteSample(
  db: Database,
  sample: { chainId: number; tokenAddress: string; priceUsd: bigint; observedAt?: Date },
): Promise<void> {
  const priceUsd = toColumn(sample.priceUsd);
  if (priceUsd === null) return;

  await db.insert(quotePriceSamples).values({
    chainId: sample.chainId,
    tokenAddress: sample.tokenAddress.toLowerCase(),
    priceUsd,
    observedAt: sample.observedAt ?? new Date(),
  });
}
