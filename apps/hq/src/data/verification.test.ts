import { asc, eq, sql } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"

import {
  agentQuestions,
  attempts,
  contractItems,
  pullRequests,
  signals,
  verificationWindows,
  workItemEvents,
  workItems,
} from "../db/schema"
import { createHqTestDb } from "../testing"
import { DEPLOY_GRACE_MINUTES, VERIFY_WINDOW_HOURS } from "../work/constants"
import type { VerifierKind } from "../work/machine"
import type { PullRequestCheck } from "../work/types"
import { requestRevert } from "./decisions"
import {
  advanceDeployItem,
  evaluateContract,
  occurrenceBuckets,
  retriageReopenedItem,
  runVerificationSweep,
  settleVerifyItem,
} from "./verification"
import {
  forceState,
  minutesAfter,
  NOW,
  resetWork,
  seedAttempt,
  seedItem,
  seedPullRequest,
} from "./work.test.helpers"
import { loadFacts, lockItem } from "./work-items"

const KEY = "github-issue:acme/web#1"
const HOUR = 60
const GRACE = DEPLOY_GRACE_MINUTES
const WINDOW_MIN = VERIFY_WINDOW_HOURS * 60
const EMPTY = { advanced: [], passed: [], reopened: [], retriaged: [], abandoned: [], errors: [] }

describe("the verification window and the sweep (in-process Postgres)", () => {
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
  const db = () => test.db

  // ---- seeding ---------------------------------------------------------------------------------
  /** A merged pull request `mergedAt` ago-or-after; the item is in `state` (default deploy). */
  async function mergedItem(
    o: {
      mergedAt?: Date
      state?: "deploy" | "verify" | "done" | "review"
      dedupeKey?: string | null
      cycle?: number
      checks?: PullRequestCheck[]
      prState?: "merged" | "open"
    } = {},
  ) {
    const item = await seedItem(db(), {
      state: o.state ?? "deploy",
      dedupeKey: o.dedupeKey === undefined ? KEY : o.dedupeKey,
      cycle: o.cycle ?? 1,
    })
    const pr = await seedPullRequest(db(), item.id, {
      number: 7,
      state: o.prState ?? "merged",
      mergedAt: o.prState === "open" ? null : (o.mergedAt ?? NOW),
      openedAt: minutesAfter(o.mergedAt ?? NOW, -60),
    })
    if (o.checks) {
      await db().update(pullRequests).set({ checks: o.checks }).where(eq(pullRequests.id, pr.id))
    }
    return { item, pr }
  }
  const addWindow = async (
    itemId: string,
    startsAt: Date,
    o: { cycle?: number; status?: "running" | "passed" | "failed" | "stopped" } = {},
  ) => {
    const [row] = await db()
      .insert(verificationWindows)
      .values({
        id: crypto.randomUUID(),
        itemId,
        cycle: o.cycle ?? 1,
        startsAt,
        endsAt: minutesAfter(startsAt, WINDOW_MIN),
        status: o.status ?? "running",
      })
      .returning()
    return row!
  }
  let position = 0
  const addContract = async (
    itemId: string,
    kind: VerifierKind,
    o: { cycle?: number; position?: number } = {},
  ) => {
    const [row] = await db()
      .insert(contractItems)
      .values({
        id: crypto.randomUUID(),
        itemId,
        cycle: o.cycle ?? 1,
        position: o.position ?? ++position,
        text: `Verified by ${kind}`,
        verifierKind: kind,
        status: "pending",
        createdByType: "system",
        createdById: "test",
      })
      .returning()
    return row!
  }
  const addFix = (
    itemId: string,
    number: number,
    result: "approved" | "rejected" | "failed" | "needs_answer" | null,
    o: {
      cycle?: number
      kind?: "fix" | "investigate"
      status?: "finished" | "running" | "requested"
    } = {},
  ) =>
    seedAttempt(db(), itemId, {
      number,
      cycle: o.cycle ?? 1,
      kind: o.kind ?? "fix",
      status: o.status ?? "finished",
      result,
      ...(o.status === "running" ? { leaseExpiresAt: minutesAfter(NOW, 600) } : {}),
    })
  const addSignal = async (itemId: string, dedupeKey: string | null, occurredAt: Date) => {
    await db()
      .insert(signals)
      .values({
        id: crypto.randomUUID(),
        source: "github_issue",
        externalId: crypto.randomUUID(),
        dedupeKey: dedupeKey ?? KEY,
        repo: "acme/web",
        title: "It broke again",
        summary: "It broke again",
        occurredAt,
        receivedAt: occurredAt,
        itemId,
        recordedByType: "agent",
        recordedById: "agent-key",
      })
  }
  /** A verify item whose three verifiers (reviewer, ci, signal_recurrence) all pass. */
  async function passingItem(mergedAt = NOW) {
    const { item, pr } = await mergedItem({
      mergedAt,
      state: "verify",
      checks: [
        { name: "unit", state: "passed" },
        { name: "e2e", state: "passed" },
      ],
    })
    const window = await addWindow(item.id, minutesAfter(mergedAt, GRACE))
    await addFix(item.id, 1, "approved")
    await addContract(item.id, "reviewer")
    await addContract(item.id, "ci")
    await addContract(item.id, "signal_recurrence")
    return { item, pr, window }
  }

  // ---- reading ---------------------------------------------------------------------------------
  const itemRow = async (id: string) =>
    (await db().select().from(workItems).where(eq(workItems.id, id)))[0]!
  const windowsOf = (itemId: string) =>
    db().select().from(verificationWindows).where(eq(verificationWindows.itemId, itemId))
  const contractOf = (itemId: string, cycle = 1) =>
    db()
      .select()
      .from(contractItems)
      .where(eq(contractItems.itemId, itemId))
      .orderBy(asc(contractItems.cycle), asc(contractItems.position))
      .then((rows) => rows.filter((r) => r.cycle === cycle))
  const eventsOf = (itemId: string) =>
    db()
      .select()
      .from(workItemEvents)
      .where(eq(workItemEvents.itemId, itemId))
      .orderBy(asc(workItemEvents.at), asc(workItemEvents.id))
  const strictlyIncreasing = (rows: { at: Date }[]) => {
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.at.getTime()).toBeGreaterThan(rows[i - 1]!.at.getTime())
    }
  }
  const sweep = (now: Date) => runVerificationSweep(db(), now)
  const snapshot = async () => ({
    items: await db().select().from(workItems).orderBy(asc(workItems.id)),
    windows: await db().select().from(verificationWindows).orderBy(asc(verificationWindows.id)),
    contract: await db().select().from(contractItems).orderBy(asc(contractItems.id)),
    attempts: await db().select().from(attempts).orderBy(asc(attempts.id)),
    questions: await db().select().from(agentQuestions).orderBy(asc(agentQuestions.id)),
    events: await db().select().from(workItemEvents).orderBy(asc(workItemEvents.id)),
  })

  // ---- the window ------------------------------------------------------------------------------
  describe("deploy to verify", () => {
    it("an item in deploy 14 minutes after merge stays, at 15 moves to verify with a window of 6 hours starting at merge + 15 min", async () => {
      const { item } = await mergedItem()
      expect(await sweep(minutesAfter(NOW, GRACE - 1))).toEqual(EMPTY)
      expect((await itemRow(item.id)).state).toBe("deploy")
      expect(await windowsOf(item.id)).toEqual([])

      const at = minutesAfter(NOW, GRACE)
      const out = await sweep(at)
      expect(out).toEqual({ ...EMPTY, advanced: [item.id] })
      const row = await itemRow(item.id)
      expect(row.state).toBe("verify")
      expect(row.cycle).toBe(1)
      const [window] = await windowsOf(item.id)
      expect(window).toMatchObject({
        itemId: item.id,
        cycle: 1,
        status: "running",
        startsAt: minutesAfter(NOW, GRACE),
        endsAt: minutesAfter(NOW, GRACE + WINDOW_MIN),
        checkedAt: null,
      })
      const events = await eventsOf(item.id)
      expect(events.map((e) => [e.kind, e.fromState, e.toState, e.reason, e.actorType])).toEqual([
        ["transition", "deploy", "verify", "deploy_grace_elapsed", "system"],
        ["window_started", null, null, null, "system"],
      ])
      expect(events.map((e) => e.cycle)).toEqual([1, 1])
      strictlyIncreasing(events)
    })

    it("an item merged 7 hours ago goes deploy to verify to done in one sweep", async () => {
      const mergedAt = minutesAfter(NOW, -7 * HOUR)
      const { item } = await mergedItem({
        mergedAt,
        checks: [{ name: "unit", state: "passed" }],
      })
      await addFix(item.id, 1, "approved")
      await addContract(item.id, "reviewer")
      await addContract(item.id, "ci")
      await addContract(item.id, "signal_recurrence")
      const out = await sweep(NOW)
      expect(out).toEqual({ ...EMPTY, advanced: [item.id], passed: [item.id] })
      expect((await itemRow(item.id)).state).toBe("done")
      const [window] = await windowsOf(item.id)
      expect(window).toMatchObject({ status: "passed", checkedAt: NOW })
      const events = await eventsOf(item.id)
      expect(events.map((e) => [e.kind, e.toState, e.reason])).toEqual([
        ["transition", "verify", "deploy_grace_elapsed"],
        ["window_started", null, null],
        ["transition", "done", "window_passed"],
        ["window_closed", null, null],
      ])
      expect(events[3]!.detail).toMatchObject({ status: "passed" })
      strictlyIncreasing(events)
    })

    it("a deploy item whose pull request is not merged stays", async () => {
      const open = await mergedItem({ prState: "open" })
      expect(await sweep(minutesAfter(NOW, 3 * HOUR))).toEqual(EMPTY)
      expect((await itemRow(open.item.id)).state).toBe("deploy")
    })

    it("the window uses the merge time, not the sweep time, and a sweep a day late starts it at merge + 15 min", async () => {
      const { item } = await mergedItem()
      await sweep(minutesAfter(NOW, 24 * HOUR))
      const [window] = await windowsOf(item.id)
      expect(window!.startsAt).toEqual(minutesAfter(NOW, GRACE))
    })

    it("advanceDeployItem re-reads the state under the lock: a stopped item is not advanced and nothing is written", async () => {
      const { item } = await mergedItem()
      await forceState(db(), item.id, "stopped", NOW)
      const before = await snapshot()
      expect(await advanceDeployItem(db(), item.id, minutesAfter(NOW, 2 * HOUR))).toBe(false)
      expect(await snapshot()).toEqual(before)
    })

    it("an item whose window would end one millisecond after the sweep is advanced and stays in verify", async () => {
      // merged so that starts_at + 6 h is now + 1 ms: a tick on the guard's clock would cross it.
      const now = minutesAfter(NOW, 10 * HOUR)
      const mergedAt = new Date(now.getTime() + 1 - (GRACE + WINDOW_MIN) * 60_000)
      const { item } = await mergedItem({ mergedAt, checks: [{ name: "unit", state: "passed" }] })
      await addFix(item.id, 1, "approved")
      await addContract(item.id, "reviewer")
      await addContract(item.id, "ci")
      expect(await sweep(now)).toEqual({ ...EMPTY, advanced: [item.id] })
      expect((await itemRow(item.id)).state).toBe("verify")
      const [window] = await windowsOf(item.id)
      expect(window).toMatchObject({ status: "running" })
      expect(await sweep(new Date(now.getTime() + 1))).toEqual({ ...EMPTY, passed: [item.id] })
      expect((await itemRow(item.id)).state).toBe("done")
    })
  })

  // ---- verify to done / reopened ---------------------------------------------------------------
  describe("verify to done or reopened", () => {
    it("a verify item with all three verifier kinds passing and the window not over stays; once over it is done and the window passed", async () => {
      const { item, window } = await passingItem()
      const justBefore = new Date(window.endsAt.getTime() - 1)
      expect(await sweep(justBefore)).toEqual(EMPTY)
      expect((await itemRow(item.id)).state).toBe("verify")
      const rows = await contractOf(item.id)
      expect(rows.map((r) => r.status)).toEqual(["passing", "passing", "passing"])
      expect(rows.every((r) => r.checkedAt?.getTime() === justBefore.getTime())).toBe(true)
      expect(rows.every((r) => (r.evidence ?? "").length > 0)).toBe(true)
      expect((await windowsOf(item.id))[0]!.status).toBe("running")

      expect(await sweep(window.endsAt)).toEqual({ ...EMPTY, passed: [item.id] })
      const done = await itemRow(item.id)
      expect(done.state).toBe("done")
      expect(done.cycle).toBe(1)
      expect((await windowsOf(item.id))[0]).toMatchObject({
        status: "passed",
        checkedAt: window.endsAt,
      })
    })

    it("a ci check that failed reopens with reason contract_failed and the window failed", async () => {
      const { item } = await mergedItem({
        state: "verify",
        checks: [
          { name: "unit", state: "passed" },
          { name: "e2e", state: "failed" },
          { name: "lint", state: "pending" },
        ],
      })
      await addWindow(item.id, minutesAfter(NOW, GRACE))
      await addContract(item.id, "ci")
      // one hour into a six hour window: a failure reopens at once, it does not wait for the end
      const now = minutesAfter(NOW, GRACE + HOUR)
      expect(await sweep(now)).toEqual({ ...EMPTY, reopened: [item.id] })
      const row = await itemRow(item.id)
      expect(row.state).toBe("reopened")
      expect(row.cycle).toBe(1)
      expect((await windowsOf(item.id))[0]).toMatchObject({ status: "failed", checkedAt: now })
      expect((await contractOf(item.id))[0]).toMatchObject({ status: "failing", checkedAt: now })
      const events = await eventsOf(item.id)
      expect(events.map((e) => [e.kind, e.fromState, e.toState, e.reason, e.actorType])).toEqual([
        ["transition", "verify", "reopened", "contract_failed", "system"],
        ["window_closed", null, null, null, "system"],
      ])
      expect(events.map((e) => e.cycle)).toEqual([1, 1])
      expect(events[1]!.detail).toMatchObject({ status: "failed" })
      strictlyIncreasing(events)
    })

    it("a signal_recurrence item fails after a signal with the dedupe key arrived inside the window", async () => {
      const { item, window } = await passingItem()
      // before the merge: not a recurrence
      await addSignal(item.id, KEY, minutesAfter(NOW, -3 * HOUR))
      // exactly at the window's start: not after it
      await addSignal(item.id, KEY, window.startsAt)
      // another key: not this item's
      await addSignal(item.id, "github-issue:acme/web#2", minutesAfter(window.startsAt, 30))
      expect(await sweep(minutesAfter(window.startsAt, 60))).toEqual(EMPTY)
      expect((await itemRow(item.id)).state).toBe("verify")
      // the row says so: with no signal after the start the verifier passes, it is not just pending
      const before = (await contractOf(item.id)).find((r) => r.verifierKind === "signal_recurrence")
      expect(before).toMatchObject({ status: "passing" })

      await addSignal(item.id, KEY, new Date(window.startsAt.getTime() + 1))
      const now = minutesAfter(window.startsAt, 90)
      expect(await sweep(now)).toEqual({ ...EMPTY, reopened: [item.id] })
      expect((await itemRow(item.id)).state).toBe("reopened")
      const recurrence = (await contractOf(item.id)).find(
        (r) => r.verifierKind === "signal_recurrence",
      )
      expect(recurrence).toMatchObject({ status: "failing" })
    })

    it("a signal_recurrence item with no dedupe key stays pending and never passes", async () => {
      const { item } = await mergedItem({ state: "verify", dedupeKey: null })
      const window = await addWindow(item.id, minutesAfter(NOW, GRACE))
      await addContract(item.id, "signal_recurrence")
      expect(await sweep(window.endsAt)).toEqual(EMPTY)
      expect((await itemRow(item.id)).state).toBe("verify")
      expect((await contractOf(item.id))[0]).toMatchObject({ status: "pending" })
    })

    it("a verify item with no contract rows in the current cycle does not pass", async () => {
      const { item } = await mergedItem({ state: "verify" })
      const window = await addWindow(item.id, minutesAfter(NOW, GRACE))
      expect(await sweep(new Date(window.endsAt.getTime() + HOUR * 60_000))).toEqual(EMPTY)
      expect((await itemRow(item.id)).state).toBe("verify")
    })

    it("a verifier that is not connected is not_connected and never passes the window", async () => {
      const { item } = await passingItem()
      await addContract(item.id, "sentry")
      const [window] = await windowsOf(item.id)
      const late = minutesAfter(window!.endsAt, 5 * HOUR)
      expect(await sweep(late)).toEqual(EMPTY)
      expect((await itemRow(item.id)).state).toBe("verify")
      const sentry = (await contractOf(item.id)).find((r) => r.verifierKind === "sentry")
      expect(sentry?.status).toBe("pending")
      expect(sentry?.evidence).toMatch(/^not_connected/)
      expect(sentry?.checkedAt).toEqual(late)
    })

    it("only the current cycle's contract rows count", async () => {
      // cycle 1 had a failing ci row; cycle 2 has a passing one
      const { item } = await mergedItem({
        state: "verify",
        cycle: 2,
        checks: [{ name: "unit", state: "passed" }],
      })
      await addContract(item.id, "reviewer", { cycle: 1, position: 1 })
      await addContract(item.id, "signal_recurrence", { cycle: 1, position: 2 })
      await addFix(item.id, 1, "rejected", { cycle: 1 })
      await addFix(item.id, 2, "approved", { cycle: 2 })
      await addContract(item.id, "reviewer", { cycle: 2, position: 1 })
      const window = await addWindow(item.id, minutesAfter(NOW, GRACE), { cycle: 2 })
      expect(await sweep(window.endsAt)).toEqual({ ...EMPTY, passed: [item.id] })
      const done = await itemRow(item.id)
      expect(done).toMatchObject({ state: "done", cycle: 2 })
      expect((await contractOf(item.id, 1)).map((r) => r.status)).toEqual(["pending", "pending"])
      expect((await contractOf(item.id, 1)).every((r) => r.checkedAt === null)).toBe(true)
      expect((await contractOf(item.id, 2)).map((r) => r.status)).toEqual(["passing"])
      const events = await eventsOf(item.id)
      expect(events.every((e) => e.cycle === 2)).toBe(true)
    })

    it("a cycle 2 item with no cycle 2 contract does not pass on cycle 1's rows", async () => {
      const { item } = await mergedItem({ state: "verify", cycle: 2 })
      await addFix(item.id, 1, "approved", { cycle: 1 })
      await addContract(item.id, "reviewer", { cycle: 1, position: 1 })
      const window = await addWindow(item.id, minutesAfter(NOW, GRACE), { cycle: 2 })
      expect(await sweep(minutesAfter(window.endsAt, HOUR))).toEqual(EMPTY)
      expect((await itemRow(item.id)).state).toBe("verify")
    })

    it("settleVerifyItem re-reads the state under the lock and ignores a window that is not running", async () => {
      const { item } = await passingItem()
      const [window] = await windowsOf(item.id)
      const late = minutesAfter(window!.endsAt, HOUR)
      await forceState(db(), item.id, "stopped", NOW)
      const before = await snapshot()
      expect(await settleVerifyItem(db(), item.id, late)).toBeNull()
      expect(await snapshot()).toEqual(before)

      await forceState(db(), item.id, "verify", NOW)
      await db()
        .update(verificationWindows)
        .set({ status: "stopped" })
        .where(eq(verificationWindows.id, window!.id))
      const stopped = await snapshot()
      expect(await settleVerifyItem(db(), item.id, late)).toBeNull()
      expect(await snapshot()).toEqual(stopped)
    })
  })

  describe("the window of the current cycle", () => {
    it("settleVerifyItem reads the window of the item's current cycle, not another cycle's", async () => {
      const { item } = await mergedItem({ state: "verify", cycle: 2 })
      // cycle 1's window was closed (and is read first); cycle 2's is the running one
      const old = await addWindow(item.id, minutesAfter(NOW, -2 * HOUR), {
        cycle: 1,
        status: "failed",
      })
      const window = await addWindow(item.id, minutesAfter(NOW, GRACE), { cycle: 2 })
      await addFix(item.id, 1, "approved", { cycle: 2 })
      await addContract(item.id, "reviewer", { cycle: 2, position: 1 })
      expect(await sweep(window.endsAt)).toEqual({ ...EMPTY, passed: [item.id] })
      const rows = await windowsOf(item.id)
      expect(rows.find((w) => w.id === old.id)).toMatchObject({ status: "failed", checkedAt: null })
      expect(rows.find((w) => w.id === window.id)).toMatchObject({ status: "passed" })
    })
  })

  // ---- evaluateContract ------------------------------------------------------------------------
  describe("evaluateContract", () => {
    const evaluate = async (itemId: string, now: Date) =>
      db().transaction(async (tx) => {
        const item = await lockItem(tx, itemId)
        const [window] = await tx
          .select()
          .from(verificationWindows)
          .where(eq(verificationWindows.itemId, itemId))
        return evaluateContract(tx, item, window!, now)
      })
    const verifyItemWith = async (
      checks: PullRequestCheck[],
      o: { prState?: "merged" | "open" } = {},
    ) => {
      const { item } = await mergedItem({ state: "verify", checks, ...o })
      await addWindow(item.id, minutesAfter(NOW, GRACE))
      return item
    }

    it("a ci item passes only when every check passed: none, pending and a missing merged pull request are pending", async () => {
      const none = await verifyItemWith([])
      await addContract(none.id, "ci")
      expect(await evaluate(none.id, NOW)).toEqual({ allPassing: false, anyFailing: false })
      expect((await contractOf(none.id))[0]).toMatchObject({ status: "pending" })

      const pending = await verifyItemWith([
        { name: "unit", state: "passed" },
        { name: "e2e", state: "pending" },
      ])
      await addContract(pending.id, "ci")
      expect(await evaluate(pending.id, NOW)).toEqual({ allPassing: false, anyFailing: false })

      const open = await verifyItemWith([{ name: "unit", state: "passed" }], { prState: "open" })
      await addContract(open.id, "ci")
      expect(await evaluate(open.id, NOW)).toEqual({ allPassing: false, anyFailing: false })

      const ok = await verifyItemWith([{ name: "unit", state: "passed" }])
      await addContract(ok.id, "ci")
      expect(await evaluate(ok.id, NOW)).toEqual({ allPassing: true, anyFailing: false })
    })

    it("the reviewer verifier passes when the cycle's newest fix attempt is approved, else stays pending", async () => {
      const item = await verifyItemWith([])
      await addContract(item.id, "reviewer")
      // no fix at all; an approved investigation is not a fix
      await addFix(item.id, 1, null, { kind: "investigate" })
      expect(await evaluate(item.id, NOW)).toEqual({ allPassing: false, anyFailing: false })
      // approved earlier, but the newest fix was rejected
      await addFix(item.id, 2, "approved")
      await addFix(item.id, 3, "rejected")
      expect(await evaluate(item.id, NOW)).toEqual({ allPassing: false, anyFailing: false })
      expect((await contractOf(item.id))[0]!.status).toBe("pending")
      // a newest fix still running is not approved either
      await addFix(item.id, 4, null, { status: "running" })
      expect(await evaluate(item.id, NOW)).toEqual({ allPassing: false, anyFailing: false })
    })

    it("the reviewer reads the same newest fix as loadFacts: a requested or needs_answer fix after an approved one does not hide it", async () => {
      const factsResult = (itemId: string) =>
        db().transaction(
          async (tx) => (await loadFacts(tx, await lockItem(tx, itemId), NOW)).newestFixResult,
        )
      for (const later of [
        { result: null, status: "requested" },
        { result: "needs_answer", status: "finished" },
      ] as const) {
        const item = await verifyItemWith([])
        await addContract(item.id, "reviewer")
        await addFix(item.id, 1, "rejected")
        await addFix(item.id, 2, "approved")
        await addFix(item.id, 3, later.result, { status: later.status })
        expect(await evaluate(item.id, NOW)).toEqual({ allPassing: true, anyFailing: false })
        expect((await contractOf(item.id))[0]).toMatchObject({ status: "passing" })
        expect((await contractOf(item.id))[0]?.evidence).toMatch(/fix attempt 2\./)
        expect(await factsResult(item.id)).toBe("approved")
      }
    })

    it("an item with an approved fix and a later requested fix reaches done once the window ends", async () => {
      const { item } = await mergedItem({ state: "verify" })
      const window = await addWindow(item.id, minutesAfter(NOW, GRACE))
      await addContract(item.id, "reviewer")
      await addFix(item.id, 1, "approved")
      await addFix(item.id, 2, null, { status: "requested" })
      expect(await sweep(window.endsAt)).toEqual({ ...EMPTY, passed: [item.id] })
      expect((await itemRow(item.id)).state).toBe("done")
    })

    it("an approval from an earlier cycle does not count", async () => {
      const item = await verifyItemWith([])
      await db().update(workItems).set({ cycle: 2 }).where(eq(workItems.id, item.id))
      await db()
        .update(verificationWindows)
        .set({ cycle: 2 })
        .where(eq(verificationWindows.itemId, item.id))
      await addFix(item.id, 1, "approved", { cycle: 1 })
      await addContract(item.id, "reviewer", { cycle: 2, position: 1 })
      expect(await evaluate(item.id, NOW)).toEqual({ allPassing: false, anyFailing: false })
    })

    it("a failing ci check wins over a pending one and over passing rows", async () => {
      const item = await verifyItemWith([
        { name: "a", state: "pending" },
        { name: "b", state: "failed" },
      ])
      await addFix(item.id, 1, "approved")
      await addContract(item.id, "reviewer")
      await addContract(item.id, "ci")
      expect(await evaluate(item.id, NOW)).toEqual({ allPassing: false, anyFailing: true })
      expect((await contractOf(item.id)).map((r) => r.status)).toEqual(["passing", "failing"])
    })

    it("a no-op evaluation writes no event and the same values again", async () => {
      const { item } = await passingItem()
      const [window] = await windowsOf(item.id)
      const at = minutesAfter(window!.startsAt, 30)
      await evaluate(item.id, at)
      const first = await snapshot()
      await evaluate(item.id, at)
      expect(await snapshot()).toEqual(first)
      expect(first.events).toEqual([])
    })
  })

  // ---- reopened and the rest of the sweep ------------------------------------------------------
  describe("the rest of the sweep", () => {
    it("the sweep returns reopened items to triage with cycle + 1", async () => {
      const item = await seedItem(db(), { state: "reopened", cycle: 1, dedupeKey: KEY })
      await seedPullRequest(db(), item.id, { state: "merged", mergedAt: NOW })
      const out = await sweep(minutesAfter(NOW, 2 * HOUR))
      expect(out).toEqual({ ...EMPTY, retriaged: [item.id] })
      const row = await itemRow(item.id)
      expect(row.state).toBe("triage")
      expect(row.cycle).toBe(2)
      const events = await eventsOf(item.id)
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        kind: "transition",
        fromState: "reopened",
        toState: "triage",
        reason: "retriaged",
        actorType: "system",
        cycle: 2,
      })
    })

    it("the retriage carries open questions into the next cycle and names them in its event", async () => {
      const item = await seedItem(db(), { state: "reopened", cycle: 1 })
      const [q] = await db()
        .insert(agentQuestions)
        .values({
          id: crypto.randomUUID(),
          itemId: item.id,
          prompt: "Which way?",
          options: [
            { id: "a", label: "A" },
            { id: "b", label: "B" },
          ],
          status: "open",
          createdAt: NOW,
        })
        .returning()
      await sweep(minutesAfter(NOW, HOUR))
      const [after] = await db().select().from(agentQuestions)
      expect(after).toMatchObject({ id: q!.id, status: "open" })
      const [event] = await eventsOf(item.id)
      expect(event!.detail).toEqual({ carriedQuestionIds: [q!.id] })
    })

    it("a retriage with no open question writes no detail", async () => {
      const item = await seedItem(db(), { state: "reopened", cycle: 3 })
      await sweep(NOW)
      const [event] = await eventsOf(item.id)
      expect(event).toMatchObject({ cycle: 4, detail: null })
    })

    it("retriageReopenedItem re-reads the state under the lock", async () => {
      const item = await seedItem(db(), { state: "reopened" })
      await forceState(db(), item.id, "stopped", NOW)
      const before = await snapshot()
      expect(await retriageReopenedItem(db(), item.id, NOW)).toBe(false)
      expect(await snapshot()).toEqual(before)
    })

    it("the sweep abandons an attempt whose lease passed and reports its id", async () => {
      const item = await seedItem(db(), { state: "attempt" })
      const stale = await seedAttempt(db(), item.id, {
        number: 1,
        status: "running",
        result: null,
        leaseExpiresAt: minutesAfter(NOW, 45),
      })
      const fresh = await seedItem(db(), { state: "attempt", title: "Fresh" })
      await seedAttempt(db(), fresh.id, {
        number: 1,
        status: "running",
        result: null,
        leaseExpiresAt: minutesAfter(NOW, 120),
      })
      expect(await sweep(minutesAfter(NOW, 44))).toEqual(EMPTY)
      expect(await sweep(minutesAfter(NOW, 46))).toEqual({ ...EMPTY, abandoned: [stale.id] })
      const [row] = await db().select().from(attempts).where(eq(attempts.id, stale.id))
      expect(row).toMatchObject({ status: "finished", result: "abandoned" })
      expect((await itemRow(item.id)).state).toBe("attempt")
    })

    it("a stopped, done or other in-flight item is left alone", async () => {
      const stopped = await mergedItem({ state: "review" })
      await forceState(db(), stopped.item.id, "stopped", NOW)
      await mergedItem({ state: "done" })
      await mergedItem({ state: "review" })
      const before = await snapshot()
      expect(await sweep(minutesAfter(NOW, 30 * HOUR))).toEqual(EMPTY)
      expect(await snapshot()).toEqual(before)
    })

    it("every event the sweep writes is by the system actor", async () => {
      const a = await mergedItem({ mergedAt: minutesAfter(NOW, -7 * HOUR) })
      await addContract(a.item.id, "signal_recurrence")
      await seedItem(db(), { state: "reopened" })
      await sweep(NOW)
      const events = await db().select().from(workItemEvents)
      expect(events.length).toBeGreaterThan(0)
      expect(events.every((e) => e.actorType === "system" && e.actorId === "hq")).toBe(true)
    })
  })

  // ---- one item's failure does not stop the pass -----------------------------------------------
  describe("a failing item is isolated", () => {
    /** An injected poison: each event insert for this item fails (a trigger per poisoned item). */
    let poisoned = 0
    const poison = async (itemId: string) => {
      await db().execute(sql`create or replace function hq.test_fail_events() returns trigger
        language plpgsql as $$ begin
          raise exception 'boom %', TG_ARGV[0];
        end $$`)
      await db().execute(
        sql.raw(
          `create trigger test_fail_events_${++poisoned} before insert on hq.work_item_events
           for each row when (new.item_id = '${itemId}')
           execute function hq.test_fail_events('${itemId}')`,
        ),
      )
    }
    afterEach(async () => {
      for (let i = 1; i <= poisoned; i++) {
        await db().execute(
          sql.raw(`drop trigger if exists test_fail_events_${i} on hq.work_item_events`),
        )
      }
      poisoned = 0
      await db().execute(sql`drop function if exists hq.test_fail_events()`)
    })
    const early = (hours: number) => minutesAfter(NOW, -hours * HOUR)

    it("an item that throws is recorded in errors and the items behind it still move, in every rule", async () => {
      // in each rule the poison item is the oldest (first in its list) and a healthy one follows
      const badReopened = await seedItem(db(), { state: "reopened", title: "bad" })
      const okReopened = await seedItem(db(), { state: "reopened", title: "ok" })
      await forceState(db(), badReopened.id, "reopened", early(3))
      const badDeploy = await mergedItem({ mergedAt: early(3) })
      const okDeploy = await mergedItem({ mergedAt: early(3) })
      await forceState(db(), badDeploy.item.id, "deploy", early(3))
      const badVerify = await passingItem(early(8))
      const okVerify = await passingItem(early(8))
      await forceState(db(), badVerify.item.id, "verify", early(7))
      await forceState(db(), okVerify.item.id, "verify", early(6))
      for (const id of [badReopened.id, badDeploy.item.id, badVerify.item.id]) await poison(id)

      const out = await sweep(NOW)
      expect(out).toMatchObject({
        retriaged: [okReopened.id],
        advanced: [okDeploy.item.id],
        passed: [okVerify.item.id],
        reopened: [],
        abandoned: [],
      })
      expect(out.errors).toEqual([
        { itemId: badReopened.id, rule: "retriage", message: expect.stringMatching(/boom/) },
        { itemId: badDeploy.item.id, rule: "advance", message: expect.stringMatching(/boom/) },
        { itemId: badVerify.item.id, rule: "settle", message: expect.stringMatching(/boom/) },
      ])
      // the failed transactions rolled back whole
      expect(await itemRow(badReopened.id)).toMatchObject({ state: "reopened", cycle: 1 })
      expect((await itemRow(badDeploy.item.id)).state).toBe("deploy")
      expect(await windowsOf(badDeploy.item.id)).toEqual([])
      expect((await itemRow(badVerify.item.id)).state).toBe("verify")
      expect((await windowsOf(badVerify.item.id))[0]?.status).toBe("running")
      expect((await itemRow(okVerify.item.id)).state).toBe("done")
      // and no message carries SQL or parameters
      for (const e of out.errors) expect(e.message).not.toMatch(/insert|params/i)
    })

    it("a failing attempt expiry is recorded and the later rules still run", async () => {
      const stuck = await seedItem(db(), { state: "attempt", title: "stuck" })
      await seedAttempt(db(), stuck.id, {
        number: 1,
        status: "running",
        result: null,
        leaseExpiresAt: minutesAfter(NOW, -1),
      })
      const reopened = await seedItem(db(), { state: "reopened" })
      await poison(stuck.id)
      const out = await sweep(NOW)
      expect(out.abandoned).toEqual([])
      expect(out.retriaged).toEqual([reopened.id])
      expect(out.errors).toEqual([
        { itemId: stuck.id, rule: "expire", message: expect.stringMatching(/boom/) },
      ])
    })
  })

  // ---- one pass, and two passes ----------------------------------------------------------------
  describe("one pass and idempotency", () => {
    it("two sweeps in a row over one clock: the second returns empty arrays", async () => {
      // B: merged 7 h ago, passes in one sweep; A: 14 minutes, stays; C: verify, passing, window open;
      // D: a stale attempt; E: reopened, retriaged by the first sweep.
      const b = await mergedItem({ mergedAt: minutesAfter(NOW, -7 * HOUR) })
      await addContract(b.item.id, "signal_recurrence")
      const a = await mergedItem({ mergedAt: minutesAfter(NOW, -(GRACE - 1)) })
      const c = await passingItem(minutesAfter(NOW, -2 * HOUR))
      const d = await seedItem(db(), { state: "attempt", title: "D" })
      const stale = await seedAttempt(db(), d.id, {
        number: 1,
        status: "running",
        result: null,
        leaseExpiresAt: minutesAfter(NOW, -1),
      })
      const e = await seedItem(db(), { state: "reopened", title: "E" })

      const first = await sweep(NOW)
      expect(first).toEqual({
        advanced: [b.item.id],
        passed: [b.item.id],
        reopened: [],
        retriaged: [e.id],
        abandoned: [stale.id],
        errors: [],
      })
      expect((await itemRow(a.item.id)).state).toBe("deploy")
      expect((await itemRow(c.item.id)).state).toBe("verify")

      const after = await snapshot()
      expect(await sweep(NOW)).toEqual(EMPTY)
      expect(await snapshot()).toEqual(after)
    })

    it("an item the first pass reopens is retriaged by the second, each at most one edge, with the story in order", async () => {
      const { item } = await mergedItem({
        state: "verify",
        checks: [{ name: "unit", state: "failed" }],
      })
      await addWindow(item.id, minutesAfter(NOW, GRACE))
      await addContract(item.id, "ci")
      const now = minutesAfter(NOW, GRACE + HOUR)

      expect(await sweep(now)).toEqual({ ...EMPTY, reopened: [item.id] })
      expect((await itemRow(item.id)).state).toBe("reopened")
      expect((await itemRow(item.id)).cycle).toBe(1)

      expect(await sweep(now)).toEqual({ ...EMPTY, retriaged: [item.id] })
      const row = await itemRow(item.id)
      expect(row.state).toBe("triage")
      expect(row.cycle).toBe(2)

      expect(await sweep(now)).toEqual(EMPTY)
      const events = await eventsOf(item.id)
      expect(events.map((e) => [e.kind, e.toState, e.cycle])).toEqual([
        ["transition", "reopened", 1],
        ["window_closed", null, 1],
        ["transition", "triage", 2],
      ])
      strictlyIncreasing(events)
    })

    it("a revert request becomes a triage item at the next sweep with the exact next cycle", async () => {
      const { item } = await mergedItem({ cycle: 2 })
      const asked = minutesAfter(NOW, 30)
      await requestRevert(db(), { itemId: item.id, founderId: "founder-1", now: asked })
      expect(await itemRow(item.id)).toMatchObject({ state: "reopened", cycle: 2 })
      expect(await sweep(asked)).toEqual({ ...EMPTY, retriaged: [item.id] })
      expect(await itemRow(item.id)).toMatchObject({ state: "triage", cycle: 3 })
      expect(await sweep(asked)).toEqual(EMPTY)
      const events = await eventsOf(item.id)
      expect(events.map((e) => [e.kind, e.toState, e.reason, e.cycle])).toEqual([
        ["transition", "reopened", "revert_requested", 2],
        ["revert_requested", null, null, 2],
        ["transition", "triage", "retriaged", 3],
      ])
      strictlyIncreasing(events)
    })

    it("the cycle never gains more than the one the move into triage adds, over repeated sweeps", async () => {
      const { item } = await mergedItem({
        state: "verify",
        checks: [{ name: "u", state: "failed" }],
      })
      await addWindow(item.id, minutesAfter(NOW, GRACE))
      await addContract(item.id, "ci")
      for (let i = 0; i < 4; i++) await sweep(minutesAfter(NOW, 2 * HOUR))
      expect(await itemRow(item.id)).toMatchObject({ state: "triage", cycle: 2 })
    })
  })

  // ---- occurrence buckets ----------------------------------------------------------------------
  describe("occurrenceBuckets", () => {
    const MERGE = NOW
    const from = minutesAfter(MERGE, -12 * HOUR)

    it("occurrenceBuckets zero-fills 30 minute buckets from 12 h before the merge to now", async () => {
      const item = await seedItem(db(), { dedupeKey: KEY })
      const to = minutesAfter(MERGE, 7 * HOUR)
      await addSignal(item.id, KEY, minutesAfter(from, 5))
      await addSignal(item.id, KEY, minutesAfter(from, 29))
      await addSignal(item.id, KEY, minutesAfter(from, 30))
      await addSignal(item.id, KEY, minutesAfter(MERGE, 20))
      await addSignal(item.id, KEY, to)
      const buckets = await occurrenceBuckets(db(), { dedupeKey: KEY, from, to })
      // 19 hours = 38 half hours, and the bucket that holds `to` itself
      expect(buckets).toHaveLength(39)
      expect(buckets[0]).toEqual({ at: from, count: 2 })
      expect(buckets[1]).toEqual({ at: minutesAfter(from, 30), count: 1 })
      expect(buckets[2]).toEqual({ at: minutesAfter(from, 60), count: 0 })
      expect(buckets.find((b) => b.at.getTime() === minutesAfter(MERGE, 0).getTime())).toEqual({
        at: MERGE,
        count: 1,
      })
      expect(buckets[38]).toEqual({ at: to, count: 1 })
      expect(buckets.reduce((n, b) => n + b.count, 0)).toBe(5)
      for (let i = 1; i < buckets.length; i++) {
        expect(buckets[i]!.at.getTime() - buckets[i - 1]!.at.getTime()).toBe(30 * 60_000)
      }
    })

    it("counts by dedupe key across every item and leaves out signals outside the range", async () => {
      const one = await seedItem(db(), { dedupeKey: KEY })
      const two = await seedItem(db(), { dedupeKey: KEY, title: "older twin" })
      const to = minutesAfter(from, 90)
      await addSignal(one.id, KEY, minutesAfter(from, 10))
      await addSignal(two.id, KEY, minutesAfter(from, 11))
      await addSignal(one.id, "github-issue:acme/web#9", minutesAfter(from, 12))
      await addSignal(one.id, KEY, new Date(from.getTime() - 1))
      await addSignal(one.id, KEY, new Date(to.getTime() + 1))
      const buckets = await occurrenceBuckets(db(), { dedupeKey: KEY, from, to })
      expect(buckets.map((b) => b.count)).toEqual([2, 0, 0, 0])
    })

    it("a range of zero length is one bucket, a reversed range is none, and a huge range is refused", async () => {
      expect(await occurrenceBuckets(db(), { dedupeKey: KEY, from, to: from })).toEqual([
        { at: from, count: 0 },
      ])
      expect(
        await occurrenceBuckets(db(), { dedupeKey: KEY, from, to: new Date(from.getTime() - 1) }),
      ).toEqual([])
      await expect(
        occurrenceBuckets(db(), { dedupeKey: KEY, from, to: minutesAfter(from, 60 * 24 * 60) }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" })
    })
  })
})
