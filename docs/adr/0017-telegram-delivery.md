# ADR 0017 — Telegram delivery and the durable alert obligation

**Status:** accepted (Phase 6)

## Context
§20 specifies the alert message and one hard requirement: *"Failure to send
Telegram must not discard the signal; retry with bounded attempts."*

Phase 5.1 had already split the alert decision from the signal, leaving
`signal_alerts` rows in `PENDING` for a sender to pick up.

## Escaping is a security control

Token symbols are attacker-controlled. Anyone can deploy a token named
`<a href="http://evil">Claim airdrop</a>`, and unescaped that renders as a live
link in the chat — a phishing vector aimed at the reader.

Rendering uses Telegram **HTML** parse mode rather than MarkdownV2: HTML needs
three characters escaped where MarkdownV2 needs eighteen and rejects the entire
message if one is missed. Every interpolated field is escaped, and a test
deploys a hostile symbol to prove it renders inert.

Phase 2's `sanitizeText` already strips control characters at ingest; HTML
injection survives that, so this is a second, independent control.

## Null is carried through to the message

A component G1 could not compute renders as `not measured`, never `0/100`. With
an empty smart-money seed list, `Smart Money: 0/100` would read as "no smart
money present" rather than "we did not look" — the §15 discipline followed all
the way to the reader. Partial evidence surfaces as an explicit coverage line.

## Both alert levels are delivered

`STRONG_SIGNAL` → 🚨, `INTERESTING` → 👀. §18 defines both and dedup already
distinguishes them. In every live run so far INTERESTING is the only level any
token has reached, so delivering STRONG alone would mean an empty channel.

## The job key had to change

`jobId.notification` was `notify.{signalId}.{alertLevel}`. Phase 5.1 lets one
signal produce several alerts at the same level — `FIRST_ALERT`, then
`SCORE_MOVED`, then `COOLDOWN_ELAPSED` — so that key would collide and BullMQ
would silently drop every re-alert. It is now `notify.{alertId}`.

## Two defects found by running it

Both were found by forcing the delivery path with a deliberately invalid bot
token, which exercises everything except a 200.

**1. Orphaned PENDING alerts were never delivered.** `pendingAlerts()` was
written for restart recovery and never wired up. A decision recorded just before
a crash — or any decision surviving a Redis flush — had its queue job vanish
while the obligation remained. The durable table is now the source of truth and
the queue is rebuilt from it at startup. Job IDs are keyed on the alert, so
requeueing something still in flight is a no-op rather than a double send.

**2. A permanently rejected alert stayed PENDING forever.** `guarded()` audits a
permanent error and swallows it, so the worker's `failed` handler never fired
and `markFailed` never ran. The row would be requeued on every restart *and*
keep counting toward dedup — meaning the token could never re-alert. That is
exactly the signal discard §20 forbids, arrived at from the opposite direction.
Permanent failures now mark `FAILED` at the point of failure.

## Failure classification

- 5xx, 429, timeouts, connection errors → `TransientProviderError`, retried with
  bounded backoff.
- 400/401/403 → `InvalidDataError`, terminal. A wrong chat id would otherwise
  burn five attempts on every alert forever and bury real failures in the audit
  table. Verified live: a 401 recorded **1 attempt**, not 5.

`FAILED` is excluded from the dedup baseline, so a failed delivery makes the
token eligible to alert again rather than going silent. That is how §20's
"must not discard" is actually satisfied — not by retrying forever, but by
returning the token to the alertable pool.

## Verification

440 tests. Live: the notification path ran end to end against real pipeline
rows — startup requeue, payload assembly, rendering, HTTP attempt, permanent
classification, `PENDING → FAILED`, and the dedup baseline correctly dropping to
zero. The bot token appeared **zero** times in the run logs, checked the same
way the Alchemy key was in Phase 1.

**Not verified:** a successful delivery. `TELEGRAM_BOT_TOKEN` and
`TELEGRAM_CHAT_ID` were still empty at the end of this phase, so no message has
been delivered to a real chat. Everything up to and including the HTTP call is
proven; the 200 path is not.

Sender concurrency is 1 with a 20-per-minute limiter — Telegram rate-limits per
chat, and a burst would manufacture the very failures the retry path exists to
absorb.
