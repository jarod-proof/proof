import { createTestDb } from "@proof/db/testing"
import { migrate } from "drizzle-orm/pglite/migrator"

import { HQ_MIGRATIONS_FOLDER, HQ_MIGRATIONS_SCHEMA, HQ_MIGRATIONS_TABLE } from "./db/migrations"

/**
 * In-process Postgres (PGlite) with starter's migrations (the auth tables) and hq's own, the same
 * two sets the hq database has. Use one per test file; call `close()` when done.
 */
export async function createHqTestDb() {
  const test = await createTestDb()
  await migrate(test.db, {
    migrationsFolder: HQ_MIGRATIONS_FOLDER,
    migrationsTable: HQ_MIGRATIONS_TABLE,
    migrationsSchema: HQ_MIGRATIONS_SCHEMA,
  })
  return test
}
