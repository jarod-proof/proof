import { paginated, paginationInput } from "@proof/api"
import { ProjectId, name, projectInOrg } from "@proof/auth-proofs"
import { z } from "zod"

import { createProject, deleteProject, listProjects } from "../data/projects"
import { inCallerOrg, requireInOrg } from "../tenant"
import { cut, defineOperation, type OperationDeps, readCursor } from "./shared"

const projectOutput = z.object({ id: z.string(), name: z.string(), createdAt: z.string() })
const toOutput = (p: { id: string; name: string; createdAt: Date }) => ({
  id: p.id,
  name: p.name,
  createdAt: p.createdAt.toISOString(),
})

export function projectOperations({ db }: Pick<OperationDeps, "db">) {
  const list_projects = defineOperation({
    name: "list_projects",
    method: "GET",
    path: "/v1/projects",
    summary: "List the organization's projects",
    description:
      "Returns the organization's projects, oldest first, one page at a time. Pass nextCursor back " +
      "as cursor to get the next page; it is null on the last page. Use the ids with delete_project.",
    permissions: { project: ["read"] },
    input: paginationInput,
    output: paginated("projects", projectOutput),
    hints: { readOnly: true, idempotent: true },
    examples: [{ input: {} }],
    handler: (input, { caller }) =>
      inCallerOrg(caller, async (org, proof) => {
        const rows = await listProjects(db, org, proof, {
          after: readCursor(input.cursor),
          limit: input.limit + 1,
        })
        const { page, nextCursor } = cut(rows, input.limit, (p) => p.createdAt)
        return { projects: page.map(toOutput), nextCursor }
      }),
  })

  const create_project = defineOperation({
    name: "create_project",
    method: "POST",
    path: "/v1/projects",
    summary: "Create a project",
    description: "Creates a project in the caller's organization and returns it.",
    permissions: { project: ["create"] },
    hints: { readOnly: false, destructive: false },
    input: z.object({ name: z.string().trim().min(1).max(100).describe("Project name") }),
    output: projectOutput,
    examples: [{ input: { name: "Website" } }],
    handler: ({ name: projectName }, { caller }) =>
      inCallerOrg(caller, async (org, proof) =>
        toOutput(await createProject(db, org, { name: projectName }, proof)),
      ),
  })

  const delete_project = defineOperation({
    name: "delete_project",
    method: "DELETE",
    path: "/v1/projects/:id",
    summary: "Delete a project",
    description:
      "Permanently deletes a project in the caller's organization. Returns NOT_FOUND for ids that " +
      "don't exist or belong to another organization. Confirm with the user before calling.",
    permissions: { project: ["delete"] },
    input: z.object({ id: z.string().describe("Project id from list_projects") }),
    output: z.object({ deleted: z.literal(true) }),
    hints: { readOnly: false, destructive: true },
    examples: [{ input: { id: "00000000-0000-0000-0000-000000000000" }, error: "NOT_FOUND" }],
    handler: ({ id }, { caller }) =>
      inCallerOrg(caller, (org, actor) =>
        name(ProjectId(id), async (projectId) => {
          // Same answer for "missing" and "another org's": existence must not leak across tenants.
          const inOrg = await requireInOrg(projectInOrg, db, projectId, org, "Project")
          await deleteProject(db, projectId, org, { inOrg, actor })
          return { deleted: true as const }
        }),
      ),
  })

  return {
    list_projects,
    create_project,
    delete_project,
  }
}
