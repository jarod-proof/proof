import { defineProof, type Named, type Proof } from "@gdp-ts/core"
import { type Database, member } from "@proof/db"
import { and, eq } from "drizzle-orm"
import type { OrganizationId, UserId } from "../lib/ids"

const MemberInOrg = defineProof("MemberInOrg")
/** User `U` is a member of organization `O`. */
export interface MemberInOrg<U, O> extends Proof<"MemberInOrg", [U, O]> {}

export async function memberInOrg<U, O>(
  db: Database,
  user: Named<U, UserId>,
  org: Named<O, OrganizationId>,
): Promise<MemberInOrg<U, O> | null> {
  const [row] = await db
    .select({ id: member.id })
    .from(member)
    .where(and(eq(member.userId, user.value), eq(member.organizationId, org.value)))
    .limit(1)
  return row ? MemberInOrg.prove(user, org) : null
}
