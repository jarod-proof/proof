import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { createHqTestDb } from "../testing"
import { editEntry, getEntry, getEntryHistory } from "./entries"
import { createProposal, decideProposal, getProposal, listProposals } from "./proposals"

const agent = { type: "agent", id: "key_1" } as const
const founder = { type: "person", id: "user_founder" } as const
const t0 = new Date("2026-11-17T12:00:00Z")
const later = (minutes: number) => new Date(t0.getTime() + minutes * 60_000)

describe("proposals (real Postgres via PGlite)", () => {
  let test: Awaited<ReturnType<typeof createHqTestDb>>
  beforeAll(async () => {
    test = await createHqTestDb()
  })
  afterAll(() => test.close())

  const propose = (
    slug: string,
    text: string,
    extra: { baseVersion?: number; runId?: string } = {},
  ) =>
    createProposal(test.db, {
      kind: "fact",
      slug,
      title: slug,
      body: { text },
      reason: "because",
      proposer: agent,
      now: t0,
      ...extra,
    })

  const decide = (proposalId: string, decision: "approve" | "reject", minutes = 1) =>
    decideProposal(test.db, { proposalId, decision, decidedBy: founder.id, now: later(minutes) })

  it("approve writes the proposal as a new version authored by the proposer, approved by the founder", async () => {
    const created = await propose("pricing", "Free, then $20.", { runId: "run_7" })
    expect(created.status).toBe("pending")
    // Pending changes nothing.
    expect(await listProposals(test.db, { status: "pending", limit: 10 })).toHaveLength(1)

    const decision = await decide(created.id, "approve")
    expect(decision).toMatchObject({ status: "approved", version: 1 })
    const entryId = decision.entryId ?? ""

    const v1 = await getEntry(test.db, entryId)
    expect(v1).toMatchObject({
      version: 1,
      title: "pricing",
      body: { text: "Free, then $20." },
      author: agent,
      runId: "run_7",
      source: `proposal:${created.id}`,
    })
    const decided = await getProposal(test.db, created.id)
    expect(decided).toMatchObject({
      status: "approved",
      entryId,
      decidedBy: founder.id,
      decidedAt: later(1),
    })

    // A proposal against the entry now writes version 2, still authored by its proposer.
    const second = await propose("pricing", "Free, then $25.")
    expect(second).toMatchObject({ entryId, baseVersion: 1 })
    expect(await decide(second.id, "approve", 2)).toMatchObject({ entryId, version: 2 })
    expect((await getEntryHistory(test.db, entryId)).map((v) => v.author)).toEqual([agent, agent])
  })

  it("approving a proposal whose baseVersion is behind the latest returns CONFLICT and leaves both untouched", async () => {
    const created = await propose("stage", "Pre-seed.")
    const entryId = (await decide(created.id, "approve")).entryId ?? ""

    // An agent proposes a change against version 1 ...
    const stale = await propose("stage", "Seed round closing.", { baseVersion: 1 })
    expect(stale.baseVersion).toBe(1)
    // ... and a founder edits the entry before looking at it.
    await editEntry(test.db, {
      id: entryId,
      title: "stage",
      body: { text: "Seed, closed." },
      baseVersion: 1,
      author: founder,
      now: later(2),
    })

    await expect(decide(stale.id, "approve", 3)).rejects.toMatchObject({ code: "CONFLICT" })

    // The newer version is not overwritten, no version was added, and the proposal is still pending.
    expect((await getEntry(test.db, entryId)).body.text).toBe("Seed, closed.")
    expect((await getEntryHistory(test.db, entryId)).map((v) => v.version)).toEqual([1, 2])
    expect(await getProposal(test.db, stale.id)).toMatchObject({
      status: "pending",
      decidedBy: null,
      decidedAt: null,
    })
    // The founder can still reject it.
    expect(await decide(stale.id, "reject", 4)).toEqual({ status: "rejected" })
  })

  it("a decided proposal can't be decided again", async () => {
    const approved = await propose("hq", "Lisbon.")
    await decide(approved.id, "approve")
    await expect(decide(approved.id, "approve", 2)).rejects.toMatchObject({ code: "CONFLICT" })
    await expect(decide(approved.id, "reject", 2)).rejects.toMatchObject({ code: "CONFLICT" })

    const rejected = await propose("mascot", "A dolphin.")
    expect(await decide(rejected.id, "reject")).toEqual({ status: "rejected" })
    await expect(decide(rejected.id, "approve", 2)).rejects.toMatchObject({ code: "CONFLICT" })
    // Rejecting wrote no entry.
    expect(await getProposal(test.db, rejected.id)).toMatchObject({
      status: "rejected",
      entryId: null,
    })
  })

  it("approving a new-entry proposal after another took its slug is a CONFLICT", async () => {
    const a = await propose("domain", "example.com")
    const b = await propose("domain", "example.org")
    expect(await decide(a.id, "approve")).toMatchObject({ version: 1 })
    await expect(decide(b.id, "approve", 2)).rejects.toMatchObject({ code: "CONFLICT" })
    expect(await getProposal(test.db, b.id)).toMatchObject({ status: "pending" })
  })

  it("refuses a baseVersion the entry never had, and one for an entry that doesn't exist", async () => {
    const created = await propose("founded", "2026.")
    await decide(created.id, "approve")
    await expect(propose("founded", "2025.", { baseVersion: 5 })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    })
    await expect(propose("nothing-yet", "x", { baseVersion: 1 })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    })
    await expect(decide("missing", "approve")).rejects.toMatchObject({ code: "NOT_FOUND" })
    await expect(getProposal(test.db, "missing")).rejects.toMatchObject({ code: "NOT_FOUND" })
  })

  it("lists proposals newest first, by status, one page at a time", async () => {
    const all = await listProposals(test.db, { limit: 100 })
    expect(all.length).toBeGreaterThan(3)
    const times = all.map((p) => p.createdAt.getTime())
    expect(times).toEqual([...times].sort((a, b) => b - a))
    const [first, second] = all
    if (!first || !second) throw new Error("need two proposals")
    const page = await listProposals(test.db, {
      after: { at: first.createdAt, id: first.id },
      limit: 100,
    })
    expect(page.map((p) => p.id)).toEqual(all.slice(1).map((p) => p.id))
    expect(
      (await listProposals(test.db, { status: "rejected", limit: 100 })).every(
        (p) => p.status === "rejected",
      ),
    ).toBe(true)
  })
})
