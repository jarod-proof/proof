import type { PermissionSet } from "@proof/api"
import type { DBAdapter } from "better-auth"

import { rolePermissions } from "./permissions"

export interface Member {
  id: string
  organizationId: string
  userId: string
  role: string
}

export type Adapter = Pick<
  DBAdapter,
  "findOne" | "findMany" | "create" | "count" | "updateMany" | "deleteMany"
>

/** The member row tying a user to an organization, or null when they don't belong to it. */
export function findMember(db: Adapter, userId: string, organizationId: string) {
  return db.findOne<Member>({
    model: "member",
    where: [
      { field: "userId", value: userId },
      { field: "organizationId", value: organizationId },
    ],
  })
}

/**
 * The permission sets a member's roles grant in an organization (one per role, see
 * rolePermissions), or null when the user isn't a member. Membership is read live, so a removed
 * member gets null at once.
 */
export async function memberGrants(
  db: Adapter,
  userId: string,
  organizationId: string,
): Promise<PermissionSet[] | null> {
  const member = await findMember(db, userId, organizationId)
  return member ? rolePermissions(member.role) : null
}

/** The user's oldest membership, used as the default active organization. */
export async function firstMembership(db: Adapter, userId: string): Promise<Member | null> {
  const [member] = await db.findMany<Member>({
    model: "member",
    where: [{ field: "userId", value: userId }],
    sortBy: { field: "createdAt", direction: "asc" },
    limit: 1,
  })
  return member ?? null
}

/** Personal organizations' slugs start with this; no one can choose such a slug (index.ts). */
export const PERSONAL_SLUG_PREFIX = "personal-"

/** The slug of a user's personal organization. The only way to tell one apart: it is never user-chosen. */
export const personalSlug = (userId: string) => `${PERSONAL_SLUG_PREFIX}${userId.toLowerCase()}`

/**
 * Create the user's personal organization, with them as owner, and make it the active org of their
 * sessions. better-auth runs user after-hooks once the signup transaction commits, so the signup
 * session already exists without an active organization.
 */
export async function personalOrganization(db: Adapter, user: { id: string; name?: string }) {
  const now = new Date()
  const org = await db.create<{ name: string; slug: string; createdAt: Date }, { id: string }>({
    model: "organization",
    data: {
      name: user.name ? `${user.name}'s workspace` : "Personal workspace",
      slug: personalSlug(user.id),
      createdAt: now,
    },
  })
  await db.create({
    model: "member",
    data: { organizationId: org.id, userId: user.id, role: "owner", createdAt: now },
  })
  await db.updateMany({
    model: "session",
    where: [{ field: "userId", value: user.id }],
    update: { activeOrganizationId: org.id },
  })
  return org.id
}
