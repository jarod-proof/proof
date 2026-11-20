import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { entryVersions } from "../db/schema"
import { createHqTestDb } from "../testing"
import { editEntry, getEntry, getEntryHistory, listEntries, searchEntries } from "./entries"
import { createProposal, decideProposal } from "./proposals"

const agent = { type: "agent", id: "key_1" } as const
const founder = { type: "person", id: "user_founder" } as const
const t0 = new Date("2026-11-17T12:00:00Z")
const later = (minutes: number) => new Date(t0.getTime() + minutes * 60_000)

describe("entries and their versions (real Postgres via PGlite)", () => {
  let test: Awaited<ReturnType<typeof createHqTestDb>>
  beforeAll(async () => {
    test = await createHqTestDb()
  })
  afterAll(() => test.close())

  /** A new entry at version 1: proposed by an agent, approved by the founder. */
  async function seed(kind: "fact" | "voice", slug: string, title: string, text: string) {
    const proposal = await createProposal(test.db, {
      kind,
      slug,
      title,
      body: { text },
      reason: "seed",
      proposer: agent,
      now: t0,
    })
    const decision = await decideProposal(test.db, {
      proposalId: proposal.id,
      decision: "approve",
      decidedBy: founder.id,
      now: t0,
    })
    if (!decision.entryId) throw new Error("seed was not approved")
    return decision.entryId
  }

  it("an edit creates version n+1 and keeps version n readable", async () => {
    const id = await seed("fact", "pricing", "Pricing", "Free, then $20 per seat.")
    const edited = await editEntry(test.db, {
      id,
      title: "Pricing",
      body: { text: "Free, then $25 per seat." },
      baseVersion: 1,
      author: founder,
      now: later(5),
    })
    expect(edited.version).toBe(2)
    expect(edited.latestVersion).toBe(2)

    expect((await getEntry(test.db, id)).body.text).toBe("Free, then $25 per seat.")
    const first = await getEntry(test.db, id, 1)
    expect(first.version).toBe(1)
    expect(first.body.text).toBe("Free, then $20 per seat.")
    expect(first.latestVersion).toBe(2)
  })

  it("nothing is deleted: history lists every version with author", async () => {
    const id = await seed("fact", "team-size", "Team size", "Two founders.")
    await editEntry(test.db, {
      id,
      title: "Team size",
      body: { text: "Two founders and an agent." },
      baseVersion: 1,
      author: founder,
      now: later(1),
    })
    await editEntry(test.db, {
      id,
      title: "Team size",
      body: { text: "Two founders and two agents." },
      baseVersion: 2,
      author: founder,
      now: later(2),
    })

    const history = await getEntryHistory(test.db, id)
    expect(history.map((v) => v.version)).toEqual([1, 2, 3])
    expect(history.map((v) => v.author)).toEqual([agent, founder, founder])
    expect(history.map((v) => v.body.text)).toEqual([
      "Two founders.",
      "Two founders and an agent.",
      "Two founders and two agents.",
    ])
    expect(history[0]?.source).toMatch(/^proposal:/)
  })

  it("an edit against an old baseVersion is a CONFLICT and writes nothing", async () => {
    const id = await seed("fact", "stage", "Stage", "Pre-seed.")
    await editEntry(test.db, {
      id,
      title: "Stage",
      body: { text: "Seed." },
      baseVersion: 1,
      author: founder,
      now: later(1),
    })
    await expect(
      editEntry(test.db, {
        id,
        title: "Stage",
        body: { text: "Series A." },
        baseVersion: 1,
        author: founder,
        now: later(2),
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" })
    expect((await getEntryHistory(test.db, id)).map((v) => v.body.text)).toEqual([
      "Pre-seed.",
      "Seed.",
    ])
    await expect(
      editEntry(test.db, {
        id: "missing",
        title: "x",
        body: { text: "x" },
        baseVersion: 1,
        author: founder,
        now: later(3),
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
  })

  it("the database refuses to update or delete a version, whoever asks", async () => {
    const id = await seed("fact", "runway", "Runway", "18 months.")
    await expect(
      test.db.update(entryVersions).set({ title: "Changed" }).where(eq(entryVersions.entryId, id)),
    ).rejects.toThrow()
    await expect(
      test.db.delete(entryVersions).where(eq(entryVersions.entryId, id)),
    ).rejects.toThrow()
    expect((await getEntry(test.db, id)).title).toBe("Runway")
  })

  it("lists, filters and pages entries, and reads missing ones as NOT_FOUND", async () => {
    await seed("voice", "tone", "Tone of voice", "Plain and warm.")
    const all = await listEntries(test.db, { limit: 100 })
    const names = all.map((e) => `${e.kind}/${e.slug}`)
    expect(names).toEqual([...names].sort())
    expect(all.length).toBeGreaterThanOrEqual(5)
    expect((await listEntries(test.db, { kind: "voice", limit: 10 })).map((e) => e.slug)).toEqual([
      "tone",
    ])
    expect((await listEntries(test.db, { query: "TONE", limit: 10 })).map((e) => e.slug)).toEqual([
      "tone",
    ])
    // A % in the query is text, not a wildcard.
    expect(await listEntries(test.db, { query: "%", limit: 10 })).toEqual([])
    const first = all[0]
    if (!first) throw new Error("no entries")
    const next = await listEntries(test.db, {
      after: { kind: first.kind, slug: first.slug },
      limit: 100,
    })
    expect(next.map((e) => e.id)).toEqual(all.slice(1).map((e) => e.id))
    await expect(getEntry(test.db, "missing")).rejects.toMatchObject({ code: "NOT_FOUND" })
    await expect(getEntry(test.db, first.id, 99)).rejects.toMatchObject({ code: "NOT_FOUND" })
    await expect(getEntryHistory(test.db, "missing")).rejects.toMatchObject({ code: "NOT_FOUND" })
  })

  it("full-text search reads the newest version only", async () => {
    const id = await seed("fact", "office", "Office", "We work from a studio in Lisbon.")
    expect((await searchEntries(test.db, { query: "Lisbon", limit: 10 })).map((h) => h.id)).toEqual(
      [id],
    )
    await editEntry(test.db, {
      id,
      title: "Office",
      body: { text: "We are fully remote." },
      baseVersion: 1,
      author: founder,
      now: later(1),
    })
    expect(await searchEntries(test.db, { query: "Lisbon", limit: 10 })).toEqual([])
    const [hit] = await searchEntries(test.db, { query: "remote", kinds: ["fact"], limit: 10 })
    expect(hit).toMatchObject({ id, version: 2, excerpt: "We are fully remote." })
    expect(await searchEntries(test.db, { query: "remote", kinds: ["voice"], limit: 10 })).toEqual(
      [],
    )
  })
})
