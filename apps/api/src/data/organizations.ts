// Organization facts the API needs that carry no tenant data: read by organization id, so no proof.
import { type Database, member, organization, user } from "@proof/db"
import { and, eq } from "drizzle-orm"

/** Whether an owner of the organization has verified their email: the organization is "claimed". */
export async function organizationClaimed(db: Database, organizationId: string): Promise<boolean> {
  const owners = await db
    .select({ verified: user.emailVerified })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(and(eq(member.organizationId, organizationId), eq(member.role, "owner")))
  return owners.some((o) => o.verified === true)
}

/** The organization's id, slug and name, for notification links and copy; null once it is gone. */
export async function organizationRef(
  db: Database,
  organizationId: string,
): Promise<{ id: string; slug: string; name: string } | null> {
  const [row] = await db
    .select({ id: organization.id, slug: organization.slug, name: organization.name })
    .from(organization)
    .where(eq(organization.id, organizationId))
    .limit(1)
  return row ?? null
}
