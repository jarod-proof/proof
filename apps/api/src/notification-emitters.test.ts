// The operations that emit notifications: who hears each event (approvers minus the requester, the run's
// starter minus the decider, owners and admins for key events, the member for two-factor resets), that
// run.done fires once, that usage.limit_reached fires once per organization per day, and that a
// notifier that throws never changes an operation's response.
import { user } from "@proof/db"
import { AppError } from "@proof/errors"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { createTestApp } from "./app.test.helpers"

type Json = Record<string, unknown>
type App = Awaited<ReturnType<typeof createTestApp>>

describe("notification emitters", () => {
  let t: App
  let member: { cookie: string; userId: string }
  let admin: { cookie: string; userId: string }
  let runKey: string

  beforeAll(async () => {
    t = await createTestApp()
    const m = await t.signUp("Member")
    await t.auth.api.addMember({
      body: { organizationId: t.owner.orgId, userId: m.userId, role: "member" },
    })
    await t.auth.api.setActiveOrganization({
      headers: new Headers({ cookie: m.cookie }),
      body: { organizationId: t.owner.orgId },
    })
    member = { cookie: m.cookie, userId: m.userId }
    const a = await t.signUp("Admin")
    await t.auth.api.addMember({
      body: { organizationId: t.owner.orgId, userId: a.userId, role: "admin" },
    })
    await t.auth.api.setActiveOrganization({
      headers: new Headers({ cookie: a.cookie }),
      body: { organizationId: t.owner.orgId },
    })
    admin = { cookie: a.cookie, userId: a.userId }
    // The agent's key: runs the agent, holds no approve and no key management (it is not a person).
    runKey = (
      await t.auth.api.createApiKey({
        body: {
          organizationId: t.owner.orgId,
          userId: t.owner.userId,
          permissions: {
            agent: ["read", "create", "update"],
            run: ["read", "create", "update", "steer"],
          },
        },
      })
    ).key
  })
  afterAll(() => t.close())

  const call = (credential: string, path: string, method: string, body?: unknown) =>
    t.req(
      path,
      t.as(credential, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    )
  const json = async (res: Response) => ({ status: res.status, body: (await res.json()) as Json })

  /** How many notifications of `type` a person has, optionally only those linking to `runId`. */
  async function count(cookie: string, type: string, runId?: string): Promise<number> {
    const page = await t.auth.api.listNotifications({
      headers: new Headers({ cookie }),
      query: { filter: "all", limit: 100 },
    })
    return page.notifications.filter(
      (n) => n.type === type && (runId === undefined || n.href?.includes(runId)),
    ).length
  }

  /** Creates an agent and a run as `credential`; the run is queued. Returns its ids. */
  async function seedRun(credential: string, title: string) {
    const agent = await json(
      await call(t.owner.cookie, "/v1/workspace-agents", "POST", { name: `Agent ${title}` }),
    )
    const agentId = agent.body.id as string
    const started = await json(
      await call(credential, `/v1/workspace-agents/${agentId}/runs`, "POST", { title }),
    )
    expect(started.status).toBe(200)
    return { agentId, runId: started.body.id as string }
  }

  /** The agent moves its run to running (through its key). */
  async function runRunning(runId: string) {
    expect((await call(runKey, `/v1/runs/${runId}`, "PATCH", { status: "running" })).status).toBe(
      200,
    )
  }

  async function requestApproval(credential: string, runId: string) {
    const res = await json(
      await call(credential, `/v1/runs/${runId}/approvals`, "POST", {
        action: "Post summary to #releases",
        detail: "v2.8 triage",
      }),
    )
    expect(res.status).toBe(200)
    return res.body.id as string
  }

  it("approval.requested goes to every approver except a requesting person", async () => {
    const { runId } = await seedRun(runKey, "Approve by key")
    await runRunning(runId)
    const before = {
      owner: await count(t.owner.cookie, "approval.requested", runId),
      admin: await count(admin.cookie, "approval.requested", runId),
      member: await count(member.cookie, "approval.requested", runId),
      viewer: await count(t.viewer.cookie, "approval.requested", runId),
    }
    await requestApproval(runKey, runId)
    // Keys are nobody's member, so the key excludes no one. Viewers can't approve.
    expect(await count(t.owner.cookie, "approval.requested", runId)).toBe(before.owner + 1)
    expect(await count(admin.cookie, "approval.requested", runId)).toBe(before.admin + 1)
    expect(await count(member.cookie, "approval.requested", runId)).toBe(before.member + 1)
    expect(await count(t.viewer.cookie, "approval.requested", runId)).toBe(before.viewer)
  })

  it("approval.requested by a signed-in member doesn't notify that member", async () => {
    const { runId } = await seedRun(runKey, "Approve by member")
    await runRunning(runId)
    const memberBefore = await count(member.cookie, "approval.requested", runId)
    const ownerBefore = await count(t.owner.cookie, "approval.requested", runId)
    const res = await json(
      await call(member.cookie, `/v1/runs/${runId}/approvals`, "POST", {
        action: "Send the invoice",
      }),
    )
    expect(res.status).toBe(200)
    expect(await count(member.cookie, "approval.requested", runId)).toBe(memberBefore)
    expect(await count(t.owner.cookie, "approval.requested", runId)).toBe(ownerBefore + 1)
    expect(await count(admin.cookie, "approval.requested", runId)).toBeGreaterThan(0)
  })

  it("approval.decided goes to the run's starter, not to the decider", async () => {
    // Started by the owner (a person), decided by the admin: the owner hears, the admin doesn't.
    const { runId } = await seedRun(t.owner.cookie, "Decided by admin")
    await runRunning(runId)
    const approvalId = await requestApproval(runKey, runId)
    const before = {
      owner: await count(t.owner.cookie, "approval.decided", runId),
      admin: await count(admin.cookie, "approval.decided", runId),
      viewer: await count(t.viewer.cookie, "approval.decided", runId),
    }
    expect(
      (
        await call(admin.cookie, `/v1/approvals/${approvalId}/decision`, "POST", {
          decision: "approve",
        })
      ).status,
    ).toBe(200)
    expect(await count(t.owner.cookie, "approval.decided", runId)).toBe(before.owner + 1)
    expect(await count(admin.cookie, "approval.decided", runId)).toBe(before.admin)
    expect(await count(t.viewer.cookie, "approval.decided", runId)).toBe(before.viewer)
  })

  it("approval.decided by the run's own starter notifies nobody", async () => {
    const { runId } = await seedRun(t.owner.cookie, "Decided by starter")
    await runRunning(runId)
    const approvalId = await requestApproval(runKey, runId)
    expect(
      (
        await call(t.owner.cookie, `/v1/approvals/${approvalId}/decision`, "POST", {
          decision: "deny",
        })
      ).status,
    ).toBe(200)
    expect(await count(t.owner.cookie, "approval.decided", runId)).toBe(0)
    expect(await count(admin.cookie, "approval.decided", runId)).toBe(0)
  })

  it("approval.decided on a run a key started notifies nobody", async () => {
    const { runId } = await seedRun(runKey, "Key-started")
    await runRunning(runId)
    const approvalId = await requestApproval(runKey, runId)
    expect(
      (
        await call(admin.cookie, `/v1/approvals/${approvalId}/decision`, "POST", {
          decision: "approve",
        })
      ).status,
    ).toBe(200)
    expect(await count(t.owner.cookie, "approval.decided", runId)).toBe(0)
    expect(await count(admin.cookie, "approval.decided", runId)).toBe(0)
  })

  it("run.done goes to a person starter once, however often the run is updated after", async () => {
    // Started by the member (a person): the member hears when it finishes, and once only.
    const { runId } = await seedRun(member.cookie, "Finish once")
    await runRunning(runId)
    const before = await count(member.cookie, "run.done", runId)
    const ownerBefore = await count(t.owner.cookie, "run.done", runId)
    expect((await call(runKey, `/v1/runs/${runId}`, "PATCH", { status: "done" })).status).toBe(200)
    expect(await count(member.cookie, "run.done", runId)).toBe(before + 1)
    // Finished runs refuse further updates (CONFLICT), and nothing is sent for them.
    const again = await call(runKey, `/v1/runs/${runId}`, "PATCH", { status: "done" })
    expect(again.status).toBe(409)
    expect((await call(runKey, `/v1/runs/${runId}`, "PATCH", { summary: "late" })).status).toBe(409)
    expect(await count(member.cookie, "run.done", runId)).toBe(before + 1)
    expect(await count(t.owner.cookie, "run.done", runId)).toBe(ownerBefore)
  })

  it("run.done of a key-started run notifies nobody, and a running update notifies nobody", async () => {
    const { runId } = await seedRun(runKey, "Key finish")
    await runRunning(runId)
    expect((await call(runKey, `/v1/runs/${runId}`, "PATCH", { status: "done" })).status).toBe(200)
    expect(await count(t.owner.cookie, "run.done", runId)).toBe(0)
    expect(await count(admin.cookie, "run.done", runId)).toBe(0)
  })

  it("run.failed of a key-started run goes to owners and admins, not members", async () => {
    const { runId } = await seedRun(runKey, "Key failure")
    await runRunning(runId)
    expect((await call(runKey, `/v1/runs/${runId}`, "PATCH", { status: "failed" })).status).toBe(
      200,
    )
    expect(await count(t.owner.cookie, "run.failed", runId)).toBe(1)
    expect(await count(admin.cookie, "run.failed", runId)).toBe(1)
    expect(await count(member.cookie, "run.failed", runId)).toBe(0)
    expect(await count(t.viewer.cookie, "run.failed", runId)).toBe(0)
  })

  it("run.failed of a person's run goes to the starter", async () => {
    const { runId } = await seedRun(member.cookie, "Person failure")
    await runRunning(runId)
    expect((await call(runKey, `/v1/runs/${runId}`, "PATCH", { status: "failed" })).status).toBe(
      200,
    )
    expect(await count(member.cookie, "run.failed", runId)).toBe(1)
    expect(await count(t.owner.cookie, "run.failed", runId)).toBe(0)
  })

  it("agent_access.revoked goes to key managers except the revoking person", async () => {
    const key = await t.auth.api.createApiKey({
      body: {
        organizationId: t.owner.orgId,
        userId: t.owner.userId,
        name: "Retired CI",
        permissions: { project: ["read"] },
      },
    })
    const before = {
      owner: await count(t.owner.cookie, "agent_access.revoked"),
      admin: await count(admin.cookie, "agent_access.revoked"),
      member: await count(member.cookie, "agent_access.revoked"),
    }
    const revoked = await json(await call(t.owner.cookie, `/v1/agents/key_${key.id}`, "DELETE"))
    expect(revoked.status).toBe(200)
    expect(await count(t.owner.cookie, "agent_access.revoked")).toBe(before.owner)
    expect(await count(admin.cookie, "agent_access.revoked")).toBe(before.admin + 1)
    expect(await count(member.cookie, "agent_access.revoked")).toBe(before.member)
  })

  it("security.two_factor_reset goes to the member whose two-factor was reset", async () => {
    const before = {
      member: await count(member.cookie, "security.two_factor_reset"),
      owner: await count(t.owner.cookie, "security.two_factor_reset"),
    }
    const res = await json(
      await call(t.owner.cookie, `/v1/members/${member.userId}/two-factor/reset`, "POST"),
    )
    expect(res.status).toBe(200)
    expect(await count(member.cookie, "security.two_factor_reset")).toBe(before.member + 1)
    expect(await count(t.owner.cookie, "security.two_factor_reset")).toBe(before.owner)
  })

  it("resetting a member's two-factor clears its enabled-at stamp, so a re-enable is news", async () => {
    const other = await t.signUp("Stamped")
    await t.auth.api.addMember({
      body: { organizationId: t.owner.orgId, userId: other.userId, role: "member" },
    })
    await t.db
      .update(user)
      .set({ twoFactorEnabled: true, twoFactorEnabledAt: new Date() })
      .where(eq(user.id, other.userId))
    const res = await call(t.owner.cookie, `/v1/members/${other.userId}/two-factor/reset`, "POST")
    expect(res.status).toBe(200)
    const [row] = await t.db
      .select({ on: user.twoFactorEnabled, at: user.twoFactorEnabledAt })
      .from(user)
      .where(eq(user.id, other.userId))
    expect(row).toEqual({ on: false, at: null })
  })

  it("create_api_key tells the other key managers once, not the person who made it", async () => {
    const before = {
      admin: await count(admin.cookie, "api_key.created"),
      owner: await count(t.owner.cookie, "api_key.created"),
      member: await count(member.cookie, "api_key.created"),
    }
    const res = await call(t.owner.cookie, "/v1/api-keys", "POST", {
      name: "Op key",
      permissions: { project: ["read"] },
    })
    expect(res.status).toBe(200)
    expect(await count(admin.cookie, "api_key.created")).toBe(before.admin + 1)
    expect(await count(t.owner.cookie, "api_key.created")).toBe(before.owner)
    expect(await count(member.cookie, "api_key.created")).toBe(before.member)
  })

  it("a notifier that throws doesn't change any operation's response", async () => {
    const broken = await createTestApp([], {
      notifier: {
        inOrg: async () => {
          throw new AppError("INTERNAL", "notify is down")
        },
        personal: async () => {
          throw new AppError("INTERNAL", "notify is down")
        },
      },
    })
    try {
      const brokenKey = (
        await broken.auth.api.createApiKey({
          body: {
            organizationId: broken.owner.orgId,
            userId: broken.owner.userId,
            permissions: { agent: ["read", "create"], run: ["read", "create", "update"] },
          },
        })
      ).key
      const agent = await json(
        await broken.req(
          "/v1/workspace-agents",
          broken.as(broken.owner.cookie, {
            method: "POST",
            body: JSON.stringify({ name: "Quiet agent" }),
          }),
        ),
      )
      const agentId = agent.body.id as string
      const started = await json(
        await broken.req(
          `/v1/workspace-agents/${agentId}/runs`,
          broken.as(broken.owner.cookie, {
            method: "POST",
            body: JSON.stringify({ title: "Quiet" }),
          }),
        ),
      )
      expect(started.status).toBe(200)
      const runId = started.body.id as string
      const sent = (path: string, body: unknown) =>
        broken.req(path, broken.as(brokenKey, { method: "PATCH", body: JSON.stringify(body) }))
      expect((await sent(`/v1/runs/${runId}`, { status: "running" })).status).toBe(200)
      const approval = await json(
        await broken.req(
          `/v1/runs/${runId}/approvals`,
          broken.as(brokenKey, { method: "POST", body: JSON.stringify({ action: "Post" }) }),
        ),
      )
      expect(approval.status).toBe(200)
      // A person's decision goes through too; the run stays blocked until it takes effect (30 seconds),
      // so the finishing update is refused by the approval rule, not by the notifier.
      const decided = await json(
        await broken.req(
          `/v1/approvals/${approval.body.id as string}/decision`,
          broken.as(broken.owner.cookie, {
            method: "POST",
            body: JSON.stringify({ decision: "approve" }),
          }),
        ),
      )
      expect(decided.status).toBe(200)
      expect(decided.body.status).toBe("approved")
    } finally {
      await broken.close()
    }
  })
  it("a throwing notifier leaves refusals, revokes, resets and finished runs as they are", async () => {
    const boom = {
      inOrg: async () => {
        throw new AppError("INTERNAL", "notify is down")
      },
      personal: async () => {
        throw new AppError("INTERNAL", "notify is down")
      },
    }
    const limited = await createTestApp([], { notifier: boom, limits: { unclaimed: 1 } })
    try {
      // The first call is within the limit of 1; the second is refused with 429, not 500.
      const list = () => limited.req("/v1/projects", limited.as(limited.fullKey))
      expect((await list()).status).toBe(200)
      const refused = await list()
      expect(refused.status).toBe(429)
      expect(refused.headers.get("retry-after")).not.toBeNull()
    } finally {
      await limited.close()
    }

    const app = await createTestApp([], { notifier: boom })
    try {
      const m = await app.signUp("Member")
      await app.auth.api.addMember({
        body: { organizationId: app.owner.orgId, userId: m.userId, role: "member" },
      })
      const key = await app.auth.api.createApiKey({
        body: {
          organizationId: app.owner.orgId,
          userId: app.owner.userId,
          name: "Doomed key",
          permissions: { project: ["read"] },
        },
      })
      const revoked = await app.req(
        `/v1/agents/key_${key.id}`,
        app.as(app.owner.cookie, { method: "DELETE" }),
      )
      expect(revoked.status).toBe(200)
      const reset = await app.req(
        `/v1/members/${m.userId}/two-factor/reset`,
        app.as(app.owner.cookie, { method: "POST" }),
      )
      expect(reset.status).toBe(200)

      const agent = await json(
        await app.req(
          "/v1/workspace-agents",
          app.as(app.owner.cookie, {
            method: "POST",
            body: JSON.stringify({ name: "Plain agent" }),
          }),
        ),
      )
      const started = await json(
        await app.req(
          `/v1/workspace-agents/${agent.body.id as string}/runs`,
          app.as(app.owner.cookie, {
            method: "POST",
            body: JSON.stringify({ title: "No approval" }),
          }),
        ),
      )
      const runId = started.body.id as string
      const patch = (body: unknown) =>
        app.req(
          `/v1/runs/${runId}`,
          app.as(app.owner.cookie, { method: "PATCH", body: JSON.stringify(body) }),
        )
      expect((await patch({ status: "running" })).status).toBe(200)
      expect((await patch({ status: "done" })).status).toBe(200)
      // A failed run with no person starter fans out to owners and admins: the throwing notifier too.
      const failed = await json(
        await app.req(
          `/v1/workspace-agents/${agent.body.id as string}/runs`,
          app.as(app.owner.cookie, { method: "POST", body: JSON.stringify({ title: "Fails" }) }),
        ),
      )
      expect(failed.status).toBe(200)
      const failedId = failed.body.id as string
      const failing = (body: unknown) =>
        app.req(
          `/v1/runs/${failedId}`,
          app.as(app.owner.cookie, { method: "PATCH", body: JSON.stringify(body) }),
        )
      expect((await failing({ status: "running" })).status).toBe(200)
      expect((await failing({ status: "failed" })).status).toBe(200)
    } finally {
      await app.close()
    }
  })
})

describe("usage.limit_reached", () => {
  it("is sent once per organization per day, on the first refused call", async () => {
    const t = await createTestApp([], { limits: { unclaimed: 2 } })
    try {
      const list = () => t.req("/v1/projects", t.as(t.fullKey))
      expect((await list()).status).toBe(200)
      expect((await list()).status).toBe(200)
      // Over the limit of 2 from here on: each call is refused, but the owner hears once.
      expect((await list()).status).toBe(429)
      expect((await list()).status).toBe(429)
      expect((await list()).status).toBe(429)
      const page = await t.auth.api.listNotifications({
        headers: new Headers({ cookie: t.owner.cookie }),
        query: { filter: "all", limit: 100 },
      })
      const limits = page.notifications.filter((n) => n.type === "usage.limit_reached")
      expect(limits).toHaveLength(1)
      const viewer = await t.auth.api.listNotifications({
        headers: new Headers({ cookie: t.viewer.cookie }),
        query: { filter: "all", limit: 100 },
      })
      expect(viewer.notifications.filter((n) => n.type === "usage.limit_reached")).toHaveLength(0)
    } finally {
      await t.close()
    }
  })
})
