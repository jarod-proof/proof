import { allowed, covers, type PermissionSet } from "@proof/api"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createTestAuth } from "./auth.test.helpers"
import {
  narrow,
  OAUTH_EXCLUDED,
  OAUTH_SCOPE_GRANTS,
  OWNER_ONLY_RESOURCES,
  PERSON_ONLY_ACTIONS,
  PERSON_ONLY_RESOURCES,
  rolePermissions,
  roles,
  scopePermissions,
  statements,
} from "./permissions"

const everyAction = Object.entries(statements).flatMap(([resource, actions]) =>
  actions.map((action) => ({ [resource]: [action] }) as PermissionSet),
)

describe("rolePermissions matches better-auth's hasPermission (real Postgres via PGlite)", () => {
  let t: Awaited<ReturnType<typeof createTestAuth>>
  let orgId: string
  const cookies: Record<string, string> = {}
  const ROLES = [
    ...Object.keys(roles),
    "admin,member",
    "viewer,member",
    "viewer,approver",
    "operator,billing",
    "unknown",
  ]

  beforeAll(async () => {
    t = await createTestAuth()
    const owner = await t.signUp("Owner")
    orgId = owner.orgId
    // One member per role takes more seats than Free's 3 (viewers are free; the rest aren't).
    await t.onPlan(orgId, "team")
    cookies.owner = owner.cookie
    for (const role of ROLES.filter((r) => r !== "owner")) {
      const u = await t.signUp(role)
      await t.addMember(orgId, u.userId, role)
      cookies[role] = u.cookie
    }
  })
  afterAll(() => t.close())

  const better = async (role: string, permissions: PermissionSet) => {
    const res = await t.auth.api.hasPermission({
      headers: new Headers({ cookie: cookies[role] ?? "" }),
      body: { organizationId: orgId, permissions: permissions as never },
    })
    return res.success
  }

  it.each(ROLES)("agrees on every single action for %s", async (role) => {
    for (const need of everyAction) {
      expect(allowed(rolePermissions(role), need), `${role} ${JSON.stringify(need)}`).toBe(
        await better(role, need),
      )
    }
  })

  it("agrees that a multi-role member needs one role covering the whole request", async () => {
    // member can create projects, viewer can only read: no single role of "viewer,member" can
    // both create a project and update the org, and admin can't delete the org.
    const requests: PermissionSet[] = [
      { project: ["create", "read"] },
      { project: ["create"], organization: ["update"] },
      { project: ["read"], ac: ["read"] },
      { organization: ["update", "delete"] },
    ]
    for (const role of ROLES) {
      for (const need of requests) {
        expect(allowed(rolePermissions(role), need), `${role} ${JSON.stringify(need)}`).toBe(
          await better(role, need),
        )
      }
    }
  })
})

describe("fixed capability roles", () => {
  it("grant exactly the permissions their statements list", () => {
    expect(roles.approver.statements).toEqual({
      run: ["read", "approve"],
      project: ["read"],
      agent: ["read"],
      entitlements: ["read"],
    })
    expect(roles.operator.statements).toEqual({
      project: ["read"],
      agent: ["read"],
      run: ["create", "read", "update", "steer"],
      entitlements: ["read"],
    })
    expect(roles.billing.statements).toEqual({
      subscription: ["read", "update"],
      entitlements: ["read"],
    })
  })

  it("let an approver approve but not steer, start or change anything", () => {
    const grants = rolePermissions("approver")
    expect(allowed(grants, { run: ["approve"] })).toBe(true)
    expect(allowed(grants, { run: ["read", "approve"] })).toBe(true)
    for (const need of [
      { run: ["create"] },
      { run: ["steer"] },
      { agent: ["update"] },
    ] as PermissionSet[]) {
      expect(allowed(grants, need), JSON.stringify(need)).toBe(false)
    }
  })

  it("let an operator run and steer, but never approve or change agents", () => {
    const grants = rolePermissions("operator")
    expect(allowed(grants, { run: ["create", "steer"] })).toBe(true)
    for (const need of [
      { run: ["approve"] },
      { agent: ["create"] },
      { apiKey: ["read"] },
    ] as PermissionSet[]) {
      expect(allowed(grants, need), JSON.stringify(need)).toBe(false)
    }
  })

  it("let billing manage the subscription and nothing else", () => {
    const grants = rolePermissions("billing")
    expect(allowed(grants, { subscription: ["read", "update"] })).toBe(true)
    for (const need of [
      { project: ["read"] },
      { member: ["read"] },
      { run: ["read"] },
    ] as PermissionSet[]) {
      expect(allowed(grants, need), JSON.stringify(need)).toBe(false)
    }
  })

  it("never reach an agent credential: no OAuth scope grants approve or subscription", () => {
    const everyScope = scopePermissions(Object.keys(OAUTH_SCOPE_GRANTS))
    expect(allowed([everyScope], { run: ["approve"] })).toBe(false)
    expect(allowed([everyScope], { subscription: ["read"] })).toBe(false)
  })

  it("hold person-only permissions only where intended: approve for approvers, billing for billing", () => {
    // create_api_key refuses these for keys, and no OAuth scope reaches them. The roles that hold
    // them are people's roles; no other fixed role may pick them up by accident.
    for (const name of ["approver", "operator", "billing"] as const) {
      for (const resource of PERSON_ONLY_RESOURCES) {
        const reaches = allowed(rolePermissions(name), {
          [resource]: [statements[resource][0]],
        } as PermissionSet)
        expect(reaches, `${name} ${resource}`).toBe(
          name === "billing" && resource === "subscription",
        )
      }
    }
    expect(allowed(rolePermissions("operator"), { run: ["approve"] })).toBe(false)
    expect(allowed(rolePermissions("billing"), { run: ["approve"] })).toBe(false)
  })
})

describe("OAuth scopes", () => {
  it("reach every catalog action, except the deliberately excluded ones", () => {
    const reachable = scopePermissions(Object.keys(OAUTH_SCOPE_GRANTS))
    for (const need of everyAction) {
      const excluded = covers(OAUTH_EXCLUDED as PermissionSet, need)
      expect(covers(reachable, need), JSON.stringify(need)).toBe(!excluded)
    }
  })

  it("keeps the person-only actions the trust rules name (a key never holds them)", () => {
    // Pinned by name: OAUTH_EXCLUDED drops every hq resource whole, so the test below can't tell
    // when one of these entries is removed.
    expect(PERSON_ONLY_ACTIONS.run).toEqual(["approve"])
    expect(PERSON_ONLY_ACTIONS.entitlements).toEqual(["override"])
    expect(PERSON_ONLY_ACTIONS.hq_entry).toEqual(["update"])
    expect(PERSON_ONLY_ACTIONS.hq_proposal).toEqual(["decide"])
    expect(PERSON_ONLY_ACTIONS.hq_spend).toEqual(["grant"])
  })

  it("lets a key record spend (reserve, settle, record) but never grant it", () => {
    expect(statements.hq_spend).toContain("record")
    expect(PERSON_ONLY_ACTIONS.hq_spend).not.toContain("record")
  })

  it("lets a key ask for a spend grant (request), which grants nothing, but never grant it", () => {
    expect(statements.hq_spend).toContain("request")
    expect(PERSON_ONLY_ACTIONS.hq_spend).not.toContain("request")
    expect(PERSON_ONLY_ACTIONS.hq_spend).toContain("grant")
  })

  it("exclude every action of the person-only resources and actions", () => {
    for (const resource of PERSON_ONLY_RESOURCES) {
      for (const action of statements[resource]) {
        expect(covers(OAUTH_EXCLUDED as PermissionSet, { [resource]: [action] })).toBe(true)
      }
    }
    for (const [resource, actions] of Object.entries(PERSON_ONLY_ACTIONS)) {
      for (const action of actions) {
        expect(covers(OAUTH_EXCLUDED as PermissionSet, { [resource]: [action] })).toBe(true)
      }
    }
  })

  it("keep the owner-only resources out of the admin role", () => {
    for (const resource of OWNER_ONLY_RESOURCES) {
      const need = { [resource]: [statements[resource][0]] } as PermissionSet
      expect(allowed(rolePermissions("owner"), need)).toBe(true)
      expect(allowed(rolePermissions("admin"), need)).toBe(false)
    }
  })

  it("ignore non-permission scopes like openid", () => {
    expect(scopePermissions(["openid", "offline_access"])).toEqual({})
    expect(scopePermissions(["read"])).toEqual({
      project: ["read"],
      apiKey: ["read"],
      agent: ["read"],
      run: ["read"],
      featureFlag: ["read"],
      entitlements: ["read"],
    })
  })

  it("narrow each role to the token's scopes, dropping roles left with nothing", () => {
    const grants = narrow(rolePermissions("viewer,member"), scopePermissions(["read"]))
    const read = { agent: ["read"], project: ["read"], run: ["read"], entitlements: ["read"] }
    expect(grants).toEqual([read, { apiKey: ["read"], ...read }])
    expect(narrow(rolePermissions("viewer"), scopePermissions(["admin"]))).toEqual([])
  })
})
