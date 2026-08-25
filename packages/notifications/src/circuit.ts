import { eq, sql } from 'drizzle-orm';
import { notifierCircuit, type Database, type DbOrTx } from '@sdb/database';
import { isRetryable } from '@sdb/shared';

/**
 * Circuit breaker for a notification transport.
 *
 * Phase 6 measured the problem this solves: a permanently failing transport
 * produced one failed delivery per feature evaluation per token — 5 evaluations
 * gave 5 failed sends, and roughly 8 per token across the §13 snapshot series.
 * The cause is that `FAILED` is excluded from the dedup baseline (correctly —
 * §20 requires the signal stay re-alertable), so every evaluation records a
 * fresh alert that fails identically.
 *
 * The distinction the pipeline was missing: a 401/403 is a GLOBAL configuration
 * fault, not a per-token one. Retrying it per token cannot help, because it will
 * fail the same way for every token forever.
 *
 * When the breaker is open the alert stays PENDING — an obligation still owed —
 * rather than churning to FAILED. That is the safe direction: an operator can
 * fix the credentials and the backlog drains, where FAILED would have burned
 * each alert into a re-alert loop.
 */

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export type CircuitConfig = {
  enabled: boolean;
  /** Consecutive global failures before opening. */
  failureThreshold: number;
  /** How long to stay open before admitting a probe. */
  openDurationMs: number;
};

export type CircuitSnapshot = {
  notifier: string;
  state: CircuitState;
  consecutiveFailures: number;
  openedAt: Date | null;
  reopenAfter: Date | null;
  lastFailureCode: string | null;
  lastFailureReason: string | null;
  lastSuccessAt: Date | null;
};

/**
 * Classify a delivery failure.
 *
 * Only failures that will recur identically for EVERY alert count toward the
 * breaker. A malformed message — often a token whose symbol produced bad markup
 * — must fail alone; letting it silence alerting for every other token would be
 * a worse bug than the one being fixed.
 *
 * The transport decides globality where it can, because only it knows its own
 * error vocabulary. Measured against the live Telegram API: a wrong chat id
 * answers `400 chat not found` and a revoked token answers `404 Not Found`,
 * so an HTTP-status table classifies both of the most likely misconfigurations
 * wrong. The status heuristic remains only as a fallback for a transport that
 * offers no hint.
 *
 * A retry-exhausted transient counts regardless: five failed attempts against a
 * 5xx is evidence of a sustained outage, and without it a 10-minute Telegram
 * problem would reproduce exactly the FAILED spam this phase exists to stop.
 */
export function isGlobalFailure(error: unknown, retriesExhausted: boolean): boolean {
  // A transient is global only once it has spent its whole retry budget —
  // never on the transport's say-so, which cannot know how many attempts remain.
  if (isRetryable(error)) return retriesExhausted;

  const hint = globalHintOf(error);
  if (hint !== null) return hint;

  // Fallback for a transport that does not classify its own faults.
  const status = httpStatusOf(error);
  return status === 401 || status === 403;
}

function globalHintOf(error: unknown): boolean | null {
  if (!error || typeof error !== 'object') return null;
  const context = (error as { context?: Record<string, unknown> }).context;
  const hint = context?.['global'];
  return typeof hint === 'boolean' ? hint : null;
}

function httpStatusOf(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const context = (error as { context?: Record<string, unknown> }).context;
  const status = context?.['httpStatus'];
  return typeof status === 'number' ? status : null;
}

/** Short stable code for the audit record. */
export function failureCodeOf(error: unknown): string {
  const status = httpStatusOf(error);
  if (status !== null) return `HTTP_${status}`;
  return error instanceof Error ? error.name : 'UNKNOWN';
}

export type Decision =
  | { allow: true; probe: boolean }
  | { allow: false; retryAt: Date };

/**
 * May this delivery proceed?
 *
 * `probe` marks the single attempt admitted after the open window elapses. The
 * notification worker runs at concurrency 1, so exactly one probe is in flight
 * without additional locking.
 */
export function decide(
  snapshot: CircuitSnapshot | null,
  config: CircuitConfig,
  now: Date = new Date(),
): Decision {
  if (!config.enabled) return { allow: true, probe: false };
  if (!snapshot || snapshot.state === 'CLOSED') return { allow: true, probe: false };

  const reopenAfter = snapshot.reopenAfter;
  if (reopenAfter === null || now >= reopenAfter) {
    // Open window elapsed: admit one probe to test recovery.
    return { allow: true, probe: true };
  }
  return { allow: false, retryAt: reopenAfter };
}

export type Transition = {
  next: CircuitState;
  consecutiveFailures: number;
  /** True only on the CLOSED/HALF_OPEN -> OPEN edge, so audit fires once. */
  justOpened: boolean;
  /** True only on the -> CLOSED edge. */
  justClosed: boolean;
  reopenAfter: Date | null;
};

/** Any success closes the circuit and clears the counter (requirement 6). */
export function onSuccess(snapshot: CircuitSnapshot | null): Transition {
  const wasOpen = snapshot !== null && snapshot.state !== 'CLOSED';
  return {
    next: 'CLOSED',
    consecutiveFailures: 0,
    justOpened: false,
    justClosed: wasOpen,
    reopenAfter: null,
  };
}

/**
 * Apply a failure.
 *
 * A non-global failure leaves the circuit untouched — including its counter, so
 * a scatter of per-message 400s can never accumulate into an opening.
 */
export function onFailure(
  snapshot: CircuitSnapshot | null,
  input: { global: boolean; config: CircuitConfig; now?: Date },
): Transition {
  const now = input.now ?? new Date();
  const current = snapshot?.state ?? 'CLOSED';
  const failures = snapshot?.consecutiveFailures ?? 0;

  if (!input.global || !input.config.enabled) {
    return {
      next: current,
      consecutiveFailures: failures,
      justOpened: false,
      justClosed: false,
      reopenAfter: snapshot?.reopenAfter ?? null,
    };
  }

  const next = failures + 1;
  const reopenAfter = new Date(now.getTime() + input.config.openDurationMs);

  // A failed probe re-opens with a fresh window rather than retrying immediately.
  if (current === 'OPEN' || current === 'HALF_OPEN') {
    return {
      next: 'OPEN',
      consecutiveFailures: next,
      justOpened: false,
      justClosed: false,
      reopenAfter,
    };
  }

  if (next >= input.config.failureThreshold) {
    return { next: 'OPEN', consecutiveFailures: next, justOpened: true, justClosed: false, reopenAfter };
  }

  return {
    next: 'CLOSED',
    consecutiveFailures: next,
    justOpened: false,
    justClosed: false,
    reopenAfter: null,
  };
}

// ---------------------------------------------------------------- persistence

export async function readCircuit(
  db: DbOrTx,
  notifier: string,
): Promise<CircuitSnapshot | null> {
  const rows = await db
    .select()
    .from(notifierCircuit)
    .where(eq(notifierCircuit.notifier, notifier))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  return {
    notifier: row.notifier,
    state: row.state as CircuitState,
    consecutiveFailures: row.consecutiveFailures,
    openedAt: row.openedAt,
    reopenAfter: row.reopenAfter,
    lastFailureCode: row.lastFailureCode,
    lastFailureReason: row.lastFailureReason,
    lastSuccessAt: row.lastSuccessAt,
  };
}

/** Persist a transition. Upsert, so the first observation creates the row. */
export async function writeCircuit(
  db: Database,
  notifier: string,
  transition: Transition,
  failure: { code: string; reason: string } | null,
  now: Date = new Date(),
): Promise<void> {
  const values = {
    notifier,
    state: transition.next,
    consecutiveFailures: transition.consecutiveFailures,
    openedAt: transition.next === 'OPEN' ? now : null,
    reopenAfter: transition.reopenAfter,
    lastFailureCode: failure?.code ?? null,
    lastFailureReason: failure?.reason.slice(0, 500) ?? null,
    lastFailureAt: failure ? now : null,
    lastSuccessAt: failure ? null : now,
    updatedAt: now,
  };

  await db
    .insert(notifierCircuit)
    .values(values)
    .onConflictDoUpdate({
      target: notifierCircuit.notifier,
      set: {
        state: values.state,
        consecutiveFailures: values.consecutiveFailures,
        // Preserve the original opening time across a failed probe, so
        // "how long has alerting been down" stays answerable.
        // ISO string with an explicit cast: the driver does not serialize a JS
        // Date through a raw sql`` parameter and fails at bind time. Same trap
        // that broke snapshots in Phase 2 and the wallet lookup in Phase 4.
        openedAt:
          transition.next === 'OPEN'
            ? sql`coalesce(${notifierCircuit.openedAt}, ${now.toISOString()}::timestamptz)`
            : null,
        reopenAfter: values.reopenAfter,
        lastFailureCode: failure ? values.lastFailureCode : notifierCircuit.lastFailureCode,
        lastFailureReason: failure ? values.lastFailureReason : notifierCircuit.lastFailureReason,
        lastFailureAt: failure ? now : notifierCircuit.lastFailureAt,
        lastSuccessAt: failure ? notifierCircuit.lastSuccessAt : now,
        updatedAt: now,
      },
    });
}
