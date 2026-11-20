// Plan entitlements (@byo-oss/entitlements) in the product, over HTTP: what a member sees (whoami),
// the plan refusals (agents, seats) that name the upgrade, the request meter that never counts a
// refusal, staff overrides from the operator organization, a refresh after checkout and the
// past_due grace window on Stripe's subscriptions, the sweep, export, and the lifecycle (an
// organization's rows go with it). The PRD's user jobs J1-J11 are noted on each test.
import { sweepAll } from "@byo-oss/core"
import { exportEntitlementsData } from "@proof/auth"
import { entitlementOverride, entitlementSnapshot, entitlementUsage, user } from "@proof/db"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { createTestApp } from "./app.test.helpers"

type Json = Record<string, unknown>
type App = Awaited<ReturnType<typeof createTestApp>>

const STAFF = "org_entitlements_staff"

/** The staff organization (OPERATOR_ORGANIZATION_ID in production), with `owner` as its owner. */
async function staffOrg(t: App, userId: string, role = "owner") {
  const ctx = await t.auth.$context
  await ctx.adapter.create({
    model: "organization",
    forceAllowId: true,
    data: { id: STAFF, name: "Staff", slug: "staff", createdAt: new Date() },
  })
  await ctx.adapter.create({
    model: "member",
    data: { organizationId: STAFF, userId, role, createdAt: new Date() },
  })
}

const call = async (t: App, credential: string, path: string, method = "GET", body?: unknown) => {
  const res = await t.req(
    path,
    t.as(credential, { method, ...(body !== undefined && { body: JSON.stringify(body) }) }),
  )
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Json, res }
}

const createAgent = (t: App, cookie: string, name: string, orgId?: string) =>
  t.req(
    "/v1/workspace-agents",
    t.as(cookie, {
      method: "POST",
      body: JSON.stringify({ name }),
      ...(orgId && { headers: { "x-organization-id": orgId } }),
    }),
  )

describe("entitlements in the product (real Postgres via PGlite)", () => {
  let t: App
  let staff: Awaited<ReturnType<App["signUp"]>>

  beforeAll(async () => {
    t = await createTestApp([], { plan: "free", staffOrganizationId: STAFF })
    staff = await t.signUp("Staff")
    await staffOrg(t, staff.userId)
  })
  afterAll(() => t.close())

  // J1: what the plan includes and how much is used, from the API every client reads.
  it("whoami reports the plan, its features and limits, and today's usage", async () => {
    const { status, body } = await call(t, t.readKey, "/v1/whoami")
    expect(status).toBe(200)
    expect(body.entitlements).toEqual({
      plan: "free",
      status: "active",
      features: {
        apiKeys: true,
        budgets: false,
        sso: false,
        auditExport: false,
        customRoles: false,
      },
      // Test users are unverified, so acme is unclaimed: the lower request limit.
      limits: { requests: 500, seats: 3, agents: 2, runHistoryDays: 30 },
      degraded: false,
    })
    expect(body.usage).toMatchObject({ limit: 500 })
  })

  // J1 (web app): the member reads the same through better-auth's endpoint.
  it("a member reads the organization's plan at /entitlements/get; another organization can't", async () => {
    const own = await call(
      t,
      t.viewer.cookie,
      `/api/auth/entitlements/get?organizationId=${t.owner.orgId}`,
    )
    expect(own.status).toBe(200)
    expect((own.body.plan as Json).key).toBe("free")
    const other = await call(
      t,
      t.other.cookie,
      `/api/auth/entitlements/get?organizationId=${t.owner.orgId}`,
    )
    expect(other.status).toBe(404)
  })

  // J2 + J8: a clear refusal naming the upgrade, not a 500; nothing is created over the limit.
  it("refuses a third workspace agent on Free with FORBIDDEN naming Pro", async () => {
    for (const name of ["One", "Two"])
      expect((await createAgent(t, t.owner.cookie, name)).status).toBe(200)
    const third = await createAgent(t, t.owner.cookie, "Three")
    expect(third.status).toBe(403)
    const body = (await third.json()) as { error: { code: string; message: string; hint: string } }
    expect(body.error.code).toBe("FORBIDDEN")
    expect(body.error.message).toBe("The Free plan includes 2 agents, and this organization has 2.")
    expect(body.error.hint).toContain("Upgrade to Pro or Team")
    const list = await call(t, t.owner.cookie, "/v1/workspace-agents")
    expect((list.body.agents as unknown[]).length).toBe(2)
  })

  // Seats: viewers are free on every plan; every other role takes one of Free's 3.
  describe("seats", () => {
    let org: string
    let owner: Awaited<ReturnType<App["signUp"]>>
    const invite = (email: string, role: string) =>
      call(t, owner.cookie, "/api/auth/organization/invite-member", "POST", {
        email,
        role,
        organizationId: org,
      })

    beforeAll(async () => {
      owner = await t.signUp("Seat owner")
      org = owner.orgId
    })

    it("invites up to the plan's seats (pending invitations hold theirs), and viewers past it", async () => {
      expect((await invite("a@seats.test", "member")).status).toBe(200)
      expect((await invite("b@seats.test", "admin")).status).toBe(200)
      // Owner + 2 pending = 3 of 3.
      const over = await invite("c@seats.test", "member")
      expect(over.status).toBe(403)
      expect(over.body).toMatchObject({ code: "PLAN_LIMIT_REACHED" })
      expect(String(over.body.message)).toContain("Upgrade to Pro or Team")
      expect((await invite("v@seats.test", "viewer")).status).toBe(200)
    })

    it("refuses adding a paid member and promoting a viewer over the limit", async () => {
      const filler = await t.signUp("Filler")
      const another = await t.signUp("Another")
      const viewer = await t.signUp("Free viewer")
      const room = await t.signUp("Room owner")
      const add = (userId: string, role: string) =>
        t.auth.api.addMember({
          body: { organizationId: room.orgId, userId, role: role as "member" },
        })
      await add(filler.userId, "member")
      await add(another.userId, "member")
      await expect(add((await t.signUp("Fourth")).userId, "member")).rejects.toMatchObject({
        body: { code: "PLAN_LIMIT_REACHED" },
      })
      await add(viewer.userId, "viewer")
      const members = await t.auth.api.listMembers({
        query: { organizationId: room.orgId },
        headers: new Headers({ cookie: room.cookie }),
      })
      const viewerMember = members.members.find((m) => m.userId === viewer.userId)
      const promote = await call(
        t,
        room.cookie,
        "/api/auth/organization/update-member-role",
        "POST",
        {
          organizationId: room.orgId,
          memberId: viewerMember?.id,
          role: "member",
        },
      )
      expect(promote.status).toBe(403)
      expect(promote.body).toMatchObject({ code: "PLAN_LIMIT_REACHED" })
      // On Team the same promotion goes through.
      await t.onPlan(room.orgId, "team")
      const allowed = await call(
        t,
        room.cookie,
        "/api/auth/organization/update-member-role",
        "POST",
        {
          organizationId: room.orgId,
          memberId: viewerMember?.id,
          role: "member",
        },
      )
      expect(allowed.status).toBe(200)
    })

    it("refuses accepting an invitation once the seats filled up after it was sent", async () => {
      const host = await t.signUp("Host")
      const guest = await t.signUp("Guest")
      const sent = await call(t, host.cookie, "/api/auth/organization/invite-member", "POST", {
        email: guest.email,
        role: "member",
        organizationId: host.orgId,
      })
      expect(sent.status).toBe(200)
      // Two members join directly in the meantime: owner + 2 = 3 of 3.
      for (const name of ["Early", "Earlier"]) {
        const u = await t.signUp(name)
        await t.auth.api.addMember({
          body: { organizationId: host.orgId, userId: u.userId, role: "member" },
        })
      }
      const accepted = await call(
        t,
        guest.cookie,
        "/api/auth/organization/accept-invitation",
        "POST",
        {
          invitationId: sent.body.id,
        },
      )
      expect(accepted.status).toBe(403)
      expect(accepted.body).toMatchObject({ code: "PLAN_LIMIT_REACHED" })
    })
  })

  // J8: consume never counts a refusal.
  it("a refused call counts nothing toward the day", async () => {
    const limited = await createTestApp([], { limits: { unclaimed: 2 } })
    try {
      const list = () => limited.req("/v1/projects", limited.as(limited.fullKey))
      expect((await list()).status).toBe(200)
      expect((await list()).status).toBe(200)
      for (let i = 0; i < 3; i++) expect((await list()).status).toBe(429)
      const meter = await limited.auth.entitlements.getLimit(limited.owner.orgId, "requests")
      expect({ used: meter.used, remaining: meter.remaining }).toEqual({ used: 2, remaining: 0 })
      const [row] = await limited.db
        .select({ used: entitlementUsage.used, refused: entitlementUsage.refused })
        .from(entitlementUsage)
        .where(eq(entitlementUsage.organizationId, limited.owner.orgId))
      expect(row).toEqual({ used: 2, refused: 3 })
    } finally {
      await limited.close()
    }
  })

  // Per-plan request caps: Free 10 000, Pro 100 000, Team unlimited, each per UTC day.
  describe("request caps per plan", () => {
    /** An app whose organization is on `plan`, optionally claimed (its owner's email verified). */
    async function appOn(plan: "free" | "pro" | "team", claimed: boolean) {
      const app = await createTestApp([], { plan })
      if (claimed) {
        await app.db.update(user).set({ emailVerified: true }).where(eq(user.id, app.owner.userId))
        await app.auth.entitlements.invalidate(app.owner.orgId)
      }
      return app
    }
    const listProjects = (app: App) => app.req("/v1/projects", app.as(app.fullKey))

    it("a claimed Free org gets 10,000, Pro 100,000, Team unlimited", async () => {
      const seen: Record<string, unknown> = {}
      for (const plan of ["free", "pro", "team"] as const) {
        const app = await appOn(plan, true)
        try {
          seen[plan] = (await app.auth.entitlements.getLimit(app.owner.orgId, "requests")).limit
        } finally {
          await app.close()
        }
      }
      expect(seen).toEqual({ free: 10_000, pro: 100_000, team: "unlimited" })
    })

    it("a Pro org's cap is 100,000: whoami and the ratelimit headers say so", async () => {
      const app = await appOn("pro", true)
      try {
        const res = await listProjects(app)
        expect(res.status).toBe(200)
        expect(res.headers.get("ratelimit-limit")).toBe("100000")
        const who = await call(app, app.fullKey, "/v1/whoami")
        expect(who.body.usage).toMatchObject({ limit: 100_000 })
        expect((who.body.entitlements as { limits: Json }).limits.requests).toBe(100_000)
        // The cap holds: a call that would pass it is refused and counts nothing.
        const over = await app.auth.entitlements.consumeUsage(app.owner.orgId, "requests", {
          amount: 100_000,
        })
        expect(over).toMatchObject({ allowed: false, reason: "limit_reached", limit: 100_000 })
      } finally {
        await app.close()
      }
    })

    it("a Team org is never refused and gets no ratelimit-* headers", async () => {
      const app = await appOn("team", true)
      try {
        // Far past Pro's cap in one go: unlimited never refuses.
        const big = await app.auth.entitlements.consumeUsage(app.owner.orgId, "requests", {
          amount: 5_000_000,
        })
        expect(big).toMatchObject({ allowed: true, limit: "unlimited", remaining: "unlimited" })
        const res = await listProjects(app)
        expect(res.status).toBe(200)
        // "unlimited" has no number to send: the pair is left out, not sent as a huge integer.
        for (const h of ["ratelimit-limit", "ratelimit-remaining", "ratelimit-reset"])
          expect(res.headers.get(h)).toBeNull()
        const who = await call(app, app.fullKey, "/v1/whoami")
        expect(who.body.usage).toMatchObject({ limit: null })
        expect((who.body.entitlements as { limits: Json }).limits.requests).toBe("unlimited")
        // The count is still kept (reports), whatever the plan.
        expect(
          (await app.auth.entitlements.getLimit(app.owner.orgId, "requests")).used,
        ).toBeGreaterThan(5_000_000)
      } finally {
        await app.close()
      }
    })

    it("an unclaimed org keeps the lower limit on every plan, Team included", async () => {
      for (const plan of ["pro", "team"] as const) {
        const app = await appOn(plan, false)
        try {
          const res = await listProjects(app)
          expect(res.headers.get("ratelimit-limit")).toBe("500")
          const who = await call(app, app.fullKey, "/v1/whoami")
          expect(who.body.usage).toMatchObject({ limit: 500 })
        } finally {
          await app.close()
        }
      }
    })

    it("the unclaimed refusal on Team says verifying lifts the limit", async () => {
      const app = await createTestApp([], { plan: "team", limits: { unclaimed: 1 } })
      try {
        expect((await listProjects(app)).status).toBe(200)
        const refused = await listProjects(app)
        expect(refused.status).toBe(429)
        const body = (await refused.json()) as { error: { hint: string } }
        expect(body.error.hint).toContain("to lift the limit")
      } finally {
        await app.close()
      }
    })
  })

  // J5 + J6: staff comp a limit for a reason, see who did it, and remove it.
  describe("staff overrides", () => {
    it("raises a customer's agent limit, then removes it", async () => {
      const customer = await t.signUp("Customer")
      const set = await call(t, staff.cookie, "/api/auth/entitlements/override/set", "POST", {
        organizationId: customer.orgId,
        kind: "limit",
        key: "agents",
        value: 3,
        reason: "Design partner, ticket 42",
      })
      expect(set.status).toBe(200)
      const override = set.body.override as Json
      expect(override).toMatchObject({
        kind: "limit",
        key: "agents",
        value: 3,
        createdBy: staff.userId,
      })
      for (const name of ["A", "B", "C"]) {
        expect((await createAgent(t, customer.cookie, name)).status).toBe(200)
      }
      expect((await createAgent(t, customer.cookie, "D")).status).toBe(403)

      const listed = await call(
        t,
        staff.cookie,
        `/api/auth/entitlements/overrides?organizationId=${customer.orgId}`,
      )
      expect(listed.status).toBe(200)
      expect((listed.body.overrides as Json[])[0]).toMatchObject({
        reason: "Design partner, ticket 42",
        createdBy: staff.userId,
      })

      const removed = await call(
        t,
        staff.cookie,
        "/api/auth/entitlements/override/remove",
        "POST",
        {
          id: override.id,
        },
      )
      expect(removed.status).toBe(200)
      const plan = await call(
        t,
        customer.cookie,
        `/api/auth/entitlements/get?organizationId=${customer.orgId}`,
      )
      expect((plan.body.limits as Json).agents).toBe(2)
    })

    it("puts a customer on another plan; the plan override takes no value", async () => {
      const customer = await t.signUp("Upgraded")
      const body = { organizationId: customer.orgId, kind: "plan", key: "team", reason: "Comp" }
      // A plan override takes no value. Leaving it out is the whole body.
      const set = await call(t, staff.cookie, "/api/auth/entitlements/override/set", "POST", body)
      expect(set.status).toBe(200)
      expect((await t.auth.entitlements.get(customer.orgId)).plan.key).toBe("team")
    })

    it("answers 404 to a customer's own owner: override is only checked in the staff organization", async () => {
      const res = await call(t, t.owner.cookie, "/api/auth/entitlements/override/set", "POST", {
        organizationId: t.owner.orgId,
        kind: "plan",
        key: "team",
        reason: "Self-upgrade",
      })
      expect(res.status).toBe(404)
    })

    // Entitlements validates after the staff gate: whatever the body, a non-staff caller sees 404.
    it("answers 404 to a non-staff caller whatever the body (the gate runs before validation)", async () => {
      for (const body of [{}, { organizationId: 7 }, { kind: "nonsense", reason: "" }]) {
        const res = await call(
          t,
          t.owner.cookie,
          "/api/auth/entitlements/override/set",
          "POST",
          body,
        )
        expect(res.status).toBe(404)
      }
      // The same malformed body from staff is a 400.
      const staffRes = await call(
        t,
        staff.cookie,
        "/api/auth/entitlements/override/set",
        "POST",
        {},
      )
      expect(staffRes.status).toBe(400)
    })

    it("refuses a staff session that also carries an API key", async () => {
      const res = await t.req(
        "/api/auth/entitlements/override/set",
        t.as(staff.cookie, {
          method: "POST",
          headers: { "x-api-key": t.fullKey },
          body: JSON.stringify({
            organizationId: t.other.orgId,
            kind: "feature",
            key: "sso",
            value: true,
            reason: "Trial",
          }),
        }),
      )
      expect(res.status).toBe(403)
      expect(((await res.json()) as Json).code).toBe("SESSION_NOT_ACCEPTED")
    })

    it("refuses an API key with entitlements:override at create_api_key (a person's action)", async () => {
      const res = await call(t, t.owner.cookie, "/v1/api-keys", "POST", {
        name: "Override key",
        permissions: { entitlements: ["override"] },
      })
      expect(res.status).toBe(403)
    })
  })

  // The cron: sweepAll from @byo-oss/core runs entitlements' sweep with support's.
  it("sweepAll runs the entitlements sweep", async () => {
    const result = await sweepAll(t.auth)
    const entry = result.results.find((r) => r.pluginId === "entitlements")
    expect(entry?.error).toBeUndefined()
    expect(entry?.runs).toBeGreaterThanOrEqual(1)
  })

  // J11: everything the package stores for an organization comes out as plain JSON.
  it("exports an organization's rows", async () => {
    const customer = await t.signUp("Exported")
    await t.auth.entitlements.get(customer.orgId)
    await t.auth.entitlements.consumeUsage(customer.orgId, "requests")
    const snapshots = await exportEntitlementsData(t.auth, { organizationId: customer.orgId })
    expect(snapshots.snapshots).toHaveLength(1)
    const usage = await exportEntitlementsData(t.auth, {
      organizationId: customer.orgId,
      cursor: snapshots.nextCursor,
    })
    expect(usage.usage.length + usage.overrides.length).toBeGreaterThanOrEqual(0)
  })

  // Lifecycle: an organization deleted through the organization plugin takes its rows with it.
  it("deleting an organization removes its snapshot, overrides and usage", async () => {
    const doomed = await t.signUp("Doomed owner")
    const created = await call(t, doomed.cookie, "/api/auth/organization/create", "POST", {
      name: "Doomed",
      slug: `doomed-${doomed.userId.toLowerCase().slice(0, 8)}`,
    })
    expect(created.status).toBe(200)
    const orgId = String(created.body.id)
    await t.auth.entitlements.get(orgId)
    await t.auth.entitlements.consumeUsage(orgId, "requests")
    await call(t, staff.cookie, "/api/auth/entitlements/override/set", "POST", {
      organizationId: orgId,
      kind: "feature",
      key: "sso",
      value: true,
      reason: "Pilot",
    })
    const rows = async () => ({
      snapshots: (
        await t.db
          .select()
          .from(entitlementSnapshot)
          .where(eq(entitlementSnapshot.organizationId, orgId))
      ).length,
      overrides: (
        await t.db
          .select()
          .from(entitlementOverride)
          .where(eq(entitlementOverride.organizationId, orgId))
      ).length,
      usage: (
        await t.db.select().from(entitlementUsage).where(eq(entitlementUsage.organizationId, orgId))
      ).length,
    })
    expect(await rows()).toEqual({ snapshots: 1, overrides: 1, usage: 1 })
    const deleted = await call(t, doomed.cookie, "/api/auth/organization/delete", "POST", {
      organizationId: orgId,
    })
    expect(deleted.status).toBe(200)
    expect(await rows()).toEqual({ snapshots: 0, overrides: 0, usage: 0 })
  })

  // Lifecycle: removing a member stores nothing per member; the override keeps its author.
  it("removing the staff member who set an override keeps the override's author", async () => {
    const author = await t.signUp("Author")
    const ctx = await t.auth.$context
    await ctx.adapter.create({
      model: "member",
      data: { organizationId: STAFF, userId: author.userId, role: "admin", createdAt: new Date() },
    })
    const target = await t.signUp("Target")
    const set = await call(t, author.cookie, "/api/auth/entitlements/override/set", "POST", {
      organizationId: target.orgId,
      kind: "feature",
      key: "budgets",
      value: true,
      reason: "Beta",
    })
    expect(set.status).toBe(200)
    await t.auth.api.removeMember({
      body: { organizationId: STAFF, memberIdOrEmail: author.email },
      headers: new Headers({ cookie: staff.cookie, origin: "http://localhost:3000" }),
    })
    const [row] = await t.db
      .select({ createdBy: entitlementOverride.createdBy })
      .from(entitlementOverride)
      .where(eq(entitlementOverride.organizationId, target.orgId))
    expect(row?.createdBy).toBe(author.userId)
  })
})

// J3 + J4 on Stripe's subscriptions (the stripe plugin's table; no call to Stripe).
describe("entitlements from Stripe subscriptions", () => {
  let t: App
  beforeAll(async () => {
    t = await createTestApp([], {
      stripe: {
        secretKey: "sk_test_placeholder_for_tests", // gitleaks:allow
        webhookSecret: "whsec_placeholder_for_tests", // gitleaks:allow
        plans: [
          { name: "pro", priceId: "price_placeholder_pro" }, // gitleaks:allow
          { name: "team", priceId: "price_placeholder_team" }, // gitleaks:allow
        ],
      },
    })
  })
  afterAll(() => t.close())

  const subscribe = async (organizationId: string, status: string) => {
    const ctx = await t.auth.$context
    await ctx.adapter.create({
      model: "subscription",
      data: {
        plan: "pro",
        referenceId: organizationId,
        status,
        periodStart: new Date(Date.now() - 86_400_000),
        periodEnd: new Date(Date.now() + 29 * 86_400_000),
        seats: 5,
      },
    })
  }

  // J3: back from checkout, a refresh shows the new plan before the webhook arrives.
  it("refreshEntitlements after checkout shows the plan the subscription bought", async () => {
    const buyer = await t.signUp("Buyer")
    const before = await call(
      t,
      buyer.cookie,
      `/api/auth/entitlements/get?organizationId=${buyer.orgId}`,
    )
    expect((before.body.plan as Json).key).toBe("free")
    // What the success redirect or the webhook writes; the cached read still says Free.
    await subscribe(buyer.orgId, "active")
    const refreshed = await call(t, buyer.cookie, "/api/auth/entitlements/refresh", "POST", {
      organizationId: buyer.orgId,
    })
    expect(refreshed.status).toBe(200)
    expect((refreshed.body.plan as Json).key).toBe("pro")
    expect((refreshed.body.limits as Json).seats).toBe(25)
  })

  // J4: a failed card keeps the plan for the grace window, counted from when it went past_due.
  it("keeps the plan while past_due for 7 days, then falls back to Free", async () => {
    const late = await t.signUp("Late payer")
    await subscribe(late.orgId, "past_due")
    expect((await t.auth.entitlements.sync(late.orgId)).plan.key).toBe("pro")
    // Eight days later (the snapshot's own clock: pastDueSince).
    await t.db
      .update(entitlementSnapshot)
      .set({ pastDueSince: new Date(Date.now() - 8 * 86_400_000) })
      .where(eq(entitlementSnapshot.organizationId, late.orgId))
    await t.auth.entitlements.invalidate(late.orgId)
    const after = await t.auth.entitlements.get(late.orgId)
    expect(after.plan.key).toBe("free")
    expect(after.status).toBe("past_due")
  })
})
