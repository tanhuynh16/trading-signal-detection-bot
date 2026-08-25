# ADR 0014 — Phase 4 review-gate corrections

**Status:** accepted (post-Phase 4, pre-Phase 5)

A review gate against commit `8f11668` found five issues. Two corrupted Phase 5
scoring inputs directly; three were correctness or documentation gaps. All are
fixed. This record exists because one of them was a mistake I had previously
reported as correct behaviour.

## 1. Valid tokens were permanently dropped by rate limiting

`readTokenMetadata` threw `InvalidDataError` — permanent, routed to
`jobs_audit`, never retried — for **any** multicall failure on `decimals()`.

Both tokens dropped that way were probed on chain afterwards and are ordinary
ERC-20s: `decimals = 18`, `totalSupply = 1e27`, identical launcher bytecode.
They were lost to a 429, not to being malformed — roughly a quarter of that
run's discoveries. The Phase 4 report called this "correct behavior". It was
not.

The sibling `unwrap()` in the *same file* already treated an identical failure
as `TransientProviderError`. The two contradicted each other.

**Fix.** On a `decimals()` multicall failure: re-read directly; if that also
fails, discriminate on `getCode` — no bytecode means permanent, bytecode present
means transient. A failing code check is itself treated as transient, because
condemning a token when the provider is unreachable is what caused the loss.
Extra calls occur only on the failure path.

Verified: a 13-minute run produced **zero** `jobs_audit` rows.

## 2. Smart-wallet entries were never detected

`smartEntries` was hardcoded `[]`. Nothing queried `trades`, so §15.5 could not
observe an entry even with a populated seed list.

Masked today by the empty list, but latent and serious: the moment a wallet was
seeded, `independent_smart_wallet_count` would have returned a **measured 0** —
"no smart money entered" when nothing had looked — on the component carrying
0.30 of the alpha weight. Exactly the null-vs-zero failure §15 exists to
prevent.

**Fix.** `smartWalletEntries()` selects seeded wallets appearing as buyers, with
`min(occurred_at)` as entry time. An empty seed list short-circuits without
querying, so the features stay null for the right reason.

*Known approximation:* `trades.wallet` is the swap recipient. For a routed swap
that is the trader, but a contract forwarding tokens onward would be credited
with the entry.

## 3. `feature_sets` had no uniqueness guard

Every other pipeline table has one (`token_snapshots` on `(pool_id,
scheduled_offset)`, `trades` on `(tx_hash, log_index)`, `signal_outcomes` on
`(signal_id, horizon)`). `feature_sets` had none, and did not even record which
snapshot a row belonged to.

BullMQ's `jobId` prevents re-*enqueueing*, not the five configured retry
attempts. A transient failure mid-job would insert a second row. Duplicates also
corrupt `holder_growth_rate`, which reads the previous feature set and divides
by the interval between them.

Not observed in practice — the feature job is nearly pure-DB and clustering
errors are swallowed — so this was latent, not active.

**Fix.** Nullable `scheduled_offset` column plus `UNIQUE (pool_id,
scheduled_offset)`; `persistFeatures` uses `onConflictDoNothing` and returns
null on conflict. Nullable so pre-existing rows keep NULL, which Postgres treats
as distinct.

## 4. `volume_acceleration_5m` measured trade count, not volume

`trades.usd_value` is never populated, so `windowVolume` silently fell through
to `buyCount + sellCount`. §15.2 means dollars, and the two diverge sharply:
measured on live data, one pool had **5 trades worth $5.76** while another had
**28 trades worth $1,871**.

**Fix.** Sum the quote side of each swap and convert once using the already
cached `QuotePriceResolver`. No per-trade price lookup is needed — the quote
asset is always WETH/USDC/DAI.

*Column-naming trap, left in place:* `trades.base_amount_raw` and
`quote_amount_raw` actually hold `amount0`/`amount1` **by position**, not
base/quote. The quote side is `quote_amount_raw` only when the candidate token
sorts before the quote token. Ignoring this produces values off by ~10 orders of
magnitude — a draft verification query did exactly that and reported $14
trillion of volume. Renaming the columns is a separate migration.

Volume is null when the quote token has no USD path, so acceleration is null
rather than fabricated.

## 5. Deviations from §15 now recorded

- **`liquidity_growth_5m`** returns null where §15.1 specifies
  `max(past, epsilon)`. Dividing by epsilon for a pool starting near zero yields
  a meaningless ~10⁵ growth figure; new pools are the common case, not an edge.
- **`buy_sell_ratio`** returns null for a window with no trades, where the
  spec's `buy_count / max(sell_count, 1)` yields 0. No trading is not balanced
  trading.
- **`unique_buyer_growth`** is interpreted as a ratio; §15.2's "relative to" is
  ambiguous between ratio and difference.

## Consequences

`volume_acceleration_5m` values are not comparable to those produced before this
change — the feature's *semantics* changed, not just its magnitude. Nothing has
been scored on the old values, so no history is invalidated.

A `jobs_audit` row with `InvalidDataError` should still be re-probed on chain
before accepting that a token genuinely lacks `decimals()`.
