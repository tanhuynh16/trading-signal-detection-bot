ALTER TABLE "feature_sets" ADD COLUMN "scheduled_offset" text;--> statement-breakpoint
CREATE UNIQUE INDEX "feature_sets_pool_offset_uq" ON "feature_sets" USING btree ("pool_id","scheduled_offset");