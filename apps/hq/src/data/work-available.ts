// Whether the work pipeline's tables exist in this database. An hq deployed before step 05 (the
// migrations) has none, and the two older endpoints that read them (`get_factory_status`,
// `get_digest`) must keep answering. The check comes first, in one query, instead of catching an
// error: an error inside a transaction aborts the transaction.
import type { Database } from "@proof/db"
import { sql } from "drizzle-orm"

export async function workTablesExist(db: Database): Promise<boolean> {
  const [row] = await db
    .select({
      exist: sql<boolean>`to_regclass('hq.work_items') is not null and to_regclass('hq.work_item_events') is not null`,
    })
    .from(sql`(values (1)) as "one"("n")`)
  return row?.exist === true
}
