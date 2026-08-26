# ADR 0020 — Measure outcomes only over provably indexed history

**Status:** accepted (Phase 7.1). Corrects a defect in [ADR 0019](0019-outcome-measurement-from-indexed-trades.md).

## Context

ADR 0019 made the outcome price path read from `trades` rather than the chain,
which is what makes a 24h horizon affordable. It did not ask whether the trades
were *there yet*.

An audit of the running system found they frequently were not. **13 of 176
outcome rows (7.4%) were finalised from incomplete trade history.**

The cause is structural, not a narrow race. The outcome job fires at wall-clock
`T0 + horizon` and queries trades with `occurred_at <= T0 + horizon`, but
`occurred_at` is *block* time. Blocks bearing that timestamp are only just being
produced, so the tail's coverage is **by construction** short of the window end
at every evaluation. Whether that yields a wrong number depends only on whether
a trade happened in the gap.

Measured tail ingestion latency, `created_at - occurred_at` over 1,165 trades:

| p50 | p90 | p99 | max |
|---|---|---|---|
| 2.8s | 112.9s | 605.5s | 659.8s |

At p90 an entire 1-minute window can be un-ingested when its horizon fires.

Two mechanisms then made it permanent: `onConflictDoNothing` on the insert, and
the reconciler's `notExists` filter, which skips any signal/horizon that already
has a row — correct or not. Nothing in the system could detect or repair it.

Worst measured case, signal `36418995` at 15m:

| | stored | true |
|---|---|---|
| `trade_count` | 22 | 66 |
| `return_pct` | 33.546960 | **79.023816** |
| `max_runup_pct` | 33.968216 | **79.023816** |

The most damaging shape was subtler. Signal `36dccbb0`'s 1m outcome recorded
`return_pct = 0.000000` with `trade_count = 0` and **no failure reason** — the
"no trades means genuinely flat" rule ADR 0019 documented as honest. Four trades
worth +4.95% existed; the tail simply had not caught up. An outcome that says
"measured, flat" is indistinguishable from a real reading, so this form of the
bug is invisible in the data §22 would consume.

## Decision

**Do not measure a window until the swap tail has provably indexed past its
end.**

The tail already maintains a sound watermark: it persists trades *before*
advancing the cursor, and advances monotonically via `greatest()`, so the cursor
is a conservative lower bound on what is stored. The only gap was dimensional —
the cursor is a block *number*, the window is a *time range*.

`discovery_cursors` gains `last_processed_block_time`. The tail stamps it with
the head block's timestamp **only after every address batch has completed
without throwing**, so a mid-drain failure leaves the older, conservative value.
Cost is one `getBlock` per completed drain: at the measured 5.8s median cadence,
~620 calls an hour, about 1% of the free-tier budget.

Outcome evaluation compares that watermark against the window end. Short of it,
the job reschedules with `moveToDelayed` + `DelayedError` — the Phase 6.1
mechanism, which defers without consuming a retry attempt.

A null watermark is treated as *not covered*. "We have no idea" is the one thing
that must never be mistaken for completeness.

### Waiting is bounded

A stalled drain, or a pool aged out of tail retention, must not leave a horizon
deferring forever with nothing recorded. Past `windowEnd + OUTCOME_MAX_DEFER_MS`
the row is written with `failure_reason = 'incomplete_tail_coverage'` and null
metrics — §27's discipline that an unmeasurable result is recorded with its
reason, never as a number derived from a window known to be short.

Tail retention rises from 25h to 26h so the 24h horizon plus a full deferral
still lands inside the window where its pool is being indexed.

## Repair, and what §21 immutability actually protects

The gate cannot fix rows already written. Those needed the first `UPDATE` path
to `signal_outcomes` in the system.

§21 requires historical outcomes stay immutable so strategy changes cannot
rewrite what a past signal meant. That protects against *reinterpretation*. It
was never meant to preserve a measurement taken before the data existed — a
reading of an incomplete window is not a historical fact, it is a bug.

So a sweep recomputes them, with two safeguards:

- **The gate applies to repair too.** Rewriting from coverage that is still
  short would swap one wrong number for another.
- **Every correction is visible.** `revision` increments and `evaluated_at`
  moves, so a restated measurement can never be mistaken for an original one,
  and each repair logs old → new.

Detection needs no new bookkeeping: a trade whose `created_at` is later than the
outcome's `evaluated_at` is proof the row was computed without it. That is
exactly the query that found the original 13. Both sides of that comparison now
come from Postgres' clock — `evaluated_at` was being stamped by the application,
and clock skew between the two could have hidden genuinely late trades.

The sweep is self-terminating: once repaired under full coverage, `evaluated_at`
moves past every trade's `created_at` and the row stops matching.

## Consequences

- Outcomes are measured later than the horizon, by the tail's lag. §21 fixes
  when a horizon *elapses*, not when it must be computed, so this costs nothing
  but latency.
- A prolonged tail outage produces `incomplete_tail_coverage` rows rather than
  wrong numbers. They are repaired automatically once coverage returns.
- `signal_outcomes` rows are no longer write-once. The revision counter is what
  keeps that honest.
- The gate can be disabled by config, which restores exactly the old behaviour —
  and is documented as doing so.

## Not addressed here

The audit found three further issues, each left deliberately separate: no reorg
handling anywhere in the tail (swaps are indexed to `head` with zero
confirmations and never removed); window edges mixing Postgres wall time with
block time; and integration tests sharing the live database, which had already
destroyed one live verification run and was causing flaky failures across
suites. The last is partly mitigated here — test files now clean only the cursor
rows they own — but the underlying sharing remains.
