# ADR 0023 — Surviving the provider's history window

**Status:** accepted (Phase 9.1)

## Context

Phase 9 shipped reorg safety and block-time outcome windows but could not verify
any of it live: the Alchemy free tier hit its monthly capacity limit. The HTTP
endpoint was then repointed at Chainstack, and probing both providers produced a
table that changes how this system has to behave:

| | Alchemy (free) | Chainstack (current plan) |
|---|---|---|
| `eth_getLogs` width | 10 blocks | **~100** (rejects 121: *"Block range limit exceeded"*) |
| History depth | full archive (5M blocks back served) | **~128 blocks**, then *"Archive, Debug and Trace requests are not available on your current plan"* |
| state-override `eth_call` (ADR 0010) | ✓ | ✓ |

These are complementary, not ranked. Chainstack gives roughly **10x the range
width** — the dominant request cost and the source of 429s in every prior phase —
but only a **~128-block sliding window**, about **4.3 minutes** on Base.

Two consequences fell out immediately.

**Every cursor was stranded.** `swap-tail` sat 244,883 blocks behind, the
factories 176,513 — 4 to 5.7 days. Chainstack could serve none of it, and
Alchemy would have needed ~70,000 requests at 10 blocks each to catch up.

**And a stranded cursor was an infinite silent loop.** The fetcher classified
*"Block range limit exceeded"* as a range error, so width overruns self-corrected
by halving; but *"Archive… not available"* matched neither the range nor the
rate-limit pattern. It became a `TransientProviderError`, which the runner logs
as "factory drain failed; other factories continue" and retries on every drain,
forever, making no progress. On a 4.3-minute window, any outage longer than that
puts the system permanently in that state — flatly contradicting §27's "runs
continuously on a VPS".

## Decision

**1. "Beyond available history" is its own failure class.**
`ProviderHistoryUnavailableError`, `retryable = false`, raised by
`fetchLogsChunked` and checked *before* the range and rate-limit patterns —
because provider wording collides with both. No amount of backoff or halving
makes a pruned block reappear, so the error now says what is actually wrong.

**2. Skipping forward is allowed, but only if it is recorded.**
`reseedCursor` moves the cursor past the unservable range — the second
deliberate exception to `advanceCursor`'s forward-only rule, after
`rewindCursor`. The skip writes an `ingestion_gaps` row and a §23 `jobs_audit`
row, and only then moves the cursor: if either record fails the cursor stays put
and the next drain tries again, rather than losing the range silently.

**3. The tail's coverage watermark must not sail over the gap.**
This is the part that matters. §21's watermark is a single instant that ADR 0020
defines as *proof* everything up to it was read and committed; a scalar cannot
express "covered, gap, covered". So `reseedCursor` deliberately does not write a
time watermark, and `evaluateOutcome` treats a window overlapping a recorded gap
as not covered — recording `incomplete_tail_coverage`, the §27 mechanism that
already means exactly this. It does not *defer*: those blocks are pruned and
never arriving, so waiting out `maxDeferMs` would only reach the same answer
slower. A gap with a null time bound counts as overlapping; an unknown edge must
never resolve in favour of "covered".

This matters at ordinary outage lengths, not theoretical ones: a five-minute
restart already exceeds a 4.3-minute window, and signals from five minutes ago
are well inside `outcomeRetentionHours`.

**4. Configuration follows the measurements.** `DISCOVERY_LOG_CHUNK_BLOCKS`
10 → 100, and `DISCOVERY_FIRST_START_BACKFILL_BLOCKS` 300 → 100 — the latter is
not a tuning preference: 300 is outside Chainstack's window, so the first drain
would have failed. It is also where a skipping cursor lands, so it must stay
inside the window or the next drain fails identically.

## A bug found while testing this

A test that let the chunk size shrink with no `onChunkShrink` callback hung
forever. The cause:

```ts
options.onChunkShrink?.(before, sizing.shrink());
```

**Optional-call short-circuiting skips the arguments too.** With no callback,
`sizing.shrink()` never ran, the window never narrowed, and the loop retried the
identical range until killed. Every production caller happens to pass a logger,
which is the only reason this was survivable — and raising the chunk size to 100
made shrinking load-bearing in a way it had not been at 10. Fixed by shrinking
first and notifying second.

## Verification

Live against Base, with one worker and a clean cursor table:

- All three factories seeded at exactly 100 blocks; **zero chunk-shrink events**,
  so Chainstack accepts the configured width outright
- 108 pools, 96 trades, 92 signals in ~15 minutes; zero errors
- Swap-tail cursor trailed the factories by the confirmation depth, and carried a
  block hash while the other sources correctly carried none
- **92 of 92 new signals carried `signal_block_time`, with skew of 0.4–4.8s and
  none over 60s** — against the pre-fix distribution of 104 of 1095 over 60s,
  worst case 7208s. Phase 9's clock fix, confirmed on real traffic.
- A forced rollback (hash corrupted to `0xdedede…`) rewound 32 blocks, deleted
  exactly 10 trades, cleared the hash, recorded one `reorg_events` row carrying
  both hashes, and was a **no-op on the second call** — no cascade. One worker
  run afterwards restored exactly those 10 trades.
- Zero credential leaks in run logs; the redactor fired 20 times on the RPC URL

### A contaminated first attempt, worth recording

The first live run showed a history-skip that should not have happened. The
cause was not the code: a `tsx watch` process from a previous session had never
exited, and it respawns the worker on every source edit. **Two workers were
writing to the same database**, and the stray one had re-created a cursor after
it was cleared. Verification runs now use `node --import tsx` rather than
`tsx watch`, so nothing survives the shell that started it. The guard itself
behaved correctly throughout — it detected the unservable range, skipped, logged,
recorded the gap, and discovery resumed five seconds later.

## Consequences

- A pruned range costs a recorded gap and an audit row, never an infinite loop.
- Outcomes over a skipped range report `incomplete_tail_coverage` rather than a
  number built from history that was never fetched.
- Request volume drops roughly 10x per drain at the same coverage.
- The 4.3-minute recovery window is now a documented operating constraint, not a
  hidden one. If long soaks prove it too tight, the open option is an archive
  fallback provider behind §9's existing `BlockchainProvider` abstraction —
  deliberately not built here.
- A one-time reset discarded 4–5 days of un-indexed range as unrecoverable. The
  pools in it expired long ago (`maxTokenAgeMinutes` 6h) and no outcome can
  reference them (`outcomeRetentionHours` 25h, repair lookback 48h).
