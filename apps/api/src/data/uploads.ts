// Where uploads are recorded: the URL of an organization's logo and of a person's avatar. The files
// themselves are in the file store (@proof/storage); these rows only point at them.
import type { CallerActsFor, Named, OrganizationId } from "@proof/auth-proofs"
import { type Database, organization, user } from "@proof/db"
import { eq } from "drizzle-orm"

/** Sets the organization's logo URL (null clears it) and returns the one it replaced. */
export async function setOrganizationLogo<O>(
  db: Database,
  org: Named<O, OrganizationId>,
  _proof: CallerActsFor<O>,
  logo: string | null,
): Promise<{ previous: string | null }> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ logo: organization.logo })
      .from(organization)
      .where(eq(organization.id, org.value))
      .for("update")
    await tx.update(organization).set({ logo }).where(eq(organization.id, org.value))
    return { previous: row?.logo ?? null }
  })
}

/**
 * Sets the person's own avatar URL (null clears it) and returns the one it replaced. A user is not
 * tenant data: the caller passes the signed-in person's id (requirePerson), never one from input.
 */
export async function setOwnAvatar(
  db: Database,
  userId: string,
  image: string | null,
): Promise<{ previous: string | null }> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ image: user.image })
      .from(user)
      .where(eq(user.id, userId))
      .for("update")
    await tx.update(user).set({ image }).where(eq(user.id, userId))
    return { previous: row?.image ?? null }
  })
}
