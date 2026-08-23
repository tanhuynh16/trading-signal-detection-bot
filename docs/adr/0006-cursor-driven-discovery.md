# ADR 0006 — Cursor-driven discovery, WebSocket as trigger only

**Status:** accepted (Phase 1)

## Context
Spec §10.2 requires a WebSocket for low-latency discovery and §10.3 requires
that "restarting the worker does not permanently skip blocks."

The obvious implementation subscribes to factory logs over WSS and treats each
delivered event as the unit of work. That makes gaps invisible: whatever the
factory emitted while the socket was down is simply never seen, and nothing in
the system can tell that it happened.

## Decision
The persisted `discovery_cursors` row is the source of truth. WebSocket
new-heads only decide *when* to drain.

1. `watchBlockNumber` fires on a new head (its value is reused — re-querying
   `eth_blockNumber` cost one RPC call every ~2s).
2. A drain fetches logs from `lastProcessedBlock + 1` to head, chunked.
3. The cursor advances per chunk, only after that chunk's rows commit.
4. A fallback timer runs the same drain, so a dead socket degrades to polling.
5. Bursts of notifications are coalesced by `DISCOVERY_MIN_DRAIN_INTERVAL_MS`.

Live discovery, restart replay and first-start backfill become one code path.

## Consequences
"Restarting does not skip blocks" is a property of the design rather than a
feature bolted on, and is tested by asserting the resumed range never begins
past the committed watermark.

The replay overlap (`DISCOVERY_BLOCK_OVERLAP`) is applied **only on the first
drain after startup**. It exists to cover the window between "logs fetched" and
"cursor committed" that a crash can leave — a risk that only exists across a
restart. Applying it on every drain re-read the same 50 blocks forever, which
against a provider capping `eth_getLogs` at 10 blocks turned one request per
factory into six.

Discovery latency is bounded by the coalescing interval rather than by block
time. Given snapshots start at T+0 and T+30s (§13), several seconds of
discovery latency is immaterial.
