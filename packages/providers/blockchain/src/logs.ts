import type { AbiEvent, Address, Hex, Log, PublicClient } from 'viem';
import { ProviderHistoryUnavailableError, TransientProviderError } from '@sdb/shared';

export type LogRange = { fromBlock: bigint; toBlock: bigint };

/**
 * Providers cap how many blocks one eth_getLogs may span, and the cap differs
 * per plan — Alchemy's free tier allows 10, paid tiers far more. Rather than
 * hardcode a guess, `maxChunk` is configuration and the fetcher halves it when
 * the provider complains, so an over-optimistic setting self-corrects instead
 * of failing the drain.
 */
export type LogFetcherOptions = {
  maxChunk: number;
  minChunk?: number;
  onChunkShrink?: (from: number, to: number) => void;
  /** Bounded retries for transient failures (429, timeout). Spec §23. */
  maxAttempts?: number;
  onRetry?: (attempt: number, delayMs: number, reason: string) => void;
};

/**
 * Remembers the largest chunk this provider actually accepted.
 *
 * Without this, every drain restarts at `maxChunk` and re-probes downward,
 * burning one wasted request per halving — on a 15s poll loop against a
 * provider capping at 10 blocks, that is most of the request budget spent
 * rediscovering a fact we already learned.
 */
export class AdaptiveChunkSize {
  private current: number;
  constructor(initial: number, private readonly min = 1) {
    this.current = Math.max(min, initial);
  }
  get value(): number {
    return this.current;
  }
  shrink(): number {
    this.current = Math.max(this.min, Math.floor(this.current / 2));
    return this.current;
  }
  canShrink(): boolean {
    return this.current > this.min;
  }
}

const RANGE_ERROR = /block range|range too large|up to a \d+ block|query returned more than|limit exceeded/i;
const RATE_LIMIT_ERROR = /429|rate ?limit|too many requests|capacity|timeout|ETIMEDOUT|ECONNRESET/i;
/**
 * The provider no longer holds these blocks — a non-archive node has pruned
 * them. Checked BEFORE the range and rate-limit patterns, because providers
 * word this in ways that collide with both: Chainstack answers
 * "Archive, Debug and Trace requests are not available on your current plan",
 * which contains neither, while others say "missing trie node" or
 * "state is not available". Halving the chunk or backing off cannot help, so
 * misclassifying it is what turns a 4.3-minute outage into a permanent stall.
 */
const HISTORY_ERROR =
  /archive|missing trie node|state (?:is )?(?:not available|unavailable)|pruned|older than|beyond the (?:last|available)|header not found/i;

function text(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function isRangeError(error: unknown): boolean {
  return RANGE_ERROR.test(text(error));
}
function isHistoryUnavailable(error: unknown): boolean {
  return HISTORY_ERROR.test(text(error));
}
function isRateLimited(error: unknown): boolean {
  return RATE_LIMIT_ERROR.test(text(error));
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Split [from, to] inclusive into chunks of at most `size` blocks. */
export function chunkRange(from: bigint, to: bigint, size: number): LogRange[] {
  if (to < from) return [];
  const chunks: LogRange[] = [];
  const step = BigInt(Math.max(1, size));
  for (let start = from; start <= to; start += step) {
    const end = start + step - 1n;
    chunks.push({ fromBlock: start, toBlock: end > to ? to : end });
  }
  return chunks;
}

/**
 * Fetch logs across a block range, chunked to respect the provider's limit.
 *
 * Chunks are fetched sequentially on purpose: the caller advances a persisted
 * cursor per chunk, so out-of-order completion would let a later chunk commit
 * over an earlier failure and open a gap.
 */
/**
 * Either a single event (typed, decoded by viem) or raw topic filters.
 *
 * The swap tail needs the raw form: it queries an ARRAY of addresses against an
 * OR of three different Swap selectors in one call, which viem's typed `event`
 * parameter cannot express.
 */
export type LogFilter =
  | { event: AbiEvent; topics?: undefined }
  | { topics: (Hex | Hex[] | null)[]; event?: undefined };

export async function fetchLogsChunked(
  client: PublicClient,
  params: { address: Address | readonly Address[] } & LogFilter & {
      fromBlock: bigint;
      toBlock: bigint;
    },
  options: LogFetcherOptions & { chunkSize?: AdaptiveChunkSize },
  onChunk: (logs: Log[], range: LogRange) => Promise<void>,
): Promise<void> {
  const minChunk = options.minChunk ?? 1;
  const maxAttempts = options.maxAttempts ?? 4;
  const sizing = options.chunkSize ?? new AdaptiveChunkSize(options.maxChunk, minChunk);
  let cursor = params.fromBlock;
  let attempt = 0;

  while (cursor <= params.toBlock) {
    const end = cursor + BigInt(sizing.value) - 1n;
    const range: LogRange = {
      fromBlock: cursor,
      toBlock: end > params.toBlock ? params.toBlock : end,
    };

    let logs: Log[];
    try {
      // viem's getLogs overloads do not cover "address array + raw OR topics",
      // so the filter is assembled untyped and narrowed by LogFilter above.
      const filter = params.event
        ? { event: params.event }
        : { topics: params.topics };
      logs = await client.getLogs({
        address: params.address as Address,
        ...filter,
        fromBlock: range.fromBlock,
        toBlock: range.toBlock,
      } as Parameters<PublicClient['getLogs']>[0]);
    } catch (error) {
      // First: is this range gone for good? Shrinking or backing off would
      // both loop forever on a pruned block.
      if (isHistoryUnavailable(error)) {
        throw new ProviderHistoryUnavailableError(
          `eth_getLogs beyond provider history [${range.fromBlock}, ${range.toBlock}]`,
          {
            fromBlock: range.fromBlock.toString(),
            toBlock: range.toBlock.toString(),
            cause: text(error),
          },
        );
      }
      if (isRangeError(error) && sizing.canShrink()) {
        // Shrink FIRST, then notify. Written as
        // `options.onChunkShrink?.(before, sizing.shrink())` the optional call
        // short-circuits its own arguments: with no callback supplied,
        // `shrink()` never ran, the window never narrowed, and the loop retried
        // the identical range forever. Production callers happen to pass a
        // logger, which is the only reason this was survivable.
        const before = sizing.value;
        const after = sizing.shrink();
        options.onChunkShrink?.(before, after);
        continue; // retry the same cursor with a smaller window
      }
      // Spec §23: back off on transient failures, bounded — never forever.
      if (isRateLimited(error) && attempt < maxAttempts) {
        attempt += 1;
        const delayMs = 250 * 2 ** attempt;
        options.onRetry?.(attempt, delayMs, text(error));
        await sleep(delayMs);
        continue;
      }
      throw new TransientProviderError(
        `eth_getLogs failed for ${params.address} [${range.fromBlock}, ${range.toBlock}]`,
        { cause: text(error) },
      );
    }

    attempt = 0; // this chunk succeeded; the next one starts with a full budget
    await onChunk(logs, range);
    cursor = range.toBlock + 1n;
  }
}
