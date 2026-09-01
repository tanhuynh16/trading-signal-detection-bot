CREATE TABLE "ingestion_gaps" (
	"id" serial PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"from_block" bigint NOT NULL,
	"to_block" bigint NOT NULL,
	"from_time" timestamp with time zone,
	"to_time" timestamp with time zone,
	"reason" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "ingestion_gaps_source_time_idx" ON "ingestion_gaps" USING btree ("source","occurred_at");