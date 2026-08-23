# ADR 0007 — Scrub secret values, not just field names

**Status:** accepted (Phase 1)

## Context
Phase 0 redacted logs by field name (`apiKey`, `botToken`, `DATABASE_URL`, …).
The first live run against Base proved that insufficient. viem embeds the full
request URL in its HTTP error messages, so a 429 produced:

```
"err": "HTTP request failed.\nStatus: 429\nURL: https://base-mainnet.g.alchemy.com/v2/<API KEY>\n..."
```

The API key reached the log as part of a *string value*, under the innocuous
key `err`. No field-name rule can catch that, and spec §24 is unconditional:
never log credentials.

## Decision
`packages/shared/src/redact.ts` scrubs by **value**:

- `registerSecret(value)` is called at startup for every real secret (RPC URLs,
  database and Redis URLs, Telegram token). Any later log line containing one,
  in any field or in the message, has it replaced.
- Registering an RPC URL also registers its long path segments, so a line
  quoting only the key is still caught.
- A small pattern set covers credential shapes that were never registered
  (Telegram tokens, URLs with opaque paths), keeping the host visible so logs
  still say which provider failed.
- `redactDeep` walks every value in the payload; a pino `logMethod` hook covers
  the message string.

Registering literal values is the primary mechanism because it cannot miss a
format we failed to anticipate; the patterns are only a backstop.

## Also fixed
Phase 0 redacted the field name `token`. In this domain that field holds a
**token contract address** — public data, and the entire point of discovery.
Logs read `"token":"[REDACTED]"` for every pool found. The bare `token` path was
removed; only credential-shaped names remain.

## Consequences
Secrets are scrubbed on the way out regardless of which library leaked them.
The cost is a walk over each log payload, which is negligible next to the I/O,
and a small risk of over-redaction if a very short secret were registered —
mitigated by ignoring registered values under 8 characters.
