// Single sign-on and SCIM provisioning belong to an organization's owner. The permission catalog
// (access.ts) grants them to the owner role only, and the check runs here, before the plugin's own:
// the sso plugin also lets admins register and edit providers, which the catalog does not allow.
// Billing (the subscription) is the owner's and the admins': see canManageBilling.
import { allowed } from "@proof/api"
import type { BetterAuthPlugin } from "better-auth"
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api"
import { memberGrants } from "./membership"

/** The sso plugin's endpoints that change a provider (reads stay with the plugin's own rules). */
export const SSO_WRITE_PATHS = [
  "/sso/register",
  "/sso/update-provider",
  "/sso/delete-provider",
  "/sso/request-domain-verification",
  "/sso/verify-domain",
] as const

const refuse = (message: string) =>
  APIError.from("FORBIDDEN", { message, code: "ORGANIZATION_OWNER_REQUIRED" })

/** The organization a provider write is for: the body's, or the stored provider's. */
async function organizationOf(ctx: {
  body?: unknown
  path?: string
  context: { adapter: unknown }
}): Promise<string | null> {
  const body = (ctx.body ?? {}) as { organizationId?: unknown; providerId?: unknown }
  if (ctx.path === "/sso/register") {
    return typeof body.organizationId === "string" ? body.organizationId : null
  }
  if (typeof body.providerId !== "string") return null
  const adapter = ctx.context.adapter as {
    findOne: <T>(query: unknown) => Promise<T | null>
  }
  const provider = await adapter.findOne<{ organizationId?: string | null }>({
    model: "ssoProvider",
    where: [{ field: "providerId", value: body.providerId }],
  })
  return provider?.organizationId ?? null
}

export const ownerOnlyGuard = {
  id: "proof-owner-only",
  hooks: {
    before: [
      {
        matcher: (ctx: { path?: string }) =>
          SSO_WRITE_PATHS.includes(ctx.path as (typeof SSO_WRITE_PATHS)[number]),
        handler: createAuthMiddleware(async (ctx) => {
          const session = await getSessionFromCtx(ctx)
          if (!session)
            throw APIError.from("UNAUTHORIZED", { message: "Sign in first", code: "UNAUTHORIZED" })
          const organizationId = await organizationOf(ctx)
          // Single sign-on is set up per organization: a provider with no organization is refused too.
          if (!organizationId) throw refuse("Single sign-on is set up for an organization's owner")
          const grants = await memberGrants(ctx.context.adapter, session.user.id, organizationId)
          if (!grants || !allowed(grants, { sso: ["update"] })) {
            throw refuse("Only an organization owner can set up single sign-on")
          }
        }),
      },
    ],
  },
} satisfies BetterAuthPlugin

/**
 * Billing: an organization's owners and admins may manage its subscription (the stripe plugin asks
 * through authorizeReference). Members and viewers may not.
 */
export async function canManageBilling(
  adapter: Parameters<typeof memberGrants>[0],
  userId: string,
  organizationId: string,
): Promise<boolean> {
  const grants = await memberGrants(adapter, userId, organizationId)
  return !!grants && allowed(grants, { subscription: ["update"] })
}
