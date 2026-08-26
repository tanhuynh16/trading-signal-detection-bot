import { and, asc, eq, lte, ne, notExists, gte } from 'drizzle-orm';
import { signalOutcomes, signals, type Database } from '@sdb/database';
import { planOutcomes } from './horizons.js';

export type ReconcileConfig = {
  /** How far back to look for unfinished work. */
  lookbackMs: number;
  /** Cap per horizon per sweep, so a backlog drains steadily rather than at once. */
  limitPerHorizon: number;
};

export type DueOutcome = { signalId: string; horizon: string };

/**
 * Find horizons that have elapsed but were never evaluated.
 *
 * This — not Redis — is what makes §21's durability real. The delayed BullMQ
 * job is the fast path, but a 24h delay lives in Redis, and Phase 6.1 settled
 * that a long-lived obligation cannot live only there: a restart is survivable,
 * a `FLUSHALL` is not. The durable `signals` rows are the source of truth and
 * the queue is rebuilt from them.
 *
 * It also backfills signals emitted before this phase existed, and covers the
 * window where a worker was simply down when a horizon came due.
 *
 * `EXPIRED` entries are excluded for the same reason they are never scheduled:
 * the return of an expiry event measures nothing. Without this the sweep would
 * cheerfully manufacture outcomes for every expiry ever recorded.
 */
export async function dueOutcomes(
  db: Database,
  config: ReconcileConfig,
  now: Date = new Date(),
): Promise<DueOutcome[]> {
  const cutoff = new Date(now.getTime() - config.lookbackMs);
  const due: DueOutcome[] = [];

  for (const plan of planOutcomes()) {
    const elapsedBefore = new Date(now.getTime() - plan.delayMs);
    // A horizon can only be due if the signal is at least that old, so the
    // lookback floor and the horizon ceiling together bound the scan.
    if (elapsedBefore < cutoff) continue;

    const rows = await db
      .select({ signalId: signals.id })
      .from(signals)
      .where(
        and(
          ne(signals.state, 'EXPIRED'),
          gte(signals.createdAt, cutoff),
          lte(signals.createdAt, elapsedBefore),
          notExists(
            db
              .select({ one: signalOutcomes.id })
              .from(signalOutcomes)
              .where(
                and(
                  eq(signalOutcomes.signalId, signals.id),
                  eq(signalOutcomes.horizon, plan.horizon),
                ),
              ),
          ),
        ),
      )
      // Oldest first: the longest-owed outcome is also the one whose trade data
      // is closest to ageing out of the tail's retention.
      .orderBy(asc(signals.createdAt))
      .limit(config.limitPerHorizon);

    for (const row of rows) due.push({ signalId: row.signalId, horizon: plan.horizon });
  }

  return due;
}
