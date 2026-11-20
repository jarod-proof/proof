// The authorization contract, checked for every operation from its own first example, so a new
// operation is covered the day it is added:
//   - it declares permissions, or is on PUBLIC on purpose
//   - a credential with no grants gets FORBIDDEN (invoke checks permissions before input)
//   - the viewer role gets FORBIDDEN unless the operation needs only what viewers hold
//   - a caller in another organization never reaches this organization's resources: by id the
//     answer is NOT_FOUND or FORBIDDEN, and no response carries one of this organization's ids
// Path params point at real resources of the "acme" organization (the fixtures below). An operation
// under a new path prefix fails until a fixture for it is added here.
import { type AnyOperation, allowed, isEmpty, type PermissionSet } from "@proof/api"
import { roles } from "@proof/auth"
import { afterAll, describe, expect, it } from "vitest"
import { createTestApp, requestFor } from "./app.test.helpers"

/** Operations any caller may run. Add a name here deliberately, with the reason. */
const PUBLIC: ReadonlySet<string> = new Set([
  "whoami", // answers about the credential itself
  "signup", // makes the account; there is no caller yet
  "get_invitation_preview", // the invitation link is the credential; read before sign-in
  "get_upload_limits", // describes this server, no organization's data
  "set_my_avatar", // the person's own avatar; requirePerson refuses keys and tokens
  "remove_my_avatar", // likewise
  "get_my_operator_organization", // the person's own membership; requirePerson refuses keys
  "list_notifications", // the caller's own notifications in this org; the handler refuses API keys
])

type Json = Record<string, unknown>
const t = await createTestApp()
afterAll(() => t.close())

async function call(credential: string, path: string, init: RequestInit) {
  const res = await t.req(path, t.as(credential, init))
  return { status: res.status, body: (await res.json()) as Json }
}
const send = (credential: string, path: string, body: unknown, method = "POST") =>
  call(credential, path, { method, body: JSON.stringify(body) })
const idOf = (r: { status: number; body: Json }, what: string) => {
  if (r.status !== 200) throw new Error(`fixture ${what}: ${r.status} ${JSON.stringify(r.body)}`)
  return r.body.id as string
}

// acme's resources, made by its owner.
const owner = t.owner.cookie
const projectId = idOf(await send(owner, "/v1/projects", { name: "Website" }), "project")
const agentId = idOf(await send(owner, "/v1/workspace-agents", { name: "Release triage" }), "agent")
const runId = idOf(
  await send(owner, `/v1/workspace-agents/${agentId}/runs`, { title: "v2.8 triage" }),
  "run",
)
idOf(await send(owner, `/v1/runs/${runId}`, { status: "running" }, "PATCH"), "run running")
const stepId = idOf(
  await send(owner, `/v1/runs/${runId}/steps`, {
    kind: "collect",
    title: "Collect",
    status: "done",
  }),
  "step",
)
const approvalId = idOf(
  await send(owner, `/v1/runs/${runId}/approvals`, { action: "Post summary", detail: "4 themes" }),
  "approval",
)
const keyId = idOf(
  await send(owner, "/v1/api-keys", { name: "CI", permissions: { project: ["read"] } }),
  "api key",
)
// A SCIM token of acme's, minted through the plugin's server-only call (the owner's route needs a session).
const scimTokenId = (
  await t.auth.api.createSCIMManagedConnection({
    body: {
      creationRequestId: "authz-fixture-scim",
      provisioningDomainId: t.owner.orgId,
      actorId: t.owner.userId,
      scopes: ["scim.users.read", "scim.users.write", "scim.groups.read", "scim.groups.write"],
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  })
).connection.connectionId
const acmeIds = [
  scimTokenId,
  projectId,
  agentId,
  runId,
  stepId,
  approvalId,
  keyId,
  t.viewer.userId,
  t.owner.orgId,
]

/** The example's input with every path param aimed at acme's resource of that kind. */
function aimedAtAcme(op: AnyOperation, input: Json): Json {
  const params = [...op.path.matchAll(/:(\w+)/g)].map((m) => m[1] as string)
  if (params.length === 0) return input
  const fixtures: [prefix: string, values: Json][] = [
    ["/v1/projects/", { id: projectId }],
    ["/v1/workspace-agents/", { id: agentId }],
    ["/v1/runs/", { id: runId, stepId }],
    ["/v1/approvals/", { id: approvalId }],
    ["/v1/agents/", { id: `key_${keyId}` }],
    ["/v1/members/", { userId: t.viewer.userId }],
    ["/v1/scim/tokens/", { id: scimTokenId }],
    // Flags are the operator's (acme here); the target is another organization.
    ["/v1/feature-flags/", { key: "new-checkout", organization: t.other.orgId }],
  ]
  const values = fixtures.find(([prefix]) => op.path.startsWith(prefix))?.[1]
  const missing = params.filter((p) => !values || !(p in values))
  if (!values || missing.length > 0) {
    throw new Error(
      `${op.name}: no acme fixture for ${op.path} (${missing.join(", ")}); add one in authorization.test.ts`,
    )
  }
  return { ...input, ...Object.fromEntries(params.map((p) => [p, values[p]])) }
}

const example = (op: AnyOperation): Json => (op.examples?.[0]?.input ?? {}) as Json
const viewerGrants: readonly PermissionSet[] = [roles.viewer.statements as PermissionSet]

// A key in acme that grants nothing: authenticated, authorized for nothing.
const noGrants = (
  await t.auth.api.createApiKey({
    body: { organizationId: t.owner.orgId, userId: t.owner.userId, permissions: {} },
  })
).key

describe("authorization", () => {
  it("has every PUBLIC operation", () => {
    const names = t.operations.map((op) => op.name)
    for (const name of PUBLIC) expect(names).toContain(name)
  })

  describe.each(t.operations.map((op) => [op.name, op] as const))("%s", (_name, op) => {
    const request = () => requestFor(op, aimedAtAcme(op, example(op)))

    it("declares permissions unless it is public", () => {
      const why = PUBLIC.has(op.name)
        ? "is PUBLIC but requires permissions"
        : "requires no permissions: declare them, or add it to PUBLIC with a reason"
      expect(isEmpty(op.permissions), `${op.name} ${why}`).toBe(PUBLIC.has(op.name))
    })

    it.skipIf(PUBLIC.has(op.name))("refuses a credential with no grants", async () => {
      const { path, init } = request()
      const res = await call(noGrants, path, init)
      expect(res.status, JSON.stringify(res.body)).toBe(403)
      expect(res.body).toMatchObject({ error: { code: "FORBIDDEN" } })
    })

    it.skipIf(PUBLIC.has(op.name))("lets the viewer role in only to read", async () => {
      const { path, init } = request()
      const res = await call(t.viewer.cookie, path, init)
      if (allowed(viewerGrants, op.permissions)) {
        expect(res.status, JSON.stringify(res.body)).not.toBe(403)
      } else {
        expect(res.status, JSON.stringify(res.body)).toBe(403)
        expect(res.body).toMatchObject({ error: { code: "FORBIDDEN" } })
      }
    })

    it.skipIf(PUBLIC.has(op.name))(
      "keeps another organization away from acme's resources",
      async () => {
        const { path, init } = request()
        const res = await call(t.other.cookie, path, init)
        const shown = `${res.status} ${JSON.stringify(res.body)}`
        if (op.path.includes(":")) expect([403, 404], shown).toContain(res.status)
        expect(res.status, shown).toBeLessThan(500)
        const text = JSON.stringify(res.body)
        for (const acmeId of acmeIds) expect(text, `carries acme's ${acmeId}`).not.toContain(acmeId)
      },
    )
  })
})

// The fixed capability roles, each held by a real member of acme: every operation answers exactly as
// the role's statements say (allowed where they cover the operation's permissions, FORBIDDEN where
// they don't). A role added to `roles` without a row here fails the first test.
const CAPABILITY_ROLES = ["approver", "operator", "billing"] as const
const capability: Record<string, { cookie: string; grants: readonly PermissionSet[] }> = {}
for (const role of CAPABILITY_ROLES) {
  const member = await t.signUp(role)
  await t.auth.api.addMember({
    body: { organizationId: t.owner.orgId, userId: member.userId, role },
  })
  await t.auth.api.setActiveOrganization({
    headers: new Headers({ cookie: member.cookie }),
    body: { organizationId: t.owner.orgId },
  })
  capability[role] = {
    cookie: member.cookie,
    grants: [roles[role].statements as PermissionSet],
  }
}

describe("fixed capability roles", () => {
  it("are each covered by a member fixture", () => {
    expect(Object.keys(capability).sort()).toEqual([...CAPABILITY_ROLES].sort())
  })

  describe.each(
    t.operations.filter((op) => !PUBLIC.has(op.name)).map((op) => [op.name, op] as const),
  )("%s", (_name, op) => {
    it("answers each capability role by its statements", async () => {
      const { path, init } = requestFor(op, aimedAtAcme(op, example(op)))
      for (const role of CAPABILITY_ROLES) {
        const { cookie, grants } = capability[role] as (typeof capability)[string]
        const res = await call(cookie, path, init)
        const shown = `${role}: ${res.status} ${JSON.stringify(res.body)}`
        if (allowed(grants, op.permissions)) {
          expect(res.status, shown).not.toBe(403)
        } else {
          expect(res.status, shown).toBe(403)
          expect(res.body, shown).toMatchObject({ error: { code: "FORBIDDEN" } })
        }
      }
    })
  })
})
