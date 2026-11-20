// Sensitive actions need a recent sign-in, not just a session. In better-auth 1.7.7 only
// list-sessions and unlink-account check session age (freshSessionMiddleware); change-email,
// delete-user, change-password and two-factor/disable only check that a session exists. The last two
// ask for the current password, which is itself a fresh proof, so they are left alone; session
// revocation stays open so a person with an old session can still sign an intruder out. This plugin refuses those
// when the session is older than FRESH_AGE_SECONDS, with better-auth's own code SESSION_NOT_FRESH.
// The same window is set as `session.freshAge`, so better-auth's guarded endpoints agree with it.
// A request with no session passes through: the endpoint itself answers UNAUTHORIZED.
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api"
import type { BetterAuthPlugin } from "better-auth"

/** How long after sign-in a session may do the sensitive actions below: one hour. */
export const FRESH_AGE_SECONDS = 60 * 60

/**
 * better-auth endpoints the plugin guards: each adds or removes a credential, changes who may act, or
 * changes security config, and isn't age-checked upstream (passkey registration is listed anyway, so the
 * window is one rule). Checked against better-auth 1.7.7 and the plugins' dists.
 */
export const FRESH_SESSION_PATHS = [
  // The sign-in address: a new address can reset the password, so this is an account takeover step.
  "/change-email",
  // Account deletion (it also needs the emailed confirmation).
  "/delete-user",
  // Passkeys: start a registration, finish one, delete one.
  "/passkey/generate-register-options",
  "/passkey/verify-registration",
  "/passkey/delete-passkey",
  // Two-factor enrolment and new backup codes (disable is guarded by better-auth itself).
  "/two-factor/enable",
  "/two-factor/generate-backup-codes",
  // Sign-in methods: link an external account to this user.
  "/link-social",
  // SCIM token mint (scim-token.ts wraps the plugin's connection; the token is returned once).
  "/scim/generate-token",
  // Organization API keys.
  "/api-key/create",
  "/api-key/update",
  "/api-key/delete",
  // Single sign-on: register, change, remove a provider, and prove its domain (routes sign-in).
  "/sso/register",
  "/sso/update-provider",
  "/sso/delete-provider",
  "/sso/verify-domain",
  // Organization members and roles.
  "/organization/invite-member",
  "/organization/update-member-role",
  "/organization/remove-member",
  "/organization/delete",
  "/organization/create-role",
  "/organization/update-role",
  "/organization/delete-role",
  // OAuth clients and the grants a person gives them (consent issues the tokens; device approve
  // issues them to a CLI). Client secrets are minted by create and rotate-secret.
  "/oauth2/create-client",
  "/oauth2/update-client",
  "/oauth2/client/rotate-secret",
  "/oauth2/delete-client",
  "/oauth2/consent",
  "/oauth2/update-consent",
  "/device/approve",
  // Platform admin: create or change users, their passwords and bans, remove them, change a role,
  // or act as someone.
  "/admin/create-user",
  "/admin/set-user-password",
  "/admin/ban-user",
  "/admin/unban-user",
  "/admin/remove-user",
  "/admin/update-user",
  "/admin/set-role",
  "/admin/impersonate-user",
] as const

/** Whether a session created at `createdAt` is still fresh at `now`. */
export function isFresh(
  createdAt: Date | string | number,
  now: number = Date.now(),
  freshAgeSeconds: number = FRESH_AGE_SECONDS,
): boolean {
  return now - new Date(createdAt).getTime() < freshAgeSeconds * 1000
}

export const freshSessionGuard = {
  id: "proof-fresh-session",
  hooks: {
    before: [
      {
        matcher: (ctx: { path?: string }) =>
          FRESH_SESSION_PATHS.includes(ctx.path as (typeof FRESH_SESSION_PATHS)[number]),
        handler: createAuthMiddleware(async (ctx) => {
          const session = await getSessionFromCtx(ctx)
          if (!session) return
          if (!isFresh(session.session.createdAt)) {
            throw APIError.from("FORBIDDEN", {
              message: "Session is not fresh",
              code: "SESSION_NOT_FRESH",
            })
          }
        }),
      },
    ],
  },
} satisfies BetterAuthPlugin
