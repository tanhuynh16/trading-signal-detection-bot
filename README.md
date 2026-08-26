# Signal Detection Bot

Base-chain crypto signal detection: discovers newly created DEX pools, gates them
through a risk engine, snapshots market data on a fixed cadence, computes
explainable features, scores them, sends deduplicated Telegram alerts, and
records outcomes so strategies can be evaluated with data.

**Alert-only.** No auto-trading, no LLM in the signal path, no ML, no social
ingestion, no multi-chain (spec §28).

Authoritative spec: [`docs/SPEC-v1.0.txt`](docs/SPEC-v1.0.txt). The phase
sequence and the four spec-gap resolutions are in
[`docs/IMPLEMENTATION-PLAN.md`](docs/IMPLEMENTATION-PLAN.md). Where this
repository deviates, the reason is in [`docs/adr/`](docs/adr/).

## Status

| Phase | Scope                                                            | State       |
| ----- | ---------------------------------------------------------------- | ----------- |
| 0     | Foundation: workspace, Docker, schema, config, logging, health   | **done**    |
| 1     | Discovery: Uniswap V2/V3 + Aerodrome, dedupe, queueing           | **done**    |
| 2     | Snapshot pipeline                                                | **done**    |
| 3     | Risk engine                                                      | **done**    |
| 4     | Features (liquidity, momentum, holders, clustering, smart money) | **done**    |
| 5     | Normalization, scoring, signal state machine                     | **done**    |
| 6     | Telegram                                                         | **done**    |
| 6.1   | Notification failure hardening (circuit breaker)                 | **done**    |
| 7     | Outcome tracking                                                 | **done**    |
| 7.1   | Outcome coverage gate + self-healing repair                      | **done**    |
| 8     | Strategy evaluation                                              | not started |

Per spec §29, phases land one at a time with review in between. Full detail in
[`docs/IMPLEMENTATION-PLAN.md`](docs/IMPLEMENTATION-PLAN.md).

## Prerequisites

- Node 22 (`nvm use`) — the repo pins it in `.nvmrc`
- pnpm via `corepack enable`
- Docker or OrbStack
- A Base RPC endpoint with WebSocket support

## Setup

```bash
nvm use
corepack enable
pnpm install
cp .env.example .env      # then fill in BASE_RPC_* with your key
docker compose up -d postgres redis
pnpm --filter @sdb/database migrate
```

## Running

```bash
pnpm dev:api        # health/ready on :3000
pnpm dev:worker     # queue host
docker compose up   # or the whole stack
```

Check readiness — this probes Postgres, Redis and the Base RPC:

```bash
curl -s localhost:3000/ready | jq
```

## Development

```bash
pnpm test        # vitest
pnpm build       # tsc --build across the workspace
pnpm lint
pnpm db:generate # regenerate migrations after a schema change
```

## Layout

```
apps/worker            BullMQ workers + discovery listeners
apps/api               health checks, evaluation queries
packages/shared        logger, errors, decimal + address + time helpers
packages/config        Zod-validated env and versioned strategy configs
packages/domain        canonical types and provider interfaces, no I/O
packages/database      Drizzle schema and migrations
packages/providers/*   blockchain, market-data, security adapters
packages/*             discovery, risk-engine, snapshot-engine, feature-engine,
                       holder-index, scoring, signal-engine, outcome-tracker,
                       notifications
```

## Conventions that matter

- **No floats on money.** Prices and USD are `numeric(38,18)`, raw token amounts
  are `numeric(78,0)`, and the driver returns both as strings. Convert through
  `@sdb/shared/decimal`, never `Number()`.
- **Null is not zero.** A feature that cannot be measured reports `null` (§15).
  Coercing it to 0 silently fabricates a signal.
- **Addresses are stored lowercase** and checksummed only for display (§11).
- **Jobs are idempotent**, keyed on the work itself — never a timestamp (§23).
- **Config changes mint a new `strategyVersion`**; historical signals keep their
  original meaning (§22).
- **Thresholds are hypotheses**, not claims about profitability (§17, §28).
- **Secrets never reach logs.** Register real values with `registerSecret()` at
  startup; provider libraries quote their request URLs (API key included) inside
  error messages, which field-name redaction alone cannot catch.
