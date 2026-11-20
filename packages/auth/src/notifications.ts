// Every in-app notification the app sends. One event catalog, one pure renderer (title, body,
// href), recipients derived from the permission catalog, and one sender that never fails its caller.
//
// Sends go through @byo-oss/notifications' `notify` endpoint (`auth.api.notify`, server-only). Inside a
// better-auth transaction the endpoint would read through the outer adapter, which waits on the
// transaction it is inside of (PGlite has one connection; see notifications.test.ts). So `send`
// defers to after the transaction commits, and runs at once when none is open.
import { allowed } from "@proof/api"
import { queueAfterTransactionHook } from "@better-auth/core/context"
import type { DeliveryRule } from "@byo-oss/notifications"

import { type Permissions, rolePermissions, roles, type RoleName } from "./permissions"

/** The organization an event is about: its id (the stamp), its slug (hrefs) and its name (copy). */
export interface OrgRef {
  id: string
  slug: string
  name: string
}

interface InOrg {
  org: OrgRef
}

/** A run's starter may be a person (a session) or an API key; only a person gets a notice. */
type RunStarter = string | null

/**
 * The events. Each names what it is about; `recipientsOf` decides who hears it and `renderNotification`
 * says what they read. Org-scoped events carry `org`; personal ones (`account.*`, `member.removed`) don't.
 */
export type NotificationEvent =
  | ({
      type: "approval.requested"
      agentName: string
      action: string
      runId: string
      /** The person who asked (a session); an agent's own request excludes nobody. */
      requesterUserId?: string
    } & InOrg)
  | ({
      type: "approval.decided"
      decision: "approved" | "denied"
      action: string
      runId: string
      deciderUserId: string
      runStarterUserId: RunStarter
    } & InOrg)
  | ({
      type: "run.failed"
      agentName: string
      runId: string
      runStarterUserId: RunStarter
    } & InOrg)
  | ({ type: "run.done"; agentName: string; runId: string; runStarterUserId: RunStarter } & InOrg)
  | ({
      type: "member.joined"
      memberUserId: string
      memberName?: string
      actorUserId?: string
    } & InOrg)
  | ({ type: "member.role_changed"; memberUserId: string; role: string } & InOrg)
  | { type: "member.removed"; userId: string; organizationName: string }
  | {
      type: "invitation.received"
      userId: string
      invitationId: string
      organizationName: string
      inviterName?: string
    }
  | ({ type: "api_key.created"; keyName: string; actorUserId: string } & InOrg)
  | ({ type: "api_key.revoked"; keyName: string; actorUserId: string } & InOrg)
  | ({ type: "agent_access.revoked"; clientName: string; actorUserId?: string } & InOrg)
  | ({ type: "security.two_factor_reset"; memberUserId: string; actorUserId?: string } & InOrg)
  | ({ type: "billing.payment_failed" } & InOrg)
  | ({ type: "billing.subscription_canceled" } & InOrg)
  | ({ type: "usage.limit_reached"; limit: number } & InOrg)
  | { type: "account.password_changed"; userId: string }
  | { type: "account.two_factor_enabled"; userId: string }
  | { type: "account.two_factor_disabled"; userId: string }
  | { type: "account.passkey_added"; userId: string }
  | { type: "account.email_changed"; userId: string }
  // Support (support.ts). Staff events are stamped with the operator organization, whose members
  // are the support staff; `org` is that organization, never the ticket's.
  | ({
      type: "support.ticket.created"
      ticketId: string
      number?: number
      actorUserId?: string
    } & InOrg)
  | ({ type: "support.customer.replied"; ticketId: string; actorUserId?: string } & InOrg)
  | ({
      type: "support.agent.mentioned"
      ticketId: string
      memberUserId: string
      actorUserId?: string
    } & InOrg)
  /** To the requester: personal, so it survives their leaving the ticket's organization. */
  | { type: "support.agent.replied"; ticketId: string; userId: string; actorUserId?: string }

export type NotificationType = NotificationEvent["type"]

/**
 * The events that also email the person (@byo-oss/notifications delivery rules; docs/notifications.md). Types
 * not listed stay in-app.
 * - Security notices go out at once, even if read first: the email is the record, and it reaches
 *   the owner when someone else is in the account.
 * - The rest wait 15 minutes and are dropped if the notification was read or seen in the app. A
 *   person who isn't in the app (no bell poll in the last 2 minutes) gets them at once.
 * - Throttles cap the ones that can repeat: one email per person per window, the rest in-app only.
 */
export const NOTIFICATION_EMAIL_ROUTES = {
  "account.password_changed": [{ channel: "email", cancelIfRead: false }],
  "account.two_factor_disabled": [{ channel: "email", cancelIfRead: false }],
  "account.passkey_added": [{ channel: "email", cancelIfRead: false }],
  "security.two_factor_reset": [{ channel: "email", cancelIfRead: false }],
  "api_key.created": [{ channel: "email", cancelIfRead: false }],
  "billing.payment_failed": [
    { channel: "email", ifUnreadAfter: { minutes: 15 }, throttle: { hours: 24 } },
  ],
  "usage.limit_reached": [{ channel: "email", ifUnreadAfter: { minutes: 15 } }],
  "approval.requested": [
    { channel: "email", ifUnreadAfter: { minutes: 15 }, throttle: { hours: 1 } },
  ],
  "run.failed": [{ channel: "email", ifUnreadAfter: { minutes: 15 }, throttle: { hours: 1 } }],
} satisfies Partial<Record<NotificationType, DeliveryRule<"email">[]>>

/** An org-scoped event as an emitter writes it: the org's ref is filled in by the sender. */
export type OrgEventInput = NotificationEvent extends infer E
  ? E extends { org: OrgRef }
    ? Omit<E, "org">
    : never
  : never

/** The copy and link a notification shows. `type` is the event's type, stored as the row's type. */
export interface RenderedNotification {
  type: NotificationType
  title: string
  body?: string
  href?: string
  data?: Record<string, unknown>
}

/** Who a notification goes to. Organization fan-out is by role, from the catalog (see below). */
export type Recipients =
  | {
      kind: "members"
      organizationId: string
      roles: readonly RoleName[]
      excludeUserIds: readonly string[]
    }
  | { kind: "member"; organizationId: string; userId: string }
  | { kind: "person"; userId: string }

/** The body `auth.api.notify` takes (@byo-oss/notifications). */
export interface NotifyBody {
  userId?: string
  organizationId?: string
  roles?: string[]
  excludeUserIds?: string[]
  type: string
  title: string
  body?: string
  href?: string
  data?: Record<string, unknown>
}

/** `auth.api.notify`-shaped, so tests can pass a fake. */
export type NotifyFn = (options: { body: NotifyBody }) => Promise<unknown>

// ── Recipient rules, as permission sets from the catalog ──────────────────────────────────────────
// A role is in a rule when one of its grants covers the whole set (as `allowed` checks everywhere).
// Changing the catalog changes who hears these, with no emitter to update.

/** Who can approve a run (`run: approve`): owners, admins and members; viewers never. */
export const APPROVERS: Permissions = { run: ["approve"] }
/** Who manages members and their roles (owners and admins). */
export const MEMBER_MANAGERS: Permissions = { member: ["update"] }
/** Who manages API keys: create and revoke (owners and admins). */
export const KEY_MANAGERS: Permissions = { apiKey: ["create", "delete"] }
/** Who manages the subscription and its billing (owners and admins). */
export const BILLING_MANAGERS: Permissions = { subscription: ["update"] }
/** Support staff, in the operator organization: who can read the queue (owners, admins, members). */
export const SUPPORT_AGENTS: Permissions = { support: ["read"] }

/** A support ticket in the web app: the staff inbox (the admin console) and the requester's page. */
export const supportTicketPaths = {
  staff: (ticketId: string) => `/admin/support/${encodeURIComponent(ticketId)}`,
  requester: (ticketId: string) => `/account/support/${encodeURIComponent(ticketId)}`,
}

/** The roles whose grants cover `need`, derived from the catalog. Empty if no role does. */
export function rolesWith(need: Permissions): RoleName[] {
  return (Object.keys(roles) as RoleName[]).filter((role) => allowed(rolePermissions(role), need))
}

const orgFanOut = (
  organizationId: string,
  need: Permissions,
  excludeUserIds: readonly (string | undefined)[] = [],
): Recipients | null => {
  const rules = rolesWith(need)
  // An empty role list would reach every member (@byo-oss/notifications ignores `roles` when it is empty).
  if (rules.length === 0) return null
  return {
    kind: "members",
    organizationId,
    roles: rules,
    excludeUserIds: excludeUserIds.filter((id): id is string => !!id),
  }
}

/** Who hears an event, or null when nobody should (a decider who started the run, an empty audience). */
export function recipientsOf(event: NotificationEvent): Recipients | null {
  switch (event.type) {
    case "approval.requested":
      return orgFanOut(event.org.id, APPROVERS, [event.requesterUserId])
    case "approval.decided":
      if (!event.runStarterUserId || event.runStarterUserId === event.deciderUserId) return null
      return { kind: "member", organizationId: event.org.id, userId: event.runStarterUserId }
    case "run.failed":
      if (event.runStarterUserId) {
        return { kind: "member", organizationId: event.org.id, userId: event.runStarterUserId }
      }
      return orgFanOut(event.org.id, MEMBER_MANAGERS)
    case "run.done":
      if (!event.runStarterUserId) return null
      return { kind: "member", organizationId: event.org.id, userId: event.runStarterUserId }
    case "member.joined":
      return orgFanOut(event.org.id, MEMBER_MANAGERS, [event.memberUserId, event.actorUserId])
    case "member.role_changed":
      return { kind: "member", organizationId: event.org.id, userId: event.memberUserId }
    case "member.removed":
      return { kind: "person", userId: event.userId }
    case "api_key.created":
    case "api_key.revoked":
      return orgFanOut(event.org.id, KEY_MANAGERS, [event.actorUserId])
    case "agent_access.revoked":
      return orgFanOut(event.org.id, { apiKey: ["delete"] }, [event.actorUserId])
    case "security.two_factor_reset":
      return { kind: "member", organizationId: event.org.id, userId: event.memberUserId }
    case "billing.payment_failed":
    case "billing.subscription_canceled":
    case "usage.limit_reached":
      return orgFanOut(event.org.id, BILLING_MANAGERS)
    case "account.password_changed":
    case "account.two_factor_enabled":
    case "account.two_factor_disabled":
    case "account.passkey_added":
    case "account.email_changed":
    case "invitation.received":
      return { kind: "person", userId: event.userId }
    case "support.ticket.created":
    case "support.customer.replied":
      return orgFanOut(event.org.id, SUPPORT_AGENTS, [event.actorUserId])
    case "support.agent.mentioned":
      if (event.memberUserId === event.actorUserId) return null
      return { kind: "member", organizationId: event.org.id, userId: event.memberUserId }
    case "support.agent.replied":
      if (event.userId === event.actorUserId) return null
      return { kind: "person", userId: event.userId }
  }
}

// ── Rendering ─────────────────────────────────────────────────────────────────────────────────────

const orgHref = (org: OrgRef, path = "") => `/${org.slug}${path}`

/**
 * The title, body and link for an event. Titles are short and sentence case; the product word for a
 * workspace agent is "agent". Hrefs are web-app paths (see apps/app/src/routes).
 */
export function renderNotification(event: NotificationEvent): RenderedNotification {
  const type = event.type
  switch (event.type) {
    case "approval.requested":
      return {
        type,
        title: "Approval needed",
        body: `${event.agentName} wants to ${event.action}.`,
        href: orgHref(event.org, `/runs/${event.runId}`),
        data: { runId: event.runId },
      }
    case "approval.decided":
      return {
        type,
        // Sent when the person decides; the decision takes effect 30 seconds later and can be undone
        // until then, so the copy names the decision, not its outcome.
        title: event.decision === "approved" ? "Action approved" : "Action denied",
        body: `${event.action}. It takes effect 30 seconds after the decision unless it is undone.`,
        href: orgHref(event.org, `/runs/${event.runId}`),
        data: { runId: event.runId, decision: event.decision },
      }
    case "run.failed":
      return {
        type,
        title: "Run failed",
        body: `${event.agentName} stopped with an error.`,
        href: orgHref(event.org, `/runs/${event.runId}`),
        data: { runId: event.runId },
      }
    case "run.done":
      return {
        type,
        title: "Run finished",
        body: `${event.agentName} finished its work.`,
        href: orgHref(event.org, `/runs/${event.runId}`),
        data: { runId: event.runId },
      }
    case "member.joined":
      return {
        type,
        title: "New member",
        body: `${event.memberName ?? "Someone"} joined ${event.org.name}.`,
        href: orgHref(event.org, "/settings/members"),
        data: { userId: event.memberUserId },
      }
    case "member.role_changed":
      return {
        type,
        title: "Your role changed",
        body: `You're now ${event.role} in ${event.org.name}.`,
        href: orgHref(event.org),
      }
    case "member.removed":
      return {
        type,
        title: "Access removed",
        body: `You were removed from ${event.organizationName} and no longer have access to it.`,
      }
    case "api_key.created":
      return {
        type,
        title: "API key created",
        body: `${event.keyName} can act in ${event.org.name} with the permissions it was given.`,
        href: orgHref(event.org, "/settings/api-keys"),
      }
    case "api_key.revoked":
      return {
        type,
        title: "API key revoked",
        body: `${event.keyName} can no longer act in ${event.org.name}.`,
        href: orgHref(event.org, "/settings/api-keys"),
      }
    case "agent_access.revoked":
      return {
        type,
        title: "Agent access revoked",
        body: `${event.clientName} can no longer act in ${event.org.name}.`,
        href: orgHref(event.org, "/settings/api-keys"),
      }
    case "security.two_factor_reset":
      return {
        type,
        title: "Two-factor sign-in was turned off",
        body: `An owner of ${event.org.name} reset your two-factor sign-in. Set it up again from your security settings.`,
        href: "/account/security",
      }
    case "billing.payment_failed":
      return {
        type,
        title: "Payment failed",
        body: `The latest payment for ${event.org.name} didn't go through.`,
        href: orgHref(event.org, "/settings/billing"),
      }
    case "billing.subscription_canceled":
      return {
        type,
        title: "Subscription canceled",
        body: `The subscription for ${event.org.name} has ended.`,
        href: orgHref(event.org, "/settings/billing"),
      }
    case "usage.limit_reached":
      return {
        type,
        title: "Daily request limit reached",
        body: `${event.org.name} reached its limit of ${event.limit} requests today. Calls resume tomorrow (UTC).`,
        href: orgHref(event.org, "/settings/billing"),
        data: { limit: event.limit },
      }
    case "account.password_changed":
      return {
        type,
        title: "Password changed",
        body: "If this wasn't you, reset your password and review your sessions.",
        href: "/account/security",
      }
    case "account.two_factor_enabled":
      return {
        type,
        title: "Two-factor sign-in is on",
        body: "Your account now asks for a second factor when you sign in.",
        href: "/account/security",
      }
    case "account.two_factor_disabled":
      return {
        type,
        title: "Two-factor sign-in is off",
        body: "Your account no longer asks for a second factor. If this wasn't you, sign in and turn it back on.",
        href: "/account/security",
      }
    case "account.passkey_added":
      return {
        type,
        title: "Passkey added",
        body: "A passkey was added to your account. If this wasn't you, remove it and review your sessions.",
        href: "/account/security",
      }
    case "account.email_changed":
      return {
        type,
        title: "Sign-in email changed",
        body: "Your sign-in email was changed. If this wasn't you, reset your password.",
        href: "/account/profile",
      }
    case "invitation.received":
      return {
        type,
        title: "Invitation to join",
        body: `${event.inviterName ?? "Someone"} invited you to join ${event.organizationName}.`,
        href: `/accept-invitation/${event.invitationId}`,
        data: { invitationId: event.invitationId },
      }
    case "support.ticket.created":
      return {
        type,
        title: "New support ticket",
        body: event.number === undefined ? undefined : `Ticket #${event.number} is waiting.`,
        href: supportTicketPaths.staff(event.ticketId),
        data: { ticketId: event.ticketId },
      }
    case "support.customer.replied":
      return {
        type,
        title: "Customer replied",
        body: "A customer replied to a support ticket.",
        href: supportTicketPaths.staff(event.ticketId),
        data: { ticketId: event.ticketId },
      }
    case "support.agent.mentioned":
      return {
        type,
        title: "You were mentioned",
        body: "A teammate mentioned you on a support ticket.",
        href: supportTicketPaths.staff(event.ticketId),
        data: { ticketId: event.ticketId },
      }
    case "support.agent.replied":
      return {
        type,
        title: "New reply to your support ticket",
        href: supportTicketPaths.requester(event.ticketId),
        data: { ticketId: event.ticketId },
      }
  }
}

/** The `auth.api.notify` body for an event's recipients and rendered copy. */
export function notifyBodyOf(recipients: Recipients, rendered: RenderedNotification): NotifyBody {
  const copy = {
    type: rendered.type,
    title: rendered.title,
    body: rendered.body,
    href: rendered.href,
    data: rendered.data,
  }
  switch (recipients.kind) {
    case "members":
      return {
        ...copy,
        organizationId: recipients.organizationId,
        roles: [...recipients.roles],
        excludeUserIds: [...recipients.excludeUserIds],
      }
    case "member":
      return { ...copy, organizationId: recipients.organizationId, userId: recipients.userId }
    case "person":
      return { ...copy, userId: recipients.userId }
  }
}

// ── Sending ───────────────────────────────────────────────────────────────────────────────────────

export interface NotifierOptions {
  notify: NotifyFn
  /** Called with every failure. Never throws to the caller of `send`. */
  onError: (error: Error, event: NotificationEvent) => void
}

export interface Notifier {
  /**
   * Send an event to its recipients. Never rejects: a failure (no members, a person not in the
   * organization, the endpoint down) goes to `onError`. Inside a better-auth transaction the send runs
   * after the transaction commits, and is dropped if it rolls back.
   */
  send(event: NotificationEvent): Promise<void>
}

const toError = (error: unknown) => (error instanceof Error ? error : new Error(String(error)))

export function createNotifier(options: NotifierOptions): Notifier {
  const report = (error: unknown, event: NotificationEvent) => {
    try {
      options.onError(toError(error), event)
    } catch {
      // A broken reporter must not fail the request that caused the event.
    }
  }
  const deliver = async (event: NotificationEvent) => {
    const recipients = recipientsOf(event)
    if (!recipients) return
    await options.notify({ body: notifyBodyOf(recipients, renderNotification(event)) })
  }
  return {
    async send(event) {
      try {
        await queueAfterTransactionHook(() => deliver(event), {
          onError: (error) => report(error, event),
        })
      } catch (error) {
        report(error, event)
      }
    },
  }
}
