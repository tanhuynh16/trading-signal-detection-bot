# ADR 0012 — A feature that cannot be measured is null

**Status:** accepted (Phase 4)

## Context
§15 states it plainly: "Do not silently substitute zero for unavailable data."
Every §15 feature has a tempting default that looks like a real value —
acceleration of 1.0 ("no change"), buy/sell ratio of 0, holder growth of 0. Each
is a claim about the token that we have not measured.

The stakes are concrete. `volume_acceleration_5m` needs the current 5-minute
window plus the three priors §15.2 averages over — roughly 20 minutes of
history. A token six minutes old has none. Reporting 1.0 tells the scorer
"momentum is flat" when the truth is "we have not watched long enough."

## Decision
Every feature returns `number | null`, and null propagates to storage as JSON
`null`. Verified in a live run: 142 of 145 rows had a null acceleration and
**zero** had it coerced to 0.

The distinction is preserved even where a zero is legitimate:

| Case | Value |
|---|---|
| Window exists, no trades occurred | `trade_velocity: 0` |
| No window to measure | `trade_velocity: null` |
| Seeded wallet list exists, none entered | `independent_smart_wallet_count: 0` |
| No seeded wallet list at all | `independent_smart_wallet_count: null` |

## Measured coverage
A 9-minute live run, showing how much of §15 is genuinely knowable at each age:

```
holder_count, trade_velocity     145/145   always computable
holder_growth_rate               113/145   null on a token's first calculation
liquidity_usd                     67/145   null without a USD path
top10_concentration               29/145   needs supply and holders
cluster_concentration              9/145   needs a detected cluster
volume_acceleration_5m             3/145   needs ~20 minutes of history
smart_wallet_*                     0/145   seed list is empty
```

That table is the feature engine working correctly, not failing. Phase 5's
coverage renormalisation (plan G1) divides by the weight actually present, so
sparse early coverage lowers confidence rather than silently scoring zero.

## Consequences
Phase 5 must handle nulls in every component — which G1 already requires.

`smart_wallet_*` being uniformly null is the designed state while the §15.5
seed list is empty. Scoring it 0 would cap every token near 70 and make
`STRONG_SIGNAL` unreachable, which is precisely the failure G1 was written to
prevent.
