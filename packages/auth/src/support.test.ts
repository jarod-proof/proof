import type { ByoEvent } from "@byo-oss/core"
import { supportRoles, supportStatements } from "@byo-oss/support"
import * as supportClient from "@byo-oss/support/client"
import { setErrorReporter } from "@proof/errors"
import { afterEach, describe, expect, it } from "vitest"

import { roles, statements } from "./access"
import type { OrgEventInput } from "./notifications"
import type { PersonalEvent } from "./notify-hooks"
import {
  acceptSupportSession,
  type SupportPluginDeps,
  supportEvents,
  supportMailer,
  supportOptions,
} from "./support"

const STAFF = "org_staff"

/** A support event as the package emits it. */
const event = (type: string, extra: Partial<ByoEvent> = {}): ByoEvent => ({
  type: type as ByoEvent["type"],
  occurredAt: new Date(),
  actorId: "user_actor",
  organizationId: "org_customer",
  subject: { type: "supportTicket", id: "tkt_1" },
  data: { ticketId: "tkt_1", visibility: "private" },
  ...extra,
})

/** Records what would be sent, as notificationHooks' inOrg and personal take it. */
function fakeNotifications() {
  const inOrg: { organizationId: string; event: OrgEventInput }[] = []
  const personal: PersonalEvent[] = []
  return {
    inOrg,
    personal,
    hooks: {
      inOrg: async (organizationId: string, e: OrgEventInput) => {
        inOrg.push({ organizationId, event: e })
      },
      personal: async (e: PersonalEvent) => {
        personal.push(e)
      },
    },
  }
}

const session = (impersonatedBy?: string) =>
  ({ user: {}, session: { impersonatedBy } }) as Parameters<
    typeof acceptSupportSession
  >[0]["session"]

describe("the support catalog entry", () => {
  it("is what the server checks: the browser-safe entry access.ts imports matches the root", () => {
    expect(supportClient.supportStatements).toEqual(supportStatements)
    expect(supportClient.supportRoles).toEqual(supportRoles)
    expect(statements.support).toEqual(supportStatements.support)
  })

  it("gives owners and admins every support action, members the suggested three, others none", () => {
    const holds = (role: keyof typeof roles) =>
      supportStatements.support.filter(
        (action) => roles[role].authorize({ support: [action] }).success,
      )
    expect(holds("owner")).toEqual(supportRoles.owner.support)
    expect(holds("admin")).toEqual(supportRoles.admin.support)
    expect(holds("member")).toEqual(supportRoles.member.support)
    for (const role of ["viewer", "approver", "operator", "billing"] as const) {
      expect(holds(role)).toEqual([])
    }
  })
})

describe("acceptSupportSession", () => {
  const accept = (headers: Record<string, string>, impersonatedBy?: string) =>
    acceptSupportSession({
      session: session(impersonatedBy),
      headers: new Headers(headers),
      kind: "customer",
    })

  it("accepts a plain cookie session", () => {
    expect(accept({ cookie: "better-auth.session_token=x" })).toBe(true)
  })

  it("refuses a session sent with an API key or a bearer token", () => {
    expect(accept({ cookie: "c", "x-api-key": "sk_x" })).toBe(false)
    expect(accept({ cookie: "c", authorization: "Bearer sk_x" })).toBe(false)
    expect(accept({ cookie: "c", authorization: "Bearer eyJ.oauth.token" })).toBe(false)
  })

  it("refuses an impersonated session", () => {
    expect(accept({ cookie: "c" }, "admin_1")).toBe(false)
  })
})

describe("supportEvents", () => {
  it("tells the staff about new tickets and customer replies, minus whoever caused them", async () => {
    const n = fakeNotifications()
    const route = supportEvents({ staffOrganizationId: STAFF, notifications: n.hooks })
    await route(event("support.ticket.created", { data: { number: 7, visibility: "private" } }))
    await route(event("support.customer.replied"))
    expect(n.inOrg).toEqual([
      {
        organizationId: STAFF,
        event: {
          type: "support.ticket.created",
          ticketId: "tkt_1",
          number: 7,
          actorUserId: "user_actor",
        },
      },
      {
        organizationId: STAFF,
        event: { type: "support.customer.replied", ticketId: "tkt_1", actorUserId: "user_actor" },
      },
    ])
    expect(n.personal).toEqual([])
  })

  it("tells a mentioned agent, and the requester about an agent's reply", async () => {
    const n = fakeNotifications()
    const route = supportEvents({ staffOrganizationId: STAFF, notifications: n.hooks })
    await route(event("support.agent.mentioned", { userId: "user_agent" }))
    await route(event("support.agent.replied", { userId: "user_requester" }))
    expect(n.inOrg).toEqual([
      {
        organizationId: STAFF,
        event: {
          type: "support.agent.mentioned",
          ticketId: "tkt_1",
          memberUserId: "user_agent",
          actorUserId: "user_actor",
        },
      },
    ])
    expect(n.personal).toEqual([
      {
        type: "support.agent.replied",
        ticketId: "tkt_1",
        userId: "user_requester",
        actorUserId: "user_actor",
      },
    ])
  })

  it("never sends an internal note, and nothing else the catalog has no entry for", async () => {
    const n = fakeNotifications()
    const route = supportEvents({ staffOrganizationId: STAFF, notifications: n.hooks })
    for (const type of [
      "support.note.added",
      "support.ticket.status_changed",
      "support.ticket.assigned",
      "support.ticket.merged",
      // notify refuses types that start with "notifications." (0.10); none is ever forwarded.
      "notifications.delivery.failed",
    ]) {
      await route(event(type, { userId: "user_requester" }))
    }
    expect(n.inOrg).toEqual([])
    expect(n.personal).toEqual([])
  })

  it("never fans out to the ticket's organization, private or shared", async () => {
    const n = fakeNotifications()
    const route = supportEvents({ staffOrganizationId: STAFF, notifications: n.hooks })
    for (const visibility of ["private", "organization"]) {
      for (const type of ["support.ticket.created", "support.customer.replied"]) {
        await route(event(type, { data: { ticketId: "tkt_1", visibility } }))
      }
    }
    expect(n.inOrg.map((x) => x.organizationId)).toEqual([STAFF, STAFF, STAFF, STAFF])
  })

  it("skips staff events with no staff organization, and replies to an email-only requester", async () => {
    const n = fakeNotifications()
    const route = supportEvents({ notifications: n.hooks })
    await route(event("support.ticket.created"))
    await route(event("support.agent.mentioned", { userId: "user_agent" }))
    await route(event("support.agent.replied", { userId: undefined, actorId: null }))
    expect(n.inOrg).toEqual([])
    expect(n.personal).toEqual([])
  })
})

describe("supportOptions", () => {
  const deps = (config: SupportPluginDeps["config"]): SupportPluginDeps => ({
    config,
    notifications: fakeNotifications().hooks,
  })

  afterEach(() => {
    setErrorReporter(() => {})
  })

  it("denies every agent action without a staff organization, and mails nothing", async () => {
    const options = supportOptions(deps({}))
    expect(options.staffOrganizationId).toBeNull()
    expect(options.authorize).toBeUndefined()
    expect(options.mailer).toBeUndefined()
    expect(options.email).toBeUndefined()
    expect(options.inbound).toBeUndefined()
    expect(options.acceptSession).toBe(acceptSupportSession)
  })

  it("keeps support's own staff check with a staff organization", () => {
    const options = supportOptions(deps({ staffOrganizationId: STAFF }))
    expect(options.staffOrganizationId).toBe(STAFF)
    expect(options.authorize).toBeUndefined()
  })

  it("mails replies with links to the requester's ticket page, and receives mail only with email", async () => {
    const email = {
      from: "Support <s@example.com>",
      replyDomain: "s.example.com",
      appUrl: "https://a",
    }
    const inbound = { key: "k", bucket: "b", region: "us-east-1" }
    const withMail = supportOptions(deps({ email, inbound }))
    expect(withMail.mailer).toBeDefined()
    expect(withMail.email).toMatchObject({ ...email })
    expect(withMail.email?.ticketPath?.("tkt_1")).toBe("/account/support/tkt_1")
    expect(withMail.email).not.toHaveProperty("replyDelay")
    expect(withMail.inbound?.source).toBeDefined()
    expect(supportOptions(deps({ email: { ...email, replyDelay: 0 } })).email?.replyDelay).toBe(0)
    expect(supportOptions(deps({ inbound })).inbound).toBeUndefined()
    // A relay's secret is the other source (support's rawRelay): it checks the bearer secret.
    const relay = supportOptions(deps({ email, inbound: { secret: "test-relay-secret-1" } }))
    const request = (secret: string) =>
      new Request("https://api.example.com/api/auth/support/inbound", {
        method: "POST",
        headers: { "content-type": "message/rfc822", authorization: `Bearer ${secret}` },
        body: "From: a@example.com\r\n\r\nHi",
      })
    expect(await relay.inbound?.source.receive(request("wrong-secret"))).toEqual({ reject: 401 })
    expect(await relay.inbound?.source.receive(request("test-relay-secret-1"))).toHaveProperty(
      "raw",
    )
    // A resolver for the DKIM check goes through as is (tests serve their own keys); unset, none.
    const resolver = async () => [["v=DKIM1; p="]]
    expect(
      supportOptions(deps({ email, inbound: { secret: "test-relay-secret-1", resolver } })).inbound
        ?.resolver,
    ).toBe(resolver)
    expect(relay.inbound).not.toHaveProperty("resolver")
  })

  it("reports a consumer that throws, and the event still resolves", async () => {
    const reported: { message: string; context?: Record<string, unknown> }[] = []
    setErrorReporter((error, context) => reported.push({ message: error.message, context }))
    const options = supportOptions({
      config: { staffOrganizationId: STAFF },
      notifications: {
        inOrg: async () => {
          throw new Error("lookup failed")
        },
        personal: async () => {},
      },
    })
    await expect(options.onEvent?.(event("support.ticket.created"))).resolves.toBeUndefined()
    expect(reported).toEqual([
      {
        message: expect.any(String),
        context: expect.objectContaining({ supportEvent: "support.ticket.created" }),
      },
    ])
  })
})

describe("supportMailer", () => {
  it("sends through the auth emails' SES client, with the reply address", async () => {
    const commands: unknown[] = []
    const mailer = supportMailer({
      from: "Support <support@example.com>",
      ses: {
        client: {
          send: async (command: { input: unknown }) => {
            commands.push(command.input)
            return { MessageId: "ses-1", $metadata: { requestId: "r" } }
          },
        },
      },
    })
    const result = await mailer.send({
      to: "alice@example.com",
      subject: "[#1] Help",
      html: "<p>Fixed</p>",
      text: "Fixed",
      replyTo: "support+token@support.example.com",
    })
    expect(result.id).toBe("ses-1")
    expect(JSON.stringify(commands)).toContain("support+token@support.example.com")
    expect(JSON.stringify(commands)).toContain("alice@example.com")
  })
})
