DROP INDEX "signal_alerts_token_status_idx";--> statement-breakpoint
ALTER TABLE "signal_alerts" ADD COLUMN "seq" bigserial NOT NULL;--> statement-breakpoint
ALTER TABLE "signals" ADD COLUMN "seq" bigserial NOT NULL;--> statement-breakpoint
CREATE INDEX "signals_token_seq_idx" ON "signals" USING btree ("token_id","seq");--> statement-breakpoint
CREATE INDEX "signal_alerts_token_status_idx" ON "signal_alerts" USING btree ("token_id","status","seq");