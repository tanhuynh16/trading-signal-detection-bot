# ADR 0004 — Reconstruct outcome price paths from Swap logs

**Status:** superseded by [ADR 0019](0019-outcome-measurement-from-indexed-trades.md) (Phase 7)

> Superseded on implementation. This was written in Phase 0, before the global
> Swap tail (ADR 0008) existed and before the provider's 10-block `eth_getLogs`
> cap was measured. Fetching the window at horizon time turns out to cost ~4,300
> requests for a single pool's 24 hours; reading the tail's already-indexed
> trades costs none. The reasoning below about exact extrema still holds — only
> the source of the logs changed.

## Context

Spec §21 requires `max_runup_pct` and `max_drawdown_pct` at horizons out to 24h,
but §13 stops snapshots at T+1h. Nothing keeps a signaled token priced for the
remaining 23 hours. Separately, runup and drawdown are _extrema_: any sampling
cadence misses the true peak and trough between samples.

## Decision

When the outcome job for horizon H fires, `eth_getLogs` the pool's `Swap` events
from signal time to now and derive the price series from them.

## Why

- Exact extrema, not sampled approximations.
- No continuous polling process and no 24h of scheduled price jobs per signal.
- Reproducible from chain data, satisfying §21 immutability and §27.

## Cost

Horizon jobs read a log range rather than a single price, so a 24h job on a busy
pool is a larger request. Mitigated by the §23 central rate limiter and by
persisting decoded trades as we go, so the range is usually already indexed.
