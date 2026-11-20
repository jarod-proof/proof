-- The history rule, at the database: a version is never updated or deleted, whoever asks. Only an
-- insert changes what the brain knows. (TRUNCATE is left to the database owner.)
CREATE FUNCTION "hq"."entry_versions_append_only"() RETURNS trigger AS $$
BEGIN
	RAISE EXCEPTION 'hq.entry_versions is append-only: a version is never updated or deleted'
		USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "entry_versions_append_only"
	BEFORE UPDATE OR DELETE ON "hq"."entry_versions"
	FOR EACH ROW EXECUTE FUNCTION "hq"."entry_versions_append_only"();
