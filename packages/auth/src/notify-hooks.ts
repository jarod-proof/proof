// Where better-auth's own events become notifications: the organization, API key, account security and
// billing events that the auth layer sees (the product's operations emit theirs through apps/api).
//
// Every send goes through the notifier (notifications.ts), which never throws and defers until the
// transaction it runs in commits. The lookups here (the organization's ref, a key's row) can throw, so
// they are wrapped and reported: a notification must never fail the request that caused it.
import type { BetterAuthPlugin } from "better-auth"
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api"

import { type Adapter, findMember } from "./membership"
import type {
  Notifier,
  NotificationEvent,
  NotificationType,
  OrgEventInput,
  OrgRef,
} from "./notifications"

/** The events about one person, with no organization. */
export type PersonalEvent = Exclude<NotificationEvent, { org: OrgRef }>

export interface NotificationHooksOptions {
  notifier: Notifier
  /** The adapter of the current transaction (see index.ts). */
  adapter: () => Promise<Adapter>
  /** Reports a failure in a lookup. Sends report their own failures through the notifier. */
  onError: (error: unknown, type: NotificationType) => void
}

export interface NotificationHooks {
  /** Sends an event about one of the organization's members or resources. */
  inOrg(organizationId: string, event: OrgEventInput): Promise<void>
  /** Sends an event about one person (account security, removal from an organization). */
  personal(event: PersonalEvent): Promise<void>
  /** Member removed: the removal notice to them, unless they removed themselves (see `takeSelfRemoval`). */
  memberRemoved(input: {
    userId: string
    organizationId: string
    organizationName: string
  }): Promise<void>
  /**
   * An invitation to someone who already has an account: a personal notice linking to it. Nothing
   * for a new address (the invitation email is the only way to reach them).
   */
  invitationReceived(input: {
    email: string
    invitationId: string
    organizationName: string
    inviterName?: string
  }): Promise<void>
  /** A billing event for the organization whose Stripe customer this is (organization.stripeCustomerId). */
  billing(stripeCustomerId: string, kind: "payment_failed" | "subscription_canceled"): Promise<void>
  /** True once per self-removal (a member removing themselves through remove-member, i.e. leaving). */
  takeSelfRemoval(userId: string, organizationId: string): boolean
  /** The `hooks` registered on the auth instance (see index.ts). */
  plugin: BetterAuthPlugin
}

/** A key the API key delete removes: its organization, name and who asked. */
interface PendingRevoke {
  organizationId: string
  keyName: string
  actorUserId: string
}

const selfKey = (organizationId: string, userId: string) => `${organizationId}:${userId}`

/** The body of a better-auth request, read loosely (the hooks run before its schema is applied). */
const bodyOf = (ctx: { body?: unknown }) => (ctx.body ?? {}) as Record<string, unknown>
const stringField = (body: Record<string, unknown>, field: string) => {
  const value = body[field]
  return typeof value === "string" && value.length > 0 ? value : null
}

export function notificationHooks(options: NotificationHooksOptions): NotificationHooks {
  const { notifier, adapter, onError } = options
  const selfRemovals = new Set<string>()
  const pendingRevokes = new Map<string, PendingRevoke>()

  const report = (error: unknown, type: NotificationType) => {
    try {
      onError(error, type)
    } catch {
      // A broken reporter must not fail the request either.
    }
  }

  const orgRef = async (db: Adapter, organizationId: string): Promise<OrgRef | null> => {
    const org = await db.findOne<{ id: string; name: string; slug: string | null }>({
      model: "organization",
      where: [{ field: "id", value: organizationId }],
    })
    if (!org) return null
    // Organization slugs are required by the app (see index.ts); the id is only a fallback for a row without one.
    return { id: org.id, slug: org.slug ?? org.id, name: org.name }
  }

  const inOrg = async (organizationId: string, event: OrgEventInput) => {
    try {
      const ref = await orgRef(await adapter(), organizationId)
      // A vanished organization has no one left to tell.
      if (!ref) return
      await notifier.send({ ...event, org: ref })
    } catch (error) {
      report(error, event.type)
    }
  }

  const personal = async (event: PersonalEvent) => {
    try {
      await notifier.send(event)
    } catch (error) {
      report(error, event.type)
    }
  }

  const billing = async (
    stripeCustomerId: string,
    kind: "payment_failed" | "subscription_canceled",
  ) => {
    const type =
      kind === "payment_failed" ? "billing.payment_failed" : "billing.subscription_canceled"
    try {
      const org = await (await adapter()).findOne<{ id: string }>({
        model: "organization",
        where: [{ field: "stripeCustomerId", value: stripeCustomerId }],
      })
      if (!org) return
      await inOrg(
        org.id,
        kind === "payment_failed"
          ? { type: "billing.payment_failed" }
          : { type: "billing.subscription_canceled" },
      )
    } catch (error) {
      report(error, type)
    }
  }

  const invitationReceived: NotificationHooks["invitationReceived"] = async ({
    email,
    invitationId,
    organizationName,
    inviterName,
  }) => {
    try {
      const invitee = await (await adapter()).findOne<{ id: string }>({
        model: "user",
        where: [{ field: "email", value: email.toLowerCase() }],
      })
      if (!invitee) return
      await personal({
        type: "invitation.received",
        userId: invitee.id,
        invitationId,
        organizationName,
        inviterName,
      })
    } catch (error) {
      report(error, "invitation.received")
    }
  }

  const memberRemoved: NotificationHooks["memberRemoved"] = async ({
    userId,
    organizationId,
    organizationName,
  }) => {
    // Removing yourself is leaving: no notice to yourself (the rows are dropped either way).
    if (takeSelfRemoval(userId, organizationId)) return
    await personal({ type: "member.removed", userId, organizationName })
  }

  function takeSelfRemoval(userId: string, organizationId: string) {
    return selfRemovals.delete(selfKey(organizationId, userId))
  }

  // ── Plugin hooks: the paths whose outcome or actor the organization hooks don't carry ────────────

  const plugin = {
    id: "proof-notifications",
    hooks: {
      before: [
        {
          // Records a member removing themselves, so the removal doesn't notify them. Keyed by the
          // organization and the person; `after` clears the key whatever the outcome.
          matcher: (ctx: { path?: string }) => ctx.path === "/organization/remove-member",
          handler: createAuthMiddleware(async (ctx) => {
            const session = await getSessionFromCtx(ctx)
            const body = bodyOf(ctx)
            const target = stringField(body, "memberIdOrEmail")
            const organizationId =
              stringField(body, "organizationId") ?? session?.session.activeOrganizationId
            if (!session || !target || !organizationId) return
            try {
              const own = await findMember(await adapter(), session.user.id, organizationId)
              if (own && (target === own.id || target === session.user.email)) {
                selfRemovals.add(selfKey(organizationId, session.user.id))
              }
            } catch (error) {
              report(error, "member.removed")
            }
          }),
        },
        {
          // A key's row is gone once it is deleted, so its organization and name are read first.
          matcher: (ctx: { path?: string }) => ctx.path === "/api-key/delete",
          handler: createAuthMiddleware(async (ctx) => {
            const session = await getSessionFromCtx(ctx)
            const keyId = stringField(bodyOf(ctx), "keyId")
            if (!session || !keyId) return
            try {
              const key = await (await adapter()).findOne<{
                referenceId: string
                name: string | null
              }>({
                model: "apikey",
                where: [{ field: "id", value: keyId }],
              })
              if (key) {
                pendingRevokes.set(keyId, {
                  organizationId: key.referenceId,
                  keyName: key.name ?? "Unnamed key",
                  actorUserId: session.user.id,
                })
              }
            } catch (error) {
              report(error, "api_key.revoked")
            }
          }),
        },
      ],
      after: [
        {
          matcher: (ctx: { path?: string }) => ctx.path === "/organization/remove-member",
          handler: createAuthMiddleware(async (ctx) => {
            const session = await getSessionFromCtx(ctx)
            const organizationId =
              stringField(bodyOf(ctx), "organizationId") ?? session?.session.activeOrganizationId
            if (session && organizationId)
              selfRemovals.delete(selfKey(organizationId, session.user.id))
          }),
        },
        {
          // A role change: the member hears about it, unless they made it themselves.
          matcher: (ctx: { path?: string }) => ctx.path === "/organization/update-member-role",
          handler: createAuthMiddleware(async (ctx) => {
            if (!successful(ctx)) return
            const session = await getSessionFromCtx(ctx)
            const memberId = stringField(bodyOf(ctx), "memberId")
            if (!session || !memberId) return
            try {
              const member = await (await adapter()).findOne<{
                organizationId: string
                userId: string
                role: string
              }>({
                model: "member",
                where: [{ field: "id", value: memberId }],
              })
              if (!member || member.userId === session.user.id) return
              await inOrg(member.organizationId, {
                type: "member.role_changed",
                memberUserId: member.userId,
                role: member.role,
              })
            } catch (error) {
              report(error, "member.role_changed")
            }
          }),
        },
        {
          // Sent after a person changes their own password (reset emails are handled by onPasswordReset).
          matcher: (ctx: { path?: string }) => ctx.path === "/change-password",
          handler: createAuthMiddleware(async (ctx) => {
            if (!successful(ctx)) return
            const session = await getSessionFromCtx(ctx)
            if (session)
              await personal({ type: "account.password_changed", userId: session.user.id })
          }),
        },
        {
          matcher: (ctx: { path?: string }) => ctx.path === "/passkey/verify-registration",
          handler: createAuthMiddleware(async (ctx) => {
            if (!successful(ctx)) return
            const session = await getSessionFromCtx(ctx)
            if (session) await personal({ type: "account.passkey_added", userId: session.user.id })
          }),
        },
        {
          matcher: (ctx: { path?: string }) => ctx.path === "/api-key/create",
          handler: createAuthMiddleware(async (ctx) => {
            if (!successful(ctx)) return
            const session = await getSessionFromCtx(ctx)
            const body = bodyOf(ctx)
            // The web app's provisional key (signup.ts) is made for a person who has not claimed the account.
            const metadata = body.metadata as { provisional?: unknown } | undefined
            if (metadata?.provisional === true) return
            const organizationId = stringField(body, "organizationId")
            const actorUserId = session?.user.id ?? stringField(body, "userId")
            if (!organizationId || !actorUserId) return
            await inOrg(organizationId, {
              type: "api_key.created",
              keyName: stringField(body, "name") ?? "Unnamed key",
              actorUserId,
            })
          }),
        },
        {
          matcher: (ctx: { path?: string }) => ctx.path === "/api-key/delete",
          handler: createAuthMiddleware(async (ctx) => {
            const keyId = stringField(bodyOf(ctx), "keyId")
            const pending = keyId ? pendingRevokes.get(keyId) : undefined
            if (!keyId) return
            pendingRevokes.delete(keyId)
            if (!pending || !successful(ctx)) return
            await inOrg(pending.organizationId, {
              type: "api_key.revoked",
              keyName: pending.keyName,
              actorUserId: pending.actorUserId,
            })
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin

  return {
    inOrg,
    billing,
    personal,
    invitationReceived,
    memberRemoved,
    takeSelfRemoval,
    plugin,
  }
}

/** True when the endpoint answered without an error (an after hook runs for refused requests too). */
function successful(ctx: { context: { returned?: unknown } }): boolean {
  return !(ctx.context.returned instanceof APIError)
}
