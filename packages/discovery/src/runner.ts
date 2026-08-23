import type { PublicClient } from 'viem';
import type { Database } from '@sdb/database';
import { AdaptiveChunkSize, fetchLogsChunked } from '@sdb/blockchain';
import { isRetryable, withContext, type Logger } from '@sdb/shared';
import { decoderFor } from './adapters.js';
import { advanceCursor, planRange, readCursor } from './cursor.js';
import { FACTORIES, type FactoryDefinition } from './factories.js';
import { normalizePoolCreation, shouldAcceptPool } from './normalize.js';
import { persistCandidate } from './persist.js';

export type DiscoveryConfig = {
  chainId: number;
  quoteTokens: readonly string[];
  overlapBlocks: number;
  firstStartBackfillBlocks: number;
  logChunkBlocks: number;
  includeAerodromeStable: boolean;
  /** Fallback drain interval when no new head arrives (§10.2 socket death). */
  pollIntervalMs: number;
  /**
   * Floor on the gap between drains. Base produces a block every ~2s and each
   * drain costs one eth_getLogs per factory, which exhausts a rate-limited
   * provider quickly. Coalescing costs only discovery latency: the cursor
   * design means a skipped notification is picked up by the next drain, never
   * lost.
   */
  minDrainIntervalMs: number;
};

export type DiscoveryDeps = {
  db: Database;
  http: PublicClient;
  ws: PublicClient | null;
  logger: Logger;
  config: DiscoveryConfig;
  /** Injected so tests can assert enqueue behaviour without a live Redis. */
  enqueue: (poolId: string) => Promise<void>;
};

/**
 * Drain one factory from its cursor to `head`.
 *
 * The cursor advances per chunk, only after that chunk's rows are committed. A
 * throw mid-range therefore leaves the watermark on the last good chunk and the
 * remainder is retried — the invariant behind §10.3's "restarting does not
 * permanently skip blocks".
 */
export async function drainFactory(
  deps: DiscoveryDeps,
  factory: FactoryDefinition,
  head: bigint,
  chunkSize?: AdaptiveChunkSize,
  isFirstDrain = true,
): Promise<{ scanned: number; discovered: number }> {
  const { db, http, config } = deps;
  const logger = withContext(deps.logger, { source: factory.source });

  const lastProcessed = await readCursor(db, factory.source);
  const plan = planRange({
    lastProcessed,
    head,
    overlapBlocks: config.overlapBlocks,
    firstStartBackfillBlocks: config.firstStartBackfillBlocks,
    isFirstDrain,
  });

  if (plan.seeded) {
    logger.info(
      { fromBlock: plan.fromBlock, toBlock: plan.toBlock },
      'no cursor found; seeding with first-start backfill',
    );
  }
  if (plan.fromBlock > plan.toBlock) return { scanned: 0, discovered: 0 };

  const decode = decoderFor(factory);
  let scanned = 0;
  let discovered = 0;

  await fetchLogsChunked(
    http,
    {
      address: factory.address,
      event: factory.event as Parameters<typeof fetchLogsChunked>[1]['event'],
      fromBlock: plan.fromBlock,
      toBlock: plan.toBlock,
    },
    {
      maxChunk: config.logChunkBlocks,
      ...(chunkSize ? { chunkSize } : {}),
      onChunkShrink: (from, to) =>
        logger.warn({ from, to }, 'provider rejected block range; shrinking chunk size'),
      onRetry: (attempt, delayMs, reason) =>
        logger.warn({ attempt, delayMs, reason }, 'rpc throttled; backing off'),
    },
    async (logs, range) => {
      for (const log of logs) {
        scanned += 1;
        const created = await handleLog(deps, factory, decode, log);
        if (created) discovered += 1;
      }
      // Committed this window; safe to move the watermark.
      await advanceCursor(db, factory.source, range.toBlock);
    },
  );

  return { scanned, discovered };
}

async function handleLog(
  deps: DiscoveryDeps,
  factory: FactoryDefinition,
  decode: ReturnType<typeof decoderFor>,
  log: Parameters<ReturnType<typeof decoderFor>>[0],
): Promise<boolean> {
  const { config } = deps;
  const decoded = decode(log);

  if (!shouldAcceptPool(decoded, { includeAerodromeStable: config.includeAerodromeStable })) {
    return false;
  }

  const { candidate, hasKnownQuoteToken } = normalizePoolCreation(decoded, {
    quoteTokens: config.quoteTokens,
    discoveredAt: new Date(),
  });

  // Spec §10.1: persist the discovery event before any expensive analysis.
  const result = await persistCandidate(deps.db, {
    chainId: config.chainId,
    candidate,
    hasKnownQuoteToken,
    // Block timestamp is Phase 2 enrichment; §3 keeps it distinct from
    // discoveredAt rather than conflating the two.
    poolCreatedAt: null,
  });

  const logger = withContext(deps.logger, {
    correlationId: result.poolId,
    poolId: result.poolId,
    tokenId: result.tokenId,
    source: factory.source,
  });

  if (!result.created) {
    logger.debug({ pool: candidate.poolAddress }, 'pool already known; not re-enqueued');
    return false;
  }

  await deps.enqueue(result.poolId);
  logger.info(
    {
      pool: candidate.poolAddress,
      token: candidate.tokenAddress,
      dex: candidate.dex,
      block: candidate.blockNumber,
      hasKnownQuoteToken,
    },
    'discovered pool',
  );
  return true;
}

/**
 * Runs all factories forever.
 *
 * WebSocket new-heads are only a trigger: every drain re-reads from the
 * persisted cursor, so a missed notification costs latency, never data. If the
 * socket dies entirely, the fallback interval keeps the same drain running and
 * the system degrades to polling.
 */
export class DiscoveryRunner {
  private stopped = false;
  private draining = false;
  private timer: NodeJS.Timeout | null = null;
  private unwatch: (() => void) | null = null;
  /**
   * One sizer per factory, held for the process lifetime: the provider's real
   * range limit is learned once rather than re-probed on every 15s drain.
   */
  private readonly chunkSizes = new Map<string, AdaptiveChunkSize>();
  /** Factories that have completed one drain in this process lifetime. */
  private readonly drained = new Set<string>();
  private lastDrainAt = 0;
  private pendingHead: bigint | null = null;

  constructor(private readonly deps: DiscoveryDeps) {}

  private sizerFor(source: string): AdaptiveChunkSize {
    let sizer = this.chunkSizes.get(source);
    if (!sizer) {
      sizer = new AdaptiveChunkSize(this.deps.config.logChunkBlocks);
      this.chunkSizes.set(source, sizer);
    }
    return sizer;
  }

  async start(): Promise<void> {
    const { logger } = this.deps;

    await this.drainAll(undefined, true);

    this.timer = setInterval(() => void this.drainAll(), this.deps.config.pollIntervalMs);

    if (this.deps.ws) {
      this.unwatch = this.deps.ws.watchBlockNumber({
        emitOnBegin: false,
        // Use the head the subscription already delivered. Re-querying
        // eth_blockNumber here would cost one RPC call every ~2s on Base and
        // was the main source of 429s against the provider's rate limit.
        onBlockNumber: (blockNumber) => void this.drainAll(blockNumber),
        onError: (error) => {
          // Not fatal: the interval keeps draining while viem reconnects.
          logger.warn({ err: error.message }, 'block subscription error; polling continues');
        },
      });
      logger.info('discovery watching new heads over websocket');
    } else {
      logger.warn('no websocket configured; discovery is polling only');
    }
  }

  /**
   * Spec §10.3: a provider failure must not crash the worker. Each factory is
   * isolated so one bad adapter or one bad RPC response cannot stop the others.
   */
  private async drainAll(knownHead?: bigint, force = false): Promise<void> {
    if (this.stopped) return;

    // Coalesce bursts of new-head notifications into one drain.
    if (!force) {
      const since = Date.now() - this.lastDrainAt;
      if (since < this.deps.config.minDrainIntervalMs) {
        if (knownHead !== undefined) this.pendingHead = knownHead;
        return;
      }
    }
    if (this.draining) return; // never overlap drains

    this.draining = true;
    this.lastDrainAt = Date.now();
    // Prefer the newest head seen while we were throttled.
    if (this.pendingHead !== null && (knownHead === undefined || this.pendingHead > knownHead)) {
      knownHead = this.pendingHead;
    }
    this.pendingHead = null;
    try {
      const head = knownHead ?? (await this.deps.http.getBlockNumber());
      for (const factory of FACTORIES) {
        try {
          const { scanned, discovered } = await drainFactory(
            this.deps,
            factory,
            head,
            this.sizerFor(factory.source),
            !this.drained.has(factory.source),
          );
          this.drained.add(factory.source);
          if (scanned > 0) {
            this.deps.logger.info(
              { source: factory.source, scanned, discovered, head },
              'drained factory',
            );
          }
        } catch (error) {
          this.deps.logger.error(
            {
              source: factory.source,
              retryable: isRetryable(error),
              err: error instanceof Error ? error.message : String(error),
              // The provider's own words, otherwise lost behind our wrapper.
              cause:
                error instanceof Error && 'context' in error
                  ? (error as { context?: Record<string, unknown> }).context?.['cause']
                  : undefined,
            },
            'factory drain failed; other factories continue',
          );
        }
      }
    } catch (error) {
      this.deps.logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        'could not read head block; will retry',
      );
    } finally {
      this.draining = false;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.unwatch?.();
  }
}
