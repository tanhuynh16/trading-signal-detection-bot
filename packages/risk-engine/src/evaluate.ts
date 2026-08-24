import { eq } from 'drizzle-orm';
import type { PublicClient } from 'viem';
import { pools, riskResults, tokens, type Database } from '@sdb/database';
import type { Dex, RiskResult } from '@sdb/domain';
import {
  normalizeGoPlus,
  simulateRoundTrip,
  type GoPlusSecurityProvider,
  type SimulationOutcome,
} from '@sdb/security';
import { ResourceGoneError, isRetryable, type Address, type Logger } from '@sdb/shared';
import { decide, mergeFlags, providerFlags, simulationFlags, type RiskRuleConfig } from './rules.js';

export type RiskEvaluationDeps = {
  db: Database;
  http: PublicClient;
  goplus: GoPlusSecurityProvider | null;
  logger: Logger;
  rules: RiskRuleConfig;
  probeWei?: bigint;
};

export type RiskEvaluation = {
  result: RiskResult;
  tokenId: string;
  poolId: string;
  simulation: SimulationOutcome | null;
  providerName: string | null;
  providerRaw: unknown;
};

/**
 * Evaluate a pool's token against §14.
 *
 * Sources are combined rather than ranked: our own simulation is authoritative
 * on tradeability (it observes the chain directly), while the provider supplies
 * contract-capability flags — mintable, blacklist, owner privileges — that no
 * amount of simulating a single trade can reveal.
 */
export async function evaluateRisk(
  deps: RiskEvaluationDeps,
  poolId: string,
): Promise<RiskEvaluation> {
  const rows = await deps.db
    .select({
      poolId: pools.id,
      poolAddress: pools.address,
      dex: pools.dex,
      tokenId: tokens.id,
      tokenAddress: tokens.address,
    })
    .from(pools)
    .innerJoin(tokens, eq(pools.tokenId, tokens.id))
    .where(eq(pools.id, poolId))
    .limit(1);

  const pool = rows[0];
  if (!pool) {
    throw new ResourceGoneError(`pool ${poolId} no longer exists`, { poolId });
  }

  const token = pool.tokenAddress as Address;

  // Simulation is the authoritative leg. A provider failure here is transient
  // and must propagate so the job retries — deciding "honeypot" because our RPC
  // was rate-limited would be a false accusation that expires the token (§18).
  const simulation = await simulateRoundTrip(deps.http, {
    token,
    dex: pool.dex as Dex,
    ...(deps.probeWei !== undefined ? { probeWei: deps.probeWei } : {}),
  });

  // Enrichment is strictly optional: a GoPlus outage degrades the verdict to
  // simulation-only rather than failing the evaluation.
  let providerRaw: unknown = null;
  let providerName: string | null = null;
  let goplusFlags = providerFlags(
    { ...EMPTY_FINDINGS, unindexed: true },
    deps.rules,
  );

  if (deps.goplus) {
    try {
      const report = await deps.goplus.analyzeToken(token, pool.poolAddress as Address);
      providerRaw = report.raw;
      providerName = deps.goplus.name;
      goplusFlags = providerFlags(normalizeGoPlus(report.raw), deps.rules);
    } catch (error) {
      deps.logger.warn(
        {
          poolId,
          retryable: isRetryable(error),
          err: error instanceof Error ? error.message : String(error),
        },
        'security provider unavailable; continuing on simulation alone',
      );
    }
  }

  const flags = mergeFlags(simulationFlags(simulation, deps.rules), goplusFlags);

  return {
    result: decide(flags, deps.rules),
    tokenId: pool.tokenId,
    poolId: pool.poolId,
    simulation,
    providerName,
    providerRaw,
  };
}

const EMPTY_FINDINGS = {
  isHoneypot: null,
  cannotBuy: null,
  cannotSellAll: null,
  isBlacklisted: null,
  transferPausable: null,
  tradingCooldown: null,
  isMintable: null,
  canTakeBackOwnership: null,
  hiddenOwner: null,
  ownerChangeBalance: null,
  buyTax: null,
  sellTax: null,
  transferTax: null,
  ownerPercent: null,
  creatorPercent: null,
  top10Percent: null,
  lpHolderCount: null,
  holderCount: null,
  unindexed: true,
} as const;

/**
 * Persist an evaluation.
 *
 * Always an INSERT. §21 requires historical values stay immutable for
 * reproducibility, and the T+0/5m/30m re-checks are separate observations of a
 * token whose contract state can genuinely change between them — overwriting
 * would erase the evidence that it changed.
 */
export async function persistRisk(
  db: Database,
  evaluation: RiskEvaluation,
): Promise<string> {
  const [row] = await db
    .insert(riskResults)
    .values({
      tokenId: evaluation.tokenId,
      poolId: evaluation.poolId,
      evaluatedAt: evaluation.result.evaluatedAt,
      status: evaluation.result.status,
      riskScore: evaluation.result.riskScore.toFixed(3),
      flags: evaluation.result.flags,
      providerName: evaluation.providerName,
      // §14.1: retain the raw security-provider response where feasible.
      providerRaw: evaluation.providerRaw as never,
    })
    .returning({ id: riskResults.id });
  return row!.id;
}
