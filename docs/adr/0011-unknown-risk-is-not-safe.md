# ADR 0011 — Undetermined risk warns; it never passes

**Status:** accepted (Phase 3)

## Context
§14 makes risk a gate but does not say what to do when a flag cannot be
determined — a simulation that reverts for an unrelated reason, or a provider
that has no data for the token.

Failing closed is the safe-sounding reading, but new pools are routinely
unroutable in their first minutes and providers routinely have no data on them.
Failing closed rejects most of the target population and the bot would rarely
alert at all.

## Decision
Three-way, not two:

- **Proven bad** — sell reverts after a successful buy, tax at or above the
  configured ceiling, provider asserts a critical flag — is `FAIL`.
- **Undetermined** is `WARNING` with an explicit `UNKNOWN_*` flag recorded, and
  continues to scoring.
- **PASS** requires positive evidence of safety, not merely the absence of
  evidence of harm.

## The partial-coverage trap
The first implementation checked only whether the provider response was
*entirely* empty. A live run then produced 24 PASS verdicts at risk score 0 —
and inspection showed responses that carried some critical fields while omitting
others. Every omitted field was silently reading as clean.

Coverage is now checked **per field**: `isHoneypot`, `cannotSellAll`,
`isBlacklisted`, `transferPausable` and `isMintable` each produce an
`UNKNOWN_SECURITY_DATA` entry naming what was omitted. After the fix the same
workload produced 14 WARNING instead of 5 — the difference is entirely tokens
that had been passing on absent data.

## Consequences
More tokens carry WARNING, which is honest: most brand-new tokens genuinely
cannot be fully assessed. Phase 5 scoring can weigh a warning however the
strategy config chooses, and the flags name exactly what was unknown.

Every action and severity in the table is configurable, and lives in strategy
config rather than env so a change mints a new `strategyVersion` and historical
verdicts keep their original meaning (§22).
