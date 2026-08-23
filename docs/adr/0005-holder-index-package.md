# ADR 0005 — A holder-index package beyond the §6 structure

**Status:** accepted (Phase 0 schema, implemented Phase 4b)

## Context

Spec §6 fixes the package layout, and §29 forbids inventing major components
without documenting the reason. But §15.3 requires `holder_count`,
`holder_growth_rate`, `top10_concentration` and `holder_retention`, and none of
those is obtainable from plain RPC — there is no "list holders" call.

## Decision

Add `packages/holder-index`: for tracked tokens only, replay ERC-20 `Transfer`
logs from the pool-creation block forward into a `holder_balances` table.

## Why

The alternative is a third-party holder API. Those are rate-limited, usually
stale for minutes-old tokens (exactly our target), typically paid for top-holder
endpoints, and — decisively — not reproducible from stored data, which §3 and
§27 both require. Cost stays bounded because tokens are only tracked for roughly
an hour.

## Cost

One more moving part, and a token with very high `Transfer` volume can put the
indexer behind. When that happens the features report null rather than a stale
number, per §15.
