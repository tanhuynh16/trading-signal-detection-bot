# Implementation Plan

The authoritative requirements live in [`SPEC-v1.0.txt`](SPEC-v1.0.txt). This
document records how we sequence the work, which open decisions we closed, and
where we deliberately depart from the spec. The ADRs in [`adr/`](adr/) cite the
gap resolutions below by their G-numbers.

## Status

| Phase | Scope | State |
|---|---|---|
| 0 | Foundation: workspace, Docker, schema, config, logging, health | **done** |
| 1 | Discovery: Uniswap V2/V3 + Aerodrome, dedupe, queueing | **done** |
| 2 | Snapshot pipeline | **done** |
| 3 | Risk engine | **done** |
| 4a | Features: liquidity, momentum | **done** |
| 4b | Features: holders, clustering, smart money | **done** |
| R | Replay/backfill harness (cross-cutting, alongside Phase 4) | not started |
| 5 | Normalization, scoring, signal state machine | **done** |
| 6 | Telegram | **done** (delivery unverified) |
| 7 | Outcome tracking | not started |
| 8 | Strategy evaluation | not started |

Spec §29 requires landing one phase at a time with review in between. At each
boundary, report changed files, commands run, tests run, acceptance criteria
met, known limitations, and unresolved decisions.

## Environment prerequisites

- Node 22 (`.nvmrc`); viem requires ≥18
- pnpm via `corepack enable`
- Docker or OrbStack
- A Base RPC endpoint with WebSocket support (Alchemy free tier)
- Telegram bot token and chat ID — Phase 6 only

## Decisions closed

The spec leaves several choices open (§7 ORM, §9 provider selection). These are
now fixed:

| Area | Decision | Rationale |
|---|---|---|
| Language / runtime | TypeScript on Node 22 LTS | §7 |
| Monorepo | pnpm workspaces, no Turborepo | §6 calls for a modular monolith |
| ORM | Drizzle | [ADR 0001](adr/0001-drizzle-over-prisma.md) |
| Chain access | viem over Alchemy Base; WSS for discovery, HTTP + multicall for reads | §7, behind `BlockchainProvider` per §9 |
| Market data | On-chain first; REST enriches only | [ADR 0002](adr/0002-onchain-first-market-data.md) |
| Holder data | Own ERC-20 `Transfer` indexer | [ADR 0005](adr/0005-holder-index-package.md) |
| DEX coverage | Uniswap V2, Uniswap V3, Aerodrome. V4 and Slipstream deferred | V4's singleton + hooks model needs a different liquidity-read path |
| Queue | Redis + BullMQ | §7 |
| Validation | Zod at every provider boundary and on config load | §7, §25 |
| Tests | Vitest, fixtures captured from real Base logs | §29 |

## Spec gaps and resolutions

Four places where implementing the spec literally produces wrong behavior. Each
resolution is configuration-driven so it stays a hypothesis, per §3.

### G1 — Smart money is 30% of alpha weight but MVP only seeds wallets manually

§17 weights smart money at 0.30; §15.5 defers autonomous discovery. Scored
literally, that component is 0 for nearly every token, capping realistic scores
near 70 and making `strongThreshold: 75` unreachable — `STRONG_SIGNAL` would
effectively never fire.

**Resolution:** components return `0..100` or null, and the aggregate
renormalizes over the weight actually present.

```
coverage = Σ wᵢ  where cᵢ ≠ null
alpha    = (Σ wᵢ·cᵢ where cᵢ ≠ null) / max(coverage, ε)
```

`coverage` is persisted on every `signals` row. `scoring.minCoverage` (default
0.6) caps thin-evidence signals at INTERESTING. `scoring.nullPolicy` selects
`renormalize` / `neutral` / `zero` so the three can be compared on outcome data.
Full reasoning: [ADR 0003](adr/0003-coverage-renormalized-scoring.md).

### G2 — Outcome tracking needs 24h of prices but snapshots stop at T+1h

§21 requires extrema out to 24h; §13 stops snapshotting at 1h. Sampling would
miss the true peak and trough anyway.

**Resolution:** at horizon time, reconstruct the price path from the pool's
`Swap` logs. Exact extrema, no polling loop, reproducible from chain data.
[ADR 0004](adr/0004-outcome-price-path-from-logs.md).

### G3 — T+30s snapshots are unachievable via REST providers

DexScreener and GeckoTerminal refresh more slowly than 30s and rate-limit hard,
so a REST-sourced T+30s snapshot would restate T+0.

**Resolution:** each snapshot is one multicall batch — reserves (V2/Aerodrome)
or `slot0` plus pool token balances (V3), plus `totalSupply`. Quote-token USD
comes from a deep on-chain reference pool with a short TTL cache.
[ADR 0002](adr/0002-onchain-first-market-data.md).

### G4 — Numeric precision is unspecified

§12 never says what type money uses. Floats on token amounts corrupt data
silently.

**Resolution:** `numeric(38,18)` for prices and USD, `numeric(78,0)` for raw
uint256 amounts, `bigint` for block numbers, **no float anywhere**. The pg
driver returns numerics as strings; conversion goes through
`packages/shared/src/decimal.ts`, never `Number()`.

## Phases

### Phase 0 — Foundation ✅
pnpm workspace, TS project references, lint/format/test harness, Docker Compose
(Postgres 16, Redis 7, migrate, api, worker), Drizzle schema for all §12 tables
plus migrations, Zod config validation that fails fast, structured logging with
§24 context and credential redaction, `/health` and `/ready`.

*Accepted when:* the stack comes up healthy, migrations apply from empty, and
invalid config aborts startup with a readable error.

*Known limitation:* `docker compose up` is unverified — no container runtime was
installed on the build machine. The other two criteria are verified.

### Phase 1 — Discovery (§10, §11) ✅
Adapters for Uniswap V2 `PairCreated`, Uniswap V3 `PoolCreated`, and Aerodrome
`PoolCreated(…, bool stable, …)`. **Factory addresses must be verified against
official deployment docs and stored in config — never hardcoded from memory.**
WSS `watchEvent` with exponential-backoff reconnect and downtime logging. A
persisted per-factory block cursor, replayed from cursor minus a configurable
overlap on restart. Quote-token allowlist normalization; pools with no
allowlisted quote are kept at lower priority, never dropped. Dedupe on
`(chain, pool_address)`, persisting the discovery row before enqueueing.

*Accepted (§10.3):* verified live against Base — pools discovered across all
three factories, no duplicate addresses, a restart resumed from the persisted
cursor without re-creating rows, and a failing factory left the others running.

*Verified factory addresses* (from each protocol's own deployment docs, pinned
by a test against logs captured from Base mainnet):

| Factory | Address |
|---|---|
| Uniswap V2 | `0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6` |
| Uniswap V3 | `0x33128a8fC17869897dcE68Ed026d694621f6FDfD` |
| Aerodrome | `0x420DD381b31aEf6683db6B902084cB0FFECe40Da` |

*Design note — cursor-driven, WebSocket-triggered.* The persisted block cursor
is the source of truth; the socket only decides *when* to drain. Live discovery,
restart replay and first-start backfill are therefore one code path, and a
dropped socket degrades to polling instead of silently losing events.

*Provider constraint.* Alchemy's free tier caps `eth_getLogs` at a **10-block
range**, so `DISCOVERY_LOG_CHUNK_BLOCKS` defaults to 10 and the fetcher halves
and remembers the limit if a provider rejects it. The replay overlap is applied
only on the first drain after startup: re-applying it every drain multiplied
requests sixfold against that cap. Steady-state still hits occasional 429s,
absorbed by bounded backoff — raising the tier or lowering
`DISCOVERY_FIRST_START_BACKFILL_BLOCKS` would remove them.

### Phase 2 — Snapshot pipeline (§13) ✅
On-chain `MarketDataProvider` with per-DEX reserve/price readers in a single
multicall. WETH/USD reference reader. `Swap` log decoder producing normalized
`trades`. BullMQ delayed jobs at T+0/30s/1m/2m/5m/10m/30m/1h, job ID
`snapshot:{poolId}:{offset}`. **The full job set is scheduled at enqueue time —
no job schedules its successor** (§13 forbids unbounded recursion). Early-stop
on risk FAIL, prolonged pool unavailability, or expiry. Block time and wall-clock
capture time stored separately (§3).

*Accepted:* verified live — 22 pools discovered and enriched, 88 snapshots
across the T+0/30s/1m/2m/5m series, 34 trades captured by the tail, zero
duplicate snapshots or trades, zero permanent failures.

*Verified on-chain facts* (captured as test fixtures, not recalled):

| Fact | Value |
|---|---|
| Swap selectors | V2 `0xd78ad95f…`, V3 `0xc42079f9…`, Aerodrome `0xb3e27736…` |
| WETH/USD reference pool | `0x6c561b446416e1a00e8e93e221854d6ea4171372` (V3 fee-3000, deepest at $69M) |
| V3 price formula | `(sqrtPriceX96 / 2^96)² × 10^(d0 − d1)` — anchored in tests to ETH ≈ $2,433.78 |

Two ABI traps are pinned by tests: Aerodrome's `getReserves` returns `uint256`
where Uniswap V2 returns `uint112`, and V2/Aerodrome `Swap` events encode
**identically** — same topic count, same data layout — differing only in
selector, so decoders dispatch on selector alone.

Trade capture uses one global tail rather than per-snapshot fetches
([ADR 0008](adr/0008-global-swap-tail.md)); liquidity is judged over a grace
period rather than at T+0 ([ADR 0009](adr/0009-liquidity-grace-period.md)).

### Phase 3 — Risk engine (§14) ✅
`SecurityProvider` interface with a mock first (§29), then one real adapter —
**selection confirmed before wiring, per §29's prohibition on silently choosing
paid APIs**. Independent on-chain buy/sell simulation via `eth_call` state
override as a second honeypot check. Deterministic rule table from §14.1, every
severity and action config-driven, raw provider response retained. Risk gates;
it never contributes positive alpha.

*Accepted:* verified live — 30 evaluations, verdicts spread across PASS and
WARNING, raw provider responses retained on every row, and re-checks appending
rather than overwriting (§21).

Own buy/sell simulation is the primary source
([ADR 0010](adr/0010-simulation-first-risk.md)), calibrated against a measured
clean baseline of 99.40% round-trip retention on Uniswap V2. Tax is computed net
of the pool's own fee, so a clean token in a 1% V3 tier is not reported as
2%-taxed.

Undetermined risk warns rather than passing
([ADR 0011](adr/0011-unknown-risk-is-not-safe.md)); provider coverage is checked
per field, because a response carrying some critical fields while omitting
others was silently reading as clean.

Risk is evaluated at T+0 and re-checked at 5m and 30m — a deployer can enable a
tax or blacklist after launch, so a single T+0 check is trivially defeated. A
FAIL cancels pending snapshots and stops tracking, satisfying §27's requirement
that a risk FAIL prevents alerting.

### Phase 4a — Liquidity and momentum features (§15.1–15.2) ✅
Pure functions over snapshots and trades. Null on insufficient history, never 0
(§15). `volume_acceleration_5m` requires three prior comparable windows or
returns null.

### Phase 4b — Holders, clustering, smart money (§15.3–15.5) ✅
`packages/holder-index` replays `Transfer` logs for tracked tokens into a balance
table; configured LP/burn addresses excluded from `top10_concentration`; dust
threshold from config. Clustering uses deterministic heuristics only —
`same_funder`, `same_funding_tx`, `similar_funding_time`,
`similar_funding_amount`. **No graph database** (§28). Smart money uses the
seeded wallet list plus a versioned `wallet_alpha_score`.

*Accepted when:* every feature is a tested pure function; null propagates rather
than degrading to 0; features recompute from stored data (§27).

### Phase 4 review gate ✅

A gate run against `8f11668` found five issues, all fixed before Phase 5
([ADR 0014](adr/0014-phase-4-review-gate-corrections.md)):

1. **Valid tokens permanently dropped by rate limiting** — `readTokenMetadata`
   classified every multicall failure as permanent. The dropped tokens were
   ordinary ERC-20s. Now verified on chain before being condemned.
2. **Smart-wallet entries never detected** — `smartEntries` was hardcoded `[]`,
   which would have reported a measured 0 the moment a wallet was seeded.
3. **`feature_sets` had no uniqueness guard** — a retried job could duplicate a
   row and corrupt `holder_growth_rate`.
4. **`volume_acceleration_5m` measured trade count, not USD volume** — measured
   live, 5 trades worth $5.76 versus 28 worth $1,871.
5. Three §15 deviations documented.

Verified after the fixes: zero `jobs_audit` rows, zero duplicate
`(pool_id, scheduled_offset)` groups, null discipline intact (105 nulls,
0 coerced zeros), 309 tests passing.

### Phase R — Replay/backfill harness
`bin/backfill --from-block --to-block` runs historical ranges through
discovery → snapshot → features → scoring into a shadow schema.

Not in the spec, and the highest-leverage addition. Every threshold in §19 is an
admitted hypothesis; without replay, each tuning iteration costs weeks of live
traffic. It also produces the fixture corpus Phases 5–8 need.

### Phase 5 — Normalization, scoring, signals (§16–§19) ✅
Reusable normalizers (min-max with clipping, log transform, bounded ratio) whose
parameters live in versioned strategy config. Component scorers returning
`0..100` or null, aggregated per **G1**, with the breakdown persisted. The §18
state machine: `NEW → WATCHING → INTERESTING → STRONG_SIGNAL`, any state →
`EXPIRED` on age, inactivity, liquidity collapse, or risk FAIL. No downgrade
unless `downgradePolicyEnabled`. All transitions persisted. Alert dedupe: one per
level per token unless the score moves past `rescoreDelta` or the cooldown expires.

*Accepted:* verified live over 19 minutes — 30 tokens reached WATCHING, 3
reached INTERESTING, 2 expired on liquidity collapse, with a genuine score
distribution rather than a degenerate one. Coverage measured at exactly 0.700
(smartMoney null), above `minCoverage`, so STRONG_SIGNAL stays reachable —
plan G1 working as designed.

The feature→component mapping follows §15's own structure, with §15.4
`cluster_concentration` as the §17 penalty since it belongs to no component
([ADR 0015](adr/0015-scoring-and-state-machine.md)). Renormalisation runs at
both the feature and component level; the inner level is load-bearing because
`volume_acceleration_5m` is null for the first ~20 minutes of every token.

Invariants verified: no signal under a risk FAIL carries an alert level (§27),
no duplicate rows per token+state, 35 signals with 35 transitions.

### Phase 5.1 — Concurrency and re-alert hardening ✅

Closed the two defects the Phase 5 audit found, plus a third the new tests
uncovered ([ADR 0016](adr/0016-alert-decisions-and-per-token-serialisation.md)):

1. **Duplicate state-entry race** — the read-decide-write sequence now runs in
   one transaction under `pg_advisory_xact_lock(hashtext(token_id))`. A unique
   index was rejected because it would block the state re-entry §18 permits
   when `downgradePolicyEnabled` is on.
2. **§18's dedup exceptions were unreachable** — `shouldAlert()` sat below an
   early return, so `SCORE_MOVED` and `COOLDOWN_ELAPSED` were dead code. Dedup
   now runs on every evaluation, and decisions live in a new `signal_alerts`
   table with separate `trigger_reason` and `status` axes, so ADR 0015 stands
   and `signals` stays the canonical state entity.
3. **`now()` is transaction-start time** — found by a flaky concurrency test
   (1 failure in 6). Overlapping transactions could write rows whose
   `created_at` order contradicted commit order, so "latest state" returned a
   stale row. Both tables now carry `seq bigserial` and order by it.

Verified: 8 consecutive clean runs of the concurrency suite; live run produced a
real `SCORE_MOVED` re-alert with no extra `signals` row, zero duplicate
`(token_id, state)`, and exactly one transition per signal.

### Phase 6 — Telegram (§20) ✅
The §20 message format: symbol, CA, age, MC, liquidity, score, "Why" breakdown,
risk warnings, links. **Send failure must not discard the signal** — bounded
retries through the `notification` queue, then `jobs_audit`.

### Phase 7 — Outcome tracking (§21)
Horizon jobs at 1m/5m/15m/30m/1h/4h/24h on the same durable scheduler as
snapshots. `return_pct`, `max_runup_pct`, `max_drawdown_pct` from the
reconstructed price path per **G2**. Signal-time reference price frozen at
emission; features and `strategyVersion` immutable thereafter.

*Accepted when:* every alert has outcome rows at all horizons, or an explicitly
recorded failure when provider data was unavailable (§27).

### Phase 8 — Evaluation (§22)
Outcomes by score band, per-feature and combination contribution, win rate,
mean and median return, return distribution, max drawdown and runup. **Report
the distribution, not just the mean** — §22 warns that meme outcomes are heavily
skewed. Every strategy change mints a new `strategyVersion`.

### Cross-cutting
Built into each phase, not deferred: the six §23 queues with idempotent job IDs,
bounded exponential backoff, permanent errors to `jobs_audit`, `poolId` as
correlation ID throughout, a central rate limiter shared by all external
providers (§23), the §24 metrics on `apps/api`, and secrets only via env (§25).

## Risks

| Risk | Mitigation |
|---|---|
| Alchemy free-tier compute units exhausted by multicall and `eth_getLogs` volume | Central rate limiter; batch aggressively; watch `provider_error_rate`; early-stop dead pools |
| Base meme volume produces very high snapshot job counts | `discovery.minLiquidityUsd` gate before scheduling; expire aggressively per §13 |
| Factory addresses or event ABIs wrong | Verify against official deployment docs in Phase 1; integration test decodes a real captured log |
| Holder indexer falls behind on high-`Transfer` tokens | Tracked tokens only, ~1h lifetime; report null rather than stale values (§15) |
| §19 thresholds are unvalidated guesses | Phase R replay and Phase 8 evaluation before trusting alerts; MVP stays alert-only (§2) |

## Non-goals (§28)

No auto-trading. No LLM in the signal path. No multi-chain. No graph database.
No social ingestion. No ML training. No claim that any threshold guarantees
profitability.
