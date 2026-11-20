import { readFileSync } from "node:fs"

import { runWithTransaction } from "@better-auth/core/context"
import { deleteMemberData } from "@byo-oss/notifications"
import { notification } from "@proof/db/schema"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { createTestAuth } from "./auth.test.helpers"
import {
  APPROVERS,
  BILLING_MANAGERS,
  createNotifier,
  NOTIFICATION_EMAIL_ROUTES,
  type NotificationEvent,
  type NotifyBody,
  type NotifyFn,
  type OrgRef,
  recipientsOf,
  renderNotification,
  rolesWith,
  SUPPORT_AGENTS,
} from "./notifications"

const org: OrgRef = { id: "org_1", slug: "acme", name: "Acme" }

/** One sample per event type. The test below checks this list covers every type in the catalog. */
const samples = {
  "approval.requested": {
    type: "approval.requested",
    org,
    agentName: "Mail agent",
    action: "send an email to 40 customers",
    runId: "run_1",
    requesterUserId: "user_a",
  },
  "approval.decided": {
    type: "approval.decided",
    org,
    decision: "approved",
    action: "send an email",
    runId: "run_1",
    deciderUserId: "user_b",
    runStarterUserId: "user_a",
  },
  "run.failed": {
    type: "run.failed",
    org,
    agentName: "Mail agent",
    runId: "run_2",
    runStarterUserId: null,
  },
  "run.done": {
    type: "run.done",
    org,
    agentName: "Mail agent",
    runId: "run_3",
    runStarterUserId: "user_a",
  },
  "member.joined": {
    type: "member.joined",
    org,
    memberUserId: "user_c",
    memberName: "Casey",
    actorUserId: "user_a",
  },
  "member.role_changed": {
    type: "member.role_changed",
    org,
    memberUserId: "user_c",
    role: "admin",
  },
  "member.removed": { type: "member.removed", userId: "user_c", organizationName: "Acme" },
  "api_key.created": { type: "api_key.created", org, keyName: "CI key", actorUserId: "user_a" },
  "api_key.revoked": { type: "api_key.revoked", org, keyName: "CI key", actorUserId: "user_a" },
  "agent_access.revoked": {
    type: "agent_access.revoked",
    org,
    clientName: "Claude Code",
    actorUserId: "user_a",
  },
  "security.two_factor_reset": {
    type: "security.two_factor_reset",
    org,
    memberUserId: "user_c",
    actorUserId: "user_a",
  },
  "billing.payment_failed": { type: "billing.payment_failed", org },
  "billing.subscription_canceled": { type: "billing.subscription_canceled", org },
  "usage.limit_reached": { type: "usage.limit_reached", org, limit: 600 },
  "account.password_changed": { type: "account.password_changed", userId: "user_a" },
  "account.two_factor_enabled": { type: "account.two_factor_enabled", userId: "user_a" },
  "account.two_factor_disabled": { type: "account.two_factor_disabled", userId: "user_a" },
  "account.passkey_added": { type: "account.passkey_added", userId: "user_a" },
  "account.email_changed": { type: "account.email_changed", userId: "user_a" },
  "invitation.received": {
    type: "invitation.received",
    userId: "user_a",
    invitationId: "inv_1",
    organizationName: "Acme",
    inviterName: "Ada",
  },
  "support.ticket.created": {
    type: "support.ticket.created",
    org,
    ticketId: "tkt_1",
    number: 42,
    actorUserId: "user_d",
  },
  "support.customer.replied": {
    type: "support.customer.replied",
    org,
    ticketId: "tkt_1",
    actorUserId: "user_d",
  },
  "support.agent.mentioned": {
    type: "support.agent.mentioned",
    org,
    ticketId: "tkt_1",
    memberUserId: "user_c",
    actorUserId: "user_a",
  },
  "support.agent.replied": {
    type: "support.agent.replied",
    ticketId: "tkt_1",
    userId: "user_d",
    actorUserId: "user_a",
  },
} satisfies Record<NotificationEvent["type"], NotificationEvent>

/** The catalog: the event types every emitter may send (graph/graph.md, Events). */
const CATALOG_TYPES = [
  "account.email_changed",
  "account.passkey_added",
  "account.password_changed",
  "account.two_factor_disabled",
  "account.two_factor_enabled",
  "agent_access.revoked",
  "api_key.created",
  "api_key.revoked",
  "approval.decided",
  "approval.requested",
  "billing.payment_failed",
  "billing.subscription_canceled",
  "invitation.received",
  "member.joined",
  "member.removed",
  "member.role_changed",
  "run.done",
  "run.failed",
  "security.two_factor_reset",
  "support.agent.mentioned",
  "support.agent.replied",
  "support.customer.replied",
  "support.ticket.created",
  "usage.limit_reached",
]

/** A notify fake that records every call. Resolves like the endpoint. */
function fakeNotify(fail?: Error) {
  const calls: NotifyBody[] = []
  const notify: NotifyFn = async ({ body }) => {
    if (fail) throw fail
    calls.push(body)
    return { count: 1, notifications: [] }
  }
  return { calls, notify }
}

describe("renderNotification", () => {
  it("renders every catalog event with a short title and a web-app path", () => {
    expect(Object.keys(samples).sort()).toEqual(CATALOG_TYPES)
    for (const event of Object.values(samples)) {
      const rendered = renderNotification(event)
      expect(rendered.type).toBe(event.type)
      expect(rendered.title.length).toBeGreaterThan(0)
      expect(rendered.title.length).toBeLessThanOrEqual(40)
      if (rendered.href !== undefined) expect(rendered.href.startsWith("/")).toBe(true)
    }
  })

  it("lists every catalog event in docs/notifications.md", () => {
    const doc = readFileSync(new URL("../../../docs/notifications.md", import.meta.url), "utf8")
    const documented = [...doc.matchAll(/^\| `([a-z_.]+)` \|/gm)].map((m) => m[1] ?? "").sort()
    expect(documented).toEqual(CATALOG_TYPES)
  })

  it("documents which events email, as NOTIFICATION_EMAIL_ROUTES routes them", () => {
    const doc = readFileSync(new URL("../../../docs/notifications.md", import.meta.url), "utf8")
    const emailCell = new Map(
      [...doc.matchAll(/^\| `([a-z_.]+)` \|.*\| ([^|]+) \|$/gm)].map((m) => [m[1], m[2]?.trim()]),
    )
    const routes: Record<string, unknown> = NOTIFICATION_EMAIL_ROUTES
    for (const type of CATALOG_TYPES) {
      expect({ type, emails: emailCell.get(type) !== "no" }).toEqual({
        type,
        emails: type in routes,
      })
    }
  })

  it("renders the org-scoped copy and links explicitly", () => {
    expect(renderNotification(samples["approval.requested"])).toEqual({
      type: "approval.requested",
      title: "Approval needed",
      body: "Mail agent wants to send an email to 40 customers.",
      href: "/acme/runs/run_1",
      data: { runId: "run_1" },
    })
    expect(renderNotification(samples["approval.decided"])).toMatchObject({
      title: "Action approved",
      body: expect.stringContaining("unless it is undone"),
      href: "/acme/runs/run_1",
    })
    expect(renderNotification({ ...samples["approval.decided"], decision: "denied" }).title).toBe(
      "Action denied",
    )
    expect(renderNotification(samples["api_key.created"]).href).toBe("/acme/settings/api-keys")
    expect(renderNotification(samples["billing.payment_failed"]).href).toBe(
      "/acme/settings/billing",
    )
    expect(renderNotification(samples["member.joined"]).href).toBe("/acme/settings/members")
    expect(renderNotification(samples["member.joined"]).body).toBe("Casey joined Acme.")
    expect(renderNotification({ ...samples["member.joined"], memberName: undefined }).body).toBe(
      "Someone joined Acme.",
    )
  })

  it("keeps personal events free of any organization link", () => {
    expect(renderNotification(samples["member.removed"])).toEqual({
      type: "member.removed",
      title: "Access removed",
      body: "You were removed from Acme and no longer have access to it.",
    })
    for (const type of [
      "account.password_changed",
      "account.two_factor_enabled",
      "account.two_factor_disabled",
      "account.passkey_added",
      "account.email_changed",
    ] as const) {
      const href = renderNotification(samples[type]).href ?? ""
      expect(href.startsWith("/account")).toBe(true)
      expect(href).not.toContain("acme")
    }
  })
})

describe("recipients come from the permission catalog", () => {
  it("approvals go to the roles that hold run:approve (approver among them), never a viewer", () => {
    expect(rolesWith(APPROVERS)).toEqual(["owner", "admin", "member", "approver"])
    expect(rolesWith(APPROVERS)).not.toContain("viewer")
    expect(recipientsOf(samples["approval.requested"])).toEqual({
      kind: "members",
      organizationId: "org_1",
      roles: ["owner", "admin", "member", "approver"],
      excludeUserIds: ["user_a"],
    })
  })

  it("billing goes to the roles that manage the subscription: owners, admins and billing", () => {
    expect(rolesWith(BILLING_MANAGERS)).toEqual(["owner", "admin", "billing"])
    expect(recipientsOf(samples["billing.payment_failed"])).toMatchObject({
      kind: "members",
      roles: ["owner", "admin", "billing"],
      excludeUserIds: [],
    })
  })

  it("follows the catalog: a role that gains a permission gains the notifications", () => {
    // Only owners and admins may delete a project in the catalog, so only they are recipients of a
    // rule built from it; the rule is the catalog's, not a list of role names kept here.
    expect(rolesWith({ project: ["delete"] })).toEqual(["owner", "admin"])
    expect(rolesWith({ project: ["update"] })).toEqual(["owner", "admin", "member"])
  })

  it("addresses a single member or a person, and skips a decider who started the run", () => {
    expect(recipientsOf(samples["approval.decided"])).toEqual({
      kind: "member",
      organizationId: "org_1",
      userId: "user_a",
    })
    expect(
      recipientsOf({
        ...samples["approval.decided"],
        deciderUserId: "user_a",
      } as NotificationEvent),
    ).toBeNull()
    expect(recipientsOf(samples["run.failed"])).toMatchObject({
      kind: "members",
      roles: ["owner", "admin"],
    })
    expect(recipientsOf(samples["member.removed"])).toEqual({ kind: "person", userId: "user_c" })
    expect(recipientsOf(samples["account.passkey_added"])).toEqual({
      kind: "person",
      userId: "user_a",
    })
  })

  it("support staff are the roles with support:read; the requester hears agent replies", () => {
    expect(rolesWith(SUPPORT_AGENTS)).toEqual(["owner", "admin", "member"])
    expect(recipientsOf(samples["support.ticket.created"])).toEqual({
      kind: "members",
      organizationId: "org_1",
      roles: ["owner", "admin", "member"],
      excludeUserIds: ["user_d"],
    })
    expect(recipientsOf(samples["support.customer.replied"])).toMatchObject({
      kind: "members",
      excludeUserIds: ["user_d"],
    })
    expect(recipientsOf(samples["support.agent.mentioned"])).toEqual({
      kind: "member",
      organizationId: "org_1",
      userId: "user_c",
    })
    expect(
      recipientsOf({ ...samples["support.agent.mentioned"], memberUserId: "user_a" }),
    ).toBeNull()
    expect(recipientsOf(samples["support.agent.replied"])).toEqual({
      kind: "person",
      userId: "user_d",
    })
    expect(recipientsOf({ ...samples["support.agent.replied"], actorUserId: "user_d" })).toBeNull()
    expect(renderNotification(samples["support.ticket.created"])).toEqual({
      type: "support.ticket.created",
      title: "New support ticket",
      body: "Ticket #42 is waiting.",
      href: "/admin/support/tkt_1",
      data: { ticketId: "tkt_1" },
    })
    expect(
      renderNotification({ ...samples["support.ticket.created"], number: undefined }).body,
    ).toBeUndefined()
    expect(renderNotification(samples["support.agent.replied"]).href).toBe("/account/support/tkt_1")
  })

  it("excludes the actor from fan-out", () => {
    expect(recipientsOf(samples["api_key.revoked"])).toMatchObject({ excludeUserIds: ["user_a"] })
    expect(recipientsOf(samples["member.joined"])).toMatchObject({
      excludeUserIds: ["user_c", "user_a"],
    })
  })
})

describe("createNotifier", () => {
  it("sends the rendered copy with the recipients' addressing", async () => {
    const { calls, notify } = fakeNotify()
    const notifier = createNotifier({ notify, onError: () => {} })
    await notifier.send(samples["approval.requested"])
    expect(calls).toEqual([
      {
        organizationId: "org_1",
        roles: ["owner", "admin", "member", "approver"],
        excludeUserIds: ["user_a"],
        type: "approval.requested",
        title: "Approval needed",
        body: "Mail agent wants to send an email to 40 customers.",
        href: "/acme/runs/run_1",
        data: { runId: "run_1" },
      },
    ])
    await notifier.send(samples["account.email_changed"])
    expect(calls.at(-1)).toEqual({
      userId: "user_a",
      type: "account.email_changed",
      title: "Sign-in email changed",
      body: "Your sign-in email was changed. If this wasn't you, reset your password.",
      href: "/account/profile",
    })
  })

  it("sends nothing when no one should hear the event", async () => {
    const { calls, notify } = fakeNotify()
    const notifier = createNotifier({ notify, onError: () => {} })
    await notifier.send({ ...samples["run.done"], runStarterUserId: null })
    expect(calls).toEqual([])
  })

  it("never rejects: a refused send goes to onError with the event", async () => {
    const failure = new Error("USER_NOT_IN_ORGANIZATION")
    const reported: { error: Error; type: string }[] = []
    const notifier = createNotifier({
      notify: fakeNotify(failure).notify,
      onError: (error, event) => reported.push({ error, type: event.type }),
    })
    await expect(notifier.send(samples["run.done"])).resolves.toBeUndefined()
    expect(reported).toEqual([{ error: failure, type: "run.done" }])
  })

  it("wraps a non-Error throw and survives a reporter that throws", async () => {
    const reported: Error[] = []
    const notifier = createNotifier({
      notify: async () => {
        throw "boom" // a non-Error value
      },
      onError: (error) => {
        reported.push(error)
        throw new Error("reporter broke")
      },
    })
    await expect(notifier.send(samples["run.done"])).resolves.toBeUndefined()
    expect(reported.map((e) => e.message)).toEqual(["boom"])
  })
})

describe("against a real auth instance", () => {
  let h: Awaited<ReturnType<typeof createTestAuth>>
  let org: { userId: string; cookie: string; orgId: string }
  let admin: { userId: string; cookie: string }
  let member: { userId: string; cookie: string }
  let viewer: { userId: string; cookie: string }
  let outsider: { userId: string; cookie: string }
  const ref: OrgRef = { id: "", slug: "acme", name: "Acme" }

  beforeAll(async () => {
    h = await createTestAuth()
    org = await h.signUp("Owner")
    admin = await h.signUp("Admin")
    member = await h.signUp("Member")
    viewer = await h.signUp("Viewer")
    outsider = await h.signUp("Outsider")
    await h.addMember(org.orgId, admin.userId, "admin")
    await h.addMember(org.orgId, member.userId, "member")
    await h.addMember(org.orgId, viewer.userId, "viewer")
    ref.id = org.orgId
  })

  afterAll(async () => {
    await h.close()
  })

  const inboxOf = async (cookie: string) =>
    (
      await h.auth.api.listNotifications({
        headers: new Headers({ cookie }),
        query: { filter: "all" },
      })
    ).notifications

  it("an organization fan-out lands one row per eligible member, stamped with the org", async () => {
    const errors: Error[] = []
    const notifier = createNotifier({
      notify: (options) => h.auth.api.notify(options),
      onError: (error) => errors.push(error),
    })
    await notifier.send({
      type: "approval.requested",
      org: ref,
      agentName: "Mail agent",
      action: "send an email",
      runId: "run_fan",
      requesterUserId: admin.userId,
    })
    expect(errors).toEqual([])

    const ownerRows = (await inboxOf(org.cookie)).filter((n) => n.type === "approval.requested")
    expect(ownerRows).toEqual([
      expect.objectContaining({
        userId: org.userId,
        organizationId: org.orgId,
        title: "Approval needed",
        href: "/acme/runs/run_fan",
        read: false,
      }),
    ])
    expect(
      (await inboxOf(member.cookie)).filter((n) => n.type === "approval.requested"),
    ).toHaveLength(1)
    // The admin asked, so is excluded; the viewer can't approve, so gets nothing.
    expect((await inboxOf(admin.cookie)).filter((n) => n.type === "approval.requested")).toEqual([])
    expect((await inboxOf(viewer.cookie)).filter((n) => n.type === "approval.requested")).toEqual(
      [],
    )
  })

  it("a single-member send lands one row for that member", async () => {
    const notifier = createNotifier({
      notify: (options) => h.auth.api.notify(options),
      onError: () => {},
    })
    await notifier.send({
      type: "run.done",
      org: ref,
      agentName: "Mail agent",
      runId: "run_single",
      runStarterUserId: member.userId,
    })
    const rows = (await inboxOf(member.cookie)).filter((n) => n.type === "run.done")
    expect(rows).toEqual([
      expect.objectContaining({
        userId: member.userId,
        organizationId: org.orgId,
        title: "Run finished",
      }),
    ])
    expect((await inboxOf(org.cookie)).filter((n) => n.type === "run.done")).toEqual([])
  })

  it("a personal event lands on the person with no organization stamp", async () => {
    const notifier = createNotifier({
      notify: (options) => h.auth.api.notify(options),
      onError: () => {},
    })
    await notifier.send({ type: "account.passkey_added", userId: viewer.userId })
    const rows = (await inboxOf(viewer.cookie)).filter((n) => n.type === "account.passkey_added")
    expect(rows).toEqual([expect.objectContaining({ userId: viewer.userId, organizationId: null })])
  })

  it("a single member who is not in the organization is refused and reported, not thrown", async () => {
    const errors: Error[] = []
    const notifier = createNotifier({
      notify: (options) => h.auth.api.notify(options),
      onError: (error) => errors.push(error),
    })
    await expect(
      notifier.send({
        type: "run.done",
        org: ref,
        agentName: "Mail agent",
        runId: "run_outsider",
        runStarterUserId: outsider.userId,
      }),
    ).resolves.toBeUndefined()
    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).toMatch(/not a member|USER_NOT_IN_ORGANIZATION|member/i)
    expect((await inboxOf(outsider.cookie)).filter((n) => n.type === "run.done")).toEqual([])
  })
})

describe("inside a better-auth transaction", () => {
  let h: Awaited<ReturnType<typeof createTestAuth>>
  let owner: { userId: string; cookie: string; orgId: string }
  let member: { userId: string; cookie: string; orgId: string }

  beforeAll(async () => {
    h = await createTestAuth()
    owner = await h.signUp("Owner")
    member = await h.signUp("Member")
    await h.addMember(owner.orgId, member.userId, "member")
  })

  afterAll(async () => {
    await h.close()
  })

  const orgOf = (): OrgRef => ({ id: owner.orgId, slug: "acme", name: "Acme" })
  const listed = async (cookie: string) =>
    (
      await h.auth.api.listNotifications({
        headers: new Headers({ cookie }),
        query: { filter: "all" },
      })
    ).notifications

  it("a send inside a transaction is written once it commits, and the transaction resolves", async () => {
    const errors: Error[] = []
    const notifier = createNotifier({
      notify: (options) => h.auth.api.notify(options),
      onError: (error) => errors.push(error),
    })
    const adapter = (await h.auth.$context).adapter
    const result = await withTimeout(
      runWithTransaction(adapter, async () => {
        await notifier.send({
          type: "approval.requested",
          org: orgOf(),
          agentName: "Mail agent",
          action: "send mail",
          runId: "run_tx",
        })
        return "committed"
      }),
      5_000,
    )
    expect(result).toBe("committed")
    expect(errors).toEqual([])
    const rows = await listed(member.cookie)
    expect(rows.map((n) => n.type)).toEqual(["approval.requested"])
  })

  it("a send inside a transaction that rolls back is never written", async () => {
    const notifier = createNotifier({
      notify: (options) => h.auth.api.notify(options),
      onError: () => {},
    })
    const adapter = (await h.auth.$context).adapter
    const before = (await listed(member.cookie)).length
    await expect(
      withTimeout(
        runWithTransaction(adapter, async () => {
          await notifier.send({
            type: "approval.requested",
            org: orgOf(),
            agentName: "Mail agent",
            action: "send mail",
            runId: "run_rolled_back",
          })
          throw new Error("the write after the send failed")
        }),
        5_000,
      ),
    ).rejects.toThrow("the write after the send failed")
    expect((await listed(member.cookie)).length).toBe(before)
  })
})

describe("auth.api.notify called directly inside a transaction", () => {
  // Before @byo-oss/notifications 0.9 this hung on PGlite's single connection. It joins the
  // transaction now, but its errors fail the transaction, so events still go through `send`.
  it("joins it, so a rollback drops the notification", async () => {
    const h = await createTestAuth()
    try {
      const owner = await h.signUp("Owner")
      const adapter = (await h.auth.$context).adapter
      const titles = async () =>
        (
          await h.db
            .select({ title: notification.title })
            .from(notification)
            .where(eq(notification.userId, owner.userId))
        ).map((row) => row.title)
      const before = await titles()
      await expect(
        withTimeout(
          runWithTransaction(adapter, async () => {
            await h.auth.api.notify({
              body: {
                userId: owner.userId,
                organizationId: owner.orgId,
                type: "approval.requested",
                title: "Direct",
              },
            })
            throw new Error("the write after the notify failed")
          }),
          5_000,
        ),
      ).rejects.toThrow("the write after the notify failed")
      expect(await titles()).toEqual(before)
    } finally {
      await h.close()
    }
  })
})

describe("deleteMemberData inside a transaction (SCIM deprovisioning)", () => {
  // Its own database: the commit and rollback cases change the same rows, in order.
  let h: Awaited<ReturnType<typeof createTestAuth>>
  let owner: { userId: string; orgId: string }
  let member: { userId: string }

  beforeAll(async () => {
    h = await createTestAuth()
    owner = await h.signUp("Owner")
    member = await h.signUp("Member")
    await h.addMember(owner.orgId, member.userId, "member")
    await h.auth.api.notify({
      body: {
        userId: member.userId,
        organizationId: owner.orgId,
        type: "approval.requested",
        title: "Org",
      },
    })
    await h.auth.api.notify({
      body: { userId: member.userId, type: "account.password_changed", title: "Personal" },
    })
  })

  afterAll(async () => {
    await h.close()
  })

  const titles = async () =>
    (
      await h.db
        .select({ title: notification.title })
        .from(notification)
        .where(eq(notification.userId, member.userId))
    )
      .map((row) => row.title)
      .sort()
  const drop = () =>
    deleteMemberData(h.auth, { userId: member.userId, organizationId: owner.orgId })

  it("a rollback keeps the member's notices for the organization", async () => {
    const adapter = (await h.auth.$context).adapter
    await expect(
      withTimeout(
        runWithTransaction(adapter, async () => {
          await drop()
          throw new Error("the membership write failed")
        }),
        5_000,
      ),
    ).rejects.toThrow("the membership write failed")
    expect(await titles()).toEqual(["Org", "Personal"])
  })

  it("a commit drops the member's notices for the organization and keeps the personal one", async () => {
    const adapter = (await h.auth.$context).adapter
    const result = await withTimeout(
      runWithTransaction(adapter, () => drop()),
      5_000,
    )
    expect(result).toEqual({ notifications: 1 })
    expect(await titles()).toEqual(["Personal"])
  })
})

/** Rejects if `promise` has not settled after `ms`. Used to prove a call does not hang. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timed out")), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}
