import { and, eq } from 'drizzle-orm';
import type { Database } from '@sdb/database';
import { pools, tokens } from '@sdb/database';
import type { DbOrTx } from '@sdb/database';
import type { TokenCandidate } from '@sdb/domain';
import type { Address } from '@sdb/shared';

export type PersistResult = {
  poolId: string;
  tokenId: string;
  /** False when this pool was already known — caller must not re-enqueue. */
  created: boolean;
};

/**
 * Spec §10.1/§10.3: a newly observed pool creates exactly one record, and
 * duplicate event delivery creates no duplicate.
 *
 * Dedupe is done by the database, not by a read-then-write in application code.
 * Three adapters drain concurrently and block ranges overlap by design, so a
 * check-then-insert would race; `ON CONFLICT DO NOTHING ... RETURNING` makes
 * "did I create this?" an atomic property of the insert itself.
 */
export async function persistCandidate(
  db: Database,
  input: {
    chainId: number;
    candidate: TokenCandidate;
    hasKnownQuoteToken: boolean;
    poolCreatedAt: Date | null;
  },
): Promise<PersistResult> {
  const { candidate, chainId } = input;

  return db.transaction(async (tx) => {
    const tokenId = await upsertToken(tx, chainId, candidate.tokenAddress, candidate.discoveredAt);

    const inserted = await tx
      .insert(pools)
      .values({
        tokenId,
        chainId,
        dex: candidate.dex,
        address: candidate.poolAddress,
        quoteTokenAddress: candidate.quoteTokenAddress,
        hasKnownQuoteToken: input.hasKnownQuoteToken,
        poolCreatedAt: input.poolCreatedAt,
        discoveredAt: candidate.discoveredAt,
        blockNumber: candidate.blockNumber,
        transactionHash: candidate.transactionHash,
      })
      .onConflictDoNothing({ target: [pools.chainId, pools.address] })
      .returning({ id: pools.id });

    const createdId = inserted[0]?.id;
    if (createdId) {
      return { poolId: createdId, tokenId, created: true };
    }

    // Lost the race, or a replayed block. Fetch the existing row so the caller
    // still has a correlation ID for logging.
    const existing = await tx
      .select({ id: pools.id, tokenId: pools.tokenId })
      .from(pools)
      .where(and(eq(pools.chainId, chainId), eq(pools.address, candidate.poolAddress)))
      .limit(1);

    const row = existing[0];
    if (!row) {
      // Conflict fired but the row is absent: only possible if it was deleted
      // between the two statements. Surfacing beats pretending we persisted.
      throw new Error(`pool ${candidate.poolAddress} conflicted but could not be read back`);
    }
    return { poolId: row.id, tokenId: row.tokenId, created: false };
  });
}

/**
 * Phase 1 stores only the token skeleton. Symbol, name, decimals and supply are
 * Phase 2 (§29 forbids implementing ahead), and §10.1 requires persisting the
 * discovery event before any expensive analysis anyway.
 */
async function upsertToken(
  tx: DbOrTx,
  chainId: number,
  address: Address,
  firstSeenAt: Date,
): Promise<string> {
  const inserted = await tx
    .insert(tokens)
    .values({ chainId, address, firstSeenAt })
    .onConflictDoNothing({ target: [tokens.chainId, tokens.address] })
    .returning({ id: tokens.id });

  const createdId = inserted[0]?.id;
  if (createdId) return createdId;

  const existing = await tx
    .select({ id: tokens.id })
    .from(tokens)
    .where(and(eq(tokens.chainId, chainId), eq(tokens.address, address)))
    .limit(1);

  const row = existing[0];
  if (!row) throw new Error(`token ${address} conflicted but could not be read back`);
  return row.id;
}
