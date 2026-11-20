import type { Caller } from "@proof/api"
import { callerActsFor, name, OrganizationId } from "@proof/auth-proofs"
import { organization } from "@proof/db"
import { createTestDb } from "@proof/db/testing"
import { sql } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createProject } from "./projects"

const caller: Caller = {
  organizationId: "org_a",
  actor: { type: "user", userId: "user_1" },
  grants: [],
  via: "session",
}

describe("projects", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>
  beforeAll(async () => {
    t = await createTestDb()
    await t.db
      .insert(organization)
      .values({ id: "org_a", name: "A", slug: "a", createdAt: new Date() })
  })
  afterAll(() => t.close())

  it("stamps createdAt in UTC whatever the database session's time zone", async () => {
    // created_at has no time zone: a database default would store the session's wall clock.
    await t.db.execute(sql`set time zone 'America/Denver'`)
    const row = await name(OrganizationId("org_a"), (org) => {
      const proof = callerActsFor(caller, org)
      if (!proof) throw new Error("caller does not act for the organization")
      return createProject(t.db, org, { name: "Site" }, proof)
    })
    expect(Math.abs(row.createdAt.getTime() - Date.now())).toBeLessThan(60_000)
  })
})
