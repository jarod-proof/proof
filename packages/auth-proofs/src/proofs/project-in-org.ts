import { defineProof, type Named, type Proof } from "@gdp-ts/core"
import { type Database, project } from "@proof/db"
import { and, eq } from "drizzle-orm"
import type { OrganizationId, ProjectId } from "../lib/ids"

const ProjectInOrg = defineProof("ProjectInOrg")
/** Project `P` exists and belongs to organization `O`. */
export interface ProjectInOrg<P, O> extends Proof<"ProjectInOrg", [P, O]> {}

export async function projectInOrg<P, O>(
  db: Database,
  id: Named<P, ProjectId>,
  org: Named<O, OrganizationId>,
): Promise<ProjectInOrg<P, O> | null> {
  const [row] = await db
    .select({ id: project.id })
    .from(project)
    .where(and(eq(project.id, id.value), eq(project.organizationId, org.value)))
    .limit(1)
  return row ? ProjectInOrg.prove(id, org) : null
}
