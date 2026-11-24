import { asc, eq } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { signals, workItemEvents, workItems } from "../db/schema"
import { RECURRENCE_REOPEN_DAYS } from "../work/constants"
import { createHqTestDb } from "../testing"
import type { RecordSignalInput } from "../work/types"
import { recordSignal } from "./signals"
import { daysAfter, forceState, minutesAfter, NOW, resetWork } from "./work.test.helpers"

const AGENT = { type: "agent", id: "key-1" } as const

const issue = (n: number, over: Partial<RecordSignalInput> = {}): RecordSignalInput => ({
  source: "github_issue",
  externalId: `acme/web#${n}:opened`,
  dedupeKey: `github-issue:acme/web#${n}`,
  repo: "acme/web",
  title: `Issue ${n} breaks`,
  summary: "It breaks when you click",
  url: `https://github.com/acme/web/issues/${n}`,
  ...over,
})

describe("recordSignal (in-process Postgres)", () => {
  let test: Awaited<ReturnType<typeof createHqTestDb>>
  beforeAll(async () => {
    test = await createHqTestDb()
  })
  afterAll(async () => {
    await test.close()
  })
  beforeEach(async () => {
    await resetWork(test.db)
  })

  const record = (
    input: RecordSignalInput,
    now = NOW,
    recorder = AGENT as { type: "agent" | "founder" | "system"; id: string },
  ) => recordSignal(test.db, { ...input, recorder, now })
  const itemsOf = () => test.db.select().from(workItems).orderBy(asc(workItems.number))
  const signalRows = () => test.db.select().from(signals)
  const eventsOf = (itemId: string) =>
    test.db.select().from(workItemEvents).where(eq(workItemEvents.itemId, itemId))

  it("a first signal creates an item in triage with FAC-1, one signal and two events (signal>triage as system)", async () => {
    const res = await record(issue(5))
    expect(res).toMatchObject({ outcome: "created", displayId: "FAC-1" })
    const [item] = await itemsOf()
    expect(item).toMatchObject({
      id: res.itemId,
      number: 1,
      title: "Issue 5 breaks",
      repo: "acme/web",
      source: "github_issue",
      state: "triage",
      cycle: 1,
      dedupeKey: "github-issue:acme/web#5",
      createdByType: "agent",
      createdById: "key-1",
      // the move into triage is one millisecond after the signal_attached event
      stateChangedAt: new Date(NOW.getTime() + 1),
    })
    const rows = await signalRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: res.signalId,
      itemId: res.itemId,
      source: "github_issue",
      externalId: "acme/web#5:opened",
      url: "https://github.com/acme/web/issues/5",
      occurredAt: NOW,
      receivedAt: NOW,
      recordedByType: "agent",
      recordedById: "key-1",
    })
    const events = await eventsOf(res.itemId)
    expect(events.map((e) => e.kind).sort()).toEqual(["signal_attached", "transition"])
    const transition = events.find((e) => e.kind === "transition")
    expect(transition).toMatchObject({
      fromState: "signal",
      toState: "triage",
      actorType: "system",
      reason: "ingested",
    })
  })

  it("the same (source, externalId) again is duplicate and writes nothing", async () => {
    const first = await record(issue(5))
    const again = await record(issue(5, { title: "Edited title" }), minutesAfter(NOW, 5))
    expect(again).toEqual({
      signalId: first.signalId,
      itemId: first.itemId,
      displayId: first.displayId,
      outcome: "duplicate",
    })
    expect(await signalRows()).toHaveLength(1)
    expect(await itemsOf()).toHaveLength(1)
    expect(await eventsOf(first.itemId)).toHaveLength(2)
  })

  it("a second signal with the same dedupe key attaches, counts 2 occurrences and keeps one item", async () => {
    const first = await record(issue(5))
    const second = await record(
      issue(5, { externalId: "acme/web#5:comment-9" }),
      minutesAfter(NOW, 3),
    )
    expect(second).toMatchObject({ outcome: "attached", itemId: first.itemId, displayId: "FAC-1" })
    expect(second.signalId).not.toBe(first.signalId)
    expect(await itemsOf()).toHaveLength(1)
    const rows = await signalRows()
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.itemId === first.itemId)).toBe(true)
    const attached = (await eventsOf(first.itemId)).filter((e) => e.kind === "signal_attached")
    expect(attached).toHaveLength(2)
    expect((await itemsOf())[0]?.state).toBe("triage")
  })

  it("a signal for an item in verify reopens it (reopened, reason recurrence)", async () => {
    const first = await record(issue(5))
    await forceState(test.db, first.itemId, "verify", minutesAfter(NOW, 10))
    const later = minutesAfter(NOW, 60)
    const res = await record(issue(5, { externalId: "acme/web#5:again" }), later)
    expect(res).toMatchObject({ outcome: "reopened", itemId: first.itemId })
    const [item] = await itemsOf()
    expect(item).toMatchObject({
      state: "reopened",
      stateChangedAt: new Date(later.getTime() + 1),
    })
    const reopen = (await eventsOf(first.itemId)).find(
      (e) => e.kind === "transition" && e.toState === "reopened",
    )
    expect(reopen).toMatchObject({ fromState: "verify", actorType: "system", reason: "recurrence" })
    expect(await signalRows()).toHaveLength(2)
  })

  it("for a done item 6 days old reopens, 8 days old creates a new item", async () => {
    expect(RECURRENCE_REOPEN_DAYS).toBe(7)
    const six = await record(issue(5))
    await forceState(test.db, six.itemId, "done", NOW)
    const reopened = await record(issue(5, { externalId: "x:6d" }), daysAfter(NOW, 6))
    expect(reopened).toMatchObject({ outcome: "reopened", itemId: six.itemId })
    expect((await itemsOf())[0]?.state).toBe("reopened")

    await resetWork(test.db)
    const eight = await record(issue(6))
    await forceState(test.db, eight.itemId, "done", NOW)
    const fresh = await record(issue(6, { externalId: "x:8d" }), daysAfter(NOW, 8))
    expect(fresh).toMatchObject({ outcome: "created", displayId: "FAC-2" })
    expect(fresh.itemId).not.toBe(eight.itemId)
    const items = await itemsOf()
    expect(items.map((i) => i.state)).toEqual(["done", "triage"])
    // Both items carry the key; the newest is the one the next signal finds.
    expect(items.every((i) => i.dedupeKey === "github-issue:acme/web#6")).toBe(true)
  })

  it("a done item at exactly 7 days still reopens", async () => {
    const first = await record(issue(5))
    await forceState(test.db, first.itemId, "done", NOW)
    const res = await record(issue(5, { externalId: "x:7d" }), daysAfter(NOW, 7))
    expect(res.outcome).toBe("reopened")
  })

  it("for a stopped item attaches and the item stays stopped", async () => {
    const first = await record(issue(5))
    await forceState(test.db, first.itemId, "stopped", NOW)
    const res = await record(issue(5, { externalId: "x:s" }), minutesAfter(NOW, 5))
    expect(res).toMatchObject({ outcome: "attached", itemId: first.itemId })
    expect((await itemsOf())[0]?.state).toBe("stopped")
    expect(await signalRows()).toHaveLength(2)
    expect((await eventsOf(first.itemId)).filter((e) => e.kind === "transition")).toHaveLength(1)
  })

  it.each(["deploy", "reopened", "plan", "attempt", "review"] as const)(
    "for an item in %s attaches",
    async (state) => {
      const first = await record(issue(5))
      await forceState(test.db, first.itemId, state, NOW)
      const res = await record(issue(5, { externalId: `x:${state}` }), minutesAfter(NOW, 5))
      expect(res).toMatchObject({ outcome: "attached", itemId: first.itemId })
      expect((await itemsOf())[0]?.state).toBe(state)
      expect(await signalRows()).toHaveLength(2)
    },
  )

  it("a signal attaches to the newest item with its dedupe key", async () => {
    const old = await record(issue(5))
    await forceState(test.db, old.itemId, "done", NOW)
    const fresh = await record(issue(5, { externalId: "x:new" }), daysAfter(NOW, 9))
    const third = await record(issue(5, { externalId: "x:third" }), daysAfter(NOW, 9))
    expect(third).toMatchObject({ outcome: "attached", itemId: fresh.itemId })
  })

  it("sentry and posthog are refused as not connected", async () => {
    for (const source of ["sentry", "posthog"] as const) {
      await expect(
        record({ ...issue(1), source, dedupeKey: `${source}:abc` }),
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: expect.stringContaining("not connected"),
      })
    }
    expect(await signalRows()).toHaveLength(0)
  })

  it("a dedupe key that does not match its source pattern is refused", async () => {
    const bad: RecordSignalInput[] = [
      issue(1, { dedupeKey: "github-issue:acme/web" }),
      issue(1, { dedupeKey: "github-issue:acme/web#x" }),
      issue(1, { dedupeKey: "ci:acme/web:main:test" }), // another source's pattern
      issue(1, { dedupeKey: "github-issue:acme/web#1\nx" }),
      issue(1, { dedupeKey: "github-issue:acme/web#1 " }),
      issue(1, { source: "ci_failure", dedupeKey: "github-issue:acme/web#1" }),
      issue(1, { source: "ci_failure", dedupeKey: "ci:acme/web:a b:test" }),
      issue(1, { source: "manual", dedupeKey: "manual:not-a-uuid" }),
      issue(1, { dedupeKey: `github-issue:acme/web#${"1".repeat(200)}` }), // only too long
    ]
    for (const input of bad) {
      await expect(record(input)).rejects.toMatchObject({ code: "BAD_REQUEST" })
    }
    expect(await signalRows()).toHaveLength(0)
    expect(await itemsOf()).toHaveLength(0)
  })

  it("an unknown source and a payload that is not an object are refused", async () => {
    await expect(record({ ...issue(1), source: "slack" as never })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    })
    for (const payload of [[1, 2], "text", 5] as unknown[]) {
      await expect(
        record(issue(1, { payload: payload as Record<string, unknown> })),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" })
    }
  })

  it("accepts a ci_failure and a manual key of the right shape", async () => {
    const ci = await record({
      source: "ci_failure",
      externalId: "suite-77",
      dedupeKey: "ci:Acme/Web:main:github-actions",
      repo: "acme/web",
      title: "CI failed on main",
      summary: "The test job failed",
    })
    expect(ci.outcome).toBe("created")
    const [item] = await itemsOf()
    expect(item?.dedupeKey).toBe("ci:acme/web:main:github-actions")
    const uuid = crypto.randomUUID()
    const manual = await record({
      source: "manual",
      externalId: `manual:${uuid}`,
      dedupeKey: `manual:${uuid}`,
      repo: "acme/web",
      title: "By hand",
      summary: "By hand",
    })
    expect(manual.outcome).toBe("created")
  })

  it("a dedupe key whose repo is not the signal's repo is refused", async () => {
    await expect(record(issue(1, { repo: "acme/api" }))).rejects.toMatchObject({
      code: "BAD_REQUEST",
    })
  })

  it("a 20 001 byte payload is refused, 20 000 is stored", async () => {
    // {"k":"..."} is 8 bytes of structure around the string.
    const exact = { k: "x".repeat(20_000 - 8) }
    expect(Buffer.byteLength(JSON.stringify(exact))).toBe(20_000)
    const over = { k: "x".repeat(20_000 - 8 + 1) }
    expect(Buffer.byteLength(JSON.stringify(over))).toBe(20_001)
    await expect(record(issue(1, { payload: over }))).rejects.toMatchObject({ code: "BAD_REQUEST" })
    expect(await signalRows()).toHaveLength(0)
    const ok = await record(issue(1, { payload: exact }))
    expect(ok.outcome).toBe("created")
    expect((await signalRows())[0]?.payload).toEqual(exact)
  })

  it("the payload limit counts bytes, not characters", async () => {
    // 3 bytes per character in UTF-8
    const wide = { k: "€".repeat(7_000) }
    await expect(record(issue(1, { payload: wide }))).rejects.toMatchObject({ code: "BAD_REQUEST" })
  })

  it("a title of 301 characters is refused", async () => {
    await expect(record(issue(1, { title: "t".repeat(301) }))).rejects.toMatchObject({
      code: "BAD_REQUEST",
    })
    expect(await signalRows()).toHaveLength(0)
  })

  it("300 characters of title and of summary are stored; 301 of summary is refused", async () => {
    await expect(record(issue(1, { summary: "s".repeat(301) }))).rejects.toMatchObject({
      code: "BAD_REQUEST",
    })
    const ok = await record(issue(1, { title: "t".repeat(300), summary: "s".repeat(300) }))
    expect(ok.outcome).toBe("created")
    expect((await itemsOf())[0]?.title).toHaveLength(300)
  })

  it("refuses an empty title, an over-long external id and a malformed repo", async () => {
    for (const input of [
      issue(1, { title: "" }),
      issue(1, { title: "   " }),
      issue(1, { externalId: "" }),
      issue(1, { externalId: "e".repeat(201) }),
      issue(1, { repo: "acme" }),
      issue(1, { repo: "acme/web/extra" }),
      issue(1, { repo: "ac me/web" }),
    ]) {
      await expect(record(input)).rejects.toMatchObject({ code: "BAD_REQUEST" })
    }
  })

  it("a repo of Acme/Web is stored as acme/web and the same issue from acme/web is the same dedupe key", async () => {
    const first = await record(
      issue(5, { repo: "Acme/Web", dedupeKey: "github-issue:Acme/Web#5", externalId: "x:1" }),
    )
    const second = await record(issue(5, { externalId: "x:2" }))
    expect(second).toMatchObject({ outcome: "attached", itemId: first.itemId })
    expect((await itemsOf())[0]).toMatchObject({
      repo: "acme/web",
      dedupeKey: "github-issue:acme/web#5",
    })
    expect((await signalRows()).map((s) => [s.repo, s.dedupeKey])).toEqual([
      ["acme/web", "github-issue:acme/web#5"],
      ["acme/web", "github-issue:acme/web#5"],
    ])
  })

  it("stores text it cannot lose: a NUL byte or a lone surrogate is BAD_REQUEST, not a 500", async () => {
    for (const input of [
      issue(1, { title: "bad\u0000title" }),
      issue(1, { summary: "bad\ud800" }),
      issue(1, { externalId: "a\u0000b" }),
      issue(1, { payload: { body: "bad\u0000" } }),
      issue(1, { payload: { nested: [{ k: "\ud83d" }] } }),
      issue(1, { payload: { "k\u0000": 1 } }),
    ]) {
      await expect(record(input)).rejects.toMatchObject({ code: "BAD_REQUEST" })
    }
    expect(await signalRows()).toHaveLength(0)
  })

  it("keeps text as given: markup and a javascript: look-alike are stored as plain text", async () => {
    const title = "<img src=x onerror=alert(1)> [click](javascript:alert(1))"
    const res = await record(issue(1, { title, summary: "<script>x</script>" }))
    const [item] = await itemsOf()
    expect(item?.title).toBe(title)
    const [row] = await signalRows()
    expect(row?.summary).toBe("<script>x</script>")
    expect(res.outcome).toBe("created")
  })

  it("a url must be https and at most 500 characters", async () => {
    for (const url of [
      "javascript:alert(1)",
      "http://github.com/a/b/issues/1",
      "not a url",
      `https://github.com/${"a".repeat(500)}`,
    ]) {
      await expect(record(issue(1, { url }))).rejects.toMatchObject({ code: "BAD_REQUEST" })
    }
    const ok = await record(issue(1, { url: undefined }))
    expect((await signalRows())[0]?.url).toBeNull()
    expect(ok.outcome).toBe("created")
  })

  it("occurredAt defaults to now, is stored, must be a date, and never lies past now", async () => {
    const early = minutesAfter(NOW, -90)
    await record(issue(1, { occurredAt: early.toISOString() }))
    await record(issue(2, { occurredAt: minutesAfter(NOW, 600).toISOString() }))
    await record(issue(3))
    const byExternal = Object.fromEntries(
      (await signalRows()).map((s) => [s.externalId, s.occurredAt]),
    )
    expect(byExternal["acme/web#1:opened"]).toEqual(early)
    expect(byExternal["acme/web#2:opened"]).toEqual(NOW)
    expect(byExternal["acme/web#3:opened"]).toEqual(NOW)
    await expect(record(issue(4, { occurredAt: "yesterday-ish" }))).rejects.toMatchObject({
      code: "BAD_REQUEST",
    })
  })

  it("maps the recorder to the author types: a founder is a person", async () => {
    await record(issue(1), NOW, { type: "founder", id: "u1" })
    await record(issue(2), NOW, { type: "system", id: "hq" })
    const rows = await signalRows()
    const by = Object.fromEntries(
      rows.map((r) => [r.externalId, [r.recordedByType, r.recordedById]]),
    )
    expect(by["acme/web#1:opened"]).toEqual(["person", "u1"])
    expect(by["acme/web#2:opened"]).toEqual(["system", "hq"])
    const items = await itemsOf()
    expect(items.map((i) => i.createdByType)).toEqual(["person", "system"])
  })

  it("a signal never sets a label, starts an attempt or moves an item past triage", async () => {
    await record(issue(1))
    await record(issue(1, { externalId: "x:2" }))
    const [item] = await itemsOf()
    expect(item?.state).toBe("triage")
    const { attempts } = await import("../db/schema")
    expect(await test.db.select().from(attempts)).toHaveLength(0)
  })

  it("the same external id under another dedupe key is a duplicate and makes no second item", async () => {
    const first = await record(issue(1, { externalId: "shared" }))
    const clash = await record(issue(2, { externalId: "shared" }))
    expect(clash).toMatchObject({ outcome: "duplicate", itemId: first.itemId })
    expect(await itemsOf()).toHaveLength(1)
    expect(await signalRows()).toHaveLength(1)
  })
})
