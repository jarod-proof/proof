CREATE TABLE "hq"."runs" (
	"id" text PRIMARY KEY NOT NULL,
	"task" text NOT NULL,
	"trigger" text NOT NULL,
	"runner" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"outcome" text,
	"link" text,
	"summary" jsonb
);
--> statement-breakpoint
CREATE TABLE "hq"."spend" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text,
	"day" date NOT NULL,
	"source" text NOT NULL,
	"amount_usd" numeric(10, 4) NOT NULL,
	"model" text NOT NULL,
	"estimated" boolean NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "spend_amount_nonnegative" CHECK ("hq"."spend"."amount_usd" >= 0)
);
--> statement-breakpoint
CREATE TABLE "hq"."spend_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"day" date NOT NULL,
	"amount_usd" numeric(10, 4) NOT NULL,
	"granted_by" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "spend_grants_amount_positive" CHECK ("hq"."spend_grants"."amount_usd" > 0)
);
--> statement-breakpoint
CREATE TABLE "hq"."spend_holds" (
	"id" text PRIMARY KEY NOT NULL,
	"day" date NOT NULL,
	"estimate_usd" numeric(10, 4) NOT NULL,
	"run_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "spend_holds_estimate_positive" CHECK ("hq"."spend_holds"."estimate_usd" > 0)
);
--> statement-breakpoint
CREATE INDEX "runs_started_idx" ON "hq"."runs" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "spend_day_source_idx" ON "hq"."spend" USING btree ("day","source");--> statement-breakpoint
CREATE INDEX "spend_grants_day_idx" ON "hq"."spend_grants" USING btree ("day");--> statement-breakpoint
CREATE INDEX "spend_holds_day_idx" ON "hq"."spend_holds" USING btree ("day");