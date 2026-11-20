// What a person holding an invitation link may see before they sign in. The invitation id is the
// secret (random, sent only to the invited address), so there is no tenant proof here: nothing is
// listed, and an unknown id answers the same as one that never existed. Whether the invited address
// has an account is deliberately not said: this is readable by anyone who can invite someone.
import { invitation, type Database, organization, user } from "@proof/db"
import { eq } from "drizzle-orm"

export type InvitationPreviewStatus = "pending" | "accepted" | "rejected" | "canceled" | "expired"

export interface InvitationPreview {
  organizationName: string
  role: string
  status: InvitationPreviewStatus
  expiresAt: Date
  inviterName: string | null
  /** The invited address, only while the invitation can still be accepted. */
  email: string | null
}

/** The invitation as the link shows it, or null for an id that is not one. */
export async function invitationPreview(
  db: Database,
  invitationId: string,
  now: Date,
): Promise<InvitationPreview | null> {
  const [row] = await db
    .select({
      email: invitation.email,
      role: invitation.role,
      status: invitation.status,
      expiresAt: invitation.expiresAt,
      organizationName: organization.name,
      inviterName: user.name,
    })
    .from(invitation)
    .innerJoin(organization, eq(organization.id, invitation.organizationId))
    .leftJoin(user, eq(user.id, invitation.inviterId))
    .where(eq(invitation.id, invitationId))
    .limit(1)
  if (!row) return null

  const stored = row.status as InvitationPreviewStatus
  const status = stored === "pending" && row.expiresAt <= now ? "expired" : stored
  return {
    organizationName: row.organizationName,
    role: row.role ?? "member",
    status,
    expiresAt: row.expiresAt,
    inviterName: row.inviterName,
    email: status === "pending" ? row.email : null,
  }
}
