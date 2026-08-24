# ADR 0008 — One global swap tail, not per-snapshot trade fetches

**Status:** accepted (Phase 2)

## Context
Spec §15.2 needs buy/sell counts, unique buyers and volume per window, which
means trade-level data. The obvious design has each snapshot job fetch its own
window of `Swap` logs.

That does not survive contact with a rate-limited provider. Alchemy's free tier
caps `eth_getLogs` at a 10-block range (discovered in Phase 1). A 5-minute
window on Base is ~150 blocks, so **15 requests per snapshot** — times eight
snapshots per pool (§13), times every tracked pool. Phase 1 was already hitting
429s with three requests per drain.

## Decision
A single drain tails `Swap` logs for every tracked pool at once:

```
eth_getLogs({ address: [...all tracked pools...],
              topics: [[univ2Swap, univ3Swap, aeroSwap]] })
```

Verified against Base before building: one such call returned 29 swaps across
two pools in a 10-block window. Cost is ~1 request per window **regardless of
how many pools are tracked**. Decoded trades land in `trades`, and snapshot jobs
aggregate their window from Postgres at zero RPC cost.

The tail reuses Phase 1's cursor machinery wholesale (`discovery_cursors` gains
a `swap-tail` row) and rides discovery's post-drain hook, so one
`eth_blockNumber` serves both.

## Consequences
Trade capture is O(1) in pool count rather than O(pools x snapshots x window).
It also front-loads the data §21 needs to reconstruct outcome price paths
(plan G2), which would otherwise be a second expensive log scan.

`trades.side` stores which side left the pool (`OUT0`/`OUT1`) rather than
BUY/SELL, because direction depends on which token is the candidate and that is
resolved at snapshot time. `tradeWindowStats` maps it at read time.

The address list grows with tracked pools; it is batched by
`SWAP_TAIL_MAX_ADDRESSES` and bounded by expiring pools past §19's
`maxTokenAgeMinutes`.
