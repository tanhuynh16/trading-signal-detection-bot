CREATE TABLE IF NOT EXISTS "reorg_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"detected_at_block" bigint NOT NULL,
	"rewound_to_block" bigint NOT NULL,
	"rewound_to_block_time" timestamp with time zone,
	"expected_hash" text,
	"actual_hash" text,
	"deleted_trades" integer DEFAULT 0 NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "discovery_cursors" ADD COLUMN IF NOT EXISTS "last_processed_block_hash" text;--> statement-breakpoint
ALTER TABLE "signals" ADD COLUMN IF NOT EXISTS "signal_block_time" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reorg_events_time_idx" ON "reorg_events" USING btree ("occurred_at");
