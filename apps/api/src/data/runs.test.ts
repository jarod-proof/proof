// The approval state changes are single conditional writes: of two decisions made at once, one wins.
// The agent's view of an approval is pending until its decision is effective.
import {
  ApprovalId,
  approvalInOrg,
  name,
  OrganizationId,
  RunId,
  runInOrg,
} from "@proof/auth-proofs"
import { agent, approval, organization, run } from "@proof/db"
import { createTestDb } from "@proof/db/testing"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { approvalView, blockingApprovals, decideApproval, undoApproval } from "./runs"

const T0 = new Date("2026-10-16T12:00:00Z")
const later = (s: number) => new Date(T0.getTime() + s * 1000)

describe("approvals in the database (real Postgres via PGlite)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>
  beforeAll(async () => {
    t = await createTestDb()
    await t.db.insert(organization).values({ id: "org-a", name: "A", slug: "a", createdAt: T0 })
    await t.db.insert(agent).values({ id: "ag", organizationId: "org-a", name: "Triage" })
    await t.db.insert(run).values({
      id: "run",
      organizationId: "org-a",
      agentId: "ag",
      title: "R",
      status: "needs_you",
    })
    await t.db.insert(approval).values({
      id: "ap-1",
      organizationId: "org-a",
      runId: "run",
      action: "Post",
      requestedAt: T0,
    })
    await t.db.insert(approval).values({
      id: "ap-2",
      organizationId: "org-a",
      runId: "run",
      action: "Merge",
      requestedAt: T0,
    })
  })
  afterAll(() => t.close())

  it("lets exactly one of two simultaneous decisions through", async () => {
    const results = await name(OrganizationId("org-a"), (org) =>
      name(ApprovalId("ap-2"), async (id) => {
        const inOrg = await approvalInOrg(t.db, id, org)
        if (!inOrg) throw new Error("setup")
        return Promise.allSettled([
          decideApproval(t.db, id, org, inOrg, "approve", "u1", T0),
          decideApproval(t.db, id, org, inOrg, "deny", "u2", T0),
        ])
      }),
    )
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"])
    const rejected = results.find((r) => r.status === "rejected")
    expect(rejected && (rejected.reason as Error).message).toContain("no longer pending")
  })

  it("keeps an approval blocking the agent until its decision is effective", async () => {
    await name(OrganizationId("org-a"), (org) =>
      name(ApprovalId("ap-1"), async (id) => {
        const inOrg = await approvalInOrg(t.db, id, org)
        if (!inOrg) throw new Error("setup")
        await decideApproval(t.db, id, org, inOrg, "approve", "u1", T0)
        const [row] = await t.db.select().from(approval).where(eqId("ap-1"))
        if (!row) throw new Error("row")
        expect(blockingApprovals([row], later(29))).toHaveLength(1)
        expect(blockingApprovals([row], later(30))).toHaveLength(0)
        expect(approvalView(row, later(29), "agent")).toMatchObject({
          status: "pending",
          decision: null,
        })
        expect(approvalView(row, later(29), "person")).toMatchObject({
          status: "approved",
          decision: { undoableUntil: later(30).toISOString() },
        })
        expect(approvalView(row, later(30), "agent")).toMatchObject({ status: "approved" })
        expect(approvalView(row, later(30), "person").decision?.undoableUntil).toBeNull()
      }),
    )
  })

  it("undoes only before the decision is effective, back to pending", async () => {
    await name(OrganizationId("org-a"), (org) =>
      name(ApprovalId("ap-1"), async (id) => {
        const inOrg = await approvalInOrg(t.db, id, org)
        if (!inOrg) throw new Error("setup")
        await expect(undoApproval(t.db, id, org, inOrg, later(30))).rejects.toThrow(
          "undo window has closed",
        )
        const back = await undoApproval(t.db, id, org, inOrg, later(29))
        expect(back).toMatchObject({ status: "pending", decidedBy: null, undoneAt: later(29) })
      }),
    )
  })
})

const eqId = (id: string) => eq(approval.id, id)

describe("runs in the database", () => {
  it("proves a run exists in its own organization", async () => {
    const t = await createTestDb()
    try {
      await t.db.insert(organization).values({ id: "org-b", name: "B", slug: "b", createdAt: T0 })
      await t.db.insert(agent).values({ id: "ag-b", organizationId: "org-b", name: "T" })
      await t.db.insert(run).values({
        id: "run-b",
        organizationId: "org-b",
        agentId: "ag-b",
        title: "R",
        status: "done",
      })
      const found = await name(OrganizationId("org-b"), (org) =>
        name(RunId("run-b"), async (id) => (await runInOrg(t.db, id, org))?.kind ?? null),
      )
      expect(found).toBe("RunInOrg")
    } finally {
      await t.close()
    }
  })
})
