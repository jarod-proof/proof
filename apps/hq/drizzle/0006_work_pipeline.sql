CREATE TABLE "hq"."agent_questions" (
	"id" text PRIMARY KEY NOT NULL,
	"item_id" text NOT NULL,
	"attempt_id" text,
	"prompt" text NOT NULL,
	"options" jsonb NOT NULL,
	"default_option_id" text,
	"status" text NOT NULL,
	"answered_option_id" text,
	"answer_note" text,
	"answered_by" text,
	"answered_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hq"."attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"item_id" text NOT NULL,
	"number" integer NOT NULL,
	"cycle" integer NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"result" text,
	"requested_by" text,
	"instructions" text,
	"claimed_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone,
	"last_heartbeat_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"duration_ms" integer,
	"files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"note" text,
	"branch" text,
	"reviewer_verdict" text,
	"reviewer_summary" text,
	"reviewed_head_sha" text,
	"run_id" text,
	"session_id" text,
	"external_ref" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "attempts_item_number_unique" UNIQUE("item_id","number")
);
--> statement-breakpoint
CREATE TABLE "hq"."contract_items" (
	"id" text PRIMARY KEY NOT NULL,
	"item_id" text NOT NULL,
	"cycle" integer NOT NULL,
	"position" integer NOT NULL,
	"text" text NOT NULL,
	"verifier_kind" text NOT NULL,
	"verifier_config" jsonb,
	"status" text NOT NULL,
	"evidence" text,
	"checked_at" timestamp with time zone,
	"created_by_type" text NOT NULL,
	"created_by_id" text NOT NULL,
	CONSTRAINT "contract_items_item_cycle_position_unique" UNIQUE("item_id","cycle","position")
);
--> statement-breakpoint
CREATE TABLE "hq"."merge_approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"item_id" text NOT NULL,
	"pull_request_id" text NOT NULL,
	"head_sha" text NOT NULL,
	"status" text NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "hq"."pull_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"item_id" text NOT NULL,
	"attempt_id" text,
	"number" integer NOT NULL,
	"url" text NOT NULL,
	"branch" text NOT NULL,
	"base" text NOT NULL,
	"head_sha" text NOT NULL,
	"is_draft" boolean NOT NULL,
	"state" text NOT NULL,
	"additions" integer,
	"deletions" integer,
	"files" integer,
	"checks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"merged_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"merged_by" text,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "pull_requests_item_number_unique" UNIQUE("item_id","number")
);
--> statement-breakpoint
CREATE TABLE "hq"."signals" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"repo" text NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"url" text,
	"payload" jsonb,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"item_id" text NOT NULL,
	"recorded_by_type" text NOT NULL,
	"recorded_by_id" text NOT NULL,
	CONSTRAINT "signals_source_external_id_unique" UNIQUE("source","external_id")
);
--> statement-breakpoint
CREATE TABLE "hq"."verification_windows" (
	"id" text PRIMARY KEY NOT NULL,
	"item_id" text NOT NULL,
	"cycle" integer NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"checked_at" timestamp with time zone,
	"result_note" text,
	CONSTRAINT "verification_windows_item_cycle_unique" UNIQUE("item_id","cycle")
);
--> statement-breakpoint
CREATE TABLE "hq"."work_item_events" (
	"id" text PRIMARY KEY NOT NULL,
	"item_id" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"kind" text NOT NULL,
	"from_state" text,
	"to_state" text,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"reason" text,
	"note" text,
	"detail" jsonb,
	"cycle" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hq"."work_items" (
	"id" text PRIMARY KEY NOT NULL,
	"number" integer GENERATED ALWAYS AS IDENTITY (sequence name "hq"."work_items_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"title" text NOT NULL,
	"repo" text NOT NULL,
	"source" text NOT NULL,
	"state" text NOT NULL,
	"cycle" integer DEFAULT 1 NOT NULL,
	"dedupe_key" text,
	"attempt_limit" integer,
	"created_by_type" text NOT NULL,
	"created_by_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"state_changed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "work_items_number_unique" UNIQUE("number")
);
--> statement-breakpoint
ALTER TABLE "hq"."agent_questions" ADD CONSTRAINT "agent_questions_item_id_work_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "hq"."work_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hq"."attempts" ADD CONSTRAINT "attempts_item_id_work_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "hq"."work_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hq"."contract_items" ADD CONSTRAINT "contract_items_item_id_work_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "hq"."work_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hq"."merge_approvals" ADD CONSTRAINT "merge_approvals_item_id_work_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "hq"."work_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hq"."merge_approvals" ADD CONSTRAINT "merge_approvals_pull_request_id_pull_requests_id_fk" FOREIGN KEY ("pull_request_id") REFERENCES "hq"."pull_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hq"."pull_requests" ADD CONSTRAINT "pull_requests_item_id_work_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "hq"."work_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hq"."signals" ADD CONSTRAINT "signals_item_id_work_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "hq"."work_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hq"."verification_windows" ADD CONSTRAINT "verification_windows_item_id_work_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "hq"."work_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hq"."work_item_events" ADD CONSTRAINT "work_item_events_item_id_work_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "hq"."work_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_questions_item_idx" ON "hq"."agent_questions" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "agent_questions_status_idx" ON "hq"."agent_questions" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "attempts_one_active_per_item_idx" ON "hq"."attempts" USING btree ("item_id") WHERE "hq"."attempts"."status" in ('requested', 'running');--> statement-breakpoint
CREATE UNIQUE INDEX "attempts_item_external_ref_idx" ON "hq"."attempts" USING btree ("item_id","external_ref") WHERE "hq"."attempts"."external_ref" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "merge_approvals_one_pending_per_pull_request_idx" ON "hq"."merge_approvals" USING btree ("pull_request_id") WHERE "hq"."merge_approvals"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "pull_requests_branch_idx" ON "hq"."pull_requests" USING btree ("branch");--> statement-breakpoint
CREATE INDEX "signals_dedupe_occurred_idx" ON "hq"."signals" USING btree ("dedupe_key","occurred_at");--> statement-breakpoint
CREATE INDEX "signals_item_idx" ON "hq"."signals" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "work_item_events_item_at_idx" ON "hq"."work_item_events" USING btree ("item_id","at");--> statement-breakpoint
CREATE INDEX "work_items_state_idx" ON "hq"."work_items" USING btree ("state");--> statement-breakpoint
CREATE INDEX "work_items_dedupe_created_idx" ON "hq"."work_items" USING btree ("dedupe_key","created_at");