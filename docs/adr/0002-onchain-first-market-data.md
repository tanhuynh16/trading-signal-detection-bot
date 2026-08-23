# ADR 0002 — On-chain first, REST only as enrichment

**Status:** accepted (Phase 0, implemented Phase 2)

## Context

Spec §13 requires snapshots at T+30s. Spec §10.2 already forbids REST polling as
the primary low-latency discovery mechanism but leaves snapshot sourcing open.

## Decision

Price, liquidity, market cap and trades are derived on-chain:

- V2/Aerodrome: `getReserves`; V3: `slot0` plus pool token balances.
- Trades: decoded `Swap` event logs.
- Quote-token USD: a deep reference pool read on-chain, short-TTL cached.

GeckoTerminal/DexScreener are limited to metadata enrichment and sanity checks.

## Why

DexScreener and GeckoTerminal refresh more slowly than 30s and rate-limit
aggressively, so a REST-sourced T+30s snapshot would restate T+0 data. Trade-level
features (unique buyers, buy/sell ratio) are not reliably derivable from their
aggregates at all. On-chain reads are also reproducible from stored data, which
§3 and §27 require and a third-party aggregate is not.

## Cost

Per-DEX ABI decoding, and V3 liquidity must be measured as pool token balances
rather than a single reserve read. Accepted.
