# ADR 0003 — Coverage-renormalized alpha scoring

**Status:** accepted (Phase 0 config, implemented Phase 5)

## Context

Spec §17 weights smart money at 0.30, but §15.5 states MVP smart money is a
manually seeded wallet list with autonomous discovery deferred. Nearly every
newly discovered token will therefore have no smart-money signal.

Scored literally, that component contributes 0 for almost all tokens, capping
realistic scores near 70 and making `strongThreshold: 75` (§19) close to
unreachable. `STRONG_SIGNAL` would effectively never fire — a silent failure,
not a loud one.

## Decision

Components return `0..100` **or null** (§15 already forbids substituting zero for
missing data). The aggregate renormalizes over the weight actually present:

    coverage = Σ wᵢ  where cᵢ ≠ null
    alpha    = (Σ wᵢ·cᵢ where cᵢ ≠ null) / max(coverage, ε)

`coverage` is persisted on every `signals` row next to the component breakdown.
`scoring.minCoverage` (default 0.6) caps a thin-evidence signal at INTERESTING,
so a score resting on one component cannot present as high conviction.

`scoring.nullPolicy` selects `renormalize` (default), `neutral` (missing = 50),
or `zero` (the literal spec reading), so the three can be compared on real
outcome data rather than argued about.

## Cost

Alpha scores are no longer directly comparable across differing coverage. The
persisted `coverage` column exists so §22 evaluation can segment by it.
