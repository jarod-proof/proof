// list_notifications over HTTP: a person (session or OAuth token) lists their own notifications in
// the organization they act in. Keys are refused, other people's and other organizations' rows and
// personal notices never show, and listing writes nothing (no read, seen or presence change, which
// would stop the person's emails). Seeded through the API's notifier, as operations send them.
import type { Caller } from "@proof/api"
import { inboxPresence, notification } from "@proof/db"
import { and, asc, desc, eq, isNull } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { BASE, createTestApp } from "./app.test.helpers"
import { createApiNotifier } from "./notifications"
import { inCallerOrg } from "./tenant"

const MCP = `${BASE}/mcp`
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"

interface Item {
  id: string
  type: string
  title: string
  body: string | null
  href: string | null
  read: boolean
  createdAt: string
}
interface Page {
  notifications: Item[]
  nextCursor: string | null
}

const callerOf = (organizationId: string, userId: string): Caller => ({
  organizationId,
  actor: { type: "user", userId },
  grants: [],
  via: "session",
})

describe("list_notifications", () => {
  let t: Awaited<ReturnType<typeof createTestApp>>
  let thirdOrgId: string
  let token: string
  const errors: unknown[] = []

  /** A device-grant OAuth token for the person, approved in acme, with only the read scope. */
  async function deviceToken(cookie: string) {
    const reg = await t.req("/api/auth/oauth2/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Notifications agent",
        token_endpoint_auth_method: "none",
        grant_types: [DEVICE_GRANT, "refresh_token"],
      }),
    })
    expect(reg.status).toBe(201)
    const { client_id: clientId } = (await reg.json()) as { client_id: string }
    const code = await t.req("/api/auth/device/code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // offline_access: a device client's refresh token is the grant its tokens stand on.
      body: JSON.stringify({ client_id: clientId, scope: "read offline_access", resource: MCP }),
    })
    const device = (await code.json()) as { device_code: string; user_code: string }
    const claim = await t.req(
      `/api/auth/device?user_code=${encodeURIComponent(device.user_code)}`,
      t.as(cookie, { method: "GET" }),
    )
    expect(claim.status).toBe(200)
    const approved = await t.req(
      "/api/auth/device/approve",
      t.as(cookie, { method: "POST", body: JSON.stringify({ userCode: device.user_code }) }),
    )
    expect(approved.status).toBe(200)
    const res = await t.req("/api/auth/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: DEVICE_GRANT,
        device_code: device.device_code,
        client_id: clientId,
      }),
    })
    const tokens = (await res.json()) as { access_token?: string }
    if (!tokens.access_token) throw new Error(JSON.stringify(tokens))
    return tokens.access_token
  }

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
    await roleChanged(thirdOrgId, third.userId, "owner")
    await notifier.personal({ type: "account.password_changed", userId: t.owner.userId })
    token = await deviceToken(t.owner.cookie)
  })

  afterAll(() => t.close())

  const get = async (headers: RequestInit, query = "") => {
    const res = await t.req(`/v1/notifications${query}`, headers)
    return { status: res.status, body: (await res.json()) as Page & Record<string, unknown> }
  }
  const bearer = (access: string): RequestInit => ({
    headers: { authorization: `Bearer ${access}` },
  })

  /** Every page of `limit`, following nextCursor until it is null. */
  async function allPages(headers: RequestInit, limit: number) {
    const items: Item[] = []
    let cursor: string | null = null
    for (let pages = 0; pages < 50; pages++) {
      const query: string = `?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`
      const { status, body } = await get(headers, query)
      expect(status, JSON.stringify(body)).toBe(200)
      expect(body.notifications.length).toBeLessThanOrEqual(limit)
      items.push(...body.notifications)
      cursor = body.nextCursor
      if (!cursor) return items
    }
    throw new Error("paging never ended")
  }

  const idsOf = (userId: string, orgId: string) =>
    t.db
      .select({ id: notification.id })
      .from(notification)
      .where(and(eq(notification.userId, userId), eq(notification.organizationId, orgId)))
      .then((rows) => rows.map((r) => r.id))

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
    expect((await idsOf(t.owner.userId, t.owner.orgId)).length).toBeGreaterThanOrEqual(8)
    expect(await idsOf(t.viewer.userId, t.owner.orgId)).toHaveLength(1)
    expect(await idsOf(t.owner.userId, thirdOrgId)).toHaveLength(1)
    const personal = await t.db
      .select({ id: notification.id })
      .from(notification)
      .where(and(eq(notification.userId, t.owner.userId), isNull(notification.organizationId)))
    expect(personal.length).toBeGreaterThanOrEqual(1)
  })

  it("gives a session its own notifications in this organization, newest first", async () => {
    const { status, body } = await get(t.as(t.owner.cookie))
    expect(status, JSON.stringify(body)).toBe(200)
    const ids = body.notifications.map((n) => n.id)
    expect([...ids].sort()).toEqual((await idsOf(t.owner.userId, t.owner.orgId)).sort())
    expect(body.notifications).toContainEqual({
      id: expect.any(String),
      type: "member.role_changed",
      title: expect.any(String),
      body: expect.any(String),
      href: expect.any(String),
      read: false,
      createdAt: expect.any(String),
    })
    expect(ids).toEqual(await dbOrder(t.owner.userId, t.owner.orgId))
  })

  it("pages one at a time across a created_at tie, in the database's order", async () => {
    const whole = (await get(t.as(t.owner.cookie))).body.notifications
    const times = whole.map((n) => n.createdAt)
    expect(times.filter((at) => times.indexOf(at) !== times.lastIndexOf(at)).length).toBe(3)
    const paged = await allPages(t.as(t.owner.cookie), 1)
    expect(paged.map((n) => n.id)).toEqual(await dbOrder(t.owner.userId, t.owner.orgId))
  })

  it("pages with nextCursor through the rest, without repeats", async () => {
    const whole = (await get(t.as(t.owner.cookie))).body.notifications
    const paged = await allPages(t.as(t.owner.cookie), 2)
    expect(paged.map((n) => n.id)).toEqual(whole.map((n) => n.id))
    expect(new Set(paged.map((n) => n.id)).size).toBe(paged.length)
  })

  it("gives an OAuth token acting for the person the same list", async () => {
    const session = await get(t.as(t.owner.cookie))
    const oauth = await get(bearer(token))
    expect(oauth.status, JSON.stringify(oauth.body)).toBe(200)
    expect(oauth.body).toEqual(session.body)
    const mcp = await t.mcpClient({ authorization: `Bearer ${token}` })
    try {
      const result = await mcp.callTool({ name: "list_notifications", arguments: {} })
      expect(result.isError).toBeFalsy()
      expect(result.structuredContent).toEqual(session.body)
    } finally {
      await mcp.close()
    }
  })

  it("leaves out other people, other organizations and personal notices", async () => {
    const listed = new Set((await allPages(t.as(t.owner.cookie), 100)).map((n) => n.id))
    const foreign = [
      ...(await idsOf(t.viewer.userId, t.owner.orgId)),
      ...(await idsOf(t.owner.userId, thirdOrgId)),
      ...(
        await t.db
          .select({ id: notification.id })
          .from(notification)
          .where(and(eq(notification.userId, t.owner.userId), isNull(notification.organizationId)))
      ).map((r) => r.id),
    ]
    expect(foreign.length).toBeGreaterThanOrEqual(3)
    expect(foreign.filter((id) => listed.has(id))).toEqual([])
  })

  it("refuses API keys, with or without grants, with a hint", async () => {
    const noGrants = (
      await t.auth.api.createApiKey({
        body: { organizationId: t.owner.orgId, userId: t.owner.userId, permissions: {} },
      })
    ).key
    for (const key of [noGrants, t.fullKey]) {
      const { status, body } = await get(t.as(key))
      expect(status, JSON.stringify(body)).toBe(403)
      expect(body).toMatchObject({
        error: { code: "FORBIDDEN", hint: expect.stringContaining("OAuth client") },
      })
    }
  })

  it("refuses an API key's MCP call too, though the key sees the tool", async () => {
    const mcp = await t.mcpClient(t.fullKey)
    try {
      const tools = (await mcp.listTools()).tools.map((x) => x.name)
      expect(tools).toContain("list_notifications")
      const result = await mcp.callTool({ name: "list_notifications", arguments: {} })
      expect(result.isError).toBe(true)
      expect(JSON.stringify(result.content)).toContain("FORBIDDEN")
      expect(JSON.stringify(result.content)).toContain("OAuth client")
    } finally {
      await mcp.close()
    }
  })

  it("lets a viewer list their own notifications", async () => {
    const { status, body } = await get(t.as(t.viewer.cookie))
    expect(status, JSON.stringify(body)).toBe(200)
    expect(body.notifications.map((n) => n.id).sort()).toEqual(
      (await idsOf(t.viewer.userId, t.owner.orgId)).sort(),
    )
  })

  it("shows another organization none of acme's notifications", async () => {
    const { status, body } = await get(t.as(t.other.cookie))
    expect(status, JSON.stringify(body)).toBe(200)
    const acme = new Set(
      (
        await t.db
          .select({ id: notification.id })
          .from(notification)
          .where(eq(notification.organizationId, t.owner.orgId))
      ).map((r) => r.id),
    )
    expect(acme.size).toBeGreaterThan(0)
    expect(body.notifications.filter((n) => acme.has(n.id))).toEqual([])
  })

  it("writes no notification state: read, seen_at and inbox_presence stay as they were", async () => {
    // One row read and a presence row, as the web app's bell leaves them.
    const [first] = await idsOf(t.owner.userId, t.owner.orgId)
    const mark = await t.req(
      "/api/auth/inbox/mark-read",
      t.as(t.owner.cookie, { method: "POST", body: JSON.stringify({ id: first }) }),
    )
    expect(mark.status).toBe(200)
    const count = await t.req("/api/auth/inbox/unread-count", t.as(t.owner.cookie))
    expect(count.status).toBe(200)

    const snapshot = async () => ({
      rows: await t.db
        .select({ id: notification.id, read: notification.read, seenAt: notification.seenAt })
        .from(notification)
        .orderBy(asc(notification.id)),
      presence: await t.db.select().from(inboxPresence).orderBy(asc(inboxPresence.id)),
    })
    const before = await snapshot()
    expect(before.presence.length).toBeGreaterThan(0)
    expect(before.rows.some((r) => r.read)).toBe(true)

    const listed = await allPages(t.as(t.owner.cookie), 2)
    expect(listed.find((n) => n.id === first)?.read).toBe(true)
    await allPages(bearer(token), 100)
    await allPages(t.as(t.viewer.cookie), 100)

    expect(await snapshot()).toEqual(before)
  })
})
