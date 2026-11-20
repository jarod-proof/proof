// A member who leaves or is removed takes their agents' access to that organization with them. The
// grant check (`grantStands` in principal.ts) only asks whether a consent or live refresh token
// stands, so without this a person removed and later re-added would find their old agent working
// again. Revoking stamps `revoked`, which also refuses access tokens issued before it.
import type { Database } from "@proof/db"
import { oauthAccessToken, oauthConsent, oauthRefreshToken } from "@proof/db/schema"
import { and, eq, isNull } from "drizzle-orm"
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api"
import type { Adapter } from "./membership"

/** Which grants to end: every one in the organization, or narrowed to a client and/or a user. */
export interface GrantScope {
  organizationId: string
  clientId?: string
  userId?: string
}

/**
 * End OAuth grants in one organization: live refresh and access tokens are stamped `revoked` (so
 * access tokens issued before `now` stop at once) and consents are deleted. Narrow by `clientId`
 * (one agent) and/or `userId` (one member). Already-revoked tokens keep their original stamp.
 * Returns how many rows changed, so callers can tell whether anything matched.
 *
 * Takes the app's Drizzle `Database` (what `revoke_agent_access` holds), not the better-auth
 * adapter. Call it only outside a better-auth transaction: on PGlite (tests) a query on the outer
 * handle waits for the open transaction and deadlocks. The organization plugin's removeMember and
 * leave hooks run outside one (checked against crud-members.mjs), so they pass the Drizzle handle
 * too. A hook that does run inside `runWithTransaction` must use the adapter instead.
 */
export async function revokeGrants(db: Database, scope: GrantScope, now: Date): Promise<number> {
  const within = (
    table: typeof oauthRefreshToken | typeof oauthAccessToken | typeof oauthConsent,
  ) =>
    and(
      eq(table.referenceId, scope.organizationId),
      scope.clientId === undefined ? undefined : eq(table.clientId, scope.clientId),
      scope.userId === undefined ? undefined : eq(table.userId, scope.userId),
    )
  return db.transaction(async (tx) => {
    const refreshed = await tx
      .update(oauthRefreshToken)
      .set({ revoked: now })
      .where(and(within(oauthRefreshToken), isNull(oauthRefreshToken.revoked)))
      .returning({ id: oauthRefreshToken.id })
    const access = await tx
      .update(oauthAccessToken)
      .set({ revoked: now })
      .where(and(within(oauthAccessToken), isNull(oauthAccessToken.revoked)))
      .returning({ id: oauthAccessToken.id })
    const consents = await tx
      .delete(oauthConsent)
      .where(within(oauthConsent))
      .returning({ id: oauthConsent.id })
    return refreshed.length + access.length + consents.length
  })
}

/**
 * `revokeGrants` through a better-auth adapter, for code that runs inside a better-auth transaction
 * (the SCIM projection): the Drizzle handle would wait on that transaction. Same effect: live tokens
 * are stamped (already-revoked ones keep their stamp) and the consents are deleted.
 */
export async function revokeGrantsWith(db: Adapter, scope: GrantScope, now: Date): Promise<void> {
  const where = [
    { field: "referenceId", value: scope.organizationId },
    ...(scope.clientId === undefined ? [] : [{ field: "clientId", value: scope.clientId }]),
    ...(scope.userId === undefined ? [] : [{ field: "userId", value: scope.userId }]),
  ]
  for (const model of ["oauthRefreshToken", "oauthAccessToken"] as const) {
    const rows = await db.findMany<{ id: string; revoked: Date | null }>({ model, where })
    const live = rows.filter((row) => !row.revoked).map((row) => row.id)
    if (live.length > 0) {
      await db.updateMany({
        model,
        where: [{ field: "id", value: live, operator: "in" }],
        update: { revoked: now },
      })
    }
  }
  await db.deleteMany({ model: "oauthConsent", where })
}

/** End every OAuth grant the user made in the organization: consents and refresh/access tokens. */
export async function revokeMemberGrants(
  db: Database,
  userId: string,
  organizationId: string,
  now = new Date(),
): Promise<void> {
  await revokeGrants(db, { organizationId, userId }, now)
}

/**
 * `/organization/leave` doesn't run the organization plugin's remove-member hooks, so leaving is
 * caught here, once the leave has succeeded. `endScim` ends the person's SCIM tokens for the org
 * (see scim-token.ts), as a removal does.
 */
export const endGrantsOnLeave = (
  db: Database,
  endScim: (userId: string, organizationId: string) => Promise<void>,
) =>
  createAuthMiddleware(async (ctx) => {
    if (ctx.path !== "/organization/leave" || ctx.context.returned instanceof APIError) return
    const organizationId = (ctx.body as { organizationId?: unknown } | undefined)?.organizationId
    const session = await getSessionFromCtx(ctx)
    if (typeof organizationId !== "string" || !session) return
    await revokeMemberGrants(db, session.user.id, organizationId)
    await endScim(session.user.id, organizationId)
  })
