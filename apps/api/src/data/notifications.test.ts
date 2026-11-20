// listNotifications against the real schema, seeded through the API's notifier (never raw inserts):
// only the person's rows stamped with the organization, newest first, paged on (created_at, id).
import type { Caller } from "@proof/api"
import { notification } from "@proof/db"
import { and, desc, eq, isNull } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { createTestApp } from "../app.test.helpers"
import { createApiNotifier } from "../notifications"
import { inCallerOrg } from "../tenant"
import { listNotifications, type NotificationRow } from "./notifications"

const callerOf = (organizationId: string, userId: string): Caller => ({
  organizationId,
  actor: { type: "user", userId },
  grants: [],
  via: "session",
})

describe("listNotifications", () => {
  let t: Awaited<ReturnType<typeof createTestApp>>
  /** An organization the owner belongs to besides acme. */
  let thirdOrgId: string
  const errors: unknown[] = []

  beforeAll(async () => {
    t = await createTestApp()
    const third = await t.signUp("Third")
    thirdOrgId = third.orgId
    await t.auth.api.addMember({
      body: { organizationId: third.orgId, userId: t.owner.userId, role: "member" },
    })
    const notifier = createApiNotifier({ auth: t.auth, db: t.db, onError: (e) => errors.push(e) })
    const roleChanged = (orgId: string, userId: string, role: string) =>
      inCallerOrg(callerOf(orgId, t.owner.userId), (org, proof) =>
        notifier.inOrg(org, proof, { type: "member.role_changed", memberUserId: userId, role }),
      )
    for (const role of ["admin", "member", "viewer", "admin", "member"]) {
      await roleChanged(t.owner.orgId, t.owner.userId, role)
    }
    await roleChanged(t.owner.orgId, t.viewer.userId, "member")
    // Three rows in the same millisecond: a tie on created_at, broken by id.
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date())
    try {
      for (const role of ["owner", "admin", "member"]) {
        await roleChanged(t.owner.orgId, t.owner.userId, role)
      }
    } finally {
      vi.useRealTimers()
    }
    await roleChanged(thirdOrgId, t.owner.userId, "admin")
    await notifier.personal({ type: "account.password_changed", userId: t.owner.userId })
  })

  afterAll(() => t.close())

  const list = (orgId: string, userId: string, limit: number, after?: { at: string; id: string }) =>
    inCallerOrg(callerOf(orgId, userId), (org, proof) =>
      listNotifications(t.db, org, proof, { userId, after, limit }),
    )

  /** Every page of `limit`, following the last row of each, as the operation's cursor does. */
  async function allPages(orgId: string, userId: string, limit: number) {
    const rows: NotificationRow[] = []
    let after: { at: string; id: string } | undefined
    for (;;) {
      const page = await list(orgId, userId, limit + 1, after)
      rows.push(...page.slice(0, limit))
      const last = page[limit - 1]
      if (page.length <= limit || !last) return rows
      after = { at: last.createdAt.toISOString(), id: last.id }
    }
  }

  const rowsWhere = (where: ReturnType<typeof and>) =>
    t.db.select({ id: notification.id }).from(notification).where(where)

  /** The person's org rows in the database's own (created_at desc, id desc) order. */
  const dbOrder = async (userId: string, orgId: string) =>
    (
      await t.db
        .select({ id: notification.id })
        .from(notification)
        .where(and(eq(notification.userId, userId), eq(notification.organizationId, orgId)))
        .orderBy(desc(notification.createdAt), desc(notification.id))
    ).map((r) => r.id)

  it("seeds every row it filters on", async () => {
    expect(errors).toEqual([])
    const of = (userId: string, orgId: string) =>
      rowsWhere(and(eq(notification.userId, userId), eq(notification.organizationId, orgId)))
    expect((await of(t.owner.userId, t.owner.orgId)).length).toBeGreaterThanOrEqual(8)
    expect(await of(t.viewer.userId, t.owner.orgId)).toHaveLength(1)
    expect(await of(t.owner.userId, thirdOrgId)).toHaveLength(1)
    const personal = await rowsWhere(
      and(eq(notification.userId, t.owner.userId), isNull(notification.organizationId)),
    )
    expect(personal.length).toBeGreaterThanOrEqual(1)
  })

  it("returns only the person's rows in this organization, newest first", async () => {
    const rows = await list(t.owner.orgId, t.owner.userId, 100)
    const expected = await rowsWhere(
      and(eq(notification.userId, t.owner.userId), eq(notification.organizationId, t.owner.orgId)),
    )
    expect(rows.map((r) => r.id).sort()).toEqual(expected.map((r) => r.id).sort())
    expect(rows.some((r) => r.type === "member.role_changed")).toBe(true)
    expect(rows.map((r) => r.id)).toEqual(await dbOrder(t.owner.userId, t.owner.orgId))
  })

  it("pages one row at a time across a created_at tie, in the database's order", async () => {
    const rows = await list(t.owner.orgId, t.owner.userId, 100)
    const times = rows.map((r) => r.createdAt.getTime())
    const tied = times.filter((ms) => times.indexOf(ms) !== times.lastIndexOf(ms))
    expect(tied.length).toBeGreaterThanOrEqual(3)
    const paged = await allPages(t.owner.orgId, t.owner.userId, 1)
    expect(paged.map((r) => r.id)).toEqual(await dbOrder(t.owner.userId, t.owner.orgId))
  })

  it("pages through every row with no repeats", async () => {
    const whole = await list(t.owner.orgId, t.owner.userId, 100)
    const paged = await allPages(t.owner.orgId, t.owner.userId, 2)
    expect(paged.map((r) => r.id)).toEqual(whole.map((r) => r.id))
    expect(new Set(paged.map((r) => r.id)).size).toBe(paged.length)
  })

  it("keeps each person and organization apart", async () => {
    const viewer = await list(t.owner.orgId, t.viewer.userId, 100)
    expect(viewer).toEqual([expect.objectContaining({ type: "member.role_changed" })])
    const owner = await list(t.owner.orgId, t.owner.userId, 100)
    expect(owner.map((r) => r.id)).not.toContain(viewer[0]?.id)
    const third = await list(thirdOrgId, t.owner.userId, 100)
    expect(third.map((r) => r.type)).toContain("member.role_changed")
    const ownerIds = new Set(owner.map((r) => r.id))
    expect(third.filter((r) => ownerIds.has(r.id))).toEqual([])
    expect([...owner, ...third].some((r) => r.type === "account.password_changed")).toBe(false)
  })
})
