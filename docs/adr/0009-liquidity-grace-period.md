# ADR 0009 — Judge liquidity over a grace period, not at T+0

**Status:** accepted (Phase 2)

## Context
Spec §19 sets `discovery.minLiquidityUsd: 10000` and §13 schedules snapshots
"for each candidate that passes minimum discovery checks". Read literally, the
check happens once, at discovery.

That discards the launches worth watching. Pools are routinely created empty and
funded a minute or two later — the creation transaction and the liquidity-add
are separate. A T+0 reading of $0 is the normal state of a brand-new pool, not
evidence of a dead one.

## Decision
Every snapshot records liquidity unconditionally. Tracking stops early (§13
permits stopping when a pool is unavailable for a configurable duration) only
once a pool has stayed below the floor past `LIQUIDITY_GRACE_MINUTES`
(default 5).

Two stop reasons are distinguished:
- `liquidity_below_floor` — priceable, but never reached `minLiquidityUsd`.
- `no_priceable_liquidity` — no USD reading at all, usually an unrecognised
  quote token. Nothing downstream can score it.

A pool that once exceeded the floor keeps its full series even if liquidity
later drains: the drain itself is signal that §15.1's `liquidity_stability` and
Phase 4 features need to see.

## Consequences
More snapshots are taken for pools that turn out to be dead, bounded by the
grace period. In the live run this stopped 20 of 30 pools early, so the majority
of wasted work is still avoided.

Remaining delayed jobs for a stopped pool are removed from the queue rather than
left to fire against a pool nothing will score.
