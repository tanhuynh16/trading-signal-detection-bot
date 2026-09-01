/**
 * Spec §23 distinguishes transient provider failures (retry with backoff) from
 * permanent invalid-data errors (route to failed/audit storage, never retry
 * forever). The queue layer branches on `retryable`.
 */
export abstract class SdbError extends Error {
  abstract readonly code: string;
  abstract readonly retryable: boolean;

  constructor(
    message: string,
    readonly context: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** Provider is up but failed this call: timeout, 5xx, rate limit, socket drop. */
export class TransientProviderError extends SdbError {
  readonly code = 'TRANSIENT_PROVIDER_ERROR';
  readonly retryable = true;
}

/** Provider returned something that will never become valid. Do not retry. */
export class InvalidDataError extends SdbError {
  readonly code = 'INVALID_DATA';
  readonly retryable = false;
}

/** Config failed validation. Fatal at startup (§19: validate config). */
export class ConfigurationError extends SdbError {
  readonly code = 'CONFIGURATION_ERROR';
  readonly retryable = false;
}

/** A pool/token no longer exists or is unreadable; caller should stop tracking. */
export class ResourceGoneError extends SdbError {
  readonly code = 'RESOURCE_GONE';
  readonly retryable = false;
}

/**
 * The provider is healthy but no longer holds the blocks being asked for.
 *
 * Distinct from `TransientProviderError` because retrying is not merely
 * wasteful, it can never succeed: a non-archive node has pruned that state and
 * no amount of backoff brings it back. Measured on Chainstack's plan, history
 * reaches only ~128 blocks (~4.3 minutes on Base), so a cursor that falls
 * outside the window would otherwise retry every drain forever, making no
 * progress and reporting nothing more useful than "drain failed" (ADR 0023).
 *
 * The caller's correct response is to skip forward and record the gap, never to
 * retry and never to pretend the skipped range was read.
 */
export class ProviderHistoryUnavailableError extends SdbError {
  readonly code = 'PROVIDER_HISTORY_UNAVAILABLE';
  readonly retryable = false;
}

export function isRetryable(error: unknown): boolean {
  return error instanceof SdbError ? error.retryable : true;
}
