CREATE SCHEMA "hq";
--> statement-breakpoint
CREATE TABLE "hq"."entries" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"slug" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "entries_kind_slug_unique" UNIQUE("kind","slug")
);
--> statement-breakpoint
CREATE TABLE "hq"."entry_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"entry_id" text NOT NULL,
	"version" integer NOT NULL,
	"title" text NOT NULL,
	"body" jsonb NOT NULL,
	"source" text,
	"author_type" text NOT NULL,
	"author_id" text NOT NULL,
	"run_id" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "entry_versions_entry_version_unique" UNIQUE("entry_id","version")
);
--> statement-breakpoint
CREATE TABLE "hq"."proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"entry_id" text,
	"kind" text NOT NULL,
	"slug" text NOT NULL,
	"base_version" integer,
	"title" text NOT NULL,
	"body" jsonb NOT NULL,
	"reason" text NOT NULL,
	"status" text NOT NULL,
	"proposed_by_type" text NOT NULL,
	"proposed_by_id" text NOT NULL,
	"run_id" text,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hq"."entry_versions" ADD CONSTRAINT "entry_versions_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "hq"."entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hq"."proposals" ADD CONSTRAINT "proposals_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "hq"."entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "proposals_status_created_idx" ON "hq"."proposals" USING btree ("status","created_at");