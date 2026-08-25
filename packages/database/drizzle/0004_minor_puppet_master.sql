CREATE TABLE "notifier_circuit" (
	"notifier" text PRIMARY KEY NOT NULL,
	"state" text DEFAULT 'CLOSED' NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"opened_at" timestamp with time zone,
	"reopen_after" timestamp with time zone,
	"last_failure_code" text,
	"last_failure_reason" text,
	"last_failure_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
