# ADR 0021 — Evaluation refuses thin samples

**Status:** accepted (Phase 8)

## Context

§22 asks for outcomes by score band, feature contribution, win rate, average and
median return, return distribution, runup, drawdown, and profit factor where
trade rules exist. It attaches a warning that is really a design constraint:

> Do not tune strategy based only on average return; meme-token outcomes may
> have highly skewed distributions.

Every threshold in §19 is an explicitly unvalidated hypothesis. Phase 8 exists to
test them — and the first honest thing it has to report is that the data cannot
yet do so. Measured when this was built:

| | |
|---|---|
| alpha_score range across all signals | 0.0 – 60.4 |
| signals at STRONG_SIGNAL | **0** |
| measured outcomes per horizon | 10 – 25 |
| horizons with any data | 1m, 5m, 15m, 30m |

The whole sample sits in the bottom bands. A report that printed "win rate 60%"
from five outcomes would be technically accurate and practically a trap: it
would invite exactly the tuning §22 warns against, and the resulting threshold
change would be fitted to noise.

## Decision

**A cell that cannot support a conclusion reports that it cannot, instead of
reporting a number.**

Below `--min-n` (default 30 measured outcomes) the renderer prints
`INSUFFICIENT` *in place of* the metrics, not beside them. A number shown next to
a warning is still read as a number; removing it is the only formatting that
actually works.

The rest follows from the same reasoning:

- **The median leads; the mean never appears without the distribution.** One
  token going 40x drags a mean somewhere no individual outcome ever was. Every
  band row carries median, p10 and p90.
- **Win rate carries a Wilson score interval.** At n under 20 a normal
  approximation produces intervals outside [0,1] and collapses to zero width at
  0% or 100% — reading as certainty from a handful of samples. Wilson stays
  bounded and stays wide when the sample is small.
- **Feature contribution is Spearman, not Pearson.** Rank correlation asks
  whether a higher feature score tends to accompany a higher return without
  letting a single outlier answer. Pearson on skewed returns would let one 40x
  make an unrelated feature look predictive.
- **A null component is dropped, never scored 0.** §15's rule matters more here
  than anywhere: `smartMoney` is frequently null, and coercing it to zero would
  invent a low score for every token we could not measure, then correlate the
  invention against returns. Each row reports how many of its samples actually
  had the feature.
- **`n` is reported next to distinct token count.** Outcomes from one token are
  correlated — a token re-entering a state produces several signals — so the
  token count is the honest measure of independent evidence.
- **Strategy versions are never pooled.** Signals scored under different weights
  are not comparable evidence. The report emits one section per
  `strategyVersion` rather than concatenating.
- **Unmeasurable outcomes are excluded from metrics but counted by reason**, so
  measurement coverage stays visible instead of quietly shrinking the sample.

## Profit factor needs a trade rule, so one is stated

§22 asks for profit factor "where trade rules exist". None exist — §28 forbids
auto-trading and the MVP is alert-only.

Rather than omit the metric or invent parameters, exactly one convention is
declared and printed in the header of every run: **notional entry at the frozen
`signal_price_usd`, exit at the horizon price.** That is the only rule the data
already implies, it needs no new hypotheses, and restating it every run stops
the number travelling without its assumption. The header also repeats that the
system does not trade and makes no tradeability claim.

Edge cases are words, not numbers: no losing trades reports `∞ (no losses yet)`
rather than some enormous figure that reads like a great strategy; no trades
reports `n/a`.

## Score bands come from configuration

§17's interior boundaries are already strategy config
(`interestingThreshold`, `strongThreshold`), so bands are derived from them
rather than hard-coded; 40 and 90 are documented §17 constants. When a threshold
moves the bands follow and the change mints a new `strategyVersion`, which is
what keeps a historical comparison meaningful.

## Consequences

- The report currently says INSUFFICIENT almost everywhere. **That is the
  correct output**, and the phase is complete because it says so rather than
  despite it.
- The evaluation is read-only over immutable history, so it is reproducible by
  construction: the same data always yields the same report.
- No recommendation is ever emitted. Changing a threshold stays a human decision
  (§22), and the report describes rather than prescribes.
- Combination analysis is limited to splitting outcomes by evidence coverage —
  the only combination question this sample can answer. No ML, no parameter
  search (§28).

## A note on the test database

Building this phase, the integration suites truncated the same database a
running worker was writing to and destroyed live verification data for the third
time. Tests now run against a separate `sdb_test` database, configured in
`vitest.config.ts`. This was an audit finding from Phase 7.1 that had been left
open; it kept presenting as a product bug, which is reason enough to have closed
it here.
