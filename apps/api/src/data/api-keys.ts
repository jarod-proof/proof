// The organization's API keys, as the API keys page shows them. Only the masked start of a key is
// returned, never the key itself (better-auth stores it hashed). createdBy is kept in the key's
// metadata at creation; keys made before that have none.
import type { CallerActsFor, Named, OrganizationId } from "@proof/auth-proofs"
import { apikey, type Database, user } from "@proof/db"
import { and, desc, eq } from "drizzle-orm"

export interface ApiKeyRow {
  id: string
  name: string | null
  start: string | null
  permissions: Record<string, string[]>
  createdAt: Date
  lastUsedAt: Date | null
  expiresAt: Date | null
  createdBy: { id: string; name: string } | null
}

const parseJson = (text: string | null): unknown => {
  if (!text) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

export async function listApiKeys<O>(
  db: Database,
  org: Named<O, OrganizationId>,
  _proof: CallerActsFor<O>,
): Promise<ApiKeyRow[]> {
  const rows = await db
    .select()
    .from(apikey)
    .where(eq(apikey.referenceId, org.value))
    .orderBy(desc(apikey.createdAt), desc(apikey.id))
  return rows.map((r) => {
    const meta = parseJson(r.metadata) as { createdBy?: { id?: unknown; name?: unknown } } | null
    const by = meta?.createdBy
    return {
      id: r.id,
      name: r.name,
      start: r.start,
      permissions: (parseJson(r.permissions) as Record<string, string[]> | null) ?? {},
      createdAt: r.createdAt,
      lastUsedAt: r.lastRequest,
      expiresAt: r.expiresAt,
      createdBy:
        typeof by?.id === "string" && typeof by?.name === "string"
          ? { id: by.id, name: by.name }
          : null,
    }
  })
}

/** The creating person's id and display name, for the key's metadata. */
export async function creatorOf(
  db: Database,
  userId: string,
): Promise<{ id: string; name: string }> {
  const [row] = await db
    .select({ name: user.name })
    .from(user)
    .where(and(eq(user.id, userId)))
    .limit(1)
  return { id: userId, name: row?.name ?? userId }
}
