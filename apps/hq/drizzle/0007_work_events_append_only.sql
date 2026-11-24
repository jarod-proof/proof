-- The history rule, at the database: a work item's event is never updated or deleted, whoever
-- asks. Only an insert changes what an item's history says. (TRUNCATE is left to the database
-- owner.)
CREATE FUNCTION "hq"."work_item_events_append_only"() RETURNS trigger AS $$
BEGIN
	RAISE EXCEPTION 'hq.work_item_events is append-only: an event is never updated or deleted'
		USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "work_item_events_append_only"
	BEFORE UPDATE OR DELETE ON "hq"."work_item_events"
	FOR EACH ROW EXECUTE FUNCTION "hq"."work_item_events_append_only"();
