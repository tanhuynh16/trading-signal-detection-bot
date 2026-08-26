# ADR 0019 — Outcome measurement from indexed trades

**Status:** accepted (Phase 7). **Supersedes ADR 0004.**

## Context

§21 requires `return_pct`, `max_runup_pct` and `max_drawdown_pct` at seven
horizons out to 24h for every emitted signal. Without them §22 has nothing to
evaluate and every threshold in §19 stays an unvalidated guess.

Three things stood in the way, all found by reading the code rather than the
spec:

- `trades.price_usd` was written as `NULL` for every row. The tail stores signed
  `amount0`/`amount1` and defers orientation to snapshot time, so there was no
  stored price path to read.
- The tail stopped indexing a pool at `maxTokenAgeMinutes` (6h), so the 24h
  horizon had no trade data at all.
- **ADR 0004 was obsolete.** It planned to `eth_getLogs` the pool's swaps from
  signal time to now. It was written in Phase 0, before the global tail
  (ADR 0008) and before the provider's 10-block `eth_getLogs` cap was measured.
  Backfilling 24h for one pool is ~4,300 requests — per signal, per horizon.

## Decisions

### The price path comes from Postgres, not the chain

The global tail already persists every Swap for tracked pools. A horizon job
reads them and makes **no RPC call at all**, which is what makes a 24h horizon
affordable. Extending tail retention to cover signalled pools costs nearly
nothing — the same block ranges are already being scanned, the filter just
carries more addresses.

That cost is not zero, so the drain logs a warning whenever the tracked pool
count exceeds one `eth_getLogs` filter, because past that point each batch is a
real extra request per block chunk.

### Every non-EXPIRED state entry is measured, not just alerted signals

§22 must be able to ask whether the alpha score predicts anything *at all*, and
that needs the low-score control group — measuring only what we alerted on can
compare INTERESTING against STRONG but can never establish that either beats a
token we ignored. The marginal cost is rows and delayed jobs, not RPC.

`EXPIRED` is excluded: the return of an expiry event measures nothing, and
including it would have the reconciler manufacture outcomes for every expiry
ever recorded.

### USD is denominated against a sampled quote-price series

The resolver already refreshes WETH/USD on a TTL, so each refresh is persisted
to `quote_price_samples` at zero extra RPC cost. Each trade is priced at the
sample nearest in time, within a bounded tolerance.

The alternative — one spot rate applied to the whole window — would let a 24h
ETH move contaminate every return and rescale the runup and drawdown extrema by
the wrong factor. Past the tolerance the trade is left unpriced rather than
reaching for a stale rate; if too much of a path is unpriceable the outcome
records `insufficient_quote_coverage` instead of a misleading number (§27).

Stablecoin quotes are pegged and need no series — $1 is as true historically as
it is now.

### Execution price, not pool mid

Each swap is priced from the ratio of the amounts it moved, which is the price
the trade actually paid, inclusive of fees and slippage. For runup and drawdown
that is the more honest figure: a mid price is one nobody could have traded at.

### The signal price is the path's first point

So a token that only ever falls reports `max_runup_pct = 0` rather than a
negative "maximum gain". This keeps `runup >= 0 >= drawdown` true for every row,
which is the standard reading of §21's "relative to signal price" and an
invariant worth being able to assert.

### The reconciler, not Redis, is the durability guarantee

§21 asks for the same durable scheduling as snapshots, and all seven horizons
are enqueued at once when the state entry is recorded — §13 forbids jobs that
schedule more jobs, and for a 24h horizon a broken chain would go unnoticed for
a day.

But a 24h BullMQ delay lives in Redis, and Phase 6.1 settled that a long-lived
obligation cannot live only there: a restart is survivable, a `FLUSHALL` is not.
A sweep every five minutes finds horizons that have elapsed with no
`signal_outcomes` row and rebuilds the queue from the durable `signals` table.
It also backfills signals emitted before this phase existed.

## Multiply before dividing — measured, not theorised

The live run exposed a precision defect in the obvious implementation.

Pricing a swap as `toUsd(div(quote, base), quoteUsd)` — the two-step form
snapshots use — truncates the quote-denominated price to 18 decimals *before*
applying the USD rate. On a real Base token from the run, a price of 8.5e-15 ETH
survives that intermediate as the integer **8527**: four significant digits, and
a 1.0e-4 relative error in the result.

The worse half is silent. A token below 1e-18 ETH truncates to zero and is
discarded as unpriceable, even though its USD price stores exactly — with ETH
near $2,500 that is any token under about $2.5e-15. **Meme tokens live in that
range**, so the two-step form quietly drops the population this system exists to
measure.

Fusing the operations — `(quote * quoteUsd) / base`, multiplying first — keeps
full precision, with the only truncation at the scale the value is stored. The
§15 discipline is unchanged: a result genuinely below resolution is `null`, never
`0`.

Snapshots are deliberately left alone; changing how `signal_price_usd` is
computed is not Phase 7's business, and returns are ratios where a systematic
1e-4 truncation on either side is immaterial against the moves being measured.

## Token ordering is derived, not fetched

`baseIsToken0` compares addresses rather than calling `readPoolState` per trade.
Uniswap V2, V3 and Aerodrome all sort `token0 < token1` at pool creation. If that
were ever false every price in the path would invert while still looking
plausible, so an opt-in integration test pins it against real Base pools.

## Consequences

- No horizon job makes an RPC call; outcome throughput is bounded by Postgres.
- Signalled pools stay in the tail for 25h, growing `trades` and the address
  list. Both are bounded by tracked pools rather than by time, and the retention
  is configurable.
- A worker outage leaves a gap in the quote series. Outcomes over that window
  record a reason rather than a number.
- Measuring every state entry produces roughly one outcome row per horizon per
  signal, including WATCHING. That is the control group §22 needs.

## Live verification

Real discovery against Base, real signals, real swaps. The three metrics for a
signal with six trades in its first minute were recomputed by hand from the raw
`trades` rows and matched exactly: `return_pct = -99.998949`,
`max_runup_pct = 3.674056`. That recomputation is also what surfaced the
precision defect above — the metrics agreed while the stored price did not.
