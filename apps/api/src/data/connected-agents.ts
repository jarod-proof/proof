// Connected agents: the organization's API keys, and the OAuth clients that hold consent or live
// refresh tokens for it. Device-grant clients have no consent row, so their refresh tokens are the
// evidence. Access tokens are JWTs and are not stored, so an OAuth client that holds only an access
// token (no refresh token) is not listed.
import { revokeGrants } from "@proof/auth"
import type { CallerActsFor, Named, OrganizationId } from "@proof/auth-proofs"
import { type Database, apikey, oauthClient, oauthConsent, oauthRefreshToken } from "@proof/db"
import { and, eq, inArray, isNull, gt } from "drizzle-orm"
import { z } from "zod"

export interface Agent {
  /** `key_<id>` for an API key, `client_<clientId>` for an OAuth client. Pass it to revokeAgentAccess. */
  id: string
  type: "oauthClient" | "apiKey"
  /** The OAuth client id, as `clientId` on audit events. Null for API keys. */
  clientId: string | null
  /** The API key id, as `actor.id` on audit events. Null for OAuth clients. */
  keyId: string | null
  name: string
  createdAt: string
  /** API keys: the last request. OAuth clients: not tracked, so null. */
  lastUsedAt: string | null
  /** API keys: `resource:action` permissions. OAuth clients: the granted scopes. */
  access: string[]
}

const KEY_PREFIX = "key_"
const CLIENT_PREFIX = "client_"

// Stored permissions are JSON written by better-auth. Anything that doesn't parse to the expected
// shape is treated as no permissions, so one bad row can't fail the whole listing.
const storedPermissions = z.record(z.string(), z.array(z.string()))

const permissionList = (raw: string | null): string[] => {
  if (!raw) return []
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return []
  }
  const parsed = storedPermissions.safeParse(json)
  if (!parsed.success) return []
  return Object.entries(parsed.data).flatMap(([resource, actions]) =>
    actions.map((action) => `${resource}:${action}`),
  )
}

export async function listConnectedAgents<O>(
  db: Database,
  org: Named<O, OrganizationId>,
  _proof: CallerActsFor<O>,
  now: Date,
): Promise<Agent[]> {
  const keys = await db.select().from(apikey).where(eq(apikey.referenceId, org.value))
  const agents: Agent[] = keys
    .filter((k) => k.enabled !== false && (!k.expiresAt || k.expiresAt > now))
    .map((k) => ({
      id: `${KEY_PREFIX}${k.id}`,
      type: "apiKey" as const,
      clientId: null,
      keyId: k.id,
      name: k.name ?? "API key",
      createdAt: k.createdAt.toISOString(),
      lastUsedAt: k.lastRequest?.toISOString() ?? null,
      access: permissionList(k.permissions),
    }))

  // Per client: the earliest row we saw for it, and the scopes it holds.
  const clients = new Map<string, { createdAt: Date; scopes: Set<string> }>()
  const note = (clientId: string, createdAt: Date, scopes: readonly string[]) => {
    const seen = clients.get(clientId)
    if (!seen) clients.set(clientId, { createdAt, scopes: new Set(scopes) })
    else {
      if (createdAt < seen.createdAt) seen.createdAt = createdAt
      for (const s of scopes) seen.scopes.add(s)
    }
  }
  const consents = await db
    .select({
      clientId: oauthConsent.clientId,
      scopes: oauthConsent.scopes,
      createdAt: oauthConsent.createdAt,
    })
    .from(oauthConsent)
    .where(eq(oauthConsent.referenceId, org.value))
  for (const c of consents) note(c.clientId, c.createdAt, c.scopes)
  const refresh = await db
    .select({
      clientId: oauthRefreshToken.clientId,
      scopes: oauthRefreshToken.scopes,
      createdAt: oauthRefreshToken.createdAt,
    })
    .from(oauthRefreshToken)
    .where(
      and(
        eq(oauthRefreshToken.referenceId, org.value),
        isNull(oauthRefreshToken.revoked),
        gt(oauthRefreshToken.expiresAt, now),
      ),
    )
  for (const r of refresh) note(r.clientId, r.createdAt, r.scopes)

  const ids = [...clients.keys()]
  const names = new Map<string, string | null>()
  if (ids.length > 0) {
    const rows = await db
      .select({ clientId: oauthClient.clientId, name: oauthClient.name })
      .from(oauthClient)
      .where(inArray(oauthClient.clientId, ids))
    for (const row of rows) names.set(row.clientId, row.name)
  }
  for (const [clientId, seen] of clients) {
    agents.push({
      id: `${CLIENT_PREFIX}${clientId}`,
      type: "oauthClient",
      clientId,
      keyId: null,
      name: names.get(clientId) ?? clientId,
      createdAt: seen.createdAt.toISOString(),
      lastUsedAt: null,
      access: [...seen.scopes].sort(),
    })
  }
  return agents.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
}

/**
 * Revoke an agent's access to this organization. An API key is deleted. An OAuth client loses its
 * consent and its refresh tokens here; `resolvePrincipal` then refuses access tokens it issued
 * before the revocation. The client itself is kept: other organizations may use it.
 * Returns false when nothing in this organization matched.
 */
export async function revokeAgentAccess<O>(
  db: Database,
  org: Named<O, OrganizationId>,
  _proof: CallerActsFor<O>,
  id: string,
  now: Date,
): Promise<boolean> {
  if (id.startsWith(KEY_PREFIX)) {
    const deleted = await db
      .delete(apikey)
      .where(and(eq(apikey.id, id.slice(KEY_PREFIX.length)), eq(apikey.referenceId, org.value)))
      .returning({ id: apikey.id })
    return deleted.length > 0
  }
  if (!id.startsWith(CLIENT_PREFIX)) return false
  const clientId = id.slice(CLIENT_PREFIX.length)
  const changed = await revokeGrants(db, { organizationId: org.value, clientId }, now)
  return changed > 0
}
