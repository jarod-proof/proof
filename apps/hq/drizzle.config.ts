import { defineConfig } from "drizzle-kit"

// hq's own tables only: `pgSchema("hq")`. The auth tables come from starter's migrations
// (packages/db), which are applied to the hq database too. hq's migrations keep their own
// bookkeeping table, so the two folders' histories never mix (see src/db/migrations.ts).
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  schemaFilter: ["hq"],
  migrations: { table: "__hq_migrations", schema: "drizzle" },
  dbCredentials: { url: process.env.HQ_DATABASE_URL ?? "" },
})
