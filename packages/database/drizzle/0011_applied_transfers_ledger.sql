-- Make holder balance accounting idempotent.
--
-- `holder_balances` is a running sum, so applying one Transfer twice is
-- permanent corruption rather than a duplicate row. `trades` never had this
-- problem: it stores one row per log under uniqueIndex(tx_hash, log_index), so
-- re-ingesting is a no-op. Balances had no equivalent identity, and the startup
-- replay overlap (DISCOVERY_BLOCK_OVERLAP, applied on the first drain after
-- every restart) re-applied every Transfer in the overlapped range.
--
-- Measured before this table existed: sum(balances)/totalSupply was QUANTIZED --
-- 60 tokens at ~1x, 59 at ~2x, 3 at ~3x -- which is the signature of whole
-- re-applications, not of a continuous accounting error. One token's top holder
-- was checked against on-chain balanceOf at a ratio of exactly 2.000.
CREATE TABLE IF NOT EXISTS "applied_transfers" (
  "tx_hash"      text        NOT NULL,
  "log_index"    integer     NOT NULL,
  "block_number" bigint      NOT NULL,
  "applied_at"   timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "applied_transfers_tx_log_uq"
  ON "applied_transfers" ("tx_hash", "log_index");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "applied_transfers_block_idx"
  ON "applied_transfers" ("block_number");
--> statement-breakpoint

-- Mark, do NOT rewrite.
--
-- Balances accumulated before this ledger existed may have been applied more
-- than once. Those rows are the audit trail of what the system actually
-- believed, and §22 keeps historical semantics intact, so they stay as they are.
-- The flag exists so calibration can exclude them rather than silently treating
-- corrupt balances as evidence.
ALTER TABLE "tokens"
  ADD COLUMN IF NOT EXISTS "holder_history_suspect" boolean DEFAULT false NOT NULL;
--> statement-breakpoint

-- Every token that already has holder rows predates the ledger, so none of its
-- balances can be proven single-applied.
UPDATE "tokens" t
   SET "holder_history_suspect" = true
 WHERE EXISTS (SELECT 1 FROM "holder_balances" h WHERE h."token_id" = t."id");
