import { createTestDb } from "@proof/db/testing"
import { agent, approval, featureFlag, member, organization, project, run, user } from "@proof/db"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  agentInOrg,
  AgentId,
  approvalInOrg,
  ApprovalId,
  callerActsFor,
  FeatureFlagKey,
  flagInOrg,
  memberInOrg,
  name,
  operatorOrg,
  OrganizationId,
  ProjectId,
  projectInOrg,
  RunId,
  runInOrg,
  UserId,
} from "./index"

const caller = (organizationId: string) => ({
  organizationId,
  actor: { type: "user" as const, userId: "u1" },
  grants: [],
  via: "session",
})

describe("callerActsFor", () => {
  it("proves only for the caller's own organization", () => {
    name(OrganizationId("org-a"), (org) => {
      expect(callerActsFor(caller("org-a"), org)?.kind).toBe("CallerActsFor")
      expect(callerActsFor(caller("org-b"), org)).toBeNull()
    })
  })
})

describe("projectInOrg (real Postgres via PGlite)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>
  beforeAll(async () => {
    t = await createTestDb()
    const now = new Date()
    await t.db.insert(organization).values([
      { id: "org-a", name: "A", slug: "a", createdAt: now },
      { id: "org-b", name: "B", slug: "b", createdAt: now },
    ])
    await t.db.insert(project).values({ id: "p1", organizationId: "org-a", name: "P" })
  })
  afterAll(() => t.close())

  const check = (projectId: string, orgId: string) =>
    name(
      ProjectId(projectId),
      OrganizationId(orgId),
      async (p, o) => (await projectInOrg(t.db, p, o))?.kind ?? null,
    )

  it("proves a project belongs to its organization", async () => {
    expect(await check("p1", "org-a")).toBe("ProjectInOrg")
  })

  it("refuses another organization's project, and missing ones", async () => {
    expect(await check("p1", "org-b")).toBeNull()
    expect(await check("nope", "org-a")).toBeNull()
  })
})

describe("agent, run, approval and member proofs (real Postgres via PGlite)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>
  beforeAll(async () => {
    t = await createTestDb()
    const now = new Date()
    await t.db.insert(organization).values([
      { id: "org-a", name: "A", slug: "a", createdAt: now },
      { id: "org-b", name: "B", slug: "b", createdAt: now },
    ])
    await t.db.insert(user).values({
      id: "u-a",
      name: "A",
      email: "a@example.com",
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    })
    await t.db.insert(member).values({
      id: "m-a",
      organizationId: "org-a",
      userId: "u-a",
      role: "member",
      createdAt: now,
    })
    await t.db.insert(agent).values({ id: "ag-a", organizationId: "org-a", name: "Triage" })
    await t.db
      .insert(run)
      .values({ id: "run-a", organizationId: "org-a", agentId: "ag-a", title: "R" })
    await t.db.insert(approval).values({
      id: "ap-a",
      organizationId: "org-a",
      runId: "run-a",
      action: "Post",
    })
  })
  afterAll(() => t.close())

  /** Each proof for the org named `orgId`, or null: the row ids are all in org-a. */
  const proofKinds = (orgId: string) =>
    name(OrganizationId(orgId), (org) =>
      name(AgentId("ag-a"), RunId("run-a"), ApprovalId("ap-a"), (ag, r, ap) =>
        name(UserId("u-a"), async (u) => ({
          agent: (await agentInOrg(t.db, ag, org))?.kind ?? null,
          run: (await runInOrg(t.db, r, org))?.kind ?? null,
          approval: (await approvalInOrg(t.db, ap, org))?.kind ?? null,
          member: (await memberInOrg(t.db, u, org))?.kind ?? null,
        })),
      ),
    )

  it("proves each row belongs to its own organization", async () => {
    expect(await proofKinds("org-a")).toEqual({
      agent: "AgentInOrg",
      run: "RunInOrg",
      approval: "ApprovalInOrg",
      member: "MemberInOrg",
    })
  })

  it("refuses another organization's rows, answering as if they were missing", async () => {
    expect(await proofKinds("org-b")).toEqual({
      agent: null,
      run: null,
      approval: null,
      member: null,
    })
  })
})

describe("operatorOrg", () => {
  it("proves only for the configured operator organization, acted for by the caller", () => {
    name(OrganizationId("org-op"), (org) => {
      expect(operatorOrg(caller("org-op"), org, "org-op")?.kind).toBe("OperatorOrg")
      // Another organization's caller, a different operator, or none configured: nothing.
      expect(operatorOrg(caller("org-b"), org, "org-op")).toBeNull()
      expect(operatorOrg(caller("org-op"), org, "org-other")).toBeNull()
      expect(operatorOrg(caller("org-op"), org, undefined)).toBeNull()
      expect(operatorOrg(caller("org-op"), org, "")).toBeNull()
    })
  })
})

describe("flagInOrg (real Postgres via PGlite)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>
  beforeAll(async () => {
    t = await createTestDb()
    const now = new Date()
    await t.db.insert(organization).values([
      { id: "org-op", name: "Op", slug: "op", createdAt: now },
      { id: "org-b", name: "B", slug: "b", createdAt: now },
    ])
    await t.db
      .insert(featureFlag)
      .values({ key: "f", organizationId: "org-op", createdAt: now, updatedAt: now })
  })
  afterAll(() => t.close())

  const check = (key: string, orgId: string) =>
    name(
      FeatureFlagKey(key),
      OrganizationId(orgId),
      async (k, o) => (await flagInOrg(t.db, k, o))?.kind ?? null,
    )

  it("proves a rollout belongs to the organization that manages it", async () => {
    expect(await check("f", "org-op")).toBe("FlagInOrg")
  })

  it("refuses another organization, and keys with no rollout", async () => {
    expect(await check("f", "org-b")).toBeNull()
    expect(await check("missing", "org-op")).toBeNull()
  })
})
