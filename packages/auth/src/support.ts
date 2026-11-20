// Customer support (@byo-oss/support), mounted in createAuth (index.ts) after organization(). The
// operator organization's members are the support staff: their roles' `support` actions (access.ts)
// decide what they may do. Everyone else is a customer, with their own tickets.
//
// What this file adds to the package's defaults:
//   - acceptSupportSession: cookie sessions only. A request that also carries an API key or a bearer
//     token, and an impersonated session, are refused (403 SESSION_NOT_ACCEPTED).
//   - supportMailer: thread mail on the same SES path as the auth emails (the dev mail sink under
//     DEV_MAIL_SINK, the fake SES in tests).
//   - supportEvents: support events become notifications, only through the catalog
//     (notifications.ts). An internal note never reaches a customer.
//   - inbound: Wraps (wrapsInbound) or any raw relay (rawRelay), whichever the config names.
import { type ByoEvent, type ByoEventHandler, createEventBus } from "@byo-oss/core"
import type { Mailer } from "@byo-oss/mailer"
import { type DkimResolver, type SupportOptions, rawRelay, support } from "@byo-oss/support"
import { wrapsInbound } from "@byo-oss/support/wraps"
import type { WrapsSesOptions } from "@wraps.dev/better-auth"
import { reportError } from "@proof/errors"

import { authMailer } from "./mailer"
import { isImpersonated } from "./guards"
import type { NotificationHooks } from "./notify-hooks"
import { supportTicketPaths } from "./notifications"

/** Support's settings, from the environment (apps/api/src/server.ts). Everything is optional. */
export interface SupportConfig {
  /**
   * The organization whose members are the support staff: OPERATOR_ORGANIZATION_ID. Unset, nobody
   * is an agent (every agent endpoint answers 403); customers can still open tickets.
   */
  staffOrganizationId?: string
  /**
   * Thread mail: agent replies are mailed to the requester, `Reply-To` support+<token>@replyDomain.
   * Unset, nothing is mailed.
   */
  email?: {
    /** The sender, verified in SES. */
    from: string
    /** The domain replies come back on (a domain, not an address). */
    replyDomain: string
    /** The web app's origin, for the ticket link. */
    appUrl: string
    /** Delay before a reply is mailed, in ms (support's default: 2 minutes). Tests pass 0. */
    replyDelay?: number
  }
  /**
   * Inbound mail at POST /api/auth/support/inbound, from one source. Needs `email`. Unset, the
   * endpoint answers 404.
   */
  inbound?: (WrapsInboundConfig | RelayInboundConfig) & {
    /**
     * DNS TXT lookups for the DKIM check that decides whether a reply may thread. Tests serve a key
     * of their own here. Unset, the system resolver (production).
     */
    resolver?: DkimResolver
  }
}

/** Wraps inbound mail: SES to S3, an EventBridge event posted with X-Wraps-Inbound-Key. */
export interface WrapsInboundConfig {
  key: string
  bucket: string
  region: string
  /** An S3 client; tests pass a fake. Unset, one is made from `region` and the AWS chain. */
  client?: { send(command: unknown): Promise<unknown> }
}

/**
 * Any relay that POSTs the raw message (message/rfc822) with `Authorization: Bearer <secret>`:
 * Postmark, Mailgun, a Cloudflare Email Worker (support's rawRelay).
 */
export interface RelayInboundConfig {
  secret: string
}

/** Headers that carry an API key or an OAuth token. Support is for cookie sessions only. */
const CREDENTIAL_HEADERS = ["authorization", "x-api-key"] as const

/**
 * Which sessions may use support: a cookie session, with no API key or bearer token beside it, that
 * no admin is impersonating. This app has no bearer plugin and API keys make no session, so a key
 * or token alone already has no session (401); this refuses one sent next to a cookie (403).
 */
export const acceptSupportSession: NonNullable<SupportOptions["acceptSession"]> = ({
  session,
  headers,
}) => !CREDENTIAL_HEADERS.some((name) => headers.has(name)) && !isImpersonated(session)

/** Thread mail through `authMailer` (mailer.ts), on the auth emails' SES options. */
export function supportMailer({ from, ses }: { from: string; ses?: WrapsSesOptions }): Mailer {
  return authMailer({ from, ses })
}

const stringOf = (value: unknown) => (typeof value === "string" && value ? value : undefined)

/**
 * Routes support events to notifications, through the catalog:
 *   - staff (the operator organization's members with `support: read`): a new ticket, a customer
 *     reply, and an @mention (to the agent mentioned);
 *   - the requester: an agent's reply, as a personal notification.
 * Nothing else is sent. `support.note.added` (an internal note) is never routed: it has no
 * requester, and it must not reach a customer. Nothing fans out to the ticket's own organization
 * (`event.organizationId`): a private ticket's events carry it too. A fan-out to it would have to
 * skip `data.visibility === "private"`.
 */
export function supportEvents({
  staffOrganizationId,
  notifications,
}: {
  staffOrganizationId?: string
  notifications: Pick<NotificationHooks, "inOrg" | "personal">
}): (event: ByoEvent) => Promise<void> {
  return async (event) => {
    const ticketId = event.subject.id
    const actorUserId = event.actorId ?? undefined
    switch (event.type) {
      case "support.ticket.created":
      case "support.customer.replied": {
        if (!staffOrganizationId) return
        const number = typeof event.data.number === "number" ? event.data.number : undefined
        await notifications.inOrg(
          staffOrganizationId,
          event.type === "support.ticket.created"
            ? { type: event.type, ticketId, number, actorUserId }
            : { type: event.type, ticketId, actorUserId },
        )
        return
      }
      case "support.agent.mentioned": {
        const memberUserId = stringOf(event.userId)
        if (!staffOrganizationId || !memberUserId) return
        await notifications.inOrg(staffOrganizationId, {
          type: event.type,
          ticketId,
          memberUserId,
          actorUserId,
        })
        return
      }
      case "support.agent.replied": {
        const userId = stringOf(event.userId)
        // An account-less requester (someone who only emailed) has no user to notify.
        if (!userId) return
        await notifications.personal({ type: event.type, ticketId, userId, actorUserId })
        return
      }
      default:
        // support.note.added and the rest: no notification.
        return
    }
  }
}

export interface SupportPluginDeps {
  config: SupportConfig
  /** The auth emails' SES options (index.ts `ses`): thread mail goes the same way. */
  ses?: WrapsSesOptions
  notifications: Pick<NotificationHooks, "inOrg" | "personal">
  /**
   * A failing event consumer. The request that caused the event still succeeds. Defaults to
   * reportError (the notifier reports its own send failures).
   */
  onEventError?: (error: unknown, event: ByoEvent) => void
}

const reportEventError = (error: unknown, event: ByoEvent) => {
  reportError(error, { supportEvent: event.type })
}

/** Support's options for this app, from its config. */
export function supportOptions({
  config,
  ses,
  notifications,
  onEventError = reportEventError,
}: SupportPluginDeps): SupportOptions {
  const { staffOrganizationId, email, inbound } = config
  const onEvent: ByoEventHandler = createEventBus(
    [supportEvents({ staffOrganizationId, notifications })],
    { onError: (error, event) => onEventError(error, event) },
  )
  return {
    // Unset: nobody is an agent, on purpose (null), so support doesn't warn at boot in every
    // instance that runs without one (tests, apps that don't use support yet).
    staffOrganizationId: staffOrganizationId ?? null,
    acceptSession: acceptSupportSession,
    onEvent,
    ...(email && {
      mailer: supportMailer({ from: email.from, ses }),
      email: {
        from: email.from,
        replyDomain: email.replyDomain,
        appUrl: email.appUrl,
        ticketPath: supportTicketPaths.requester,
        ...(email.replyDelay !== undefined && { replyDelay: email.replyDelay }),
      },
    }),
    ...(email &&
      inbound && {
        inbound: {
          source:
            "secret" in inbound
              ? rawRelay({ secret: inbound.secret })
              : wrapsInbound({
                  key: inbound.key,
                  bucket: inbound.bucket,
                  region: inbound.region,
                  client: inbound.client,
                }),
          ...(inbound.resolver && { resolver: inbound.resolver }),
        },
      }),
  }
}

/** The support plugin for this app. */
export const supportPlugin = (deps: SupportPluginDeps) => support(supportOptions(deps))
