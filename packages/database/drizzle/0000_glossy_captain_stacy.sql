CREATE TABLE "discovery_cursors" (
	"source" text PRIMARY KEY NOT NULL,
	"last_processed_block" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feature_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_id" uuid NOT NULL,
	"pool_id" uuid NOT NULL,
	"calculated_at" timestamp with time zone NOT NULL,
	"feature_version" text NOT NULL,
	"values" jsonb NOT NULL,
	"normalized_values" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "holder_balances" (
	"token_id" uuid NOT NULL,
	"wallet" text NOT NULL,
	"balance_raw" numeric(78, 0) NOT NULL,
	"first_acquired_at" timestamp with time zone NOT NULL,
	"last_updated_block" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs_audit" (
	"id" serial PRIMARY KEY NOT NULL,
	"queue" text NOT NULL,
	"job_id" text NOT NULL,
	"correlation_id" text,
	"status" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"error_message" text,
	"payload" jsonb,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_id" uuid NOT NULL,
	"chain_id" integer NOT NULL,
	"dex" text NOT NULL,
	"address" text NOT NULL,
	"quote_token_address" text NOT NULL,
	"has_known_quote_token" boolean DEFAULT true NOT NULL,
	"pool_created_at" timestamp with time zone,
	"discovered_at" timestamp with time zone NOT NULL,
	"block_number" bigint NOT NULL,
	"transaction_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "risk_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_id" uuid NOT NULL,
	"pool_id" uuid,
	"evaluated_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"risk_score" numeric(6, 3) NOT NULL,
	"flags" jsonb NOT NULL,
	"provider_name" text,
	"provider_raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signal_outcomes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"signal_id" uuid NOT NULL,
	"horizon" text NOT NULL,
	"evaluated_at" timestamp with time zone NOT NULL,
	"price_usd" numeric(38, 18),
	"return_pct" numeric(20, 6),
	"max_runup_pct" numeric(20, 6),
	"max_drawdown_pct" numeric(20, 6),
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signal_transitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"signal_id" uuid NOT NULL,
	"from_state" text,
	"to_state" text NOT NULL,
	"reason" text NOT NULL,
	"alpha_score" numeric(6, 3),
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_id" uuid NOT NULL,
	"pool_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"state" text NOT NULL,
	"alpha_score" numeric(6, 3) NOT NULL,
	"components" jsonb NOT NULL,
	"coverage" numeric(5, 4) NOT NULL,
	"strategy_version" text NOT NULL,
	"feature_set_id" uuid,
	"alert_level" text NOT NULL,
	"signal_price_usd" numeric(38, 18),
	"signal_block_number" bigint
);
--> statement-breakpoint
CREATE TABLE "token_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_id" uuid NOT NULL,
	"pool_id" uuid NOT NULL,
	"scheduled_offset" text NOT NULL,
	"block_number" bigint NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"price_usd" numeric(38, 18),
	"market_cap_usd" numeric(38, 18),
	"liquidity_usd" numeric(38, 18),
	"base_reserve_raw" numeric(78, 0),
	"quote_reserve_raw" numeric(78, 0),
	"volume_usd_5m" numeric(38, 18),
	"buy_count_5m" integer,
	"sell_count_5m" integer,
	"unique_buyers_5m" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chain_id" integer NOT NULL,
	"address" text NOT NULL,
	"symbol" text,
	"name" text,
	"decimals" integer,
	"total_supply_raw" numeric(78, 0),
	"first_seen_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trades" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pool_id" uuid NOT NULL,
	"tx_hash" text NOT NULL,
	"log_index" integer NOT NULL,
	"wallet" text NOT NULL,
	"side" text NOT NULL,
	"block_number" bigint NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"base_amount_raw" numeric(78, 0) NOT NULL,
	"quote_amount_raw" numeric(78, 0) NOT NULL,
	"usd_value" numeric(38, 18),
	"price_usd" numeric(38, 18),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallet_clusters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cluster_key" text NOT NULL,
	"wallet_address" text NOT NULL,
	"evidence_type" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"detected_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chain_id" integer NOT NULL,
	"address" text NOT NULL,
	"source" text NOT NULL,
	"alpha_score" numeric(6, 3),
	"alpha_score_version" text,
	"metrics" jsonb,
	"last_evaluated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "feature_sets" ADD CONSTRAINT "feature_sets_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_sets" ADD CONSTRAINT "feature_sets_pool_id_pools_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."pools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holder_balances" ADD CONSTRAINT "holder_balances_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pools" ADD CONSTRAINT "pools_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_results" ADD CONSTRAINT "risk_results_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_results" ADD CONSTRAINT "risk_results_pool_id_pools_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."pools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_outcomes" ADD CONSTRAINT "signal_outcomes_signal_id_signals_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."signals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_transitions" ADD CONSTRAINT "signal_transitions_signal_id_signals_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."signals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_pool_id_pools_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."pools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_feature_set_id_feature_sets_id_fk" FOREIGN KEY ("feature_set_id") REFERENCES "public"."feature_sets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_snapshots" ADD CONSTRAINT "token_snapshots_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_snapshots" ADD CONSTRAINT "token_snapshots_pool_id_pools_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."pools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_pool_id_pools_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."pools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "feature_sets_pool_time_idx" ON "feature_sets" USING btree ("pool_id","calculated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "holder_balances_token_wallet_uq" ON "holder_balances" USING btree ("token_id","wallet");--> statement-breakpoint
CREATE INDEX "holder_balances_token_balance_idx" ON "holder_balances" USING btree ("token_id","balance_raw");--> statement-breakpoint
CREATE INDEX "jobs_audit_queue_time_idx" ON "jobs_audit" USING btree ("queue","occurred_at");--> statement-breakpoint
CREATE INDEX "jobs_audit_correlation_idx" ON "jobs_audit" USING btree ("correlation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pools_chain_address_uq" ON "pools" USING btree ("chain_id","address");--> statement-breakpoint
CREATE INDEX "pools_token_idx" ON "pools" USING btree ("token_id");--> statement-breakpoint
CREATE INDEX "pools_discovered_idx" ON "pools" USING btree ("discovered_at");--> statement-breakpoint
CREATE INDEX "risk_results_token_time_idx" ON "risk_results" USING btree ("token_id","evaluated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "signal_outcomes_signal_horizon_uq" ON "signal_outcomes" USING btree ("signal_id","horizon");--> statement-breakpoint
CREATE INDEX "signal_transitions_signal_idx" ON "signal_transitions" USING btree ("signal_id","occurred_at");--> statement-breakpoint
CREATE INDEX "signals_token_time_idx" ON "signals" USING btree ("token_id","created_at");--> statement-breakpoint
CREATE INDEX "signals_state_idx" ON "signals" USING btree ("state");--> statement-breakpoint
CREATE UNIQUE INDEX "token_snapshots_pool_offset_uq" ON "token_snapshots" USING btree ("pool_id","scheduled_offset");--> statement-breakpoint
CREATE INDEX "token_snapshots_pool_time_idx" ON "token_snapshots" USING btree ("pool_id","captured_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tokens_chain_address_uq" ON "tokens" USING btree ("chain_id","address");--> statement-breakpoint
CREATE UNIQUE INDEX "trades_tx_log_uq" ON "trades" USING btree ("tx_hash","log_index");--> statement-breakpoint
CREATE INDEX "trades_pool_time_idx" ON "trades" USING btree ("pool_id","occurred_at");--> statement-breakpoint
CREATE INDEX "trades_wallet_idx" ON "trades" USING btree ("wallet");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_clusters_key_wallet_uq" ON "wallet_clusters" USING btree ("cluster_key","wallet_address");--> statement-breakpoint
CREATE INDEX "wallet_clusters_wallet_idx" ON "wallet_clusters" USING btree ("wallet_address");--> statement-breakpoint
CREATE UNIQUE INDEX "wallets_chain_address_uq" ON "wallets" USING btree ("chain_id","address");