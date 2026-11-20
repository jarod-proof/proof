import { AgentId, agentInOrg, name } from "@proof/auth-proofs"
import { z } from "zod"

import {
  type Agent,
  type AgentActivity,
  AUTONOMY,
  type Autonomy,
  agentActivity,
  countAgents,
  createAgent,
  deleteAgent,
  getAgent,
  listAgents,
  updateAgent,
} from "../data/agents"
import { assertCapacity } from "../plan-limits"
import { inCallerOrg, orNotFound, requireInOrg } from "../tenant"
import { agentRef, defineOperation, type OperationDeps } from "./shared"

const agentSettingsInput = z.object({
  name: z.string().trim().min(1).max(100).describe("Name shown in the sidebar and the run list"),
  description: z.string().trim().max(500).nullable().optional().describe("What the agent does"),
  autonomy: z
    .enum(AUTONOMY)
    .optional()
    .describe(
      "suggest_only: it suggests and waits; ask_first: it works, then waits for approval before " +
        "anything leaves the organization; autonomous: it acts, asking only for the always-ask actions",
    ),
  alwaysAskExternalPost: z
    .boolean()
    .optional()
    .describe(
      "Posting outside the organization (guest Slack channels, email, public issues) always asks",
    ),
  alwaysAskMergeOrDeploy: z
    .boolean()
    .optional()
    .describe("Merging or deploying code always asks; agents may open pull requests"),
  alwaysAskOverEnergyBudget: z
    .boolean()
    .optional()
    .describe("Going past the run's energy budget pauses and asks instead of continuing"),
  energyBudgetWh: z
    .number()
    .positive()
    .max(1_000_000)
    .nullable()
    .optional()
    .describe("Energy budget per run, in watt-hours; null for none"),
  pinned: z.boolean().optional().describe("Pin to the sidebar"),
})

const workspaceAgentOutput = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  autonomy: z.enum(AUTONOMY),
  alwaysAskExternalPost: z.boolean(),
  alwaysAskMergeOrDeploy: z.boolean(),
  alwaysAskOverEnergyBudget: z.boolean(),
  energyBudgetWh: z.number().nullable(),
  pinned: z.boolean(),
  activity: z
    .enum(["running", "needs_you", "queued", "idle"])
    .describe("What the agent is doing now, from its open runs"),
  createdAt: z.string(),
  updatedAt: z.string(),
})

const toAgentOutput = (r: Agent, activity: AgentActivity) => ({
  id: r.id,
  name: r.name,
  description: r.description,
  autonomy: r.autonomy as Autonomy,
  alwaysAskExternalPost: r.alwaysAskExternalPost,
  alwaysAskMergeOrDeploy: r.alwaysAskMergeOrDeploy,
  alwaysAskOverEnergyBudget: r.alwaysAskOverEnergyBudget,
  energyBudgetWh: r.energyBudgetWh,
  pinned: r.pinned,
  activity,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
})

export function workspaceAgentOperations({
  auth,
  db,
  now,
}: Pick<OperationDeps, "auth" | "db" | "now">) {
  const list_agents = defineOperation({
    name: "list_agents",
    method: "GET",
    path: "/v1/workspace-agents",
    summary: "List the workspace agents and what each is doing",
    description:
      "Lists the workers this organization has configured (for example a release-triage agent), with " +
      "their settings and what each is doing now: running, needs_you (waiting for an approval), queued " +
      "or idle. These are not the AI clients connected to the organization (those are list_connected_agents, " +
      "which lists credentials). Use an id with get_agent, start_run or list_runs.",
    permissions: { agent: ["read"] },
    input: z.object({}),
    output: z.object({ agents: z.array(workspaceAgentOutput) }),
    hints: { readOnly: true, idempotent: true },
    examples: [{ input: {} }],
    handler: (_input, { caller }) =>
      inCallerOrg(caller, async (org, proof) => {
        const rows = await listAgents(db, org, proof)
        const activity = await agentActivity(
          db,
          org,
          proof,
          rows.map((r) => r.id),
        )
        return { agents: rows.map((r) => toAgentOutput(r, activity.get(r.id) ?? "idle")) }
      }),
  })

  const get_agent = defineOperation({
    name: "get_agent",
    method: "GET",
    path: "/v1/workspace-agents/:id",
    summary: "Get one workspace agent and its settings",
    description:
      "Returns one workspace agent: its name, autonomy, the actions that always need a person's approval, " +
      "its energy budget, whether it is pinned, and what it is doing now. Returns NOT_FOUND for ids " +
      "outside this organization. Use the id with update_agent, start_run or list_runs.",
    permissions: { agent: ["read"] },
    input: agentRef,
    output: workspaceAgentOutput,
    hints: { readOnly: true, idempotent: true },
    examples: [{ input: { id: "00000000-0000-0000-0000-000000000000" }, error: "NOT_FOUND" }],
    handler: ({ id }, { caller }) =>
      inCallerOrg(caller, (org, proof) =>
        name(AgentId(id), async (agentId) => {
          const inOrg = await requireInOrg(agentInOrg, db, agentId, org, "Agent")
          const row = orNotFound(await getAgent(db, agentId, org, inOrg), "Agent")
          const activity = await agentActivity(db, org, proof, [id])
          return toAgentOutput(row, activity.get(id) ?? "idle")
        }),
      ),
  })

  const create_agent = defineOperation({
    name: "create_agent",
    method: "POST",
    path: "/v1/workspace-agents",
    summary: "Create a workspace agent",
    description:
      "Creates a workspace agent in the caller's organization. Defaults: ask_first autonomy, and the three " +
      "always-ask actions on. Start its work with start_run. Returns the agent. The plan limits how " +
      "many agents an organization has (Free: 2); over it the call is FORBIDDEN, and the hint names " +
      "the plan that allows more.",
    permissions: { agent: ["create"] },
    hints: { readOnly: false, destructive: false },
    input: agentSettingsInput,
    output: workspaceAgentOutput,
    examples: [{ input: { name: "Release triage", description: "Groups release blockers" } }],
    handler: (input, { caller }) =>
      inCallerOrg(caller, async (org, proof) => {
        // Capacity: a count the app supplies (entitlements' checkCapacity). Two concurrent creates
        // can both pass at the limit; the plan is a commercial limit, not a security one.
        const count = await countAgents(db, org, proof)
        assertCapacity(
          await auth.entitlements.checkCapacity(caller.organizationId, "agents", { count }),
          "agents",
        )
        const row = await createAgent(db, org, proof, input, now())
        return toAgentOutput(row, "idle")
      }),
  })

  const update_agent = defineOperation({
    name: "update_agent",
    method: "PATCH",
    path: "/v1/workspace-agents/:id",
    summary: "Change a workspace agent's settings",
    description:
      "Changes the given settings of a workspace agent: name, description, autonomy, the three always-ask " +
      "actions, the energy budget, and pinned. Omitted settings stay as they are. Returns the agent, or " +
      "NOT_FOUND for ids outside this organization. Changing autonomy or the always-ask actions changes what " +
      "agents may do without asking: confirm with the user first.",
    permissions: { agent: ["update"] },
    hints: { readOnly: false, destructive: true, idempotent: true },
    input: agentRef.extend(agentSettingsInput.partial().shape),
    output: workspaceAgentOutput,
    examples: [
      {
        input: { id: "00000000-0000-0000-0000-000000000000", pinned: true },
        error: "NOT_FOUND",
      },
    ],
    handler: ({ id, ...patch }, { caller }) =>
      inCallerOrg(caller, (org, proof) =>
        name(AgentId(id), async (agentId) => {
          const inOrg = await requireInOrg(agentInOrg, db, agentId, org, "Agent")
          const row = orNotFound(
            await updateAgent(db, agentId, org, { inOrg, actor: proof }, patch, now()),
            "Agent",
          )
          const activity = await agentActivity(db, org, proof, [id])
          return toAgentOutput(row, activity.get(id) ?? "idle")
        }),
      ),
  })

  const delete_agent = defineOperation({
    name: "delete_agent",
    method: "DELETE",
    path: "/v1/workspace-agents/:id",
    summary: "Delete a workspace agent and all of its runs",
    description:
      "Permanently deletes a workspace agent together with its runs, their steps, approvals and messages. " +
      "Returns NOT_FOUND for ids outside this organization. Confirm with the user before calling: the " +
      "history can't be recovered.",
    permissions: { agent: ["delete"] },
    input: agentRef,
    output: z.object({ deleted: z.literal(true) }),
    hints: { readOnly: false, destructive: true },
    examples: [{ input: { id: "00000000-0000-0000-0000-000000000000" }, error: "NOT_FOUND" }],
    handler: ({ id }, { caller }) =>
      inCallerOrg(caller, (org, proof) =>
        name(AgentId(id), async (agentId) => {
          const inOrg = await requireInOrg(agentInOrg, db, agentId, org, "Agent")
          await deleteAgent(db, agentId, org, { inOrg, actor: proof })
          return { deleted: true as const }
        }),
      ),
  })

  return {
    list_agents,
    get_agent,
    create_agent,
    update_agent,
    delete_agent,
  }
}
