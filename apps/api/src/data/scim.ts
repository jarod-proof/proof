// The organization's SCIM tokens. A token is an active credential of a managed SCIM connection that
// the organization owns (provisioningDomainId). The secret is never stored in the clear, so only the
// credential's id and its metadata are listed. Revoking goes through better-auth (operations/scim.ts),
// which keeps the plugin's own event log.
import type { CallerActsFor, Named, OrganizationId } from "@proof/auth-proofs"
import { type Database, scimManagedConnection, scimManagedCredential, user } from "@proof/db"
import { and, desc, eq, inArray } from "drizzle-orm"

export interface ScimTokenRow {
  /** The managed connection's id, which is what callers name a token by. */
  id: string
  /** The active credentials a revoke ends (normally one). */
  credentialIds: string[]
  createdAt: Date
  createdBy: { id: string; name: string } | null
  lastUsedAt: Date | null
  expiresAt: Date | null
}

/**
 * The organization's live SCIM tokens, newest first: the active connections with at least one active
 * credential. Revoked and decommissioned connections are not listed.
 */
export async function listScimTokens<O>(
  db: Database,
  org: Named<O, OrganizationId>,
  _proof: CallerActsFor<O>,
): Promise<ScimTokenRow[]> {
  const connections = await db
    .select({
      id: scimManagedConnection.connectionId,
      recordId: scimManagedConnection.id,
      createdAt: scimManagedConnection.createdAt,
      createdBy: scimManagedConnection.createdBy,
      creatorName: user.name,
    })
    .from(scimManagedConnection)
    .leftJoin(user, eq(user.id, scimManagedConnection.createdBy))
    .where(
      and(
        eq(scimManagedConnection.provisioningDomainId, org.value),
        eq(scimManagedConnection.status, "active"),
      ),
    )
    .orderBy(desc(scimManagedConnection.createdAt))
  if (connections.length === 0) return []

  const credentials = await db
    .select()
    .from(scimManagedCredential)
    .where(
      and(
        inArray(
          scimManagedCredential.connectionRecordId,
          connections.map((c) => c.recordId),
        ),
        eq(scimManagedCredential.status, "active"),
      ),
    )

  const rows: ScimTokenRow[] = []
  for (const connection of connections) {
    const mine = credentials.filter((c) => c.connectionRecordId === connection.recordId)
    if (mine.length === 0) continue
    const lastUsed = mine.reduce<Date | null>(
      (latest, c) => (c.lastUsedAt && (!latest || c.lastUsedAt > latest) ? c.lastUsedAt : latest),
      null,
    )
    rows.push({
      id: connection.id,
      credentialIds: mine.map((c) => c.credentialId),
      createdAt: connection.createdAt,
      createdBy:
        connection.creatorName === null
          ? null
          : { id: connection.createdBy, name: connection.creatorName },
      lastUsedAt: lastUsed,
      expiresAt: mine.reduce<Date | null>(
        (soonest, c) => (!soonest || c.expiresAt < soonest ? c.expiresAt : soonest),
        null,
      ),
    })
  }
  return rows
}
