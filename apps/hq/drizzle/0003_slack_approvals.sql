CREATE TABLE "hq"."founders" (
	"user_id" text PRIMARY KEY NOT NULL,
	"slack_user_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "founders_slack_user_id_unique" UNIQUE("slack_user_id")
);
--> statement-breakpoint
CREATE TABLE "hq"."slack_actions" (
	"key" text PRIMARY KEY NOT NULL,
	"outcome" text NOT NULL,
	"slack_user_id" text NOT NULL,
	"user_id" text NOT NULL,
	"action_ts" text,
	"created_at" timestamp with time zone NOT NULL
);
