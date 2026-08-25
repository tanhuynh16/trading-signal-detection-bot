# ADR 0018 — A circuit breaker for globally broken notification

**Status:** accepted (Phase 6.1)

## Context

Phase 6 closed with delivery working and one measured defect left open: **a
permanently failing transport produced one failed delivery per feature
evaluation, per token.**

Measured: 5 successive evaluations produced 5 `PENDING` alerts and 5 failed
sends — roughly 8 per token across the §13 snapshot series, ~160 across a
20-pool run.

The cause is not a bug in dedup. `FAILED` is excluded from the dedup baseline
deliberately, because §20 requires that a send failure must not discard the
signal. So every evaluation correctly sees no prior alert, returns
`first_alert`, and records a fresh row that the `(signal_id, feature_set_id)`
unique key cannot block. Each one then fails in exactly the same way.

The distinction the pipeline was missing: **a broken credential is a global
fault, not a per-token one.** Retrying it per token cannot help, because it
fails identically for every token until an operator intervenes.

## Decision

A circuit breaker sits in front of the transport. After
`NOTIFIER_CIRCUIT_FAILURE_THRESHOLD` (default 3) consecutive *global* failures
it opens for `NOTIFIER_CIRCUIT_OPEN_MS` (default 5 minutes), after which one
probe is admitted; any success closes it and clears the counter.

**While open, the alert stays `PENDING` — it is not marked `FAILED`.** That is
the safe direction. `PENDING` is an obligation still owed: fix the credentials
and the backlog drains. `FAILED` would burn the alert into the re-alert loop
this ADR exists to stop.

The job is rescheduled with BullMQ's `moveToDelayed` + `DelayedError`, which the
worker treats as *rescheduled* rather than *failed*, so holding an alert costs
no retry attempt. `guarded()` rethrows `DelayedError` explicitly — swallowing it
would mark the job complete and orphan the alert it was holding.

## State lives in Postgres, not Redis

The breaker must survive a restart *and* a `FLUSHALL`, and it is the
operator-facing record of *why* alerting went quiet. `notifier_circuit` holds
one row per transport with the state, the consecutive count, when it opened,
when a probe is next admitted, and the last failure and success.

Verified live: with Redis flushed between runs the circuit was still `OPEN` with
its counter intact, and the startup requeue rebuilt the queue from the durable
`signal_alerts` rows.

## HTTP status alone cannot classify a Telegram fault

The original design classified globality from the status code: 401/403 global,
400 per-message. Probing the live Bot API showed that table is wrong on both of
the most likely misconfigurations:

| Fault | Actual response |
|---|---|
| Wrong chat id | `400 Bad Request: chat not found` |
| Empty chat id | `400 Bad Request: chat_id is empty` |
| Revoked or malformed bot token | `404 Not Found` |
| Bot blocked / not started | `403 Forbidden: …` |

A wrong chat id — the single most likely misconfiguration, and the thing this
phase exists to contain — answers **400**, which the status table called
per-message. The breaker would never have opened on it. A revoked token answers
**404**, which fell through to the transient branch and was not global either.

So the transport classifies its own faults: `TelegramNotifier` sets
`global: true|false` in the error context, because only it knows Telegram's
error vocabulary. `isGlobalFailure` prefers that hint and keeps the status
heuristic only as a fallback for a transport that offers none.

A 400 is still per-message *by default* — a token whose symbol produced bad
markup must fail alone rather than silencing alerting for every other token.
Only a description naming a configuration fault promotes it.

One rule the transport may not override: a **retryable** error is global only
once its retry budget is exhausted. The transport cannot know how many attempts
remain, and without exhaustion a single 503 blip would open the circuit. With
it, a sustained outage still opens — five failed attempts against a 5xx is
evidence enough, and otherwise a 10-minute Telegram problem would reproduce
exactly the `FAILED` spam this phase removes.

## Alerting going silent is never itself silent

Opening writes an `error` log naming the transport, failure code, consecutive
count and next probe time, plus one `jobs_audit` row with
`status = 'circuit_open'` — once per opening, not per suppressed job. Closing
logs at `info` with how long it was open.

## Consequences

- A broken credential now costs **at most `failureThreshold` failed sends in
  total**, not one per evaluation per token.
- Held alerts accumulate as `PENDING` during an outage. That is the correct
  outstanding obligation; the half-open probe and the startup requeue drain them
  once the transport recovers.
- The breaker is global to a transport, so a single genuinely broken chat
  suppresses delivery for every token. That is the intended trade: the
  alternative is the unbounded failure loop it replaces.
- Multi-process deployment would let several workers probe at once. The
  notification worker is `concurrency: 1`, so this is noted as a limitation
  rather than solved speculatively.

## Live verification

Bad chat id, 6 seeded alerts, real Bot API:

- attempts stopped at exactly 3; the circuit opened with `HTTP_400`
- all 6 alerts stayed `PENDING` — **zero `FAILED`**
- exactly one `circuit_open` audit row

Then Redis flushed, the window aged, the real chat id restored:

- the circuit was still `OPEN` after the flush (durability)
- the probe succeeded, the circuit closed after 109.8s open
- all 3 held alerts delivered, `sent_at` populated

## A defect found on the way

`redactDeep` rebuilt every object from its own enumerable properties. `Date` and
`Error` have none, so both were logged as `{}` — silently, everywhere in the
project. The circuit's "when will a probe be admitted" was blank because of it,
and so was `logger.error({ err: reason }, 'unhandled rejection')` in `main.ts`,
the one line §24 exists to make visible. Both are now preserved, still scrubbed.
