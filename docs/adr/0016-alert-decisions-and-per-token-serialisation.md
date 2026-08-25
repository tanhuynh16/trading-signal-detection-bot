# ADR 0016 — Alert decisions, per-token serialisation, and monotonic ordering

**Status:** accepted (Phase 5.1)

The Phase 5 audit found two defects. Fixing them surfaced a third that neither
the audit nor the original tests had caught.

## 1. Serialise per token; do not enforce global uniqueness

`evaluateSignal` read the current state and wrote a new one across six awaits
with no lock, and `signals` had no uniqueness guard. Two concurrent evaluations
could both read WATCHING, both compute INTERESTING, and both insert.

A unique index on `(token_id, state)` would close it but would also **break
legitimate state re-entry**: with `downgradePolicyEnabled` a token may go
STRONG_SIGNAL → WATCHING → INTERESTING → WATCHING, which §18 explicitly permits.
Narrowing a spec'd option to work around a race is the wrong trade.

Instead the whole read-decide-write sequence runs in one transaction holding
`pg_advisory_xact_lock(hashtext(token_id))`. Transaction-scoped, so it releases
on commit or rollback with no cleanup path to get wrong. A `hashtext` collision
serialises two unrelated tokens — contention, never incorrectness.

## 2. Alert lifecycle is not the alert trigger

§18's dedup exceptions were unreachable: `shouldAlert()` sat below an early
return that fired whenever the state was unchanged, and with no-downgrade each
state is entered once, so only `first_alert` and `level_upgraded` could ever
occur. Measured before the fix: 75 of 98 evaluations skipped dedup entirely.

Dedup now runs on every evaluation. Decisions live in a new `signal_alerts`
table so **ADR 0015 stands** — `signals` remains the canonical
state-transition entity, one row per state entry, and §21 attaches outcomes only
to it. One signal can own several alert decisions over its life.

Two independent axes, not a boolean:

| `trigger_reason` | `status` |
|---|---|
| `FIRST_ALERT`, `LEVEL_UPGRADED`, `SCORE_MOVED`, `COOLDOWN_ELAPSED` | `PENDING`, `SENT`, `FAILED`, `SUPPRESSED` |

A boolean cannot express "decided to alert, tried, failed" — exactly the state
Phase 6 must retry, and §20 requires a Telegram failure never discard the signal.

Cooldown keys on `status IN ('SENT','PENDING')`. `SENT` is delivery. `PENDING`
is in flight and counts, or a second alert would queue for the same fact before
the first is sent — and until Phase 6 exists nothing reaches `SENT`, so
excluding it would make every evaluation re-alert. `FAILED` and `SUPPRESSED` are
excluded, so a failed delivery becomes re-alertable rather than swallowed.

Suppressed decisions are recorded too, with their reason, so Phase 8 can tune
`rescoreDelta` and `cooldownMinutes` against evidence instead of guesswork.

## 3. `now()` is transaction-start time — found by the new tests

The concurrency test was flaky: one failure in six runs. The cause was not the
lock, which worked correctly.

`created_at` defaults to `now()`, which in Postgres is **transaction start**
time and identical for every statement in a transaction. Two overlapping
transactions can therefore write rows whose `created_at` order contradicts their
commit order. `currentSignal()` ordered by `created_at DESC LIMIT 1`, so it could
return a **stale state** — and the next evaluation would redo a transition that
had already happened, producing exactly the duplicate the lock was meant to
prevent.

The lock serialised the writes; the read picked the wrong row.

Both `signals` and `signal_alerts` now carry a `seq bigserial` allocated at
insert time. Under the per-token lock, sequence order is commit order. Ordering
is by `seq`, not by time.

This is a general trap: any "latest row wins" query ordered by a `now()`-default
timestamp is unreliable under concurrency. Verified directly — `now()` returns
an identical value across statements 50ms apart while `clock_timestamp()`
advances.

## Verification

Eight consecutive runs of the concurrency suite passed after the fix, against
one failure in six before it.

Live over nine minutes:

```
trigger_reason | suppression_reason   | status     | count
FIRST_ALERT    |                      | PENDING    | 1
SCORE_MOVED    |                      | PENDING    | 1
               | suppressed_duplicate | SUPPRESSED | 1
```

`SCORE_MOVED` firing on real data is the direct proof: that branch was
unreachable dead code before this patch. One signal owned multiple alert
decisions with no extra `signals` row, and both invariants held — zero duplicate
`(token_id, state)` rows and exactly one transition per signal.

`COOLDOWN_ELAPSED` needs 60 minutes and did not appear in the window; it is
covered by an integration test rather than claimed from the live run.

## Consequences

`downgradePolicyEnabled` stays available, and a test proves re-entry works with
it on. Migrations 0002 and 0003 are additive: a new table plus two columns, no
constraint added to existing data.
