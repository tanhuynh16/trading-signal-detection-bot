import { and, gte, isNotNull, eq, sql } from 'drizzle-orm';
import { signalOutcomes, signals, type Database } from '@sdb/database';

/**
 * The evaluation sample: one row per measured outcome, carrying everything §22
 * needs to group and attribute it.
 *
 * Deliberately loads rows rather than aggregating in SQL. The sample is small
 * by construction (a signal produces at most seven outcomes) and the statistics
 * §22 asks for — medians, quantiles, rank correlation — are far clearer in
 * tested pure functions than in window-function SQL. If the sample ever grows
 * past what a process can hold, that is a happy problem and the aggregation can
 * move down.
 */

export type OutcomeSample = {
  signalId: string;
  tokenId: string;
  strategyVersion: string;
  alphaScore: number;
  coverage: number;
  horizon: string;
  /** Null when the outcome could not be measured; `failureReason` says why. */
  returnPct: number | null;
  maxRunupPct: number | null;
  maxDrawdownPct: number | null;
  tradeCount: number | null;
  failureReason: string | null;
  /** Frozen per-signal component scores; a component may be null (§15). */
  components: Record<string, number | null>;
  createdAt: Date;
};

type ComponentRow = { name: string; raw: number | null; weight: number };

export type SampleFilter = {
  strategyVersion?: string;
  since?: Date;
  horizon?: string;
};

export async function loadSamples(
  db: Database,
  filter: SampleFilter = {},
): Promise<OutcomeSample[]> {
  const conditions = [isNotNull(signals.alphaScore)];
  if (filter.strategyVersion) {
    conditions.push(eq(signals.strategyVersion, filter.strategyVersion));
  }
  if (filter.since) conditions.push(gte(signals.createdAt, filter.since));
  if (filter.horizon) conditions.push(eq(signalOutcomes.horizon, filter.horizon));

  const rows = await db
    .select({
      signalId: signals.id,
      tokenId: signals.tokenId,
      strategyVersion: signals.strategyVersion,
      alphaScore: signals.alphaScore,
      coverage: signals.coverage,
      components: signals.components,
      createdAt: signals.createdAt,
      horizon: signalOutcomes.horizon,
      returnPct: signalOutcomes.returnPct,
      maxRunupPct: signalOutcomes.maxRunupPct,
      maxDrawdownPct: signalOutcomes.maxDrawdownPct,
      tradeCount: signalOutcomes.tradeCount,
      failureReason: signalOutcomes.failureReason,
    })
    .from(signalOutcomes)
    .innerJoin(signals, eq(signals.id, signalOutcomes.signalId))
    .where(and(...conditions))
    .orderBy(signals.createdAt);

  return rows.map((row) => ({
    signalId: row.signalId,
    tokenId: row.tokenId,
    strategyVersion: row.strategyVersion,
    alphaScore: Number(row.alphaScore),
    coverage: Number(row.coverage),
    horizon: row.horizon,
    returnPct: row.returnPct === null ? null : Number(row.returnPct),
    maxRunupPct: row.maxRunupPct === null ? null : Number(row.maxRunupPct),
    maxDrawdownPct: row.maxDrawdownPct === null ? null : Number(row.maxDrawdownPct),
    tradeCount: row.tradeCount,
    failureReason: row.failureReason,
    components: toComponentMap(row.components),
    createdAt: row.createdAt,
  }));
}

/**
 * `signals.components` is jsonb written by the scorer. A component whose raw
 * score is null was not measurable, and stays null here rather than becoming 0
 * — §15's discipline, which matters more in analysis than anywhere else,
 * because a zero would silently become a data point.
 */
function toComponentMap(value: unknown): Record<string, number | null> {
  if (!Array.isArray(value)) return {};
  const out: Record<string, number | null> = {};
  for (const entry of value as ComponentRow[]) {
    if (!entry || typeof entry.name !== 'string') continue;
    out[entry.name] = typeof entry.raw === 'number' ? entry.raw : null;
  }
  return out;
}

/** Which strategy versions are present, so the report can refuse to pool them. */
export async function strategyVersions(db: Database): Promise<string[]> {
  const rows = await db
    .selectDistinct({ version: signals.strategyVersion })
    .from(signalOutcomes)
    .innerJoin(signals, eq(signals.id, signalOutcomes.signalId))
    .orderBy(signals.strategyVersion);
  return rows.map((row) => row.version);
}

/** Horizons present in the data, ordered by their real duration. */
export async function horizonsPresent(db: Database): Promise<string[]> {
  // GROUP BY rather than DISTINCT: Postgres rejects ordering a DISTINCT query
  // by an expression that is not in its select list, and '15m' sorting before
  // '1m' as text would misreport which horizon came first in time.
  const rows = await db.execute<{ horizon: string }>(sql`
    SELECT horizon FROM signal_outcomes
    GROUP BY horizon
    ORDER BY CASE horizon
      WHEN '1m' THEN 1 WHEN '5m' THEN 2 WHEN '15m' THEN 3 WHEN '30m' THEN 4
      WHEN '1h' THEN 5 WHEN '4h' THEN 6 WHEN '24h' THEN 7 ELSE 8 END
  `);
  return rows.map((row) => row.horizon);
}
