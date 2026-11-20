// Impersonation (better-auth's admin plugin) lets a platform admin act as another user. Such a
// session is someone else's session on the admin's machine, so it is read-only: it must not change
// anything, mint anything (OAuth consent, device approval, keys, passkeys, sign-in links) or outlive
// the impersonation. This guard fails closed. For an impersonated session, every better-auth request
// is refused (403 IMPERSONATED_SESSION_NOT_ALLOWED) except the two that end it, and a GET only
// passes when it is listed as a read. Refused server-side, whatever the client sends. The product API
// has its own read-only grants for the same session (IMPERSONATION_GRANTS in permissions.ts).
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api"
import type { BetterAuthPlugin } from "better-auth"

/** Endpoints an impersonated session may call with any method: the ones that end the impersonation. */
export const IMPERSONATION_ALLOWED_PATHS = ["/admin/stop-impersonating", "/sign-out"] as const

/**
 * GET endpoints the configured plugins mount that only read. An impersonated session may call these.
 * Every other GET is refused: a GET that changes state would otherwise pass unnoticed after an upgrade.
 */
export const IMPERSONATION_READ_GET_PATHS = [
  "/.well-known/oauth-authorization-server",
  "/.well-known/openid-configuration",
  "/account-info",
  "/admin/get-user",
  "/admin/list-users",
  "/admin/oauth2/resources",
  "/admin/oauth2/resources/:identifier",
  "/api-key/get",
  "/api-key/list",
  // Entitlements (@byo-oss/entitlements): the organization's plan, and the staff's override list.
  // The package itself refuses an impersonated session on the staff list (acceptSession).
  "/entitlements/get",
  "/entitlements/overrides",
  "/error",
  "/get-session",
  "/inbox/list",
  "/inbox/unread-count",
  "/jwks",
  "/list-accounts",
  "/list-sessions",
  "/oauth2/get-client",
  "/oauth2/get-clients",
  "/oauth2/get-consent",
  "/oauth2/get-consents",
  "/oauth2/public-client",
  "/oauth2/userinfo",
  "/ok",
  "/organization/get-active-member",
  "/organization/get-active-member-role",
  "/organization/get-full-organization",
  "/organization/get-invitation",
  "/organization/get-organization",
  "/organization/list",
  "/organization/list-invitations",
  "/organization/list-members",
  "/organization/list-user-invitations",
  "/passkey/list-user-passkeys",
  "/reset-password/:token",
  "/scim/v2/Groups",
  "/scim/v2/Groups/:groupId",
  "/scim/v2/ResourceTypes",
  "/scim/v2/ResourceTypes/:resourceTypeId",
  "/scim/v2/Schemas",
  "/scim/v2/Schemas/:schemaId",
  "/scim/v2/ServiceProviderConfig",
  "/scim/v2/Users",
  "/scim/v2/Users/:userId",
  "/security/summary",
  "/sign-in-methods",
  "/sso/get-provider",
  "/sso/providers",
  "/sso/saml2/sp/metadata",
  "/subscription/list",
] as const

/**
 * GET endpoints an impersonated session may not call, decided one by one. Each one mints or links
 * something, consumes a single-use token, signs someone in, or ends a session, or (support) is only
 * for the person themselves.
 */
export const IMPERSONATION_REFUSED_GET_PATHS = [
  // Store a WebAuthn challenge. A registration one would let the admin enrol their own passkey.
  "/passkey/generate-authenticate-options",
  "/passkey/generate-register-options",
  // Issues an authorization code for an existing consent.
  "/oauth2/authorize",
  // Claims a pending device code for the session's user (the step before approving it).
  "/device",
  // Ends the session it is called with.
  "/oauth2/end-session",
  // Consumes an emailed link: signs in, verifies the address or changes it, or deletes the account.
  "/magic-link/verify",
  "/passkey-signup/verify",
  "/verify-email",
  "/delete-user/callback",
  // OAuth, SSO and SAML callbacks: they link an account or sign someone in.
  "/callback/:id",
  "/sso/callback",
  "/sso/callback/:providerId",
  "/sso/saml2/sp/acs/:providerId",
  "/sso/saml2/sp/slo/:providerId",
  // Records a Stripe checkout against the organization.
  "/subscription/success",
  // Mints an OAuth token from the token endpoint (disabled in this app; refused anyway).
  "/token",
  // Support (@byo-oss/support). These only read, but support is for the person themselves: a
  // customer's own tickets or an agent's queue. Support refuses an impersonated session too
  // (acceptSupportSession in support.ts); this guard answers first.
  "/support/my-tickets",
  "/support/ticket",
  "/support/attachment",
  "/support/agent/tickets",
  "/support/agent/ticket",
  "/support/agent/tags",
  "/support/agent/canned",
  "/support/agent/attachment",
] as const

const readOnly = (path: string) =>
  (IMPERSONATION_READ_GET_PATHS as readonly string[]).includes(path)

/** Whether an impersonated session may call this path with this method. */
export const impersonationAllows = (path: string, method: string): boolean => {
  if ((IMPERSONATION_ALLOWED_PATHS as readonly string[]).includes(path)) return true
  return method === "GET" && readOnly(path)
}

export const impersonationGuard = {
  id: "proof-impersonation-guard",
  hooks: {
    before: [
      {
        matcher: (ctx: { path?: string; method?: string; request?: { method?: string } }) => {
          // An in-process call (auth.api.*, as principal.ts makes for a session) has no method. It is
          // our own code, so it is judged as a read: only the read paths pass, as for a GET.
          const method = String(ctx.method ?? ctx.request?.method ?? "GET").toUpperCase()
          return !impersonationAllows(ctx.path ?? "", method)
        },
        handler: createAuthMiddleware(async (ctx) => {
          const session = await getSessionFromCtx(ctx)
          const impersonatedBy = (
            session?.session as { impersonatedBy?: string | null } | undefined
          )?.impersonatedBy
          if (impersonatedBy) {
            throw APIError.from("FORBIDDEN", {
              message: "An impersonated session is read-only. Ask the user to do this themselves.",
              code: "IMPERSONATED_SESSION_NOT_ALLOWED",
            })
          }
        }),
      },
    ],
  },
} satisfies BetterAuthPlugin

/** Whether a session is an impersonation (an admin acting as the user). */
export const isImpersonated = (session: unknown): boolean =>
  Boolean(
    (session as { session?: { impersonatedBy?: string | null } } | null)?.session?.impersonatedBy,
  )
