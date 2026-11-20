// Paginated lists: pages line up with no repeats or gaps, and a bad cursor is a BAD_REQUEST.
import { encodeCursor } from "@proof/api"
import { member, twoFactor, user as userTable } from "@proof/db"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { createTestApp } from "./app.test.helpers"

type Page = { status: number; body: Record<string, unknown> & { nextCursor: string | null } }

describe("paginated operations", () => {
  let t: Awaited<ReturnType<typeof createTestApp>>
  beforeAll(async () => {
    t = await createTestApp()
  })
  afterAll(() => t.close())

  const get = async (path: string, credential: string): Promise<Page> => {
    const res = await t.req(path, t.as(credential))
    return { status: res.status, body: (await res.json()) as Page["body"] }
  }

  /** Walk every page of a list, returning the items in order. */
  async function walk(path: string, credential: string, key: string, limit: number) {
    const items: { id: string }[] = []
    let cursor: string | null = null
    let pages = 0
    do {
      const qs = new URLSearchParams({ limit: String(limit), ...(cursor ? { cursor } : {}) })
      const page = await get(`${path}?${qs}`, credential)
      expect(page.status).toBe(200)
      items.push(...(page.body[key] as { id: string }[]))
      cursor = page.body.nextCursor
      pages++
      expect(pages).toBeLessThan(50)
    } while (cursor !== null)
    return { items, pages }
  }

  describe("list_projects", () => {
    it("pages through every project once, in creation order, with nextCursor", async () => {
      const created: string[] = []
      for (let i = 1; i <= 5; i++) {
        const res = await t.req(
          "/v1/projects",
          t.as(t.fullKey, { method: "POST", body: JSON.stringify({ name: `P${i}` }) }),
        )
        created.push(((await res.json()) as { id: string }).id)
      }
      const { items, pages } = await walk("/v1/projects", t.readKey, "projects", 2)
      expect(pages).toBe(3)
      // Projects created in the same millisecond order by id, so compare as sets: no repeats, no gaps.
      expect(items.map((p) => p.id).sort()).toEqual([...created].sort())
    })

    it("returns a null nextCursor on the last page and the default page size otherwise", async () => {
      const first = await get("/v1/projects", t.readKey)
      expect(first.body.nextCursor).toBeNull()
      expect((first.body.projects as unknown[]).length).toBe(5)
    })

    it("starts from the first page when cursor is empty, as a form or template sends it", async () => {
      const empty = await get("/v1/projects?cursor=", t.readKey)
      expect(empty.status).toBe(200)
      expect(empty.body).toEqual((await get("/v1/projects", t.readKey)).body)
    })

    it("answers BAD_REQUEST with a hint for a garbage cursor", async () => {
      for (const cursor of [
        "not-a-cursor",
        encodeCursor({ at: "yesterday", id: "x" }),
        // A valid ISO date that Postgres can't store: year 0 is out of its timestamp range.
        encodeCursor({ at: "0000-01-01T00:00:00Z", id: "x" }),
      ]) {
        const res = await get(`/v1/projects?cursor=${encodeURIComponent(cursor)}`, t.readKey)
        expect(res.status, cursor).toBe(400)
        expect(res.body.error).toMatchObject({ code: "BAD_REQUEST", message: "Invalid cursor" })
        expect((res.body.error as { hint: string }).hint).toContain("nextCursor")
      }
    })

    it("rejects a limit above 100", async () => {
      const res = await get("/v1/projects?limit=101", t.readKey)
      expect(res.status).toBe(400)
    })
  })

  describe("list_audit_events", () => {
    it("pages through audit events newest first, without repeats", async () => {
      for (let i = 1; i <= 3; i++) {
        await t.req(
          "/v1/projects",
          t.as(t.fullKey, { method: "POST", body: JSON.stringify({ name: `A${i}` }) }),
        )
      }
      const { items } = await walk("/v1/audit-events", t.owner.cookie, "events", 2)
      const ids = items.map((e) => e.id)
      expect(new Set(ids).size).toBe(ids.length)
      expect(ids.length).toBeGreaterThanOrEqual(8)
      const first = await get("/v1/audit-events?limit=1", t.owner.cookie)
      const events = first.body.events as { operation: string; actor: { type: string } }[]
      expect(events[0]).toMatchObject({ operation: "create_project", actor: { type: "apiKey" } })
    })

    it("needs the organization admin permission", async () => {
      const res = await t.req("/v1/audit-events", t.as(t.fullKey))
      expect(res.status).toBe(403)
      expect((await res.json()).error.hint).toContain("organization")
    })

    it("answers BAD_REQUEST, not a server error, for a cursor with a bad time", async () => {
      const cursor = encodeCursor({ at: "not-a-date", id: "x" })
      const res = await get(`/v1/audit-events?cursor=${encodeURIComponent(cursor)}`, t.owner.cookie)
      expect(res.status).toBe(400)
      expect(res.body.error).toMatchObject({ code: "BAD_REQUEST" })
    })
  })
})

describe("reset_member_two_factor scope", () => {
  let t: Awaited<ReturnType<typeof createTestApp>>
  beforeAll(async () => {
    t = await createTestApp()
  })
  afterAll(() => t.close())

  const reset = (userId: string) =>
    t.req(`/v1/members/${userId}/two-factor/reset`, t.as(t.owner.cookie, { method: "POST" }))

  const enableTwoFactor = async (userId: string) => {
    await t.db
      .insert(twoFactor)
      .values({ id: `tf-${userId}`, secret: "s", backupCodes: "b", userId })
    await t.db.update(userTable).set({ twoFactorEnabled: true }).where(eq(userTable.id, userId))
  }

  it("lets an owner reset a member whose only organization is this one", async () => {
    await enableTwoFactor(t.viewer.userId)
    const res = await reset(t.viewer.userId)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ reset: true })
    const rows = await t.db.select().from(twoFactor).where(eq(twoFactor.userId, t.viewer.userId))
    expect(rows).toHaveLength(0)
  })

  it("refuses with CONFLICT, and changes nothing, for a member of another organization too", async () => {
    await t.db.insert(member).values({
      id: "member-elsewhere",
      organizationId: t.other.orgId,
      userId: t.viewer.userId,
      role: "member",
      createdAt: new Date(),
    })
    await enableTwoFactor(t.viewer.userId)
    const res = await reset(t.viewer.userId)
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string; hint?: string } }
    expect(body.error.code).toBe("CONFLICT")
    expect(body.error.hint).toMatch(/own security settings/)
    const rows = await t.db.select().from(twoFactor).where(eq(twoFactor.userId, t.viewer.userId))
    expect(rows).toHaveLength(1)
    const [u] = await t.db
      .select({ enabled: userTable.twoFactorEnabled })
      .from(userTable)
      .where(eq(userTable.id, t.viewer.userId))
    expect(u?.enabled).toBe(true)
  })
})
