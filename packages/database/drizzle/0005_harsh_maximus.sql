CREATE TABLE "quote_price_samples" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chain_id" integer NOT NULL,
	"token_address" text NOT NULL,
	"price_usd" numeric(38, 18) NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "signal_outcomes" ADD COLUMN "trade_count" integer;--> statement-breakpoint
CREATE INDEX "quote_price_samples_token_time_idx" ON "quote_price_samples" USING btree ("token_address","observed_at");