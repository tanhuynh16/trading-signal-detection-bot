# ADR 0010 — Own buy/sell simulation as the primary risk source

**Status:** accepted (Phase 3)

## Context
Spec §14 requires detecting honeypots, unsellable tokens and unusual transfer
taxes, and §29 forbids silently choosing a paid API. The obvious approach is a
third-party token-security API.

GoPlus was measured on Base before committing to it. For a **mature** token it
returns 39 fields mapping almost perfectly onto the §14.1 table. For a token one
minute old it returned only 10 fields, with `is_honeypot`, `is_mintable` and
`is_blacklisted` absent and both tax fields empty strings — still 10 fields six
minutes later.

**Correction to an earlier claim.** That measurement was a single token, and
generalising from it was too strong. Across a live run of 30 evaluations,
GoPlus returned full data for roughly half and partial or no data for the rest.
It is genuinely useful — just not dependable for a verdict on a token minutes
old, which is exactly the population this bot targets.

## Decision
Our own on-chain buy/sell simulation is the primary source for tradeability and
tax. GoPlus is enrichment for contract-capability flags that no single trade can
reveal: mintable, blacklist, pausable, owner privileges, holder concentration.

The simulation runs through `eth_simulateV1` with a state override granting a
synthetic account ETH:

1. buy, then `balanceOf` in the same batch to learn the amount received
2. buy, approve, sell exactly that amount

Two round trips rather than one, because a value cannot be computed mid-batch.

Free-tier support was verified: balance overrides, code overrides and
`eth_simulateV1` all work; `debug_traceCall` does not.

## Calibration
Validated against the Base WETH/USDC V2 pair: 0.01 ETH round-tripped to
0.009940 ETH — 99.40%, exactly `(1 - 0.003)^2`, two pool fees and zero token
tax. That is the clean baseline every tax assertion is anchored to.

## The fee/tax trap
Round-trip retention conflates the DEX fee with the token's tax. A clean token
in a 1% V3 pool retains ~98%; against a fixed baseline that reads as a 2%-tax
token, and 1% tiers are common for new listings. So tax is computed net of the
pool's own fee:

```
expectedRetention = (1 - dexFee)^2
tokenTax          = 1 - observed / expected
```

## Consequences
Tradeability is judged from what the chain actually does, reproducible from
block state per §3, with no external dependency or rate limit on the critical
path.

A failed buy is reported as `UNKNOWN_TRADEABILITY`, never `HONEYPOT`: a revert
is indistinguishable from a pool too thin to route through, and accusing a
legitimate new token would expire it under §18.

A single probe size cannot detect a tax that only applies above a threshold
size. Documented limitation.
