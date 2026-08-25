# ADR 0015 — Feature→component mapping and nested renormalisation

**Status:** accepted (Phase 5)

## Context
§17 names four scoring components and gives their weights, but never says which
§15 features feed them. §16 requires normalizers and says "scoring defines
whether missing data excludes a feature or applies a neutral score" — leaving
the null policy to the implementation.

## Decision: the mapping follows §15's own structure

| Component | Weight | §15 source |
|---|---|---|
| liquidity | 0.20 | §15.1 |
| momentum | 0.30 | §15.2 |
| holder | 0.20 | §15.3 |
| smartMoney | 0.30 | §15.5 |

**§15.4 `cluster_concentration` maps to no component**, which is exactly why
§17's formula ends `- configured_penalties`. A large share of supply held by one
detected cluster is evidence that the apparent organic interest is a single
actor, so it subtracts rather than contributing. A null cluster reading applies
no penalty: absence of evidence is not evidence.

Three features are inverted (`mc_liquidity_ratio`, `top10_concentration`,
`smart_wallet_entry_recency`) because higher is worse.

## Decision: renormalise at BOTH levels

Plan G1 renormalises across components. Phase 5 needs the same treatment
*within* a component:

```
component = Σ(wᵢ·fᵢ | fᵢ≠null) / Σ(wᵢ | fᵢ≠null)    → null if all null
alpha     = Σ(Wc·Cc | Cc≠null) / Σ(Wc | Cc≠null)
```

The inner level is load-bearing, not a refinement. `volume_acceleration_5m` is
null for roughly the first 20 minutes of every token's life, so a momentum
component holding three of four features is the *common* case. Without inner
renormalisation that component is diluted by an implicit zero and momentum reads
weak precisely when a token is newest — reintroducing the null-as-zero failure
the pipeline exists to avoid. A test pins this: one saturated feature scores the
component 100 under `renormalize` and 30 under `zero`.

## Normalizers (§16)

- **log** for values spanning orders of magnitude (`liquidity_usd`,
  `holder_count`, `trade_velocity`). On a linear $1k–$1M scale, $10k and $100k
  both land in the bottom tenth — where every new pool lives. A test asserts log
  separates them by >30 points where min-max separates them by <11.
- **boundedRatio** for multiples centred on 1.0 (`buy_sell_ratio`,
  `volume_acceleration_5m`), where 1.0 is a meaningful neutral rather than an
  arbitrary point. §19's thresholds (3.0 acceleration, 1.2 ratio) are asserted
  to land in the informative middle of the curve, not at an extreme.
- **minMax with clipping** for already-bounded features. Values outside the
  range clip: 300% retention is a data error, not three times better than 100%.

## §18 state machine

Pure and deterministic (§27). One `signals` row per **state entry**, never
updated — §21 needs a frozen reference price per emitted signal and §22 requires
historical signals to keep their original meaning. Transitions go to
`signal_transitions`.

Two readings worth recording:

- §17's band table calls 0–39 "Ignore", but §18 defines no Ignore state. A
  low-scoring token simply never upgrades past WATCHING. §18's transitions are
  normative; the band table is descriptive.
- A token with no risk verdict yet is treated as **WARNING, not PASS**. §14
  makes risk a gate, and an unevaluated token has not passed it.

Thin evidence caps at INTERESTING: a score of 95 computed on one component out
of four is 95 on a quarter of the picture, and §17's bands assume a full
assessment.

## Calibration — measured, not asserted

A 19-minute live run produced a genuine distribution rather than a degenerate
one:

```
band   0-9  10-19  20-29  30-39  40-49  50-59  60-69
count   10     18      1      1      1      1      3
```

30 tokens reached WATCHING (avg 14.6), 3 reached INTERESTING (avg 63.1), 2
expired on `liquidity_collapse`. Coverage sat at exactly 0.700 — smartMoney null
with an empty seed list — comfortably above `minCoverage` 0.6, so STRONG_SIGNAL
remains reachable. No token reached 75 in that window, which is unremarkable
over 19 minutes.

Every bound remains an initial hypothesis (§17, §19). Real tuning is Phase R
replay plus Phase 8 evaluation.

## Consequences

Phase 5 sets `alert_level` and stops. Sending is Phase 6 and nothing is enqueued
to the notification queue yet (§29).

Verified invariants: no signal under a risk FAIL carries an alert level (§27),
no token has duplicate rows for the same state, and every signal has exactly one
transition row (35/35).
