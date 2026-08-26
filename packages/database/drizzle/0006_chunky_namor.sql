ALTER TABLE "discovery_cursors" ADD COLUMN "last_processed_block_time" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "signal_outcomes" ADD COLUMN "revision" integer DEFAULT 0 NOT NULL;