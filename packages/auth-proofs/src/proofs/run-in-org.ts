import { defineProof, type Named, type Proof } from "@gdp-ts/core"
import { type Database, run } from "@proof/db"
import { and, eq } from "drizzle-orm"
import type { OrganizationId, RunId } from "../lib/ids"

const RunInOrg = defineProof("RunInOrg")
/** Run `R` exists and belongs to organization `O`. */
export interface RunInOrg<R, O> extends Proof<"RunInOrg", [R, O]> {}

export async function runInOrg<R, O>(
  db: Database,
  id: Named<R, RunId>,
  org: Named<O, OrganizationId>,
): Promise<RunInOrg<R, O> | null> {
  const [row] = await db
    .select({ id: run.id })
    .from(run)
    .where(and(eq(run.id, id.value), eq(run.organizationId, org.value)))
    .limit(1)
  return row ? RunInOrg.prove(id, org) : null
}
