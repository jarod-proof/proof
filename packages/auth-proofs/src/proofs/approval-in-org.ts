import { defineProof, type Named, type Proof } from "@gdp-ts/core"
import { approval, type Database } from "@proof/db"
import { and, eq } from "drizzle-orm"
import type { ApprovalId, OrganizationId } from "../lib/ids"

const ApprovalInOrg = defineProof("ApprovalInOrg")
/** Approval `X` exists and belongs to organization `O`. */
export interface ApprovalInOrg<X, O> extends Proof<"ApprovalInOrg", [X, O]> {}

export async function approvalInOrg<X, O>(
  db: Database,
  id: Named<X, ApprovalId>,
  org: Named<O, OrganizationId>,
): Promise<ApprovalInOrg<X, O> | null> {
  const [row] = await db
    .select({ id: approval.id })
    .from(approval)
    .where(and(eq(approval.id, id.value), eq(approval.organizationId, org.value)))
    .limit(1)
  return row ? ApprovalInOrg.prove(id, org) : null
}
