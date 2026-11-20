// Members' security state for the Members page. better-auth's member list has no two-factor or
// activity fields, so these are read here, always filtered to the caller's organization.
import type { CallerActsFor, MemberInOrg, Named, OrganizationId, UserId } from "@proof/auth-proofs"
import { personalSlug } from "@proof/auth"
import { type Database, member, organization, session, twoFactor, user } from "@proof/db"
import { AppError } from "@proof/errors"
import { and, eq, inArray, max, ne } from "drizzle-orm"

export interface MemberSecurity {
  userId: string
  name: string
  email: string
  role: string
  twoFactorEnabled: boolean
  /** The user's latest session activity. Sessions carry no organization, so this is per user. */
  lastActiveAt: Date | null
}

export async function listMemberSecurity<O>(
  db: Database,
  org: Named<O, OrganizationId>,
  _proof: CallerActsFor<O>,
): Promise<MemberSecurity[]> {
  const rows = await db
    .select({
      userId: user.id,
      name: user.name,
      email: user.email,
      role: member.role,
      twoFactorEnabled: user.twoFactorEnabled,
    })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(eq(member.organizationId, org.value))
    .orderBy(member.createdAt, member.id)
  if (rows.length === 0) return []
  const activity = await db
    .select({ userId: session.userId, at: max(session.updatedAt) })
    .from(session)
    .where(
      inArray(
        session.userId,
        rows.map((r) => r.userId),
      ),
    )
    .groupBy(session.userId)
  const lastActive = new Map(activity.map((a) => [a.userId, a.at ? new Date(a.at) : null]))
  return rows.map((r) => ({
    userId: r.userId,
    name: r.name,
    email: r.email,
    role: r.role,
    twoFactorEnabled: r.twoFactorEnabled ?? false,
    lastActiveAt: lastActive.get(r.userId) ?? null,
  }))
}

/**
 * Turns off a member's two-factor sign-in: their authenticator and backup codes are removed, and the
 * account stops asking for a second factor. Only an owner may call it (the `twoFactor:reset` action).
 * Two-factor belongs to the account, so this is refused (CONFLICT) while the person is a member of
 * any other organization: they, or an owner of their only organization, must turn it off instead.
 * The person's own personal organization (made at sign-up, see membership.ts) doesn't count: every
 * account has one, so counting it would refuse every reset.
 */
export async function resetMemberTwoFactor<U, O>(
  db: Database,
  userId: Named<U, UserId>,
  org: Named<O, OrganizationId>,
  _proofs: { member: MemberInOrg<U, O>; actor: CallerActsFor<O> },
): Promise<void> {
  await db.transaction(async (tx) => {
    // Membership is re-checked here, so a stale proof can't reach another organization's member.
    const [inOrg] = await tx
      .select({ id: member.id })
      .from(member)
      .where(and(eq(member.userId, userId.value), eq(member.organizationId, org.value)))
      .limit(1)
    if (!inOrg) return
    const [elsewhere] = await tx
      .select({ id: member.id })
      .from(member)
      .innerJoin(organization, eq(organization.id, member.organizationId))
      .where(
        and(
          eq(member.userId, userId.value),
          ne(member.organizationId, org.value),
          ne(organization.slug, personalSlug(userId.value)),
        ),
      )
      .limit(1)
    if (elsewhere) {
      throw new AppError("CONFLICT", "This person is a member of another organization", {
        hint: "Two-factor belongs to the account, not to one organization, so it can't be turned off from here. The person should turn it off in their own security settings, or an owner of their only organization can reset it.",
      })
    }
    await tx.delete(twoFactor).where(eq(twoFactor.userId, userId.value))
    // Clear the enabled-at stamp too, or a later re-enable looks like no change (no notice, stale date).
    await tx
      .update(user)
      .set({ twoFactorEnabled: false, twoFactorEnabledAt: null })
      .where(eq(user.id, userId.value))
  })
}
