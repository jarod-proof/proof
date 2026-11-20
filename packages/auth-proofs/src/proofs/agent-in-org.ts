import { defineProof, type Named, type Proof } from "@gdp-ts/core"
import { agent, type Database } from "@proof/db"
import { and, eq } from "drizzle-orm"
import type { AgentId, OrganizationId } from "../lib/ids"

const AgentInOrg = defineProof("AgentInOrg")
/** Workspace agent `A` exists and belongs to organization `O`. */
export interface AgentInOrg<A, O> extends Proof<"AgentInOrg", [A, O]> {}

export async function agentInOrg<A, O>(
  db: Database,
  id: Named<A, AgentId>,
  org: Named<O, OrganizationId>,
): Promise<AgentInOrg<A, O> | null> {
  const [row] = await db
    .select({ id: agent.id })
    .from(agent)
    .where(and(eq(agent.id, id.value), eq(agent.organizationId, org.value)))
    .limit(1)
  return row ? AgentInOrg.prove(id, org) : null
}
