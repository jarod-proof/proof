import { fileURLToPath } from "node:url"

/**
 * hq's migrations (apps/hq/drizzle) sit beside starter's, which also run on the hq database (auth
 * tables). Each folder has its own bookkeeping table, because Drizzle skips any migration older
 * than the newest one recorded in the table it uses: sharing one would silently drop hq's.
 */
export const HQ_MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url))
export const HQ_MIGRATIONS_TABLE = "__hq_migrations"
export const HQ_MIGRATIONS_SCHEMA = "drizzle"
