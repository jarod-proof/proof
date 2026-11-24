import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

import { asc, eq } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import {
  agentQuestions,
  contractItems,
  mergeApprovals,
  signals,
  verificationWindows,
  workItemEvents,
  workItems,
} from "../db/schema"
import { createHqTestDb } from "../testing"
import { recordSignal } from "./signals"
import {
  forceState,
  minutesAfter,
  NOW,
  resetWork,
  seedAttempt,
  seedItem,
  seedPullRequest,
} from "./work.test.helpers"
import {
  createManualItem,
  listWorkItems,
  loadFacts,
  lockItem,
  resolveItem,
  transitionItem,
} from "./work-items"
import { appendEvent } from "./work-events"

const events = (db: Parameters<typeof resetWork>[0], itemId: string) =>
  db
    .select()
    .from(workItemEvents)
    .where(eq(workItemEvents.itemId, itemId))
    .orderBy(asc(workItemEvents.at))

describe("work items (in-process Postgres)", () => {
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

  describe("transitionItem, the only door", () => {
    it("writes one event with from, to, actor and reason and updates stateChangedAt", async () => {
      const item = await seedItem(test.db, { state: "triage" })
      const later = minutesAfter(NOW, 5)
      const moved = await test.db.transaction(async (tx) =>
        transitionItem(tx, {
          item: await lockItem(tx, item.id),
          to: "plan",
          actor: { type: "agent", id: "key-1" },
          reason: "investigation_started",
          note: "looking",
          now: later,
        }),
      )
      expect(moved.state).toBe("plan")
      expect(moved.stateChangedAt).toEqual(later)
      expect(moved.updatedAt).toEqual(later)
      const rows = await events(test.db, item.id)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        kind: "transition",
        fromState: "triage",
        toState: "plan",
        actorType: "agent",
        actorId: "key-1",
        reason: "investigation_started",
        note: "looking",
        cycle: 1,
        at: later,
      })
    })

    it("a transition by the wrong actor is FORBIDDEN and writes nothing", async () => {
      const item = await seedItem(test.db, { state: "triage" })
      await expect(
        test.db.transaction(async (tx) =>
          transitionItem(tx, {
            item: await lockItem(tx, item.id),
            to: "plan",
            actor: { type: "founder", id: "u1" },
            reason: "investigation_started",
            now: NOW,
          }),
        ),
      ).rejects.toMatchObject({ code: "FORBIDDEN" })
      expect((await resolveItem(test.db, item.id)).state).toBe("triage")
      expect(await events(test.db, item.id)).toHaveLength(0)
    })

    it("a failed guard is CONFLICT and writes nothing; with a contract and budget it passes", async () => {
      const item = await seedItem(test.db, { state: "plan", attemptLimit: 3 })
      const move = () =>
        test.db.transaction(async (tx) =>
          transitionItem(tx, {
            item: await lockItem(tx, item.id),
            to: "attempt",
            actor: { type: "agent", id: "key-1" },
            reason: "fix_started",
            now: NOW,
          }),
        )
      await expect(move()).rejects.toMatchObject({ code: "CONFLICT" })
      expect(await events(test.db, item.id)).toHaveLength(0)
      await test.db.insert(contractItems).values({
        id: crypto.randomUUID(),
        itemId: item.id,
        cycle: 1,
        position: 0,
        text: "no more 500s",
        verifierKind: "ci",
        status: "pending",
        createdByType: "agent",
        createdById: "key-1",
      })
      expect((await move()).state).toBe("attempt")
      expect(await events(test.db, item.id)).toHaveLength(1)
    })

    it("a move out of reopened or stopped into triage starts the next cycle", async () => {
      const stopped = await seedItem(test.db, { state: "stopped", cycle: 1 })
      const back = await test.db.transaction(async (tx) =>
        transitionItem(tx, {
          item: await lockItem(tx, stopped.id),
          to: "triage",
          actor: { type: "founder", id: "u1" },
          reason: "reopened",
          now: NOW,
        }),
      )
      expect(back).toMatchObject({ state: "triage", cycle: 2 })
      const [stoppedEvent] = await events(test.db, stopped.id)
      expect(stoppedEvent).toMatchObject({ fromState: "stopped", toState: "triage", cycle: 2 })

      const reopened = await seedItem(test.db, { state: "reopened", cycle: 2 })
      const retriaged = await test.db.transaction(async (tx) =>
        transitionItem(tx, {
          item: await lockItem(tx, reopened.id),
          to: "triage",
          actor: { type: "system", id: "sweep" },
          reason: "retriaged",
          now: NOW,
        }),
      )
      expect(retriaged).toMatchObject({ state: "triage", cycle: 3 })
    })

    it("a stale row cannot write a second move: the update is a compare-and-set on the state", async () => {
      const item = await seedItem(test.db, { state: "triage" })
      const stale = { ...item }
      await test.db.transaction(async (tx) =>
        transitionItem(tx, {
          item: await lockItem(tx, item.id),
          to: "plan",
          actor: { type: "agent", id: "k" },
          reason: "investigation_started",
          now: NOW,
        }),
      )
      await expect(
        test.db.transaction((tx) =>
          transitionItem(tx, {
            item: stale,
            to: "stopped",
            actor: { type: "founder", id: "u1" },
            reason: "stopped",
            now: NOW,
          }),
        ),
      ).rejects.toMatchObject({ code: "CONFLICT" })
      expect((await resolveItem(test.db, item.id)).state).toBe("plan")
      expect(await events(test.db, item.id)).toHaveLength(1)
    })

    it("lockItem is NOT_FOUND for an unknown id", async () => {
      await expect(
        test.db.transaction((tx) => lockItem(tx, crypto.randomUUID())),
      ).rejects.toMatchObject({ code: "NOT_FOUND" })
    })
  })

  describe("appendEvent", () => {
    it("inserts one row and the stored event cannot be changed", async () => {
      const item = await seedItem(test.db)
      await test.db.transaction((tx) =>
        appendEvent(tx, {
          itemId: item.id,
          at: NOW,
          kind: "signal_attached",
          actor: { type: "system", id: "hq" },
          detail: { signalId: "s1" },
          cycle: 1,
        }),
      )
      const [row] = await events(test.db, item.id)
      expect(row).toMatchObject({
        kind: "signal_attached",
        actorType: "system",
        actorId: "hq",
        fromState: null,
        toState: null,
        reason: null,
        detail: { signalId: "s1" },
      })
    })
  })

  describe("resolveItem", () => {
    it("finds an item by uuid and by FAC-<n>, in any case", async () => {
      const item = await seedItem(test.db)
      expect(item.displayId).toBe(`FAC-${item.number}`)
      expect((await resolveItem(test.db, item.id)).id).toBe(item.id)
      expect((await resolveItem(test.db, `FAC-${item.number}`)).id).toBe(item.id)
      expect((await resolveItem(test.db, `fac-${item.number}`)).id).toBe(item.id)
    })

    it("is NOT_FOUND for an unknown id, an unknown number and a malformed reference", async () => {
      await seedItem(test.db)
      for (const ref of [crypto.randomUUID(), "FAC-9999", "FAC-0", "", "nonsense", "FAC-1x"]) {
        await expect(resolveItem(test.db, ref)).rejects.toMatchObject({ code: "NOT_FOUND" })
      }
    })
  })

  describe("loadFacts, the one place facts are read", () => {
    it("reads an empty item as no contract, no pull request, nothing active", async () => {
      const item = await seedItem(test.db, { state: "triage" })
      expect(await test.db.transaction((tx) => loadFacts(tx, item, NOW))).toEqual({
        state: "triage",
        contractItems: 0,
        pullRequest: "none",
        attemptsRemaining: true,
        graceElapsed: false,
        windowPassed: false,
        pendingMergeApproval: false,
        openQuestion: false,
        attemptsUsed: 0,
        attemptLimit: null,
        activeAttempt: "none",
        newestFixResult: null,
      })
    })

    it("counts only the current cycle's contract and fix attempts", async () => {
      const item = await seedItem(test.db, { state: "attempt", cycle: 2, attemptLimit: 3 })
      const cycle1 = { cycle: 1, status: "finished" as const }
      await seedAttempt(test.db, item.id, { number: 1, ...cycle1, result: "failed" })
      await seedAttempt(test.db, item.id, { number: 2, ...cycle1, result: "failed" })
      await seedAttempt(test.db, item.id, { number: 3, ...cycle1, result: "approved" })
      // Cycle 2: an investigation and a needs_answer fix do not count; a rejected fix does.
      await seedAttempt(test.db, item.id, {
        number: 4,
        cycle: 2,
        kind: "investigate",
        result: "investigated",
      })
      await seedAttempt(test.db, item.id, { number: 5, cycle: 2, result: "needs_answer" })
      await seedAttempt(test.db, item.id, { number: 6, cycle: 2, result: "rejected" })
      for (const [cycle, position] of [
        [1, 0],
        [2, 0],
        [2, 1],
      ] as const) {
        await test.db.insert(contractItems).values({
          id: crypto.randomUUID(),
          itemId: item.id,
          cycle,
          position,
          text: "c",
          verifierKind: "ci",
          status: "pending",
          createdByType: "agent",
          createdById: "k",
        })
      }
      const facts = await test.db.transaction((tx) => loadFacts(tx, item, NOW))
      expect(facts).toMatchObject({
        contractItems: 2,
        attemptsUsed: 1,
        attemptLimit: 3,
        attemptsRemaining: true,
        newestFixResult: "rejected",
        activeAttempt: "none",
      })
      // A running fix counts as used.
      await seedAttempt(test.db, item.id, {
        number: 7,
        cycle: 2,
        status: "running",
        leaseExpiresAt: minutesAfter(NOW, 30),
      })
      const running = await test.db.transaction((tx) => loadFacts(tx, item, NOW))
      expect(running).toMatchObject({ attemptsUsed: 2, activeAttempt: "fresh" })
    })

    it("an attempt whose lease passed is stale; the budget is spent at the limit", async () => {
      const item = await seedItem(test.db, { state: "attempt", attemptLimit: 2 })
      await seedAttempt(test.db, item.id, { number: 1, result: "failed" })
      await seedAttempt(test.db, item.id, {
        number: 2,
        status: "running",
        leaseExpiresAt: minutesAfter(NOW, -1),
      })
      const facts = await test.db.transaction((tx) => loadFacts(tx, item, NOW))
      expect(facts).toMatchObject({
        activeAttempt: "stale",
        attemptsUsed: 2,
        attemptsRemaining: false,
        newestFixResult: "failed",
      })
    })

    it("a cycle-2 item that still holds a cycle-1 running attempt reads it as active", async () => {
      const item = await seedItem(test.db, { state: "triage", cycle: 2, attemptLimit: 3 })
      await seedAttempt(test.db, item.id, {
        number: 1,
        cycle: 1,
        status: "running",
        leaseExpiresAt: minutesAfter(NOW, 10),
      })
      const at = (m: number) =>
        test.db.transaction((tx) => loadFacts(tx, item, minutesAfter(NOW, m)))
      expect(await at(0)).toMatchObject({ activeAttempt: "fresh", attemptsUsed: 0 })
      expect((await at(10)).activeAttempt).toBe("stale")
      expect((await at(11)).activeAttempt).toBe("stale")
    })

    it("a requested attempt is active and fresh but not used", async () => {
      const item = await seedItem(test.db, { state: "triage", attemptLimit: 1 })
      await seedAttempt(test.db, item.id, { number: 1, kind: "fix", status: "requested" })
      const facts = await test.db.transaction((tx) => loadFacts(tx, item, NOW))
      expect(facts).toMatchObject({
        activeAttempt: "fresh",
        attemptsUsed: 0,
        attemptsRemaining: true,
      })
    })

    it("reads the newest pull request, the deploy grace and the window", async () => {
      const item = await seedItem(test.db, { state: "deploy", cycle: 2 })
      await seedPullRequest(test.db, item.id, {
        number: 7,
        state: "closed",
        openedAt: minutesAfter(NOW, -600),
      })
      const merged = await seedPullRequest(test.db, item.id, {
        number: 8,
        state: "merged",
        openedAt: minutesAfter(NOW, -120),
        mergedAt: minutesAfter(NOW, -16),
      })
      const at = (m: number) =>
        test.db.transaction((tx) => loadFacts(tx, item, minutesAfter(NOW, m)))
      // 16 minutes after the merge the grace has elapsed; 14 minutes after it has not.
      expect((await at(0)).pullRequest).toBe("merged")
      expect((await at(0)).graceElapsed).toBe(true)
      expect((await at(2)).graceElapsed).toBe(true)
      expect((await at(-3)).graceElapsed).toBe(false)
      expect((await at(-1)).graceElapsed).toBe(true)

      await test.db.insert(verificationWindows).values({
        id: crypto.randomUUID(),
        itemId: item.id,
        cycle: 1,
        startsAt: minutesAfter(NOW, -900),
        endsAt: minutesAfter(NOW, -500),
        status: "passed",
      })
      expect((await at(0)).windowPassed).toBe(false) // another cycle's window
      await test.db.insert(verificationWindows).values({
        id: crypto.randomUUID(),
        itemId: item.id,
        cycle: 2,
        startsAt: minutesAfter(NOW, -16),
        endsAt: minutesAfter(NOW, 344),
        status: "running",
      })
      expect((await at(0)).windowPassed).toBe(false)
      expect((await at(344)).windowPassed).toBe(true)
      expect((await at(343)).windowPassed).toBe(false)

      await test.db.insert(mergeApprovals).values({
        id: crypto.randomUUID(),
        itemId: item.id,
        pullRequestId: merged.id,
        headSha: merged.headSha,
        status: "pending",
        requestedAt: NOW,
      })
      await test.db.insert(agentQuestions).values({
        id: crypto.randomUUID(),
        itemId: item.id,
        prompt: "p",
        options: [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
        ],
        status: "open",
        createdAt: NOW,
      })
      // The approval asks for a decision only while the item is in review AND its pull request is
      // the current one and still open (W5: otherwise the card would be dead); the question
      // counts in any state.
      expect(await at(0)).toMatchObject({ pendingMergeApproval: false, openQuestion: true })
      const inReview = { ...item, state: "review" as const }
      // review, but the current pull request (#8) is merged: nothing to approve
      expect(await test.db.transaction((tx) => loadFacts(tx, inReview, NOW))).toMatchObject({
        pendingMergeApproval: false,
        openQuestion: true,
      })
      // a newer open pull request with its own pending approval: now the card is live
      const open = await seedPullRequest(test.db, item.id, {
        number: 9,
        state: "open",
        openedAt: minutesAfter(NOW, -60),
        branch: "factory/fix-9",
      })
      await test.db.insert(mergeApprovals).values({
        id: crypto.randomUUID(),
        itemId: item.id,
        pullRequestId: open.id,
        headSha: open.headSha,
        status: "pending",
        requestedAt: NOW,
      })
      expect(await test.db.transaction((tx) => loadFacts(tx, inReview, NOW))).toMatchObject({
        pullRequest: "open",
        pendingMergeApproval: true,
        openQuestion: true,
      })
    })
  })

  describe("createManualItem", () => {
    it("createManualItem creates source manual with a manual signal", async () => {
      const made = await createManualItem(test.db, {
        title: "Fix the login page",
        body: "It 500s on Safari",
        repo: "Acme/Web",
        founderId: "u1",
        now: NOW,
      })
      expect(made.displayId).toBe("FAC-1")
      const item = await resolveItem(test.db, made.itemId)
      expect(item).toMatchObject({
        source: "manual",
        state: "triage",
        repo: "acme/web",
        title: "Fix the login page",
      })
      expect(item.dedupeKey).toMatch(/^manual:[0-9a-f-]{36}$/)
      const stored = await test.db
        .select({ source: workItems.createdByType, by: workItems.createdById })
        .from(workItems)
        .where(eq(workItems.id, made.itemId))
      expect(stored).toEqual([{ source: "person", by: "u1" }])
      const rows = await events(test.db, made.itemId)
      expect(rows.map((e) => e.kind).sort()).toEqual(["signal_attached", "transition"])
      const stored2 = await test.db.select().from(signals).where(eq(signals.itemId, made.itemId))
      expect(stored2).toHaveLength(1)
      expect(stored2[0]).toMatchObject({
        source: "manual",
        repo: "acme/web",
        title: "Fix the login page",
        summary: "It 500s on Safari",
        payload: { body: "It 500s on Safari" },
        recordedByType: "person",
        recordedById: "u1",
      })
      expect(stored2[0]?.externalId).toMatch(/^manual:[0-9a-f-]{36}$/)
      expect(stored2[0]?.externalId).toBe(stored2[0]?.dedupeKey)
      expect(stored2[0]?.dedupeKey).toBe(item.dedupeKey)
    })

    it("the manual summary is cut at a code point, never inside an emoji", async () => {
      // 299 letters then a two-unit emoji: the 300th unit would split it.
      const made = await createManualItem(test.db, {
        title: "t",
        body: `${"a".repeat(299)}\u{1F600}tail`,
        repo: "acme/web",
        founderId: "u1",
        now: NOW,
      })
      const [row] = await test.db.select().from(signals).where(eq(signals.itemId, made.itemId))
      expect(row?.summary).toBe("a".repeat(299))
    })

    it("refuses an empty or over-long title and a bad repo", async () => {
      const base = { body: undefined, repo: "acme/web", founderId: "u1", now: NOW }
      for (const input of [
        { ...base, title: "" },
        { ...base, title: "x".repeat(301) },
        { ...base, title: "ok", repo: "not a repo" },
        { ...base, title: "ok", body: "x".repeat(20_001) },
      ]) {
        await expect(createManualItem(test.db, input)).rejects.toMatchObject({
          code: "BAD_REQUEST",
        })
      }
    })
  })

  describe("listWorkItems", () => {
    const list = (input: Partial<Parameters<typeof listWorkItems>[1]> = {}) =>
      listWorkItems(test.db, { limit: 50, ...input })

    it("listWorkItems filters by exact dedupeKey, by state, by pullRequestNumber (with repo) and by a query over title, display id, summary and attempt files, case-insensitively", async () => {
      const a = await seedItem(test.db, {
        title: "Login 500s on Safari",
        dedupeKey: "github-issue:acme/web#1",
        state: "triage",
      })
      const b = await seedItem(test.db, {
        title: "Billing rounds wrong",
        dedupeKey: "github-issue:acme/web#2",
        state: "review",
      })
      const c = await seedItem(test.db, {
        title: "Other repo thing",
        repo: "acme/api",
        dedupeKey: "github-issue:acme/api#1",
        state: "review",
      })
      await seedPullRequest(test.db, b.id, { number: 41 })
      await seedPullRequest(test.db, c.id, { number: 41, repo: "acme/api" })
      await seedAttempt(test.db, a.id, { number: 1, files: ["src/auth/Session.ts"] })
      await recordSignal(test.db, {
        source: "github_issue",
        externalId: "acme/web#2:1",
        dedupeKey: "github-issue:acme/web#2",
        repo: "acme/web",
        title: "Billing rounds wrong",
        summary: "Totals drop a cent when VAT applies",
        recorder: { type: "agent", id: "k" },
        now: NOW,
      })
      const ids = async (input = {}) => (await list(input)).map((r) => r.id).sort()
      const sorted = (...rows: { id: string }[]) => rows.map((r) => r.id).sort()

      expect(await ids({ dedupeKey: "github-issue:acme/web#1" })).toEqual(sorted(a))
      expect(await ids({ dedupeKey: "github-issue:acme/web" })).toEqual([]) // exact, not a prefix
      expect(await ids({ state: "review" })).toEqual(sorted(b, c))
      expect(await ids({ pullRequestNumber: 41, repo: "ACME/api" })).toEqual(sorted(c))
      expect(await ids({ pullRequestNumber: 41 })).toEqual(sorted(b, c))
      expect(await ids({ repo: "acme/api" })).toEqual(sorted(c))
      // title, display id, signal summary, attempt files; case-insensitively
      expect(await ids({ query: "safari" })).toEqual(sorted(a))
      expect(await ids({ query: `fac-${b.number}` })).toEqual(sorted(b))
      expect(await ids({ query: "VAT APPLIES" })).toContain(b.id)
      expect(await ids({ query: "auth/session" })).toEqual(sorted(a))
      // LIKE wildcards in the query are literal text
      expect(await ids({ query: "%" })).toEqual([])
      expect(await ids({ query: "_" })).toEqual([])
    })

    it("pages items that share one createdAt without skipping or repeating any", async () => {
      for (let i = 0; i < 5; i++) await seedItem(test.db, { title: `same${i}` })
      const seen: string[] = []
      let after: { at: Date; id: string } | undefined
      for (let page = 0; page < 3; page++) {
        const rows = await list({ limit: 2, after })
        seen.push(...rows.map((r) => r.id))
        const last = rows.at(-1)
        if (!last) break
        after = { at: last.createdAt, id: last.id }
      }
      expect(seen).toHaveLength(5)
      expect(new Set(seen).size).toBe(5)
    })

    it("pages newest first by a (createdAt, id) cursor", async () => {
      const made = []
      for (let i = 0; i < 5; i++) {
        made.push(await seedItem(test.db, { now: minutesAfter(NOW, i), title: `t${i}` }))
      }
      const first = await list({ limit: 2 })
      expect(first.map((r) => r.title)).toEqual(["t4", "t3"])
      const last = first[1]
      if (!last) throw new Error("no last row")
      const second = await list({ limit: 2, after: { at: last.createdAt, id: last.id } })
      expect(second.map((r) => r.title)).toEqual(["t2", "t1"])
      const third = await list({
        limit: 5,
        after: { at: second[1]?.createdAt as Date, id: second[1]?.id as string },
      })
      expect(third.map((r) => r.title)).toEqual(["t0"])
    })

    it("refuses a limit outside 1 to 100 and a query over 200 characters", async () => {
      await expect(list({ limit: 0 })).rejects.toMatchObject({ code: "BAD_REQUEST" })
      await expect(list({ limit: 101 })).rejects.toMatchObject({ code: "BAD_REQUEST" })
      await expect(list({ query: "x".repeat(201) })).rejects.toMatchObject({ code: "BAD_REQUEST" })
    })
  })

  describe("forceState", () => {
    it("sets a state and its instant without an event", async () => {
      const item = await seedItem(test.db)
      await forceState(test.db, item.id, "done", minutesAfter(NOW, -60))
      const stored = await resolveItem(test.db, item.id)
      expect(stored.state).toBe("done")
      expect(stored.stateChangedAt).toEqual(minutesAfter(NOW, -60))
      expect(await events(test.db, item.id)).toHaveLength(0)
    })
  })
})

describe("the test helpers", () => {
  it("are imported by no production file", () => {
    const root = join(import.meta.dirname, "..")
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) {
          if (name !== "node_modules") walk(path)
        } else if (/\.tsx?$/.test(name) && !/\.test\.|\.test\.helpers\./.test(name)) {
          if (readFileSync(path, "utf8").includes("work.test.helpers")) offenders.push(path)
        }
      }
    }
    walk(root)
    expect(offenders).toEqual([])
  })
})
