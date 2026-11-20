// Workspace agents: the configured workers of an organization and their settings. Every function
// takes the organization as a Named id plus a proof, and still filters by organizationId in SQL.
import type { AgentId, AgentInOrg, CallerActsFor, Named, OrganizationId } from "@proof/auth-proofs"
import { AppError } from "@proof/errors"
import { type Database, agent, run } from "@proof/db"
import { and, asc, eq, inArray } from "drizzle-orm"

export type Agent = typeof agent.$inferSelect

export const AUTONOMY = ["suggest_only", "ask_first", "autonomous"] as const
export type Autonomy = (typeof AUTONOMY)[number]

export interface AgentSettings {
  name?: string
  description?: string | null
  autonomy?: Autonomy
  alwaysAskExternalPost?: boolean
  alwaysAskMergeOrDeploy?: boolean
  alwaysAskOverEnergyBudget?: boolean
  energyBudgetWh?: number | null
  pinned?: boolean
}

export async function listAgents<O>(
  db: Database,
  org: Named<O, OrganizationId>,
  _proof: CallerActsFor<O>,
): Promise<Agent[]> {
  return db
    .select()
    .from(agent)
    .where(eq(agent.organizationId, org.value))
    .orderBy(asc(agent.createdAt), asc(agent.id))
}

/** How many workspace agents the organization has (the plan's `agents` limit counts them). */
export async function countAgents<O>(
  db: Database,
  org: Named<O, OrganizationId>,
  _proof: CallerActsFor<O>,
): Promise<number> {
  return db.$count(agent, eq(agent.organizationId, org.value))
}

export async function createAgent<O>(
  db: Database,
  org: Named<O, OrganizationId>,
  _proof: CallerActsFor<O>,
  input: AgentSettings & { name: string },
  now: Date,
): Promise<Agent> {
  const [row] = await db
    .insert(agent)
    .values({
      id: crypto.randomUUID(),
      organizationId: org.value,
      name: input.name,
      description: input.description ?? null,
      autonomy: input.autonomy ?? "ask_first",
      alwaysAskExternalPost: input.alwaysAskExternalPost ?? true,
      alwaysAskMergeOrDeploy: input.alwaysAskMergeOrDeploy ?? true,
      alwaysAskOverEnergyBudget: input.alwaysAskOverEnergyBudget ?? true,
      energyBudgetWh: input.energyBudgetWh ?? null,
      pinned: input.pinned ?? false,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
  if (!row) throw new AppError("INTERNAL", "insert returned no row")
  return row
}

export async function updateAgent<A, O>(
  db: Database,
  id: Named<A, AgentId>,
  org: Named<O, OrganizationId>,
  _proofs: { inOrg: AgentInOrg<A, O>; actor: CallerActsFor<O> },
  patch: AgentSettings,
  now: Date,
): Promise<Agent | undefined> {
  const [row] = await db
    .update(agent)
    .set({ ...patch, updatedAt: now })
    .where(and(eq(agent.id, id.value), eq(agent.organizationId, org.value)))
    .returning()
  return row
}

export async function deleteAgent<A, O>(
  db: Database,
  id: Named<A, AgentId>,
  org: Named<O, OrganizationId>,
  _proofs: { inOrg: AgentInOrg<A, O>; actor: CallerActsFor<O> },
): Promise<void> {
  // Runs, their steps, approvals and messages go with it (ON DELETE CASCADE).
  await db.delete(agent).where(and(eq(agent.id, id.value), eq(agent.organizationId, org.value)))
}

/** What each agent is doing right now, from its open runs (idle when it has none). */
export type AgentActivity = "running" | "needs_you" | "queued" | "idle"

export async function agentActivity<O>(
  db: Database,
  org: Named<O, OrganizationId>,
  _proof: CallerActsFor<O>,
  agentIds: readonly string[],
): Promise<Map<string, AgentActivity>> {
  const out = new Map<string, AgentActivity>()
  if (agentIds.length === 0) return out
  const open = await db
    .select({ agentId: run.agentId, status: run.status })
    .from(run)
    .where(
      and(
        eq(run.organizationId, org.value),
        inArray(run.agentId, [...agentIds]),
        inArray(run.status, ["queued", "running", "needs_you"]),
      ),
    )
  // needs_you outranks running, which outranks queued.
  const rank: Record<AgentActivity, number> = { idle: 0, queued: 1, running: 2, needs_you: 3 }
  for (const row of open) {
    const next = row.status as AgentActivity
    const current = out.get(row.agentId) ?? "idle"
    if (rank[next] > rank[current]) out.set(row.agentId, next)
  }
  return out
}

/** One workspace agent in this organization, or undefined when it is not (or no longer) there. */
export async function getAgent<A, O>(
  db: Database,
  id: Named<A, AgentId>,
  org: Named<O, OrganizationId>,
  _proof: AgentInOrg<A, O>,
): Promise<Agent | undefined> {
  const [row] = await db
    .select()
    .from(agent)
    .where(and(eq(agent.id, id.value), eq(agent.organizationId, org.value)))
    .limit(1)
  return row
}
