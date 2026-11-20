CREATE TABLE "hq"."spend_grant_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"amount_usd" numeric(10, 4) NOT NULL,
	"reason" text NOT NULL,
	"run_id" text,
	"status" text NOT NULL,
	"requested_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" text,
	CONSTRAINT "spend_grant_requests_amount_positive" CHECK ("hq"."spend_grant_requests"."amount_usd" > 0)
);
--> statement-breakpoint
CREATE INDEX "spend_grant_requests_created_idx" ON "hq"."spend_grant_requests" USING btree ("created_at");