# ADR 0001 — Drizzle over Prisma

**Status:** accepted (Phase 0)

Spec §7 requires choosing one ORM and using it consistently, without saying which.

## Decision

Drizzle ORM with `postgres-js`.

## Why

- §22 evaluation work is analytical: score-band cohorts, per-feature contribution,
  return distributions. That is window-function territory, and Drizzle's SQL
  escape hatch stays typed instead of dropping to `$queryRaw`.
- No Rust query engine binary in the VPS image (§7 deploys via Docker Compose).
- Snapshot writes are high-rate and narrow; Drizzle's thin driver layer suits them.

## Cost

Fewer ergonomics than Prisma Client, no Prisma Studio equivalent maturity, and
migration tooling is younger. Accepted.
