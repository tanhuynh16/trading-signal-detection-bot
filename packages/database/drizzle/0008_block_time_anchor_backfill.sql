-- Backfill the block-time anchor for signals written before the column existed.
--
-- Not a guess: `signal_block_number` was already recorded on every signal, and
-- the snapshot that produced it still holds that block's timestamp, so this
-- recovers a fact we had all along rather than inventing precision. Measured on
-- the live database before this ran: 104 of 1095 signals (9.5%) had a
-- `created_at` more than a minute away from their block time, worst case 7208s,
-- because `created_at` is `now()` — transaction-start time on the Postgres
-- clock — while block time tracked the wall clock to within 6s across all 6100
-- snapshots. Leaving those anchored on `created_at` would keep ~5% of §21
-- outcome windows measuring the wrong interval forever.
--
-- Idempotent: fills only nulls, so a re-run is a no-op.
UPDATE "signals" s
SET "signal_block_time" = ts."observed_at"
FROM (
  SELECT DISTINCT ON ("pool_id", "block_number")
         "pool_id", "block_number", "observed_at"
  FROM "token_snapshots"
  ORDER BY "pool_id", "block_number", "captured_at"
) ts
WHERE s."signal_block_time" IS NULL
  AND s."signal_block_number" IS NOT NULL
  AND ts."pool_id" = s."pool_id"
  AND ts."block_number" = s."signal_block_number";
