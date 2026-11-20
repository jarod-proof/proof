// Workspace agents and runs over REST and MCP: roles (viewer reads, member and admin act, only owners
// reset two-factor), cross-tenant NOT_FOUND, the agent-side run protocol, and the 30-second approval
// window. Time is injected (createTestApp's `now`), so the window is tested without sleeping.
import { twoFactor, user as userTable } from "@proof/db"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { createTestApp } from "./app.test.helpers"

const DAY = "2026-10-16T12:00:00.000Z"
let clock = new Date(DAY)
const at = (seconds: number) => new Date(new Date(DAY).getTime() + seconds * 1000)

type Json = Record<string, unknown>

describe("workspace agents and runs", () => {
  let t: Awaited<ReturnType<typeof createTestApp>>
  let member: { cookie: string; userId: string }
  let admin: { cookie: string; userId: string }
  let runKey: string
  let readKey: string
  let otherRunKey: string

  beforeAll(async () => {
    t = await createTestApp([], { now: () => clock })
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
    // An agent-side key: it runs the agent, but holds no approve and no owner-only permissions.
    const key = (org: string, user: string, permissions: Record<string, string[]>) =>
      t.auth.api.createApiKey({ body: { organizationId: org, userId: user, permissions } })
    runKey = (
      await key(t.owner.orgId, t.owner.userId, {
        agent: ["read", "create", "update"],
        run: ["read", "create", "update", "steer"],
      })
    ).key
    readKey = (await key(t.owner.orgId, t.owner.userId, { run: ["read"], agent: ["read"] })).key
    otherRunKey = (
      await key(t.other.orgId, t.other.userId, {
        agent: ["read", "create", "update", "delete"],
        run: ["read", "create", "update", "steer"],
      })
    ).key
  })
  afterAll(() => t.close())
  beforeEach(() => {
    clock = new Date(DAY)
  })

  const call = (credential: string, path: string, method: string, body?: unknown) =>
    t.req(
      path,
      t.as(credential, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    )
  const json = async (res: Response) => ({ status: res.status, body: (await res.json()) as Json })

  /** Creates an agent and a run for it as the owner; returns their ids. */
  async function seedRun(title = "Release triage") {
    const agent = await json(
      await call(t.owner.cookie, "/v1/workspace-agents", "POST", { name: `Agent ${title}` }),
    )
    const agentId = agent.body.id as string
    const started = await json(
      await call(t.owner.cookie, `/v1/workspace-agents/${agentId}/runs`, "POST", { title }),
    )
    expect(started.status).toBe(200)
    expect(started.body.status).toBe("queued")
    return { agentId, runId: started.body.id as string }
  }

  /** Drives a run to needs_you as the agent (through its key): running, one step, one approval. */
  async function driveToApproval(credential = runKey) {
    const { agentId, runId } = await seedRun()
    expect(
      (await call(credential, `/v1/runs/${runId}`, "PATCH", { status: "running" })).status,
    ).toBe(200)
    const step = await json(
      await call(credential, `/v1/runs/${runId}/steps`, "POST", {
        kind: "collect",
        title: "Collected 14 release blockers",
        status: "done",
      }),
    )
    expect(step.status).toBe(200)
    const approval = await json(
      await call(credential, `/v1/runs/${runId}/approvals`, "POST", {
        action: "Post summary to #releases",
        detail: "v2.8 triage: 4 themes",
      }),
    )
    expect(approval.status).toBe(200)
    return { agentId, runId, approvalId: approval.body.id as string }
  }

  describe("the agent-side run protocol", () => {
    it("takes a run from queued to needs_you with steps, footprint and an approval", async () => {
      const { runId, approvalId } = await driveToApproval()
      const detail = await json(await call(t.owner.cookie, `/v1/runs/${runId}`, "GET"))
      expect(detail.body).toMatchObject({
        status: "needs_you",
        steps: [
          { position: 1, kind: "collect" },
          { position: 2, kind: "approval", status: "needs_you" },
        ],
        approvals: [
          {
            id: approvalId,
            status: "pending",
            decision: null,
            action: "Post summary to #releases",
          },
        ],
      })
      const inbox = await json(await call(t.owner.cookie, "/v1/inbox", "GET"))
      expect(inbox.body).toEqual({ needsYou: 1 })
    })

    it("refuses to finish the run while an approval is pending", async () => {
      const { runId } = await driveToApproval()
      const res = await json(await call(runKey, `/v1/runs/${runId}`, "PATCH", { status: "done" }))
      expect(res).toMatchObject({ status: 409, body: { error: { code: "CONFLICT" } } })
    })

    it("updates a step's progress and status, stamping its times", async () => {
      const { runId } = await seedRun()
      const step = await json(
        await call(runKey, `/v1/runs/${runId}/steps`, "POST", {
          kind: "test",
          title: "Running tests",
          status: "running",
          progressDone: 38,
          progressTotal: 61,
        }),
      )
      const stepId = step.body.id as string
      const done = await json(
        await call(runKey, `/v1/runs/${runId}/steps/${stepId}`, "PATCH", { status: "done" }),
      )
      expect(done.body).toMatchObject({ status: "done", progressDone: 38, progressTotal: 61 })
      expect(done.body.finishedAt).not.toBeNull()
      const elsewhere = await json(
        await call(
          runKey,
          `/v1/runs/${runId}/steps/00000000-0000-0000-0000-000000000000`,
          "PATCH",
          {
            status: "done",
          },
        ),
      )
      expect(elsewhere.status).toBe(404)
    })

    it("records the footprint the agent reports", async () => {
      const { agentId, runId } = await seedRun()
      await call(t.owner.cookie, `/v1/workspace-agents/${agentId}`, "PATCH", { energyBudgetWh: 2 })
      const res = await json(
        await call(runKey, `/v1/runs/${runId}`, "PATCH", {
          energyWh: 0.6,
          tokens: 18000,
          toolCalls: 7,
        }),
      )
      expect(res.body.footprint).toEqual({ energyWh: 0.6, tokens: 18000, toolCalls: 7 })
      const detail = await json(await call(t.owner.cookie, `/v1/runs/${runId}`, "GET"))
      expect(detail.body.footprint).toEqual({
        energyWh: 0.6,
        tokens: 18000,
        toolCalls: 7,
        energyBudgetWh: 2,
      })
    })

    it("starts, pauses and finishes a run, with the start time on running", async () => {
      const { runId } = await seedRun()
      const running = await json(
        await call(runKey, `/v1/runs/${runId}`, "PATCH", { status: "running" }),
      )
      expect(running.body).toMatchObject({ status: "running", startedBy: { type: "user" } })
      expect(running.body.startedAt).not.toBeNull()
      const done = await json(await call(runKey, `/v1/runs/${runId}`, "PATCH", { status: "done" }))
      expect(done.body.status).toBe("done")
      const after = await json(
        await call(runKey, `/v1/runs/${runId}/steps`, "POST", { kind: "x", title: "late" }),
      )
      expect(after).toMatchObject({ status: 409, body: { error: { code: "CONFLICT" } } })
    })

    it("refuses summary and footprint updates once the run has finished", async () => {
      const { runId } = await seedRun()
      await call(runKey, `/v1/runs/${runId}`, "PATCH", { status: "running" })
      await call(runKey, `/v1/runs/${runId}`, "PATCH", {
        status: "done",
        summary: "final",
        tokens: 10,
      })
      const late = await json(
        await call(runKey, `/v1/runs/${runId}`, "PATCH", { summary: "rewritten", tokens: 999 }),
      )
      expect(late).toMatchObject({ status: 409, body: { error: { code: "CONFLICT" } } })
      const detail = await json(await call(t.owner.cookie, `/v1/runs/${runId}`, "GET"))
      expect(detail.body).toMatchObject({ summary: "final", footprint: { tokens: 10 } })
    })

    it("lists runs newest first, filtered by status, one page at a time", async () => {
      const { runId: first } = await driveToApproval()
      const { runId: second } = await seedRun("Second")
      const page = await json(await call(t.owner.cookie, "/v1/runs?limit=1", "GET"))
      expect(page.body.runs).toHaveLength(1)
      expect(page.body.nextCursor).not.toBeNull()
      const next = await json(
        await call(
          t.owner.cookie,
          `/v1/runs?limit=1&cursor=${encodeURIComponent(page.body.nextCursor as string)}`,
          "GET",
        ),
      )
      expect(next.body.runs).toHaveLength(1)
      expect((page.body.runs as Json[])[0]?.id).not.toBe((next.body.runs as Json[])[0]?.id)
      const needsYou = await json(await call(t.owner.cookie, "/v1/runs?status=needs_you", "GET"))
      expect((needsYou.body.runs as Json[]).map((r) => r.id)).toContain(first)
      expect((needsYou.body.runs as Json[]).map((r) => r.id)).not.toContain(second)
    })

    it("defers a run to a future time, and refuses a past one", async () => {
      const { runId } = await seedRun()
      const past = await json(
        await call(t.owner.cookie, `/v1/runs/${runId}/defer`, "POST", {
          until: "2020-01-01T00:00:00Z",
        }),
      )
      expect(past).toMatchObject({ status: 400, body: { error: { code: "BAD_REQUEST" } } })
      const until = at(3600).toISOString()
      const deferred = await json(
        await call(t.owner.cookie, `/v1/runs/${runId}/defer`, "POST", { until }),
      )
      expect(deferred.body).toMatchObject({ status: "queued", deferredUntil: until })
    })

    it("lets a person steer a run and shows the message to the agent", async () => {
      const { runId } = await seedRun()
      const sent = await json(
        await call(member.cookie, `/v1/runs/${runId}/messages`, "POST", {
          body: "Skip the billing item",
        }),
      )
      expect(sent).toMatchObject({
        status: 200,
        body: { body: "Skip the billing item", authorId: member.userId },
      })
      const detail = await json(await call(runKey, `/v1/runs/${runId}`, "GET"))
      expect(detail.body.messages).toHaveLength(1)
    })
  })

  describe("approvals: the 30-second window", () => {
    it("is pending for the agent and approved for a person until it takes effect", async () => {
      const { runId, approvalId } = await driveToApproval()
      clock = at(0)
      const decided = await json(
        await call(t.owner.cookie, `/v1/approvals/${approvalId}/decision`, "POST", {
          decision: "approve",
        }),
      )
      expect(decided.body).toMatchObject({
        status: "approved",
        decision: { decidedBy: t.owner.userId, undoableUntil: at(30).toISOString() },
      })

      clock = at(29)
      const agentSees = await json(await call(runKey, `/v1/runs/${runId}`, "GET"))
      expect(agentSees.body.approvals).toEqual([
        expect.objectContaining({ id: approvalId, status: "pending", decision: null }),
      ])
      const personSees = await json(await call(t.owner.cookie, `/v1/runs/${runId}`, "GET"))
      expect(personSees.body.approvals).toEqual([
        expect.objectContaining({
          status: "approved",
          decision: expect.objectContaining({ undoableUntil: at(30).toISOString() }),
        }),
      ])
      // The agent can't finish the run on the strength of a decision that isn't effective yet.
      const early = await json(await call(runKey, `/v1/runs/${runId}`, "PATCH", { status: "done" }))
      expect(early.status).toBe(409)

      clock = at(31)
      const effective = await json(await call(runKey, `/v1/runs/${runId}`, "GET"))
      expect(effective.body.approvals).toEqual([
        expect.objectContaining({ status: "approved", decision: null }),
      ])
      const finished = await json(
        await call(runKey, `/v1/runs/${runId}`, "PATCH", { status: "done" }),
      )
      expect(finished.status).toBe(200)
    })

    it("can be undone before it takes effect, and then decided again", async () => {
      const { approvalId } = await driveToApproval()
      clock = at(0)
      await call(t.owner.cookie, `/v1/approvals/${approvalId}/decision`, "POST", {
        decision: "deny",
      })
      clock = at(29)
      const undone = await json(
        await call(t.owner.cookie, `/v1/approvals/${approvalId}/undo`, "POST"),
      )
      expect(undone.body).toMatchObject({ status: "pending", decision: null })
      const again = await json(
        await call(t.owner.cookie, `/v1/approvals/${approvalId}/decision`, "POST", {
          decision: "approve",
        }),
      )
      expect(again.body).toMatchObject({ status: "approved" })
    })

    it("refuses an undo once the decision is effective", async () => {
      const { approvalId } = await driveToApproval()
      clock = at(0)
      await call(t.owner.cookie, `/v1/approvals/${approvalId}/decision`, "POST", {
        decision: "approve",
      })
      clock = at(30)
      const late = await json(
        await call(t.owner.cookie, `/v1/approvals/${approvalId}/undo`, "POST"),
      )
      expect(late).toMatchObject({ status: 409, body: { error: { code: "CONFLICT" } } })
      expect(late.body.error).toMatchObject({ hint: expect.stringContaining("takes effect") })
    })

    it("refuses a second decision on the same approval, and an undo with nothing to undo", async () => {
      const { approvalId } = await driveToApproval()
      const undoPending = await json(
        await call(t.owner.cookie, `/v1/approvals/${approvalId}/undo`, "POST"),
      )
      expect(undoPending).toMatchObject({ status: 409, body: { error: { code: "CONFLICT" } } })
      clock = at(0)
      await call(t.owner.cookie, `/v1/approvals/${approvalId}/decision`, "POST", {
        decision: "approve",
      })
      const twice = await json(
        await call(t.owner.cookie, `/v1/approvals/${approvalId}/decision`, "POST", {
          decision: "deny",
        }),
      )
      expect(twice).toMatchObject({ status: 409, body: { error: { code: "CONFLICT" } } })
    })

    it("lets only people decide: a key with the run permissions is refused", async () => {
      const { approvalId } = await driveToApproval()
      const res = await json(
        await call(runKey, `/v1/approvals/${approvalId}/decision`, "POST", { decision: "approve" }),
      )
      expect(res).toMatchObject({ status: 403, body: { error: { code: "FORBIDDEN" } } })
    })

    it("counts pending approvals in the inbox only for people who can approve", async () => {
      const count = async (credential: string) =>
        ((await json(await call(credential, "/v1/inbox", "GET"))).body.needsYou as number) ?? 0
      const ownerBefore = await count(t.owner.cookie)
      await driveToApproval()
      expect(await count(t.owner.cookie)).toBe(ownerBefore + 1)
      expect(await count(member.cookie)).toBe(ownerBefore + 1)
      expect(await count(t.viewer.cookie)).toBe(0)
      expect(await count(runKey)).toBe(0)
    })
  })

  describe("roles", () => {
    it("lets a viewer read agents and runs, and refuses every write", async () => {
      const { agentId, runId, approvalId } = await driveToApproval()
      expect((await call(t.viewer.cookie, "/v1/workspace-agents", "GET")).status).toBe(200)
      expect((await call(t.viewer.cookie, `/v1/runs/${runId}`, "GET")).status).toBe(200)
      for (const [path, method, body] of [
        ["/v1/workspace-agents", "POST", { name: "x" }],
        [`/v1/workspace-agents/${agentId}`, "PATCH", { pinned: true }],
        [`/v1/workspace-agents/${agentId}`, "DELETE", undefined],
        [`/v1/workspace-agents/${agentId}/runs`, "POST", { title: "x" }],
        [`/v1/runs/${runId}/messages`, "POST", { body: "x" }],
        [`/v1/approvals/${approvalId}/decision`, "POST", { decision: "approve" }],
      ] as const) {
        const res = await json(await call(t.viewer.cookie, path, method, body))
        expect(res, `${method} ${path}`).toMatchObject({
          status: 403,
          body: { error: { code: "FORBIDDEN" } },
        })
      }
    })

    it("lets a member create agents, start and approve runs, but not delete agents or reset 2FA", async () => {
      const created = await json(
        await call(member.cookie, "/v1/workspace-agents", "POST", { name: "Member's" }),
      )
      expect(created.status).toBe(200)
      const del = await json(
        await call(member.cookie, `/v1/workspace-agents/${created.body.id as string}`, "DELETE"),
      )
      expect(del).toMatchObject({ status: 403, body: { error: { code: "FORBIDDEN" } } })
      const { runId, approvalId } = await driveToApproval()
      expect(
        (
          await call(member.cookie, `/v1/approvals/${approvalId}/decision`, "POST", {
            decision: "approve",
          })
        ).status,
      ).toBe(200)
      expect((await call(member.cookie, `/v1/runs/${runId}`, "GET")).status).toBe(200)
      const resetAttempt = await call(
        member.cookie,
        `/v1/members/${t.viewer.userId}/two-factor/reset`,
        "POST",
      )
      expect(resetAttempt.status).toBe(403)
      const members = await json(await call(member.cookie, "/v1/members/security", "GET"))
      expect(members).toMatchObject({ status: 403, body: { error: { code: "FORBIDDEN" } } })
    })

    it("lets an admin read member security and decide, but not reset 2FA (owners only)", async () => {
      const members = await json(await call(admin.cookie, "/v1/members/security", "GET"))
      expect(members.status).toBe(200)
      const rows = members.body.members as { userId: string; role: string }[]
      expect(rows.map((r) => r.role).sort()).toEqual(["admin", "member", "owner", "viewer"])
      expect(rows.every((r) => r.userId !== t.other.userId)).toBe(true)
      const reset = await json(
        await call(admin.cookie, `/v1/members/${member.userId}/two-factor/reset`, "POST"),
      )
      expect(reset).toMatchObject({ status: 403, body: { error: { code: "FORBIDDEN" } } })
    })

    it("resets a member's two-factor as owner, audits it, and refuses your own", async () => {
      const m = member.userId
      await t.db
        .insert(twoFactor)
        .values({ id: "tf-member", secret: "s", backupCodes: "b", userId: m })
      await t.db.update(userTable).set({ twoFactorEnabled: true }).where(eq(userTable.id, m))
      const before = await json(await call(t.owner.cookie, "/v1/members/security", "GET"))
      expect((before.body.members as Json[]).find((r) => r.userId === m)).toMatchObject({
        twoFactorEnabled: true,
      })

      const reset = await json(
        await call(t.owner.cookie, `/v1/members/${m}/two-factor/reset`, "POST"),
      )
      expect(reset).toMatchObject({ status: 200, body: { reset: true } })
      const rows = await t.db.select().from(twoFactor).where(eq(twoFactor.userId, m))
      expect(rows).toHaveLength(0)
      const after = await json(await call(t.owner.cookie, "/v1/members/security", "GET"))
      expect((after.body.members as Json[]).find((r) => r.userId === m)).toMatchObject({
        twoFactorEnabled: false,
      })

      const self = await json(
        await call(t.owner.cookie, `/v1/members/${t.owner.userId}/two-factor/reset`, "POST"),
      )
      expect(self).toMatchObject({ status: 400, body: { error: { code: "BAD_REQUEST" } } })
    })

    it("answers NOT_FOUND for a user who is not a member of the organization", async () => {
      const res = await json(
        await call(t.owner.cookie, `/v1/members/${t.other.userId}/two-factor/reset`, "POST"),
      )
      expect(res).toMatchObject({ status: 404, body: { error: { code: "NOT_FOUND" } } })
    })
  })

  describe("other organizations", () => {
    it("answers NOT_FOUND for another organization's agents and runs, never FORBIDDEN", async () => {
      const { agentId, runId, approvalId } = await driveToApproval()
      const checks = [
        ["GET", `/v1/workspace-agents/${agentId}`, undefined],
        ["PATCH", `/v1/workspace-agents/${agentId}`, { pinned: true }],
        ["DELETE", `/v1/workspace-agents/${agentId}`, undefined],
        ["POST", `/v1/workspace-agents/${agentId}/runs`, { title: "x" }],
        ["GET", `/v1/runs/${runId}`, undefined],
        ["PATCH", `/v1/runs/${runId}`, { status: "running" }],
        ["POST", `/v1/runs/${runId}/messages`, { body: "x" }],
        ["POST", `/v1/approvals/${approvalId}/decision`, { decision: "approve" }],
      ] as const
      for (const [method, path, body] of checks) {
        // A decision needs a person: the other org's owner session, not a key.
        const credential = path.includes("/decision") ? t.other.cookie : otherRunKey
        const res = await json(await call(credential, path, method, body))
        expect(res, `${method} ${path}`).toMatchObject({
          status: 404,
          body: { error: { code: "NOT_FOUND" } },
        })
      }
      const list = await json(await call(otherRunKey, "/v1/runs", "GET"))
      expect(list.body.runs).toEqual([])
    })

    it("keeps the owner's runs out of another org's session", async () => {
      const { runId } = await driveToApproval()
      const res = await json(await call(t.other.cookie, `/v1/runs/${runId}`, "GET"))
      expect(res).toMatchObject({ status: 404, body: { error: { code: "NOT_FOUND" } } })
    })
  })

  describe("keys", () => {
    it("refuses to mint a key with owner-only permissions or approve", async () => {
      for (const permissions of [
        { sso: ["read"] },
        { scim: ["create"] },
        { subscription: ["read"] },
        { twoFactor: ["reset"] },
        { run: ["approve"] },
      ]) {
        const res = await json(
          await call(t.owner.cookie, "/v1/api-keys", "POST", { name: "x", permissions }),
        )
        expect(res, JSON.stringify(permissions)).toMatchObject({
          status: 403,
          body: { error: { code: "FORBIDDEN" } },
        })
      }
    })

    it("mints an ordinary agent key, which then runs an agent", async () => {
      const res = await json(
        await call(t.owner.cookie, "/v1/api-keys", "POST", {
          name: "CI",
          permissions: { run: ["read"] },
        }),
      )
      expect(res.status).toBe(200)
      const listed = await json(await call(res.body.key as string, "/v1/runs", "GET"))
      expect(listed.status).toBe(200)
    })

    it("lists keys masked, with who created them, for anyone with apiKey read", async () => {
      const created = await json(
        await call(t.owner.cookie, "/v1/api-keys", "POST", {
          name: "Listed",
          permissions: { run: ["read"] },
        }),
      )
      expect(created.status).toBe(200)
      const list = await json(await call(member.cookie, "/v1/api-keys", "GET"))
      expect(list.status).toBe(200)
      const row = (list.body.keys as Json[]).find((k) => k.id === created.body.id)
      expect(row).toMatchObject({
        name: "Listed",
        permissions: { run: ["read"] },
        createdBy: { id: t.owner.userId },
        lastUsedAt: null,
        expiresAt: null,
      })
      expect(JSON.stringify(list.body)).not.toContain(created.body.key as string)
      expect(row).not.toHaveProperty("key")
      expect(await json(await call(t.viewer.cookie, "/v1/api-keys", "GET"))).toMatchObject({
        status: 403,
      })
    })

    it("keeps read-only keys to reads", async () => {
      const res = await json(await call(readKey, "/v1/workspace-agents", "POST", { name: "x" }))
      expect(res).toMatchObject({ status: 403, body: { error: { code: "FORBIDDEN" } } })
    })
  })

  describe("MCP", () => {
    it("lists only the tools a key can use, and refuses a hidden one by name", async () => {
      const client = await t.mcpClient(readKey)
      try {
        const names = (await client.listTools()).tools.map((x) => x.name)
        expect(names).toEqual(expect.arrayContaining(["list_runs", "get_run", "list_agents"]))
        expect(names).not.toContain("decide_approval")
        const res = await client.callTool({
          name: "decide_approval",
          arguments: { id: "x", decision: "approve" },
        })
        expect(res.isError).toBe(true)
      } finally {
        await client.close()
      }
    })

    it("runs the same writes as REST for a session (create, then get)", async () => {
      const client = await t.mcpClient(t.owner.cookie)
      try {
        const created = await client.callTool({
          name: "create_agent",
          arguments: { name: "Via MCP" },
        })
        expect(created.structuredContent).toMatchObject({
          name: "Via MCP",
          activity: "idle",
          autonomy: "ask_first",
        })
        const id = (created.structuredContent as { id: string }).id
        const got = await client.callTool({ name: "get_agent", arguments: { id } })
        expect(got.structuredContent).toMatchObject({ id, name: "Via MCP" })
      } finally {
        await client.close()
      }
    })

    it("answers a mismatched organization header with 409 on /mcp too", async () => {
      const res = await t.req(
        "/mcp",
        t.as(t.owner.cookie, {
          method: "POST",
          headers: {
            "x-organization-id": t.other.orgId,
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
        }),
      )
      expect(res.status).toBe(409)
      expect(await res.json()).toMatchObject({ error: { code: "CONFLICT" } })
    })
  })

  describe("the organization header", () => {
    it("refuses a session for another organization, and accepts its own or none", async () => {
      const mismatch = await t.req(
        "/v1/workspace-agents",
        t.as(t.owner.cookie, { headers: { "x-organization-id": t.other.orgId } }),
      )
      expect(mismatch.status).toBe(409)
      expect(await mismatch.json()).toMatchObject({
        error: { code: "CONFLICT", hint: expect.stringContaining("Reload the page") },
      })
      const own = await t.req(
        "/v1/workspace-agents",
        t.as(t.owner.cookie, { headers: { "x-organization-id": t.owner.orgId } }),
      )
      expect(own.status).toBe(200)
      expect((await t.req("/v1/workspace-agents", t.as(t.owner.cookie))).status).toBe(200)
    })

    it("refuses a key or token that names another organization, and accepts its own", async () => {
      const mismatch = await t.req(
        "/v1/workspace-agents",
        t.as(runKey, { headers: { "x-organization-id": t.other.orgId } }),
      )
      expect(mismatch.status).toBe(409)
      const own = await t.req(
        "/v1/workspace-agents",
        t.as(runKey, { headers: { "x-organization-id": t.owner.orgId } }),
      )
      expect(own.status).toBe(200)
    })
  })
})
