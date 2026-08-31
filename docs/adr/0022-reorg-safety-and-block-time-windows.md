# ADR 0022 — Reorg safety, and one clock for outcome windows

**Status:** accepted (Phase 9)

## Context

The Phase 7.1 audit left three findings open. Test-database isolation was closed
in Phase 8. The other two are both data-correctness defects, and both were still
live when this began:

1. **No reorg handling anywhere.** `planRange` read to `head` with zero
   confirmations, in discovery and in the swap tail alike, and a swap indexed
   from a block that later left the canonical chain was never removed. Nothing
   in the repository mentioned confirmations or reorgs.
2. **Outcome windows mixed two clocks.** `evaluateOutcome` built its window from
   `signals.created_at` — Postgres wall time — then filled it with trades
   selected on `trades.occurred_at`, which is block time.

Both corrupt `trades` and `signal_outcomes`, which is what §22 evaluates. The
ordering argument for doing this before anything else: the binding constraint on
the project is data volume — Phase 8 reports INSUFFICIENT everywhere — and the
next step is to run continuously for weeks. Collecting that history first and
fixing these afterwards would make the whole sample suspect.

## Decision 1 — confirmations, applied asymmetrically

A confirmation depth is a latency cost, and the two consumers value latency
completely differently.

| Source | Depth | Why |
|---|---|---|
| Swap tail | 5 (~10s) | Its rows feed §21 outcome math, which is never recomputed once written. A phantom swap is permanent. |
| Discovery | 0 | §10 wants a pool found within seconds. The worst case of an unconfirmed read is a `pools` row for a pool that stopped existing, which then produces no snapshots and expires on its own. |

The depth lives in `planRange` rather than at the runner's single `head` choke
point, precisely so the two can differ. Both are configured, so the asymmetry is
a decision on the record rather than an omission.

The tail's cost is that its coverage watermark trails head by the depth, which
Phase 7.1's deferral machinery already absorbs with no new code.

## Decision 2 — rollback on hash mismatch

Confirmations make a reorg rare. They do not make one detectable: a cursor
holding a block *number* cannot notice, because number N still exists after a
reorg — it is simply a different block.

The tail already fetched `getBlock(plan.toBlock)` at the end of every drain for
the time watermark, so the hash rides along free. It is stored beside the block,
and each drain re-reads that block and compares. On a mismatch: rewind by
`SWAP_TAIL_REORG_DEPTH` (32, ~64s on Base), delete the trades above the rewind
point, and record a `reorg_events` row. The next drain re-reads the range and
re-inserts whatever the canonical chain actually holds, idempotent against the
`(tx_hash, log_index)` unique index.

Three details carry the correctness:

- **`rewindCursor` hard-sets the time watermark backwards**, where
  `advanceCursor` deliberately cannot. This is the load-bearing half: §21's
  coverage gate treats the watermark as proof that everything up to that instant
  is committed, so leaving it forward after deleting the trades underneath would
  let an outcome be finalised from a window whose contents were just removed —
  ADR 0020's defect arriving by a different route.
- **The hash is cleared on rewind, and cleared whenever the block advances
  without one.** A mid-drain chunk commit moves the block but knows no hash;
  keeping the old one would leave the cursor claiming a hash for a block behind
  it, and the very next check would roll back healthy history on every drain.
  A null hash reads as "cannot tell", which is neither a mismatch nor a
  guarantee — the detector does nothing and the next completed drain
  re-establishes it.
- **A rollback settles after one pass** rather than cascading, because the
  rewind clears the hash the next check would have compared.

Cost: one extra `getBlock` per drain, ~620/hour, the same order as the watermark
call already made.

**Not handled:** a reorg deeper than `SWAP_TAIL_REORG_DEPTH`. Said plainly here
rather than implied otherwise.

### Why `reorg_events` exists

Re-ingested swaps carry a fresh `created_at`, so Phase 7.1's `late_trades`
detector already catches most of the fallout for free. It misses exactly one
case: the reorg removed trades and the canonical chain has none to put back, so
nothing is re-inserted and nothing looks late. That is also the case where the
recorded number is most wrong, because it came from swaps that never happened.
One `EXISTS` clause over the event table closes it, with a third repair reason
`reorg_rollback`.

## Decision 3 — the outcome window runs on the chain's clock

`signals.signal_block_number` already existed and was populated from the
snapshot that produced the signal. Its block time was one column away in
`token_snapshots.observed_at`. The window is now
`[signal_block_time, signal_block_time + horizon]`, and `damagedOutcomes`
reconstructs the same anchor — if the sweep disagreed with the measurement it
would either miss real damage or invent it, and never settle.

**The measurement that justified this was far worse than the −63.2s the audit
had recorded.** On the live database:

| | |
|---|---|
| snapshots where block time tracked wall time | 6100, spread **0.3s – 6.0s**, median 1.3s |
| signals where `created_at` was >60s from block time | **104 of 1095 (9.5%)** |
| worst `created_at` error | **−7207.8s (two hours)** |
| recorded outcomes measured on a wrong window | **292 of 5463 (5.3%)**, 268 of them >10 min wrong |

The two-hour figure is not clock drift. `signals.created_at` defaults to
`now()`, which is **transaction-start** time — the same property ADR 0016 found
when it added `seq`. Compared against `signal_transitions.occurred_at`, written
by the application in the *same transaction*, the gap reaches 7208.6s. Block
time, by contrast, never drifted more than 6s from the wall clock across every
snapshot ever taken. It is simply the better anchor, and by a wide margin.

## The backfill, and a deviation from the plan

The Phase 9 plan said explicitly: no backfill, because old rows should not
pretend to precision they never had. **The measurement above changed that.**

The block time is not a guess for historical rows — `signal_block_number` was
already stored on every signal, and the snapshot that produced it still holds
that block's timestamp. Migration `0008` recovers a fact we had all along. It
filled all 1095 signals and corrected 104 anchors, 99 of them by more than ten
minutes. It fills only nulls, so it is idempotent.

**What the backfill does not do is rewrite the 292 outcomes already measured on
the wrong window.** Only 24 of them are caught by the `late_trades` detector,
and all of them are older than the repair sweep's 48-hour lookback, so no sweep
will reach them. Correcting them is a deliberate one-time decision about
historical data, not something to do silently inside a phase about reorgs — it
is left for a human call, with the exact count recorded here.

## Consequences

- Every trade that reaches `trades` is on the canonical chain, or is provably
  removed when it stops being.
- An outcome window now means the same thing as the data inside it.
- `discovery_cursors` gains a hash, and the block/hash pairing is now an
  invariant with its own tests — a hash describing a block the cursor is not on
  would delete good data on every drain, which is worse than the bug being
  fixed. Several tests exist only to assert that a healthy chain is never rolled
  back.
- Live verification against Base could not be completed: the Alchemy free tier
  hit its monthly capacity limit mid-phase. Chain-facing behaviour is covered by
  integration tests against a fake chain, and the clock work was verified
  against real recorded data, which needed no RPC. §29 forbids silently choosing
  a paid tier, so the live run waits.
