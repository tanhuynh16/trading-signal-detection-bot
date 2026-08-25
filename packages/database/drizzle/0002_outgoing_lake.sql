CREATE TABLE "signal_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"signal_id" uuid NOT NULL,
	"token_id" uuid NOT NULL,
	"feature_set_id" uuid NOT NULL,
	"alert_level" text NOT NULL,
	"trigger_reason" text,
	"status" text NOT NULL,
	"suppression_reason" text,
	"alpha_score" numeric(6, 3) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "signal_alerts" ADD CONSTRAINT "signal_alerts_signal_id_signals_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."signals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_alerts" ADD CONSTRAINT "signal_alerts_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_alerts" ADD CONSTRAINT "signal_alerts_feature_set_id_feature_sets_id_fk" FOREIGN KEY ("feature_set_id") REFERENCES "public"."feature_sets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "signal_alerts_signal_feature_uq" ON "signal_alerts" USING btree ("signal_id","feature_set_id");--> statement-breakpoint
CREATE INDEX "signal_alerts_token_status_idx" ON "signal_alerts" USING btree ("token_id","status","created_at");