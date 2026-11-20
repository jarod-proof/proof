import { allowed } from "@proof/api"
import { cimd } from "@better-auth/cimd"
import { fetchClientMetadataResource } from "@better-auth/cimd/node"
import { apiKey } from "@better-auth/api-key"
import { type ClientMetadataResourceFetch, oauthProvider } from "@better-auth/oauth-provider"
import { passkey } from "@better-auth/passkey"
import { scim } from "@better-auth/scim"
import { sso } from "@better-auth/sso"
import { stripe } from "@better-auth/stripe"
import type { Database } from "@proof/db"
import * as schema from "@proof/db/schema"
import { createLogger } from "@proof/logger"
import { type AuthWithContext, deleteMemberData, inbox } from "@byo-oss/notifications"
import { createEntitlements, deleteOrganizationData } from "@byo-oss/entitlements"
import { stripePlans } from "@byo-oss/entitlements/stripe"
import { type WrapsSesOptions, wraps } from "@wraps.dev/better-auth"
import { reportError } from "@proof/errors"
import Stripe from "stripe"
import {
  type BetterAuthPlugin,
  type DBTransactionAdapter,
  betterAuth,
  getCurrentAdapter,
} from "better-auth"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api"
import {
  admin,
  haveIBeenPwned,
  jwt,
  lastLoginMethod,
  magicLink,
  organization,
  twoFactor,
} from "better-auth/plugins"
import { authEvents, type AuthEvent } from "./auth-events"
import { PASSWORD_COMPROMISED_MESSAGE } from "./constants"
import { type DeviceInterval, deviceAuthorizationPlugin } from "./device"
import {
  assertSeatAvailable,
  catalog,
  type EntitlementsConfig,
  entitlementsPlugin,
  type PlanEntitlements,
  seatsTaken,
  takesNewSeat,
  takesSeat,
} from "./entitlements"
import { impersonationGuard } from "./guards"
import { FRESH_AGE_SECONDS, freshSessionGuard } from "./fresh-session"
import { endGrantsOnLeave, revokeGrantsWith, revokeMemberGrants } from "./member-grants"
import {
  type Adapter,
  findMember,
  firstMembership,
  PERSONAL_SLUG_PREFIX,
  personalOrganization,
} from "./membership"
import {
  accountPlugin,
  assertCanDelete,
  changeRequestOf,
  removePersonalOrganization,
} from "./account-plugin"
import { type LoginContext, signInOf } from "./login-method"
import { createNotices } from "./notices"
import { notificationEmailChannel, withDeliveryIndexes } from "./notification-email"
import {
  NOTIFICATION_EMAIL_ROUTES,
  type NotificationType,
  type NotifyFn,
  createNotifier,
} from "./notifications"
import { type NotificationHooks, notificationHooks } from "./notify-hooks"
import { securitySummaryPlugin } from "./security-summary"
import { signInMethodsOf, signInMethodsPlugin } from "./sign-in-methods"
import { canManageBilling, ownerOnlyGuard } from "./owner-only"
import { uploadFieldGuard } from "./upload-fields"
import { ac, OAUTH_SCOPES, roles, rolePermissions } from "./permissions"
import { isReservedOrgSlug, slugOf } from "./reserved-slugs"
import { twoFactorMagicLink } from "./magic-link-two-factor"
import { passkeySignupPlugin } from "./passkey-signup"
import { type AuthRateLimitOptions, authIpAddress, authRateLimit } from "./rate-limit"
import { resumeMagicLinkAuthorization } from "./resume"
import { endProvisionalKeys } from "./signup"
import { scimProjection } from "./scim-projection"
import { type SupportConfig, supportPlugin } from "./support"
import {
  type ScimConnection,
  type ScimConnectionInput,
  type ScimManagement,
  endScimTokensOf,
  scimCredentialHashSecret,
  scimTokenPlugin,
} from "./scim-token"

export { DEVICE_VERIFICATION_PATH } from "./device"
export {
  IMPERSONATION_ALLOWED_PATHS,
  IMPERSONATION_READ_GET_PATHS,
  IMPERSONATION_REFUSED_GET_PATHS,
} from "./guards"
export { isReservedOrgSlug, RESERVED_ORG_SLUGS } from "./reserved-slugs"
export { isClaimed, type ProvisionalSignup, provisionalSignup } from "./signup"
export { parseStripePlans, type StripePlanConfig } from "./stripe-plans"
// Everything entitlements stores for an organization, as JSON pages (support exports, migrations).
export { exportEntitlementsData } from "@byo-oss/entitlements"
export {
  acceptEntitlementsSession,
  type EntitlementsConfig,
  PLAN_LIMIT_CODE,
  type PlanEntitlements,
} from "./entitlements"
export { type SignInMethods, type SocialProvider } from "./sign-in-methods"
export {
  type AuthEvent,
  type AuthEventName,
  AUTH_EVENT_NAMES,
} from "./auth-events"
export { FRESH_AGE_SECONDS, FRESH_SESSION_PATHS, freshSessionGuard, isFresh } from "./fresh-session"
export { type AuthRateLimitOptions, CLIENT_IP_HEADER } from "./rate-limit"

/** Where better-auth's routes are mounted; the OAuth issuer is `${baseURL}${AUTH_BASE_PATH}`. */
export const AUTH_BASE_PATH = "/api/auth"

export { PASSWORD_COMPROMISED_CODE, PASSWORD_COMPROMISED_MESSAGE } from "./constants"

/** Every API key starts with this, so a bearer token can be routed without a lookup. */
export const API_KEY_PREFIX = "sk_"

// Warnings from auth hooks that have no request to answer (SCIM deprovisioning kept an owner).
const logger = createLogger({ name: "auth" })

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"])

const isLoopbackHttp = (uri: unknown) => {
  try {
    const url = new URL(String(uri))
    return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)
  } catch {
    return false
  }
}

/**
 * Local MCP clients (Claude Code, Cursor, the MCP SDK) register with an http://localhost callback
 * but don't send `application_type`, which defaults to "web" and makes the provider reject them.
 * Loopback-only redirects mean a native app (RFC 8252), so default those to "native".
 */
const nativeLoopbackRegistration = createAuthMiddleware(async (ctx) => {
  if (ctx.path !== "/oauth2/register") return
  const body = ctx.body as { application_type?: string; redirect_uris?: unknown } | undefined
  const uris = body?.redirect_uris
  if (!body || body.application_type || !Array.isArray(uris) || uris.length === 0) return
  if (!uris.every(isLoopbackHttp)) return
  return { context: { body: { ...body, application_type: "native" } } }
})

export interface AuthOptions {
  db: Database
  secret: string
  baseURL: string
  /**
   * Origins the web app is served from when that is not the API's own origin (`pnpm dev`, where vite
   * runs on its own portless URL; the e2e stack on another port). Trusted for `callbackURL`/`redirectTo`
   * and origin checks, and allowed for passkey ceremonies. Empty in production, where apps/api serves
   * the web app from `baseURL`. Each one is a bare origin (scheme, host, port), see WEB_ORIGINS.
   */
  webOrigins?: string[]
  /** "Name <addr@domain>" — sender for auth emails. */
  emailFrom: string
  appName?: string
  /** Wraps API key: syncs signups to Wraps contacts. Omit to disable. */
  wrapsApiKey?: string
  /**
   * App pages the OAuth flow sends people to. Defaults: `/sign-in`, `/consent`, and
   * `/select-organization` (shown when the user belongs to several orgs; it sets the active org,
   * then POSTs `/oauth2/continue` with `{ postLogin: true }`).
   */
  oauthPages?: { login?: string; consent?: string; selectOrganization?: string }
  /** Protected resources OAuth tokens are issued for (RFC 8707), e.g. `${baseURL}/mcp`. */
  oauthResources?: string[]
  /**
   * Fetch for Client ID Metadata Documents (CIMD). Defaults to the SSRF-safe Node transport
   * (public addresses only, connection pinned, no redirects). Only a test overrides it.
   */
  clientMetadataFetch?: ClientMetadataResourceFetch
  /**
   * Per-key request limit. better-auth's default is 10 per day, which one agent session exhausts.
   * Defaults to 600 per minute; `false` turns it off (e.g. when a gateway rate-limits instead).
   */
  apiKeyRateLimit?: { timeWindow: number; maxRequests: number } | false
  /** Device-grant minimum poll interval (e.g. "5s"). Tests use a short one; the default is 5s. */
  deviceInterval?: DeviceInterval
  /** Passed to `WrapsEmail` for auth emails (`client`, `region`, `roleArn`, ...); tests inject a fake. */
  ses?: WrapsSesOptions
  /** Called when an auth email fails to send. Sends never block the auth flow. */
  onEmailError?: (error: Error) => void
  /** GitHub OAuth app. The sign-in button is offered only when both values are set. */
  github?: { clientId: string; clientSecret: string }
  /** Google OAuth client. Offered only when both values are set. */
  google?: { clientId: string; clientSecret: string }
  /**
   * Check new and changed passwords against Have I Been Pwned (sends a 5-character hash prefix).
   * Off by default so tests make no network calls; server.ts turns it on.
   */
  passwordBreachCheck?: boolean
  /**
   * Stripe billing, in test mode only: the secret key must be an `sk_test_` key (a live key is refused
   * here and in packages/env). Unset, the stripe plugin is not mounted at all. Plans are the app's own
   * (price ids from the Stripe test dashboard); none are invented. No plans means no subscriptions.
   */
  stripe?: { secretKey: string; webhookSecret: string; plans?: { name: string; priceId: string }[] }
  /**
   * Opt-in rate limits for better-auth's credential, mail and one-time-code endpoints, keyed on the
   * client address (apps/api sets it, see CLIENT_IP_HEADER). Unset or `false`: off, so library and
   * test callers see no 429s. server.ts passes `{}` for the defaults. Counts live in `rateLimit`.
   */
  rateLimit?: false | AuthRateLimitOptions
  /**
   * Called for each auth event (sign-in, failed sign-in, sign-out, factor and key changes; see
   * auth-events.ts). server.ts writes them to the audit trail. Errors are reported, never returned.
   */
  onAuthEvent?: (event: AuthEvent) => void | Promise<void>
  /**
   * Called when a notification could not be recorded (the flow that caused it still succeeds).
   * Defaults to reportError, which reports only 5xx and unexposed errors.
   */
  onNotificationError?: (error: unknown, type: NotificationType) => void
  /**
   * Called once per new account, by every sign-up path (email, social, passkey, provisional
   * signup), after its personal organization exists. server.ts counts it in analytics. Errors are
   * reported, never returned: a sign-up never fails for it.
   */
  onSignUp?: (event: { userId: string; organizationId: string }) => void
  /**
   * Called once an organization or a person has been deleted, after the row is gone: on
   * /organization/delete, and on every user delete (self-delete, its confirmation link, admin
   * removal). Self-delete also reports the personal organization it removed. server.ts sweeps their
   * files from the file store (file-sweep.ts). Errors are reported, never returned: the deletion has
   * already happened.
   */
  onDeleted?: (event: DeletedEvent) => void | Promise<void>
  /**
   * Customer support (@byo-oss/support, support.ts): the staff organization, thread mail and
   * inbound mail. Support is always mounted, so its tables and routes don't depend on the config;
   * unset, nobody is an agent and nothing is mailed.
   */
  support?: SupportConfig
  /**
   * Plan entitlements (@byo-oss/entitlements, entitlements.ts): the staff organization that manages
   * overrides and the unclaimed organizations' request limit. Always mounted; with Stripe and plans
   * the stripe plugin's subscriptions decide each organization's plan, else everyone is on Free.
   */
  entitlements?: EntitlementsConfig
}

/** What `onDeleted` reports: one organization, or one person. */
export type DeletedEvent = { organizationId: string } | { userId: string }

const defaultNotificationError = (error: unknown, type: NotificationType) => {
  reportError(error, { notification: type })
}

/**
 * Refuses a slug the app's paths use, and a personal organization's (`personal-<user id>`, see
 * membership.ts): those are only ever made at sign-up, so account deletion can tell the personal
 * organization apart. `current` is the organization's slug before an update, which may stay.
 */
const refuseReservedSlug = (slug: string, current?: string | null) => {
  const personal = slug.trim().toLowerCase().startsWith(PERSONAL_SLUG_PREFIX) && slug !== current
  if (isReservedOrgSlug(slug) || personal) {
    throw APIError.from("BAD_REQUEST", {
      message: "That address is reserved. Choose another organization URL.",
      code: "RESERVED_ORGANIZATION_SLUG",
    })
  }
}

/**
 * The passkey RP ID for these origins. One host, or the same host everywhere, is that host, so
 * production is unchanged. Otherwise it is the longest domain suffix all the hosts share, when that is
 * a real domain: at least two labels, or `localhost` (`api.localhost` and `web.localhost` give
 * `localhost`). IP addresses and hosts with only a TLD in common (`api.acme.com` and `web.other.com`)
 * fall back to the first host, so the API's own passkeys keep working; the other origins then can't use them.
 *
 * @internal Exported for the tests only.
 */
export function passkeyRpID(origins: readonly string[]): string {
  const hosts = origins.map((origin) => new URL(origin).hostname)
  const first = hosts[0] ?? ""
  if (hosts.every((host) => host === first)) return first
  const isIp = (host: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":")
  if (hosts.some(isIp)) return first
  const labels = hosts.map((host) => host.split(".").reverse())
  const shared: string[] = []
  const shortest = Math.min(...labels.map((l) => l.length))
  for (let i = 0; i < shortest; i++) {
    const label = labels[0]?.[i]
    if (label === undefined || !labels.every((l) => l[i] === label)) break
    shared.push(label)
  }
  const suffix = shared.reverse().join(".")
  const usable = shared.length >= 2 || suffix === "localhost"
  return usable ? suffix : first
}

/**
 * Write columns on a user row directly. This skips better-auth's user hooks, so a caller that needs
 * them (the claim, two-factor stamping) runs what it needs itself.
 */
function setUserFields(db: Adapter, userId: string, update: Record<string, unknown>) {
  return db.updateMany({ model: "user", where: [{ field: "id", value: userId }], update })
}

/**
 * better-auth's sign-out deletes the session without putting it in the context, so the audit mapper
 * (auth-events.ts) would not know who signed out. This loads it before the endpoint runs.
 */
const signOutSession = {
  id: "proof-sign-out-session",
  hooks: {
    before: [
      {
        matcher: (ctx: { path?: string }) => ctx.path === "/sign-out",
        handler: createAuthMiddleware(async (ctx) => {
          const session = await getSessionFromCtx(ctx)
          if (session) return { context: { session } }
        }),
      },
    ],
  },
} satisfies BetterAuthPlugin

/**
 * Composite indexes for the grant check (grantStands in principal.ts), declared on the
 * oauth-provider plugin's tables. better-auth reads a plugin's table `indexes` when it builds the
 * schema, so `auth:generate` carries them into auth-schema.ts, and drizzle-kit into the migration.
 * Equality columns come first; the refresh-token index ends with `revoked`, then the range column.
 * The plugin's single-column clientId indexes are dropped in their favour.
 */
function withGrantIndexes(
  plugin: ReturnType<typeof oauthProvider>,
): ReturnType<typeof oauthProvider> {
  // Kept out of the object literal below: the plugin's schema type has no `indexes` field.
  const grantIndexes = {
    oauthConsent: {
      indexes: [{ name: "oauthConsent_grant_idx", fields: ["clientId", "referenceId", "userId"] }],
    },
    oauthRefreshToken: {
      indexes: [
        {
          name: "oauthRefreshToken_grant_idx",
          fields: ["clientId", "referenceId", "userId", "revoked", "expiresAt"],
        },
      ],
    },
  }
  // Both composite indexes lead with clientId, so they also serve the oauth_client cascade: the
  // plugin's own single-column clientId index is redundant and costs a write per token rotation. It
  // is turned off; the field (its reference included) is otherwise the plugin's.
  const noClientIdIndex = <T extends { fields: { clientId: object } }>(table: T): T => ({
    ...table,
    fields: { ...table.fields, clientId: { ...table.fields.clientId, index: false } },
  })
  const schema = plugin.schema ?? {}
  return {
    ...plugin,
    schema: {
      ...schema,
      oauthConsent: { ...noClientIdIndex(schema.oauthConsent), ...grantIndexes.oauthConsent },
      oauthRefreshToken: {
        ...noClientIdIndex(schema.oauthRefreshToken),
        ...grantIndexes.oauthRefreshToken,
      },
    },
  }
}

export function createAuth(opts: AuthOptions) {
  if (opts.stripe && !opts.stripe.secretKey.startsWith("sk_test_")) {
    throw new Error("Stripe is test mode only: the secret key must start with sk_test_.")
  }
  for (const origin of opts.webOrigins ?? []) {
    const url = new URL(origin)
    if (url.origin !== origin) throw new Error(`webOrigins: "${origin}" must be a bare origin.`)
  }
  // The API's own origin is trusted by better-auth already; these are the extra web origins.
  const webOrigins = opts.webOrigins ?? []
  const apiOrigin = new URL(opts.baseURL).origin
  const billing = !!opts.stripe
  // Subscriptions exist only with plans (stripeBilling); only then is the stripe plugin a billing source.
  const billingSource = billing && (opts.stripe?.plans?.length ?? 0) > 0
  // The typed entitlements API (createEntitlements) needs the auth instance, so hooks read it here.
  const gateRef: { current?: PlanEntitlements } = {}
  const gate = (): PlanEntitlements => {
    if (!gateRef.current) throw new Error("auth is not initialised")
    return gateRef.current
  }
  // Verifying an owner's email claims their organizations: the higher request limit applies at once
  // in this process (other processes within cacheTtlMs).
  const invalidateOwned = async (db: Adapter, userId: string) => {
    const memberships = await db.findMany<{ organizationId: string; role: string }>({
      model: "member",
      where: [{ field: "userId", value: userId }],
    })
    for (const m of memberships) {
      if (m.role.split(",").some((r) => r.trim() === "owner"))
        await gate().invalidate(m.organizationId)
    }
  }
  // The SCIM plugin's managed-connection endpoint is server-only; it is called on the instance built below.
  const scimApi: {
    connect?: (input: ScimConnectionInput) => Promise<ScimConnection>
    management?: ScimManagement
  } = {}
  // A removed member's or leaver's SCIM tokens end with their access to the organization.
  const endScim = async (userId: string, organizationId: string) => {
    if (!scimApi.management) throw new Error("auth is not initialised")
    await endScimTokensOf(scimApi.management, userId, organizationId)
  }
  // The inbox package's cleanup takes the auth instance, which only exists after betterAuth returns.
  const inboxRef: { auth?: AuthWithContext } = {}
  // A SCIM deprovision ends a person's access the way a removal does, inside the SCIM transaction: the
  // adapter for the grants (the Drizzle handle would wait on that transaction), the tokens via the plugin,
  // and their notices for the organization (deleteMemberData picks up the open transaction itself).
  const endAccessIn = async (db: Adapter, userId: string, organizationId: string) => {
    if (!inboxRef.auth) throw new Error("auth is not initialised")
    await revokeGrantsWith(db, { organizationId, userId }, new Date())
    await deleteMemberData(inboxRef.auth, { userId, organizationId })
    await endScim(userId, organizationId)
  }

  // Deletions are reported (onDeleted) only once the row is gone. Self-delete removes the personal
  // organization raw in beforeDelete, so its id waits here, by user id, for user.delete.after.
  const personalOrgsDeleted = new Map<string, string>()
  const reportDeleted = async (event: DeletedEvent) => {
    try {
      await opts.onDeleted?.(event)
    } catch (error) {
      reportError(error, { phase: "onDeleted", ...event })
    }
  }

  // Callbacks below run after construction and need the adapter, so they read it from this ref.
  const ref: { context?: Promise<{ adapter: Adapter }> } = {}
  // Inside a better-auth transaction (native transactions are on, for the scim plugin) this is the
  // transaction's adapter: a query on the outer one would wait on the transaction it's inside of.
  const adapter = async (): Promise<Adapter> => {
    if (!ref.context) throw new Error("auth is not initialised")
    // better-auth types the outer adapter as a transaction adapter; ours is the narrower Pick of it.
    const outer = (await ref.context).adapter as DBTransactionAdapter
    return (await getCurrentAdapter(outer)) as Adapter
  }

  // Notifications go through the inbox plugin's `notify` endpoint (auth.api.notify, server-only). That
  // exists once betterAuth has returned, so the notifier reads it through a ref set below, as scimApi does.
  const notifyRef: { notify?: NotifyFn } = {}
  const onNotificationError = opts.onNotificationError ?? defaultNotificationError
  const notifier = createNotifier({
    notify: (body) => {
      if (!notifyRef.notify) throw new Error("auth is not initialised")
      return notifyRef.notify(body)
    },
    onError: (error, event) => onNotificationError(error, event.type),
  })
  const notifications = notificationHooks({
    notifier,
    adapter,
    onError: (error, type) => onNotificationError(error, type),
  })

  // Auth emails go through the user's own SES via Wraps. The plugin fills in better-auth's top-level
  // senders (verification, reset, password changed); the invitation sender belongs to the
  // organization plugin, so it comes from `wrapsPlugin.emails` below and shares the SES client.
  // Invitation links point at the app's /accept-invitation/:id page.
  const wrapsPlugin = wraps({
    apiKey: opts.wrapsApiKey,
    email: {
      from: opts.emailFrom,
      appName: opts.appName ?? "Proof",
      appUrl: opts.baseURL,
      ses: opts.ses,
      onError: opts.onEmailError,
    },
  })
  // The account emails wraps doesn't send (change of address, deletion), on the same SES client.
  const notices = createNotices({
    appName: opts.appName ?? "Proof",
    send: wrapsPlugin.emails.send,
  })

  const auth = betterAuth({
    secret: opts.secret,
    baseURL: opts.baseURL,
    // Web origins other than the API's (see AuthOptions.webOrigins). Empty: only the base URL is trusted.
    trustedOrigins: webOrigins,
    basePath: AUTH_BASE_PATH,
    // Native transactions: the scim plugin refuses an adapter without them (SCIM writes are atomic).
    database: drizzleAdapter(opts.db, { provider: "pg", schema, transaction: true }),
    emailVerification: {
      // A change of address (see account-plugin.ts) sends its link to the new address, naming the one it
      // replaces; everything else is wraps' verification email. This app's config wins over the plugin's.
      sendVerificationEmail: async (data) => {
        const change = changeRequestOf(data.token)
        if (change) {
          return notices.emailChangeConfirmation({
            to: data.user.email,
            oldEmail: change.oldEmail,
            name: data.user.name,
            url: data.url,
          })
        }
        return wrapsPlugin.emails.verification(data)
      },
    },
    // A reset means the password may be compromised: sign out every session, not just future ones.
    emailAndPassword: {
      enabled: true,
      revokeSessionsOnPasswordReset: true,
      // Wraps fills this gap only when it is unset, so the reset's side effects run here. Resetting
      // through an emailed link proves the mailbox, so the address counts as verified: provisional
      // signups (see signup.ts) are claimed this way.
      onPasswordReset: async ({ user }) => {
        // Verified first: a failing notice must not leave the claim unrecorded. This write skips
        // the user update hook, so the provisional key is ended here too.
        const db = await adapter()
        await setUserFields(db, user.id, { emailVerified: true })
        await endProvisionalKeys(db, user.id)
        await invalidateOwned(db, user.id)
        // The "password changed" email is this notification's email route (cancelIfRead: false), as
        // for /change-password, so it is not also sent from here.
        await notifications.personal({ type: "account.password_changed", userId: user.id })
      },
    },
    // Rate limits key on the client address apps/api sets in CLIENT_IP_HEADER (rate-limit.ts).
    rateLimit: authRateLimit(opts.rateLimit ?? false),
    // better-auth turns its origin/CSRF checks off under a test runner. Keep them on, so tests
    // exercise what production does (requests with cookies must come from a trusted origin).
    advanced: { disableOriginCheck: false, ipAddress: authIpAddress },
    // The jwt plugin's session-to-JWT endpoint, and the device plugin's /device/token, which mints a
    // session token. OAuth clients get tokens from /oauth2/token instead (device grant included).
    // delete-consent removes the consent row but leaves the client's refresh tokens, which keep the
    // grant standing (principal.ts), so it would look like a revocation without being one.
    // revoke_agent_access ends a grant.
    disabledPaths: ["/token", "/device/token", "/oauth2/delete-consent"],
    hooks: { before: nativeLoopbackRegistration, after: endGrantsOnLeave(opts.db, endScim) },
    user: {
      // Changing the sign-in email: the new address gets a confirmation link, the old one a notice.
      changeEmail: { enabled: true },
      // Deleting an account: a confirmation link first; refused while the user owns organizations
      // others depend on (account-plugin.ts). The personal organization goes with the account.
      deleteUser: {
        enabled: true,
        sendDeleteAccountVerification: async ({ user, url }) =>
          notices.deleteAccountConfirmation({ to: user.email, name: user.name, url }),
        beforeDelete: async (user) => {
          const db = await adapter()
          await assertCanDelete(db, user.id, billing)
          // The SCIM tokens they minted end with them. Memberships are read first: they cascade away.
          const memberships = await db.findMany<{ organizationId: string }>({
            model: "member",
            where: [{ field: "userId", value: user.id }],
          })
          for (const { organizationId } of memberships) await endScim(user.id, organizationId)
          // Its entitlements rows go too: the organization is deleted raw, so no org hook runs.
          const personalId = await removePersonalOrganization(db, user.id, billing, (orgId) =>
            deleteOrganizationData(auth, orgId),
          )
          // Its files are swept in user.delete.after, once the user is gone too, never from here.
          if (personalId) personalOrgsDeleted.set(user.id, personalId)
        },
      },
      // Set when two-factor is switched on, cleared when it is switched off (see databaseHooks).
      additionalFields: {
        twoFactorEnabledAt: { type: "date", required: false, input: false },
      },
    },
    account: {
      accountLinking: {
        enabled: true,
        // Unlinking the last way in is refused by account-plugin.ts, which also counts passkeys.
        allowUnlinkingAll: true,
      },
    },
    session: {
      // A sensitive action needs a sign-in this recent (fresh-session.ts). better-auth's own guarded
      // endpoints (list-sessions, change-password, ...) use the same window.
      freshAge: FRESH_AGE_SECONDS,
      // How the session was signed in, shown on the security page (login-method.ts).
      additionalFields: {
        loginMethod: { type: "string", required: false, input: false },
        loginTwoFactor: { type: "boolean", required: false, defaultValue: false, input: false },
      },
    },
    socialProviders: {
      ...(opts.github && {
        github: { clientId: opts.github.clientId, clientSecret: opts.github.clientSecret },
      }),
      ...(opts.google && {
        google: { clientId: opts.google.clientId, clientSecret: opts.google.clientSecret },
      }),
    },
    databaseHooks: {
      // Every account works inside an organization: signing up creates a personal one.
      // A verified address is a claimed account (verify-email, or any other path that sets it).
      user: {
        create: {
          after: async (user) => {
            const organizationId = await personalOrganization(await adapter(), user)
            try {
              opts.onSignUp?.({ userId: user.id, organizationId })
            } catch (error) {
              reportError(error, { phase: "onSignUp" })
            }
          },
        },
        // Every user delete (self-delete, its link, admin removal) runs this after the row is gone.
        // better-auth queues it with no error handler, so reportDeleted never throws: a throw here
        // would answer 500 for a deletion that already happened. Admin removal skips beforeDelete,
        // so it has no personal organization entry and sweeps the person's files only.
        delete: {
          after: async (user) => {
            const personalId = personalOrgsDeleted.get(user.id)
            personalOrgsDeleted.delete(user.id)
            await reportDeleted({ userId: user.id })
            if (personalId) await reportDeleted({ organizationId: personalId })
          },
        },
        update: {
          after: async (user) => {
            if (!user) return
            const db = await adapter()
            if (user.emailVerified) {
              await endProvisionalKeys(db, user.id)
              await invalidateOwned(db, user.id)
            }
            // The date two-factor was switched on: stamped once, cleared when it is switched off.
            const stamped = (user as { twoFactorEnabledAt?: Date | null }).twoFactorEnabledAt
            // Stamped once per switch-on, so the stamp marks each transition: the notice goes out with it.
            if (user.twoFactorEnabled && !stamped) {
              await setUserFields(db, user.id, { twoFactorEnabledAt: new Date() })
              await notifications.personal({ type: "account.two_factor_enabled", userId: user.id })
            } else if (!user.twoFactorEnabled && stamped) {
              await setUserFields(db, user.id, { twoFactorEnabledAt: null })
              await notifications.personal({ type: "account.two_factor_disabled", userId: user.id })
            }
          },
        },
      },
      // New sessions start in the user's first organization. Membership is still checked per request.
      session: {
        create: {
          before: async (session, context) => {
            const member = await firstMembership(await adapter(), session.userId)
            const login = await signInOf(context as LoginContext | null)
            return {
              data: { ...session, activeOrganizationId: member?.organizationId ?? null, ...login },
            }
          },
        },
      },
    },
    plugins: [
      wrapsPlugin,
      // Before the password is stored, so a breached one never reaches the hash.
      haveIBeenPwned({
        enabled: opts.passwordBreachCheck ?? false,
        customPasswordCompromisedMessage: PASSWORD_COMPROMISED_MESSAGE,
      }),
      // Recorded on the user row (lastLoginMethod) for the sign-in screens.
      lastLoginMethod({ storeInDatabase: true }),
      // Passkeys are bound to the app's origins: the base URL and the web origins (see passkeyRpID).
      passkey({
        rpID: passkeyRpID([apiOrigin, ...webOrigins]),
        rpName: opts.appName ?? "Proof",
        origin: [apiOrigin, ...webOrigins],
      }),
      // TOTP with backup codes and trusted devices. Signing in with a second factor pending answers
      // `twoFactorRedirect`; the web app sends the person to /two-factor (see client.ts).
      twoFactor({ issuer: opts.appName ?? "Proof" }),
      // Sign-in links; the wraps plugin sends them through the same SES path as other auth emails.
      magicLink({ sendMagicLink: wrapsPlugin.emails.magicLink }),
      // Unlinking, deletion and email-change rules, and the security summary the page reads.
      // A used change-of-address link is told in the app (account.email_changed), verified or not.
      accountPlugin({
        notices,
        adapter,
        billing: !!opts.stripe,
        onEmailChanged: (userId) =>
          notifications.personal({ type: "account.email_changed", userId }),
      }),
      // Notices for account, organization, API key and passkey events (see notify-hooks.ts).
      notifications.plugin,
      securitySummaryPlugin(),
      // Which sign-in methods the sign-in page offers (sign-in-methods.ts).
      signInMethodsPlugin(signInMethodsOf(opts)),
      // A link proves the mailbox, not the second factor: a user with two-factor on gets the code next.
      twoFactorMagicLink({ baseURL: opts.baseURL }),
      // Platform admins: a user whose `role` is "admin". Impersonation is limited by impersonationGuard.
      admin({ adminRoles: ["admin"], defaultRole: "user" }),
      impersonationGuard,
      // Sensitive actions (passkeys, two-factor enrolment, keys, members, admin) need a recent sign-in.
      // Right after the impersonation guard: an impersonated session is refused there first.
      freshSessionGuard,
      // Owner-only single sign-on, SCIM provisioning and billing (catalog in access.ts, checks in owner-only.ts).
      ownerOnlyGuard,
      // Logo and image columns are written by the upload operations, not by better-auth (upload-fields.ts).
      uploadFieldGuard,
      // Domain verification (a DNS TXT record) gates sign-in: an unproven domain is never routed to its provider.
      sso({ domainVerification: { enabled: true } }),
      scim({
        connections: [],
        managedConnections: { credentialHashSecret: scimCredentialHashSecret(opts.secret) },
        // Provisioned users become members of the token's organization (scim-projection.ts).
        // A provisioned member takes a seat: refused over the plan's limit (entitlements.ts).
        projection: scimProjection(endAccessIn, logger, async (db, organizationId) =>
          assertSeatAvailable(gate(), organizationId, await seatsTaken(db, organizationId)),
        ),
      }),
      scimTokenPlugin({
        connect: async (input) => {
          if (!scimApi.connect) throw new Error("auth is not initialised")
          return scimApi.connect(input)
        },
      }),
      organization({
        ac,
        roles,
        creatorRole: "owner",
        // How a membership came to be: "scim" when the directory provisioned it (scim-projection.ts).
        // Null for every other path (invitation, owner adds, signup). Not client-settable.
        schema: {
          member: {
            additionalFields: { source: { type: "string", required: false, input: false } },
          },
        },
        sendInvitationEmail: wrapsPlugin.emails.invitation,
        // Organization slugs are URL segments, so the app's own paths are refused (RESERVED_ORG_SLUGS).
        organizationHooks: {
          beforeCreateOrganization: async ({ organization }) => {
            refuseReservedSlug(organization.slug ?? slugOf(organization.name ?? ""))
          },
          beforeUpdateOrganization: async ({ organization, member }) => {
            if (typeof organization.slug !== "string") return
            const current = await (await adapter()).findOne<{ slug: string | null }>({
              model: "organization",
              where: [{ field: "id", value: member.organizationId }],
            })
            refuseReservedSlug(organization.slug, current?.slug)
          },
          // Seats (entitlements.ts): every role but viewer takes one, up to the plan's limit. An
          // invitation holds its seat while pending; accepting counts the members only.
          beforeCreateInvitation: async ({ invitation }) => {
            if (!takesSeat(invitation.role)) return
            const db = await adapter()
            const count = await seatsTaken(db, invitation.organizationId, { invitations: true })
            await assertSeatAvailable(gate(), invitation.organizationId, count)
          },
          beforeAcceptInvitation: async ({ invitation, organization }) => {
            if (!takesSeat(invitation.role ?? "member")) return
            const count = await seatsTaken(await adapter(), organization.id)
            await assertSeatAvailable(gate(), organization.id, count)
          },
          beforeAddMember: async ({ member }) => {
            if (!takesSeat(member.role)) return
            const count = await seatsTaken(await adapter(), member.organizationId)
            await assertSeatAvailable(gate(), member.organizationId, count)
          },
          beforeUpdateMemberRole: async ({ member, newRole }) => {
            if (!takesNewSeat(member.role, newRole)) return
            const count = await seatsTaken(await adapter(), member.organizationId)
            await assertSeatAvailable(gate(), member.organizationId, count)
          },
          // Removal ends the agent access the member granted here (leaving: `endGrantsOnLeave`). The
          // inbox plugin drops their notifications for this organization (and on leaving, and when the
          // organization is deleted). The removed person is told (not themselves), in a personal notice
          // that isn't stamped with the organization, so it survives that cleanup.
          afterRemoveMember: async ({ member, user, organization }) => {
            await revokeMemberGrants(opts.db, member.userId, organization.id)
            await endScim(member.userId, organization.id)
            await notifications.memberRemoved({
              userId: user.id,
              organizationId: organization.id,
              organizationName: organization.name,
            })
          },
          // A new member, by invitation or added directly. A new organization's creator is its only
          // member, so the fan-out (managers minus the new member) reaches nobody.
          afterAcceptInvitation: async ({ member, user, organization }) => {
            await notifications.inOrg(organization.id, {
              type: "member.joined",
              memberUserId: member.userId,
              memberName: user.name,
            })
          },
          // Someone who already has an account hears of the invitation in the app too.
          afterCreateInvitation: async ({ invitation, inviter, organization }) => {
            await notifications.invitationReceived({
              email: invitation.email,
              invitationId: invitation.id,
              organizationName: organization.name,
              inviterName: inviter.name,
            })
          },
          afterAddMember: async ({ member, user, organization }) => {
            await notifications.inOrg(organization.id, {
              type: "member.joined",
              memberUserId: member.userId,
              memberName: user.name,
            })
          },
          // A creator demoted below the role that may mint SCIM tokens loses them (the catalog's scim:create).
          afterUpdateMemberRole: async ({ member }) => {
            if (allowed(rolePermissions(member.role), { scim: ["create"] })) return
            await endScim(member.userId, member.organizationId)
          },
          // Runs once the plugin's delete has returned: the row is gone. Never throws (reportDeleted).
          afterDeleteOrganization: async ({ organization }) => {
            await reportDeleted({ organizationId: organization.id })
          },
          // Support cleans up after delete, remove-member and leave with its own hooks (support.ts):
          // its rows aren't deleted here too, or they would be deleted twice.
        },
      }),
      // After organization(): support's tables reference `organization`, and its staff are the
      // operator organization's members (support.ts). Its events become notifications.
      supportPlugin({ config: opts.support ?? {}, ses: opts.ses, notifications }),
      // After organization(): its tables reference `organization`. Stripe (last) is its billing
      // source when mounted with plans; the source finds the stripe plugin at init, in any order.
      entitlementsPlugin({ config: opts.entitlements ?? {}, billing: billingSource, adapter }),
      // Keys belong to an organization and carry an explicit permission subset (`create_api_key`
      // checks it against the creator). No defaults: a key without permissions can do nothing.
      apiKey({
        references: "organization",
        defaultPrefix: API_KEY_PREFIX,
        enableMetadata: true,
        rateLimit:
          opts.apiKeyRateLimit === false
            ? { enabled: false }
            : { enabled: true, timeWindow: 60_000, maxRequests: 600, ...opts.apiKeyRateLimit },
        permissions: { defaultPermissions: {} },
      }),
      // Signs OAuth access tokens. No `set-auth-jwt` on /get-session: a session JWT must never pass
      // as an OAuth token (resolvePrincipal also requires a client claim and the OAuth issuer).
      jwt({ disableSettingJwtHeader: true }),
      withGrantIndexes(
        oauthProvider({
          loginPage: opts.oauthPages?.login ?? "/sign-in",
          consentPage: opts.oauthPages?.consent ?? "/consent",
          scopes: ["openid", "profile", "email", "offline_access", ...OAUTH_SCOPES],
          // MCP clients (Claude, ChatGPT, Cursor) register themselves (RFC 7591); PKCE stays required.
          allowDynamicClientRegistration: true,
          allowUnauthenticatedClientRegistration: true,
          clientRegistrationDefaultScopes: ["openid", "offline_access", ...OAUTH_SCOPES],
          resources: opts.oauthResources,
          // Self-registered MCP clients must be able to ask for these resources, or authorize fails
          // with invalid_target (per-client resource links are enforced by default, RFC 8707 §3).
          clientRegistrationDefaultResources: opts.oauthResources,
          // A token acts in exactly one organization: the session's active one when the user consents.
          // The consent page should show it and offer a switcher (set-active, then accept). The
          // select-organization page is only shown when the session has no valid active org; it sets
          // one and POSTs /oauth2/continue with { postLogin: true }.
          postLogin: {
            page: opts.oauthPages?.selectOrganization ?? "/select-organization",
            shouldRedirect: async ({ user, session }): Promise<boolean> => {
              const orgId = session.activeOrganizationId
              if (typeof orgId !== "string") return true
              return !(await findMember(await adapter(), user.id, orgId))
            },
            consentReferenceId: async ({ user, session }): Promise<string> => {
              const orgId = session.activeOrganizationId
              const member =
                typeof orgId === "string" ? await findMember(await adapter(), user.id, orgId) : null
              if (!member) throw new Error("No organization selected for this authorization")
              return member.organizationId
            },
          },
          customAccessTokenClaims: ({ referenceId }) => (referenceId ? { org: referenceId } : {}),
        }),
      ),
      // Client ID Metadata Documents: an HTTPS client_id is fetched and validated, with no
      // registration. Dynamic registration stays on for clients that don't use it. Keep the default
      // fetch policy (HTTPS, public addresses, no redirects); see docs/auth.md.
      cimd({
        fetchClientMetadataResource: opts.clientMetadataFetch ?? fetchClientMetadataResource,
      }),
      // A pending OAuth authorization survives the emailed link (see resume.ts). After oauthProvider,
      // so its signature check has already run on the sign-in request.
      resumeMagicLinkAuthorization({
        authorizeUrl: `${opts.baseURL}${AUTH_BASE_PATH}/oauth2/authorize`,
        signInUrl: `${opts.baseURL}${opts.oauthPages?.login ?? "/sign-in"}`,
      }),
      // RFC 8628 device grant on the same token endpoint (see device.ts).
      deviceAuthorizationPlugin({ interval: opts.deviceInterval }),
      // Passkey sign-up: the emailed link proves the address and signs in; the passkey is added after
      // (passkey-signup.ts). Reads the passkey() defaults above, so it needs no registration option.
      passkeySignupPlugin({
        db: opts.db,
        sendLink: ({ email, name, url }) => notices.passkeySignupLink({ to: email, name, url }),
      }),
      signOutSession,
      // Audit events for auth activity (auth-events.ts).
      authEvents({ onAuthEvent: opts.onAuthEvent ?? (() => {}) }),
      // In-app notifications (@byo-oss/notifications): the bell. Written by the server only (auth.api.notify).
      // Some events also email (NOTIFICATION_EMAIL_ROUTES; the API's delivery sweep sends them).
      withDeliveryIndexes(
        inbox({
          appUrl: opts.baseURL,
          channels: {
            email: notificationEmailChannel({
              from: opts.emailFrom,
              appName: opts.appName ?? "Proof",
              ses: opts.ses,
            }),
          },
          routes: NOTIFICATION_EMAIL_ROUTES,
          // Only to a verified address: a signup (or a provisional one, by an agent) can use
          // someone else's, and its events would otherwise mail them. A reset verifies first.
          shouldDeliver: ({ user }) => user.emailVerified,
        }),
      ),
      ...(opts.stripe ? [stripeBilling(opts.stripe, adapter, notifications)] : []),
    ],
  })
  notifyRef.notify = (body) => auth.api.notify(body)
  inboxRef.auth = auth
  scimApi.connect = (input) => auth.api.createSCIMManagedConnection(input)
  scimApi.management = {
    list: (provisioningDomainId) =>
      auth.api.listSCIMManagedConnections({ body: { provisioningDomainId } }),
    get: (input) => auth.api.getSCIMManagedConnection({ body: input }),
    revokeCredential: (input) => auth.api.revokeSCIMManagedCredential({ body: input }),
  }
  ref.context = auth.$context
  gateRef.current = createEntitlements(auth, catalog)
  // The app's Drizzle handle, for the tables better-auth doesn't own (signup_attempt, see signup.ts),
  // and the typed entitlements API (hasFeature, consumeUsage, checkCapacity, ...).
  return Object.assign(auth, { db: opts.db, entitlements: gateRef.current })
}

/** The stripe plugin, in test mode. Organizations are the billing customers; owners and admins may manage one. */
function stripeBilling(
  config: NonNullable<AuthOptions["stripe"]>,
  adapter: () => Promise<Adapter>,
  notifications: NotificationHooks,
) {
  // The plugin's plans come from the catalog (stripePlans): names are plan keys, so STRIPE_PLANS can
  // only name a plan the catalog has (boot fails otherwise); the price ids stay in the environment.
  const plans = stripePlans(
    catalog,
    Object.fromEntries((config.plans ?? []).map((plan) => [plan.name, { priceId: plan.priceId }])),
  )
  return stripe({
    stripeClient: new Stripe(config.secretKey, { typescript: true }),
    stripeWebhookSecret: config.webhookSecret,
    // Payment failures and cancellations reach the organization's billing managers (its owners).
    onEvent: async (event) => {
      const customer = (event.data.object as { customer?: unknown }).customer
      if (typeof customer !== "string") return
      if (event.type === "invoice.payment_failed")
        await notifications.billing(customer, "payment_failed")
      if (event.type === "customer.subscription.deleted") {
        await notifications.billing(customer, "subscription_canceled")
      }
    },
    // Customers are made when an organization subscribes, not when a person signs up.
    createCustomerOnSignUp: false,
    organization: { enabled: true },
    subscription:
      plans.length > 0
        ? {
            enabled: true,
            plans,
            // A refusal is a 403 here: the plugin's own `false` would answer 401 (UNAUTHORIZED).
            authorizeReference: async ({ user, referenceId }) => {
              if (await canManageBilling(await adapter(), user.id, referenceId)) return true
              throw APIError.from("FORBIDDEN", {
                message: "Only an organization's owners and admins can manage billing",
                code: "ORGANIZATION_BILLING_FORBIDDEN",
              })
            },
          }
        : { enabled: false },
  })
}

export type Auth = ReturnType<typeof createAuth>

export {
  oauthProviderAuthServerMetadata,
  oauthProviderOpenIdConfigMetadata,
} from "@better-auth/oauth-provider"
export * from "./permissions"
export { oauthIssuer, type Principal, resolvePrincipal } from "./principal"
export { acceptSupportSession, type SupportConfig, supportMailer } from "./support"
export { type GrantScope, revokeGrants } from "./member-grants"
export { memberGrants, personalSlug } from "./membership"
export {
  APPROVERS,
  BILLING_MANAGERS,
  createNotifier,
  KEY_MANAGERS,
  MEMBER_MANAGERS,
  type NotificationEvent,
  type NotificationType,
  type Notifier,
  type NotifierOptions,
  type NotifyBody,
  type NotifyFn,
  notifyBodyOf,
  type OrgEventInput,
  type OrgRef,
  type Recipients,
  type RenderedNotification,
  recipientsOf,
  renderNotification,
  rolesWith,
  SUPPORT_AGENTS,
  supportTicketPaths,
} from "./notifications"
