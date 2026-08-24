# ADR 0013 — Holder balances are relative to when tracking began

**Status:** accepted (Phase 4)

## Context
ADR 0005 established that holder features have no reproducible source but our
own `Transfer` log replay. The indexer starts tailing a token when it enters the
tracked set — at pool discovery — not at token deployment.

A token is often deployed and distributed *before* its pool is created. A wallet
that received tokens in that window and then sells produces a debit with no
matching credit, so its stored balance goes **negative**.

## Decision
Accept partial history rather than backfilling to token deployment, and treat
negative balances as the artifact they are.

Backfilling was rejected on cost: the provider caps `eth_getLogs` at 10 blocks,
so reconstructing full history per token would multiply request volume against a
budget already saturated (measured: 134 throttle backoffs in a 9-minute run with
all four phases active).

Consumers filter accordingly:
- `holder_count`, `top10_concentration`, `holder_retention` already require a
  balance above the dust threshold, so negatives were never counted.
- `cluster_concentration` sums balances and **did not** filter. Negative
  balances dragged the denominator to zero or below, and the feature returned
  null for every token in a live run — silently, because null is also its
  legitimate "no cluster found" answer. It now sums positive balances only,
  after which the feature measured on 9 of 145 rows.

## Consequences
Holder counts are accurate for the population that acquired after tracking
began, which is the population that matters for a token being evaluated in its
first hour.

Absolute holder totals may understate a token whose distribution predates its
pool. Concentration ratios are computed over observed positive balances, so they
describe the tracked cohort rather than the entire holder set — a limitation
worth remembering when reading `top10_concentration` for an older token.

Clustering runs only at the 5m, 30m and 1h offsets rather than on every
snapshot: holder sets barely move in 30 seconds, and re-running the funding
lookups added request load for no new information.
