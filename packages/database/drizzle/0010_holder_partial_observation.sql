-- Holder balances can no longer be negative.
--
-- A negative balance meant we applied a transfer OUT whose matching transfer IN
-- happened before the transfer tail's cursor: the wallet was funded before we
-- started reading. That is missing history, not a debt.
--
-- Measured at the time of this migration: 739 rows across 123 tokens were
-- negative, the worst at -1.5e28. The feature layer never surfaced them because
-- `eligible()` filters `balance > dustThreshold`, so a negative row is silently
-- dropped -- and so is a wallet whose balance is merely UNDERSTATED, which
-- removes a real holder from top10_concentration rather than a phantom one.
--
-- `partially_observed` marks a balance as a LOWER BOUND rather than a
-- measurement: 0 there means "we cannot tell", not "holds nothing". It is the
-- null that §15 would have used if numeric(78,0) NOT NULL had one to spare.
ALTER TABLE "holder_balances"
  ADD COLUMN IF NOT EXISTS "partially_observed" boolean DEFAULT false NOT NULL;
--> statement-breakpoint

-- Correct the rows already stored. This rewrites history, deliberately and
-- visibly: the previous values are not data, they are an accounting artifact,
-- and every one of them was already being discarded by the feature layer. The
-- flag preserves the fact that these wallets' inbound history is incomplete.
UPDATE "holder_balances"
   SET "partially_observed" = true,
       "balance_raw" = 0
 WHERE "balance_raw" < 0;
