import { AppError } from "@proof/errors"
import { and, asc, eq } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import {
  agentQuestions,
  attempts,
  contractItems,
  mergeApprovals,
  pullRequests,
  verificationWindows,
  workItemEvents,
  workItems,
} from "../db/schema"
import { createHqTestDb } from "../testing"
import { deriveAttention } from "../work/machine"
import { finishAttempt, heartbeatAttempt, requestAttempt, startAttempt } from "./attempts"
import {
  approveMerge,
  checkUuid,
  closeRunningWindow,
  reopenItem,
  requestRevert,
  retryItem,
  stopItem,
} from "./decisions"
import { recordPullRequest } from "./pull-requests"
import { askQuestion, answerQuestion } from "./questions"
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
import { loadFacts, lockItem, resolveItem } from "./work-items"

const AGENT = { type: "agent", id: "agent-key" } as const
const FOUNDER = "founder-1"
const BRANCH = "factory/fix-7"
const SHA_A = "a1b2c3d4".repeat(5)
const SHA_B = "b".repeat(40)
const REVIEW = { verdict: "approve", summary: "Looks right." } as const
const urlOf = (n: number, repo = "acme/web") => `https://github.com/${repo}/pull/${n}`

describe("founder decisions (in-process Postgres)", () => {
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
  const eventsOf = (itemId: string) =>
    db()
      .select()
      .from(workItemEvents)
      .where(eq(workItemEvents.itemId, itemId))
      .orderBy(asc(workItemEvents.at), asc(workItemEvents.id))
  const kindsOf = async (itemId: string) => (await eventsOf(itemId)).map((e) => e.kind)
  const approvalsOf = (itemId: string) =>
    db()
      .select()
      .from(mergeApprovals)
      .where(eq(mergeApprovals.itemId, itemId))
      .orderBy(asc(mergeApprovals.requestedAt), asc(mergeApprovals.id))
  const attemptsOf = (itemId: string) =>
    db().select().from(attempts).where(eq(attempts.itemId, itemId)).orderBy(asc(attempts.number))
  const windowsOf = (itemId: string) =>
    db().select().from(verificationWindows).where(eq(verificationWindows.itemId, itemId))
  const itemOf = (itemId: string) => resolveItem(db(), itemId)
  const factsOf = (itemId: string, now = NOW) =>
    db().transaction(async (tx) => loadFacts(tx, await lockItem(tx, itemId), now))
  const expectAppError = async (p: Promise<unknown>, code: string) => {
    const error = await p.then(
      () => null,
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).code).toBe(code)
  }
  const strictlyIncreasing = (rows: { at: Date }[]) => {
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.at.getTime()).toBeGreaterThan(rows[i - 1]!.at.getTime())
    }
  }

  const addContract = async (itemId: string, cycle = 1) => {
    await db().insert(contractItems).values({
      id: crypto.randomUUID(),
      itemId,
      cycle,
      position: 1,
      text: "It works",
      verifierKind: "reviewer",
      status: "pending",
      createdByType: "system",
      createdById: "test",
    })
  }
  const record = (itemId: string, o: Record<string, unknown> = {}, now = NOW) =>
    recordPullRequest(db(), {
      actor: AGENT,
      itemId,
      branch: BRANCH,
      number: 7,
      url: urlOf(7),
      base: "main",
      headSha: SHA_A,
      isDraft: false,
      state: "open",
      ...o,
      now,
    })

  /** An item in `review` whose approved fix and open pull request ask for a merge approval. */
  async function reviewed(o: { attemptLimit?: number } = {}) {
    const item = await seedItem(db(), { state: "plan", attemptLimit: o.attemptLimit ?? null })
    await addContract(item.id)
    const attempt = await startAttempt(db(), {
      itemId: item.id,
      kind: "fix",
      actor: AGENT,
      now: NOW,
    })
    await heartbeatAttempt(db(), {
      attemptId: attempt.id,
      branch: BRANCH,
      now: minutesAfter(NOW, 1),
    })
    await record(item.id, {}, minutesAfter(NOW, 2))
    await finishAttempt(db(), {
      actor: AGENT,
      attemptId: attempt.id,
      result: "approved",
      reviewer: REVIEW,
      now: minutesAfter(NOW, 10),
    })
    const [approval] = await approvalsOf(item.id)
    expect(approval?.status).toBe("pending")
    return { item, attempt, approval: approval! }
  }
  const approve = (itemId: string, o: Partial<Parameters<typeof approveMerge>[1]> = {}) =>
    approveMerge(db(), {
      itemId,
      headSha: SHA_A,
      founderId: FOUNDER,
      now: minutesAfter(NOW, 20),
      ...o,
    })
  const NOW2 = minutesAfter(NOW, 60)
  const stop = (itemId: string, o: { note?: string; founderId?: string; now?: Date } = {}) =>
    stopItem(db(), { itemId, founderId: FOUNDER, now: NOW2, ...o })
  const reopen = (itemId: string, o: { note?: string; founderId?: string; now?: Date } = {}) =>
    reopenItem(db(), { itemId, founderId: FOUNDER, now: NOW2, ...o })
  const revert = (itemId: string, o: { note?: string; founderId?: string; now?: Date } = {}) =>
    requestRevert(db(), { itemId, founderId: FOUNDER, now: NOW2, ...o })
  const retry = (itemId: string, o: { note?: string; founderId?: string; now?: Date } = {}) =>
    retryItem(db(), { itemId, note: "Try the other approach", founderId: FOUNDER, now: NOW2, ...o })
  const addWindow = async (
    itemId: string,
    o: { cycle?: number; status?: "running" | "passed" } = {},
  ) => {
    const [row] = await db()
      .insert(verificationWindows)
      .values({
        id: crypto.randomUUID(),
        itemId,
        cycle: o.cycle ?? 1,
        startsAt: NOW,
        endsAt: minutesAfter(NOW, 360),
        status: o.status ?? "running",
      })
      .returning()
    return row!
  }
  const mergedItem = async (state: "deploy" | "verify" | "done") => {
    const item = await seedItem(db(), { state })
    await seedPullRequest(db(), item.id, { number: 7, state: "merged", mergedAt: NOW })
    return item
  }

  describe("approveMerge", () => {
    it("with the pending head sha approves and leaves the item in review", async () => {
      const { item, approval } = await reviewed()
      const before = await eventsOf(item.id)
      const at = minutesAfter(NOW, 20)
      const out = await approve(item.id, { note: "Ship it.", now: at })
      expect(out).toEqual({ headSha: SHA_A, pullRequestUrl: urlOf(7) })
      const [row] = await approvalsOf(item.id)
      expect(row).toMatchObject({
        id: approval.id,
        status: "approved",
        decidedBy: FOUNDER,
        decidedAt: at,
        note: "Ship it.",
        headSha: SHA_A,
      })
      expect((await itemOf(item.id)).state).toBe("review")
      const after = await eventsOf(item.id)
      expect(after).toHaveLength(before.length + 1)
      expect(after.at(-1)).toMatchObject({
        kind: "merge_approved",
        actorType: "founder",
        actorId: FOUNDER,
        note: "Ship it.",
        at,
        cycle: 1,
        detail: { approvalId: approval.id, headSha: SHA_A, pullRequestNumber: 7 },
      })
      // no transition and no attempt: approving records a decision and nothing else
      expect(after.filter((e) => e.kind === "transition")).toHaveLength(
        before.filter((e) => e.kind === "transition").length,
      )
      // and the item no longer asks for a decision
      expect((await factsOf(item.id)).pendingMergeApproval).toBe(false)
      expect(deriveAttention(await factsOf(item.id))).toBeNull()
    })

    it("lower-cases the sha it compares: an upper-case input matches the stored lower-case head", async () => {
      const { item } = await reviewed()
      const out = await approve(item.id, { headSha: SHA_A.toUpperCase() })
      expect(out.headSha).toBe(SHA_A)
      expect((await approvalsOf(item.id))[0]?.status).toBe("approved")
    })

    it("a short sha is refused, a non-hex one is BAD_REQUEST, and nothing is written", async () => {
      const { item } = await reviewed()
      const before = await eventsOf(item.id)
      for (const headSha of [
        "",
        "abc",
        "a".repeat(6),
        "a".repeat(65),
        "g".repeat(40),
        " " + SHA_A,
      ]) {
        await expectAppError(approve(item.id, { headSha }), "BAD_REQUEST")
      }
      expect((await approvalsOf(item.id))[0]?.status).toBe("pending")
      expect(await eventsOf(item.id)).toHaveLength(before.length)
    })

    it("with a stale head sha is CONFLICT and writes nothing", async () => {
      const { item } = await reviewed()
      // a push after the card loaded: the pending approval is voided
      await record(item.id, { headSha: SHA_B }, minutesAfter(NOW, 15))
      const before = await eventsOf(item.id)
      const approvals = await approvalsOf(item.id)
      expect(approvals.map((a) => a.status)).toEqual(["void"])
      // the plan's pinned message, although no approval is pending any more
      await expectAppError(approve(item.id, { headSha: SHA_A }), "CONFLICT")
      await expect(approve(item.id, { headSha: SHA_A })).rejects.toThrow(
        "The pull request changed since you looked",
      )
      // the new head has no approval until a new approved attempt: approving it is CONFLICT too
      await expectAppError(approve(item.id, { headSha: SHA_B }), "CONFLICT")
      await expect(approve(item.id, { headSha: SHA_B })).rejects.toThrow(
        "No merge approval is waiting",
      )
      expect(await eventsOf(item.id)).toHaveLength(before.length)
      expect((await approvalsOf(item.id)).map((a) => a.status)).toEqual(["void"])
    })

    it("a sha that is not the pending approval's is CONFLICT even when the approval is pending", async () => {
      const { item } = await reviewed()
      const before = await eventsOf(item.id)
      await expectAppError(approve(item.id, { headSha: SHA_B }), "CONFLICT")
      expect((await approvalsOf(item.id))[0]?.status).toBe("pending")
      expect(await eventsOf(item.id)).toHaveLength(before.length)
    })

    it("twice is CONFLICT and the second writes nothing", async () => {
      const { item } = await reviewed()
      await approve(item.id)
      const before = await eventsOf(item.id)
      await expectAppError(approve(item.id, { founderId: "founder-2", now: NOW2 }), "CONFLICT")
      expect(await eventsOf(item.id)).toHaveLength(before.length)
      expect((await approvalsOf(item.id))[0]).toMatchObject({
        status: "approved",
        decidedBy: FOUNDER,
      })
      expect((await eventsOf(item.id)).filter((e) => e.kind === "merge_approved")).toHaveLength(1)
    })

    it("after the pull request closed is CONFLICT", async () => {
      const { item } = await reviewed()
      await record(item.id, { state: "closed" }, minutesAfter(NOW, 15))
      expect((await itemOf(item.id)).state).toBe("stopped")
      await expectAppError(approve(item.id), "CONFLICT")
      expect((await approvalsOf(item.id)).map((a) => a.status)).toEqual(["void"])
    })

    it("after the pull request merged is CONFLICT", async () => {
      const { item } = await reviewed()
      await record(item.id, { state: "merged" }, minutesAfter(NOW, 15))
      expect((await itemOf(item.id)).state).toBe("deploy")
      await expectAppError(approve(item.id), "CONFLICT")
    })

    it("an item that is not in review is CONFLICT even with a pending approval row", async () => {
      const { item } = await reviewed()
      await forceState(db(), item.id, "attempt", NOW2)
      const before = await eventsOf(item.id)
      await expectAppError(approve(item.id), "CONFLICT")
      expect((await approvalsOf(item.id))[0]?.status).toBe("pending")
      expect(await eventsOf(item.id)).toHaveLength(before.length)
    })

    it("a retry that started after the card loaded makes the pending approval unapprovable (the approval is left pending: see the report)", async () => {
      const { item } = await reviewed({ attemptLimit: 3 })
      await startAttempt(db(), {
        itemId: item.id,
        kind: "fix",
        actor: AGENT,
        now: minutesAfter(NOW, 30),
      })
      expect((await itemOf(item.id)).state).toBe("attempt")
      await expectAppError(approve(item.id), "CONFLICT")
      expect((await approvalsOf(item.id))[0]?.status).toBe("pending")
      // the dead card is never asked for: the fact is false, so the item has no merge_approval
      const facts = await factsOf(item.id, minutesAfter(NOW, 31))
      expect(facts.pendingMergeApproval).toBe(false)
      expect(deriveAttention(facts)).not.toBe("merge_approval")
    })

    it("pendingMergeApproval is true only in review and for the current pull request's approval", async () => {
      const { item } = await reviewed()
      expect((await factsOf(item.id)).pendingMergeApproval).toBe(true)
      expect(deriveAttention(await factsOf(item.id))).toBe("merge_approval")
      // a newer pull request of the cycle takes over as current: the older approval is not asked for
      await seedPullRequest(db(), item.id, {
        number: 8,
        state: "open",
        openedAt: minutesAfter(NOW, 30),
        branch: "factory/fix-8",
      })
      expect((await factsOf(item.id)).pendingMergeApproval).toBe(false)
      expect(deriveAttention(await factsOf(item.id))).not.toBe("merge_approval")
      // and out of review, whatever the approval row says
      const other = await reviewed()
      await forceState(db(), other.item.id, "attempt", NOW2)
      expect((await factsOf(other.item.id, NOW2)).pendingMergeApproval).toBe(false)
      await forceState(db(), other.item.id, "review", NOW2)
      expect((await factsOf(other.item.id, NOW2)).pendingMergeApproval).toBe(true)
    })

    it("the pull request the approval is bound to must be the item's current one", async () => {
      const { item, approval } = await reviewed()
      // a newer pull request of the same cycle with the same head: the old approval is not its own
      await seedPullRequest(db(), item.id, {
        number: 8,
        state: "open",
        openedAt: minutesAfter(NOW, 30),
        branch: "factory/fix-8",
      })
      const [newer] = await db()
        .select()
        .from(pullRequests)
        .where(and(eq(pullRequests.itemId, item.id), eq(pullRequests.number, 8)))
      expect(newer?.headSha).toBe("a".repeat(40))
      await db()
        .update(pullRequests)
        .set({ headSha: SHA_A })
        .where(eq(pullRequests.id, newer?.id ?? ""))
      const before = await eventsOf(item.id)
      await expectAppError(approve(item.id, { headSha: SHA_A }), "CONFLICT")
      expect((await approvalsOf(item.id))[0]).toMatchObject({ id: approval.id, status: "pending" })
      expect(await eventsOf(item.id)).toHaveLength(before.length)
    })

    it("a pull request that is no longer open is CONFLICT", async () => {
      const { item } = await reviewed()
      await db()
        .update(pullRequests)
        .set({ state: "closed" })
        .where(eq(pullRequests.itemId, item.id))
      await expectAppError(approve(item.id), "CONFLICT")
      expect((await approvalsOf(item.id))[0]?.status).toBe("pending")
    })

    it("a draft pull request can be approved (the card shows isDraft)", async () => {
      const item = await seedItem(db(), { state: "plan" })
      await addContract(item.id)
      const attempt = await startAttempt(db(), {
        itemId: item.id,
        kind: "fix",
        actor: AGENT,
        now: NOW,
      })
      await heartbeatAttempt(db(), {
        attemptId: attempt.id,
        branch: BRANCH,
        now: minutesAfter(NOW, 1),
      })
      await record(item.id, { isDraft: true })
      await finishAttempt(db(), {
        actor: AGENT,
        attemptId: attempt.id,
        result: "approved",
        reviewer: REVIEW,
        now: minutesAfter(NOW, 5),
      })
      await approve(item.id)
      expect((await approvalsOf(item.id))[0]?.status).toBe("approved")
    })

    it("the note is capped and a blank one is none; the founder id and item id are checked", async () => {
      const { item } = await reviewed()
      await expectAppError(approve(item.id, { note: "x".repeat(2001) }), "BAD_REQUEST")
      await expectAppError(approve(item.id, { founderId: "" }), "BAD_REQUEST")
      await expectAppError(approve("FAC-1"), "BAD_REQUEST")
      await expectAppError(approve(crypto.randomUUID()), "NOT_FOUND")
      expect((await approvalsOf(item.id))[0]?.status).toBe("pending")
      await approve(item.id, { note: "  " })
      expect((await approvalsOf(item.id))[0]?.note).toBeNull()
    })
  })

  describe("stopItem", () => {
    it("from review withdraws open questions, voids the pending approval, ends a requested attempt and sets stopped", async () => {
      const { item } = await reviewed({ attemptLimit: 3 })
      const q1 = await askQuestion(db(), {
        itemId: item.id,
        prompt: "One?",
        options: [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
        ],
        actor: AGENT,
        now: minutesAfter(NOW, 30),
      })
      const q2 = await askQuestion(db(), {
        itemId: item.id,
        prompt: "Two?",
        options: [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
        ],
        actor: AGENT,
        now: minutesAfter(NOW, 31),
      })
      await answerQuestion(db(), {
        questionId: q2.id,
        optionId: "a",
        founderId: FOUNDER,
        now: minutesAfter(NOW, 32),
      })
      const requested = await requestAttempt(db(), {
        itemId: item.id,
        kind: "fix",
        origin: "founder_request",
        founderId: FOUNDER,
        now: minutesAfter(NOW, 33),
      })
      const moved = await stop(item.id, { note: "Not worth it." })
      expect(moved).toMatchObject({ state: "stopped", cycle: 1, stateChangedAt: NOW2 })

      const questions = await db()
        .select()
        .from(agentQuestions)
        .where(eq(agentQuestions.itemId, item.id))
      expect(Object.fromEntries(questions.map((q) => [q.id, q.status]))).toEqual({
        [q1.id]: "withdrawn",
        [q2.id]: "answered",
      })
      expect((await approvalsOf(item.id)).map((a) => a.status)).toEqual(["void"])
      const [ended] = (await attemptsOf(item.id)).filter((a) => a.id === requested.id)
      expect(ended).toMatchObject({
        status: "finished",
        result: "abandoned",
        finishedAt: expect.any(Date),
      })
      expect(await factsOf(item.id, NOW2)).toMatchObject({
        openQuestion: false,
        pendingMergeApproval: false,
        activeAttempt: "none",
      })

      const rows = (await eventsOf(item.id)).filter((e) => e.at >= NOW2)
      expect(rows.map((e) => [e.kind, e.actorType])).toEqual([
        ["transition", "founder"],
        ["merge_approval_void", "system"],
        ["attempt_abandoned", "system"],
      ])
      expect(rows[0]).toMatchObject({
        fromState: "review",
        toState: "stopped",
        reason: "stopped",
        actorId: FOUNDER,
        note: "Not worth it.",
      })
      // the open question the stop withdrew is named in the stop's own event; the answered one is not
      expect(rows[0]?.detail).toEqual({ withdrawnQuestionIds: [q1.id] })
      expect(rows[1]).toMatchObject({ reason: "stopped" })
      expect(rows[2]?.detail).toMatchObject({ attemptId: requested.id, reason: "stopped" })
      strictlyIncreasing(rows)
    })

    it("a stop also voids an approved approval: a stopped item holds no live go-ahead", async () => {
      const { item } = await reviewed()
      await approve(item.id)
      await stop(item.id)
      expect((await approvalsOf(item.id)).map((a) => a.status)).toEqual(["void"])
    })

    it("ends a running verification window with status stopped, and leaves a running attempt alone", async () => {
      const item = await seedItem(db(), { state: "verify" })
      const window = await addWindow(item.id)
      const running = await seedAttempt(db(), item.id, {
        number: 1,
        kind: "fix",
        status: "running",
        result: null,
        leaseExpiresAt: minutesAfter(NOW, 600),
      })
      await stop(item.id)
      const [w] = await windowsOf(item.id)
      expect(w).toMatchObject({ id: window.id, status: "stopped", checkedAt: NOW2 })
      expect((await attemptsOf(item.id))[0]).toMatchObject({ id: running.id, status: "running" })
      const rows = (await eventsOf(item.id)).filter((e) => e.at >= NOW2)
      expect(rows.map((e) => e.kind)).toEqual(["transition", "window_closed"])
      expect(rows[1]).toMatchObject({ actorType: "system", cycle: 1 })
      expect(rows[1]?.detail).toMatchObject({ windowId: window.id, status: "stopped" })
      strictlyIncreasing(rows)
    })

    it("works from triage, plan, attempt, deploy and verify and is CONFLICT from done, stopped, reopened and signal", async () => {
      for (const state of ["triage", "plan", "attempt", "review", "deploy", "verify"] as const) {
        const item = await seedItem(db(), { state })
        expect((await stop(item.id)).state).toBe("stopped")
      }
      for (const state of ["done", "stopped", "reopened", "signal"] as const) {
        const item = await seedItem(db(), { state })
        const before = await eventsOf(item.id)
        await expectAppError(stop(item.id), "CONFLICT")
        expect(await eventsOf(item.id)).toHaveLength(before.length)
        expect((await itemOf(item.id)).state).toBe(state)
      }
    })

    it("a refused stop leaves a window, a question and an approval as they were", async () => {
      const item = await seedItem(db(), { state: "done" })
      const window = await addWindow(item.id, { status: "passed" })
      await expectAppError(stop(item.id), "CONFLICT")
      expect((await windowsOf(item.id))[0]).toMatchObject({ id: window.id, status: "passed" })
    })

    it("a stopped item can be reopened to triage in cycle 2 and a new request succeeds (the requested attempt was ended)", async () => {
      const item = await seedItem(db(), { state: "plan" })
      await requestAttempt(db(), {
        itemId: item.id,
        kind: "investigate",
        origin: "founder_request",
        founderId: FOUNDER,
        now: NOW,
      })
      await stop(item.id)
      const reopened = await reopen(item.id, { now: minutesAfter(NOW2, 5) })
      expect(reopened).toMatchObject({ state: "triage", cycle: 2 })
      const next = await requestAttempt(db(), {
        itemId: item.id,
        kind: "investigate",
        origin: "founder_request",
        founderId: FOUNDER,
        now: minutesAfter(NOW2, 6),
      })
      expect(next).toMatchObject({ status: "requested", cycle: 2, number: 2 })
    })

    it("the note is capped and ids are checked, and nothing is written when they fail", async () => {
      const item = await seedItem(db(), { state: "triage" })
      await expectAppError(stop(item.id, { note: "x".repeat(2001) }), "BAD_REQUEST")
      await expectAppError(stop(item.id, { founderId: "" }), "BAD_REQUEST")
      await expectAppError(stop("nope"), "BAD_REQUEST")
      expect((await itemOf(item.id)).state).toBe("triage")
      expect(await eventsOf(item.id)).toHaveLength(0)
    })
  })

  describe("stopItem and approvals that were already acted on", () => {
    const voids = async (itemId: string) =>
      (await eventsOf(itemId)).filter((e) => e.kind === "merge_approval_void")

    it("a stop in deploy after approve and merge leaves the approval approved and writes no void", async () => {
      const { item, approval } = await reviewed()
      await approve(item.id)
      await record(item.id, { state: "merged" }, minutesAfter(NOW, 30))
      expect((await itemOf(item.id)).state).toBe("deploy")
      const before = await voids(item.id)
      await stop(item.id)
      expect((await itemOf(item.id)).state).toBe("stopped")
      expect(await approvalsOf(item.id)).toMatchObject([{ id: approval.id, status: "approved" }])
      expect(await voids(item.id)).toHaveLength(before.length)
    })

    it("a stop after the pull request closed leaves a pending approval's record alone too", async () => {
      // a closed pull request already voided the pending approval (W4b); the stop adds nothing
      const { item } = await reviewed({ attemptLimit: 3 })
      await approve(item.id)
      await db()
        .update(pullRequests)
        .set({ state: "closed" })
        .where(eq(pullRequests.itemId, item.id))
      await stop(item.id)
      expect((await approvalsOf(item.id)).map((a) => a.status)).toEqual(["approved"])
      expect(await voids(item.id)).toHaveLength(0)
    })

    it("a cycle 2 stop keeps cycle 1's approved approval on its merged pull request, and voids the open one", async () => {
      const { item, approval: first } = await reviewed()
      await approve(item.id)
      await record(item.id, { state: "merged" }, minutesAfter(NOW, 30))
      // the item was reopened and is in review again in cycle 2 with a new open pull request
      await db()
        .update(workItems)
        .set({ cycle: 2, state: "review" })
        .where(eq(workItems.id, item.id))
      const second = await seedAttempt(db(), item.id, {
        number: 2,
        cycle: 2,
        kind: "fix",
        result: "approved",
        branch: "factory/fix-9",
      })
      const open = await seedPullRequest(db(), item.id, {
        number: 9,
        state: "open",
        openedAt: minutesAfter(NOW, 120),
        branch: "factory/fix-9",
        attemptId: second.id,
      })
      const [pending] = await db()
        .insert(mergeApprovals)
        .values({
          id: crypto.randomUUID(),
          itemId: item.id,
          pullRequestId: open.id,
          headSha: open.headSha,
          status: "pending",
          requestedAt: minutesAfter(NOW, 121),
        })
        .returning()
      await stop(item.id)
      const rows = await approvalsOf(item.id)
      expect(Object.fromEntries(rows.map((a) => [a.id, a.status]))).toEqual({
        [first.id]: "approved",
        [pending?.id ?? ""]: "void",
      })
      expect(await voids(item.id)).toHaveLength(1)
    })
  })

  describe("stopItem events", () => {
    it("a stop with nothing to withdraw has no detail, and a window close is one ms after the move", async () => {
      const item = await seedItem(db(), { state: "verify" })
      await addWindow(item.id)
      await stop(item.id)
      const rows = await eventsOf(item.id)
      expect(rows.map((e) => [e.kind, e.at.getTime() - NOW2.getTime()])).toEqual([
        ["transition", 0],
        ["window_closed", 1],
      ])
      expect(rows[0]?.detail).toBeNull()
    })

    it("a stop lists every withdrawn question, oldest first", async () => {
      const item = await seedItem(db(), { state: "plan" })
      const ask = (prompt: string, now: Date) =>
        askQuestion(db(), {
          itemId: item.id,
          prompt,
          options: [
            { id: "a", label: "A" },
            { id: "b", label: "B" },
          ],
          actor: AGENT,
          now,
        })
      const q1 = await ask("one", minutesAfter(NOW, 1))
      const q2 = await ask("two", minutesAfter(NOW, 2))
      await stop(item.id)
      const transition = (await eventsOf(item.id)).find((e) => e.kind === "transition")
      expect(transition?.detail).toEqual({ withdrawnQuestionIds: [q1.id, q2.id] })
    })
  })

  describe("reopenItem", () => {
    it("on stopped goes to triage with cycle 2 (the move adds the one, this does not add another); on done goes to reopened", async () => {
      const stopped = await seedItem(db(), { state: "stopped", cycle: 1 })
      const a = await reopen(stopped.id, { note: "Try again." })
      expect(a).toMatchObject({ state: "triage", cycle: 2 })
      const rows = await eventsOf(stopped.id)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        kind: "transition",
        fromState: "stopped",
        toState: "triage",
        reason: "reopened",
        actorType: "founder",
        actorId: FOUNDER,
        note: "Try again.",
        cycle: 2,
      })

      const done = await seedItem(db(), { state: "done", cycle: 1 })
      const b = await reopen(done.id)
      expect(b).toMatchObject({ state: "reopened", cycle: 1 })
      expect((await eventsOf(done.id))[0]).toMatchObject({
        fromState: "done",
        toState: "reopened",
        reason: "reopened",
      })
    })

    it("from verify goes to reopened and ends the running window as stopped", async () => {
      const item = await seedItem(db(), { state: "verify" })
      const window = await addWindow(item.id)
      const out = await reopen(item.id)
      expect(out).toMatchObject({ state: "reopened", cycle: 1 })
      expect((await windowsOf(item.id))[0]).toMatchObject({
        id: window.id,
        status: "stopped",
        checkedAt: NOW2,
      })
      const rows = await eventsOf(item.id)
      expect(rows.map((e) => e.kind)).toEqual(["transition", "window_closed"])
      strictlyIncreasing(rows)
    })

    it("from reopened, triage, plan, attempt, review and deploy is CONFLICT (never FORBIDDEN)", async () => {
      for (const state of [
        "reopened",
        "triage",
        "plan",
        "attempt",
        "review",
        "deploy",
        "signal",
      ] as const) {
        const item = await seedItem(db(), { state })
        await expectAppError(reopen(item.id), "CONFLICT")
        expect((await itemOf(item.id)).state).toBe(state)
        expect(await eventsOf(item.id)).toHaveLength(0)
      }
    })

    it("a done item reopened twice in a row is CONFLICT the second time", async () => {
      const item = await seedItem(db(), { state: "done" })
      await reopen(item.id)
      await expectAppError(reopen(item.id), "CONFLICT")
      expect(await kindsOf(item.id)).toEqual(["transition"])
    })

    it("checks the note, the founder and the id", async () => {
      const item = await seedItem(db(), { state: "done" })
      await expectAppError(reopen(item.id, { note: "x".repeat(2001) }), "BAD_REQUEST")
      await expectAppError(reopen(item.id, { founderId: " " }), "BAD_REQUEST")
      await expectAppError(reopen("fac-1"), "BAD_REQUEST")
      await expectAppError(reopen(crypto.randomUUID()), "NOT_FOUND")
      expect((await itemOf(item.id)).state).toBe("done")
    })
  })

  describe("retryItem", () => {
    const exhausted = async (o: { state?: "attempt" | "review" } = {}) => {
      const item = await seedItem(db(), {
        state: o.state ?? "attempt",
        attemptLimit: 3,
        dedupeKey: null,
      })
      for (const number of [1, 2, 3]) {
        await seedAttempt(db(), item.id, { number, kind: "fix", result: "failed" })
      }
      return item
    }

    it("on a non-exhausted item is CONFLICT; on an exhausted one raises the limit from 3 to 4 and writes a retry_granted event with the note", async () => {
      const fresh = await seedItem(db(), { state: "attempt", attemptLimit: 3 })
      await seedAttempt(db(), fresh.id, { number: 1, kind: "fix", result: "failed" })
      await expectAppError(retry(fresh.id), "CONFLICT")
      expect((await itemOf(fresh.id)).attemptLimit).toBe(3)
      expect(await eventsOf(fresh.id)).toHaveLength(0)

      const item = await exhausted()
      expect(await retry(item.id, { note: "Use the other library." })).toEqual({ attemptLimit: 4 })
      expect((await itemOf(item.id)).attemptLimit).toBe(4)
      const rows = await eventsOf(item.id)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        kind: "retry_granted",
        actorType: "founder",
        actorId: FOUNDER,
        note: "Use the other library.",
        cycle: 1,
        detail: { from: 3, to: 4 },
        at: NOW2,
      })
      // the item is no longer exhausted, and a fix may start
      expect(deriveAttention(await factsOf(item.id, NOW2))).toBeNull()
      const next = await startAttempt(db(), {
        itemId: item.id,
        kind: "fix",
        actor: AGENT,
        now: NOW2,
      })
      expect(next.number).toBe(4)
      // retrying again while the item is not exhausted is CONFLICT
      await expectAppError(retry(item.id), "CONFLICT")
    })

    it("an item without a limit, an approved third fix and an item in done are not exhausted", async () => {
      const noLimit = await seedItem(db(), { state: "attempt" })
      await seedAttempt(db(), noLimit.id, { number: 1, kind: "fix", result: "failed" })
      await expectAppError(retry(noLimit.id), "CONFLICT")

      const approved = await seedItem(db(), { state: "review", attemptLimit: 3 })
      for (const number of [1, 2]) {
        await seedAttempt(db(), approved.id, { number, kind: "fix", result: "failed" })
      }
      await seedAttempt(db(), approved.id, { number: 3, kind: "fix", result: "approved" })
      await expectAppError(retry(approved.id), "CONFLICT")

      const done = await seedItem(db(), { state: "done", attemptLimit: 3 })
      for (const number of [1, 2, 3]) {
        await seedAttempt(db(), done.id, { number, kind: "fix", result: "failed" })
      }
      await expectAppError(retry(done.id), "CONFLICT")
      for (const id of [noLimit.id, approved.id, done.id]) {
        expect(await eventsOf(id)).toHaveLength(0)
      }
    })

    it("an item whose attempt budget is spent counts as exhausted even while a question is open", async () => {
      const item = await exhausted()
      await askQuestion(db(), {
        itemId: item.id,
        prompt: "?",
        options: [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
        ],
        actor: AGENT,
        now: NOW,
      })
      expect(await retry(item.id)).toEqual({ attemptLimit: 4 })
    })

    it("an exhausted item with a running attempt is CONFLICT", async () => {
      const item = await exhausted()
      await seedAttempt(db(), item.id, {
        number: 4,
        kind: "investigate",
        status: "running",
        result: null,
        leaseExpiresAt: minutesAfter(NOW, 600),
      })
      await expectAppError(retry(item.id), "CONFLICT")
    })

    it("a note is required and capped, and ids are checked", async () => {
      const item = await exhausted()
      await expectAppError(retry(item.id, { note: "" }), "BAD_REQUEST")
      await expectAppError(retry(item.id, { note: "   " }), "BAD_REQUEST")
      await expectAppError(retry(item.id, { note: "x".repeat(2001) }), "BAD_REQUEST")
      await expectAppError(retry(item.id, { note: undefined as never }), "BAD_REQUEST")
      await expectAppError(retry(item.id, { founderId: "" }), "BAD_REQUEST")
      await expectAppError(retry("x"), "BAD_REQUEST")
      expect((await itemOf(item.id)).attemptLimit).toBe(3)
      expect(await eventsOf(item.id)).toHaveLength(0)
      expect(await retry(item.id, { note: "x".repeat(2000) })).toEqual({ attemptLimit: 4 })
    })
  })

  describe("requestRevert", () => {
    it("in triage is CONFLICT; in deploy with a merged PR moves to reopened and records the PR url in the event detail", async () => {
      const triage = await seedItem(db(), { state: "triage" })
      await expectAppError(revert(triage.id), "CONFLICT")
      expect(await eventsOf(triage.id)).toHaveLength(0)

      const item = await mergedItem("deploy")
      const out = await revert(item.id, { note: "It broke checkout." })
      expect(out).toMatchObject({ state: "reopened", cycle: 1 })
      const rows = await eventsOf(item.id)
      expect(rows.map((e) => [e.kind, e.actorType, e.actorId])).toEqual([
        ["transition", "founder", FOUNDER],
        ["revert_requested", "founder", FOUNDER],
      ])
      expect(rows[0]).toMatchObject({
        fromState: "deploy",
        toState: "reopened",
        reason: "revert_requested",
        note: "It broke checkout.",
      })
      expect(rows[1]).toMatchObject({
        note: "It broke checkout.",
        cycle: 1,
        detail: { pullRequestUrl: urlOf(7), pullRequestNumber: 7 },
      })
      // the two founder events are one millisecond apart, in story order
      expect(rows.map((e) => e.at.getTime() - NOW2.getTime())).toEqual([0, 1])
    })

    it("from verify ends the running window; from done leaves the passed one", async () => {
      const verify = await mergedItem("verify")
      const window = await addWindow(verify.id)
      await revert(verify.id)
      expect((await windowsOf(verify.id))[0]).toMatchObject({ id: window.id, status: "stopped" })
      expect((await eventsOf(verify.id)).map((e) => e.kind)).toEqual([
        "transition",
        "window_closed",
        "revert_requested",
      ])
      expect((await eventsOf(verify.id)).map((e) => e.at.getTime() - NOW2.getTime())).toEqual([
        0, 1, 2,
      ])

      const done = await mergedItem("done")
      const passed = await addWindow(done.id, { status: "passed" })
      expect((await revert(done.id)).state).toBe("reopened")
      expect((await windowsOf(done.id))[0]).toMatchObject({ id: passed.id, status: "passed" })
    })

    it("needs a merged pull request: none, an open one and a closed one are CONFLICT", async () => {
      const none = await seedItem(db(), { state: "done" })
      await expectAppError(revert(none.id), "CONFLICT")
      const open = await seedItem(db(), { state: "deploy" })
      await seedPullRequest(db(), open.id, { number: 7, state: "open" })
      await expectAppError(revert(open.id), "CONFLICT")
      const closed = await seedItem(db(), { state: "verify" })
      await seedPullRequest(db(), closed.id, { number: 7, state: "closed" })
      await expectAppError(revert(closed.id), "CONFLICT")
      for (const id of [none.id, open.id, closed.id]) {
        expect(await eventsOf(id)).toHaveLength(0)
      }
    })

    it("is CONFLICT in review, stopped and reopened even with a merged pull request", async () => {
      for (const state of ["review", "stopped", "reopened", "attempt"] as const) {
        const item = await seedItem(db(), { state })
        await seedPullRequest(db(), item.id, { number: 7, state: "merged", mergedAt: NOW })
        await expectAppError(revert(item.id), "CONFLICT")
        expect((await itemOf(item.id)).state).toBe(state)
      }
    })

    it("a merged pull request of an earlier cycle does not count for this one", async () => {
      const item = await seedItem(db(), { state: "done", cycle: 2 })
      const old = await seedAttempt(db(), item.id, {
        number: 1,
        cycle: 1,
        kind: "fix",
        branch: "old",
      })
      await seedPullRequest(db(), item.id, {
        number: 7,
        state: "merged",
        mergedAt: NOW,
        branch: "old",
        attemptId: old.id,
      })
      await expectAppError(revert(item.id), "CONFLICT")
    })

    it("an unrelated one-off: the note is optional but capped", async () => {
      const item = await mergedItem("deploy")
      await expectAppError(revert(item.id, { note: "x".repeat(2001) }), "BAD_REQUEST")
      expect((await itemOf(item.id)).state).toBe("deploy")
      const out = await revert(item.id)
      expect(out.state).toBe("reopened")
      expect((await eventsOf(item.id))[0]?.note).toBeNull()
    })
  })

  describe("every founder function names the founder in the events it writes", () => {
    const founderEvents = async (itemId: string) =>
      (await eventsOf(itemId))
        .filter((e) => e.actorType === "founder")
        .map((e) => [e.kind, e.actorId])

    it("approve, stop and reopen: one founder event each, in order", async () => {
      const { item } = await reviewed({ attemptLimit: 3 })
      await approve(item.id, { founderId: "f-approve" })
      await stop(item.id, { founderId: "f-stop" })
      await reopen(item.id, { founderId: "f-reopen", now: minutesAfter(NOW2, 5) })
      expect(await founderEvents(item.id)).toEqual([
        ["merge_approved", "f-approve"],
        ["transition", "f-stop"],
        ["transition", "f-reopen"],
      ])
    })

    it("answer and retry: one founder event each", async () => {
      const item = await seedItem(db(), { state: "attempt", attemptLimit: 3 })
      for (const number of [1, 2, 3]) {
        await seedAttempt(db(), item.id, { number, kind: "fix", result: "failed" })
      }
      const q = await askQuestion(db(), {
        itemId: item.id,
        prompt: "Which?",
        options: [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
        ],
        actor: AGENT,
        now: NOW,
      })
      await answerQuestion(db(), {
        questionId: q.id,
        optionId: "a",
        founderId: "f-answer",
        now: minutesAfter(NOW, 1),
      })
      await retry(item.id, { founderId: "f-retry" })
      expect(await founderEvents(item.id)).toEqual([
        ["question_answered", "f-answer"],
        ["retry_granted", "f-retry"],
      ])
    })

    it("revert writes two founder events (the move and the revert_requested record): a departure from the plan's one", async () => {
      const item = await mergedItem("deploy")
      await revert(item.id, { founderId: "f-revert" })
      expect(await founderEvents(item.id)).toEqual([
        ["transition", "f-revert"],
        ["revert_requested", "f-revert"],
      ])
    })
  })

  describe("closeRunningWindow and the recurrence reopen from verify", () => {
    it("a signal for an item in verify reopens it and ends the running window as failed", async () => {
      const key = "github-issue:acme/web#12"
      const item = await seedItem(db(), { state: "verify", dedupeKey: key, source: "github_issue" })
      const window = await addWindow(item.id)
      const out = await recordSignal(db(), {
        source: "github_issue",
        externalId: "evt-1",
        dedupeKey: key,
        repo: "acme/web",
        title: "Login fails again",
        summary: "Login fails again",
        recorder: { type: "agent", id: "agent-key" },
        now: minutesAfter(NOW, 90),
      })
      expect(out.outcome).toBe("reopened")
      expect((await itemOf(item.id)).state).toBe("reopened")
      expect((await windowsOf(item.id))[0]).toMatchObject({
        id: window.id,
        status: "failed",
        checkedAt: minutesAfter(NOW, 90),
      })
      const rows = await eventsOf(item.id)
      // story order, one millisecond apart: the signal, the move, the window's close
      expect(rows.map((e) => [e.kind, e.at.getTime() - minutesAfter(NOW, 90).getTime()])).toEqual([
        ["signal_attached", 0],
        ["transition", 1],
        ["window_closed", 2],
      ])
      const closed = rows.find((e) => e.kind === "window_closed")
      expect(closed).toMatchObject({ actorType: "system" })
      expect(closed?.detail).toMatchObject({ windowId: window.id, status: "failed" })
    })

    it("a recurrence for a done item leaves its passed window alone", async () => {
      const key = "github-issue:acme/web#13"
      const item = await seedItem(db(), {
        state: "done",
        dedupeKey: key,
        source: "github_issue",
        now: NOW,
      })
      await forceState(db(), item.id, "done", NOW)
      const window = await addWindow(item.id, { status: "passed" })
      await recordSignal(db(), {
        source: "github_issue",
        externalId: "evt-2",
        dedupeKey: key,
        repo: "acme/web",
        title: "Again",
        summary: "Again",
        recorder: { type: "agent", id: "agent-key" },
        now: minutesAfter(NOW, 90),
      })
      expect((await itemOf(item.id)).state).toBe("reopened")
      expect((await windowsOf(item.id))[0]).toMatchObject({ id: window.id, status: "passed" })
      expect(await kindsOf(item.id)).toEqual(["signal_attached", "transition"])
      const times = (await eventsOf(item.id)).map(
        (e) => e.at.getTime() - minutesAfter(NOW, 90).getTime(),
      )
      expect(times).toEqual([0, 1])
    })

    it("closes only the current cycle's running window and says whether it closed one", async () => {
      const item = await seedItem(db(), { state: "verify", cycle: 2 })
      const old = await addWindow(item.id, { cycle: 1 })
      const none = await db().transaction(async (tx) =>
        closeRunningWindow(tx, {
          item: await lockItem(tx, item.id),
          status: "stopped",
          actor: { type: "system", id: "hq" },
          now: NOW,
        }),
      )
      expect(none).toBe(false)
      expect((await windowsOf(item.id))[0]).toMatchObject({ id: old.id, status: "running" })
      const current = await addWindow(item.id, { cycle: 2 })
      const closed = await db().transaction(async (tx) =>
        closeRunningWindow(tx, {
          item: await lockItem(tx, item.id),
          status: "failed",
          note: "a signal came back",
          actor: { type: "system", id: "hq" },
          now: NOW,
        }),
      )
      expect(closed).toBe(true)
      const rows = await windowsOf(item.id)
      expect(rows.find((w) => w.id === current.id)).toMatchObject({
        status: "failed",
        checkedAt: NOW,
        resultNote: "a signal came back",
      })
      expect(rows.find((w) => w.id === old.id)?.status).toBe("running")
      // closing it again does nothing and writes no second event
      const again = await db().transaction(async (tx) =>
        closeRunningWindow(tx, {
          item: await lockItem(tx, item.id),
          status: "stopped",
          actor: { type: "system", id: "hq" },
          now: NOW,
        }),
      )
      expect(again).toBe(false)
      expect((await eventsOf(item.id)).filter((e) => e.kind === "window_closed")).toHaveLength(1)
    })
  })

  describe("a first signal's events are in story order", () => {
    it("signal_attached, then the move into triage one millisecond later", async () => {
      const out = await recordSignal(db(), {
        source: "github_issue",
        externalId: "evt-first",
        dedupeKey: "github-issue:acme/web#99",
        repo: "acme/web",
        title: "New",
        summary: "New",
        recorder: { type: "agent", id: "agent-key" },
        now: NOW,
      })
      const rows = await eventsOf(out.itemId)
      expect(rows.map((e) => [e.kind, e.at.getTime() - NOW.getTime()])).toEqual([
        ["signal_attached", 0],
        ["transition", 1],
      ])
    })
  })

  describe("checkUuid", () => {
    it("accepts a uuid in any case (stored lower-case) and refuses everything else", () => {
      const id = crypto.randomUUID()
      expect(checkUuid("itemId", id)).toBe(id)
      expect(checkUuid("itemId", id.toUpperCase())).toBe(id)
      for (const bad of ["", "FAC-1", "not-a-uuid", `${id} `, `${id}x`, 7, null, undefined]) {
        expect(() => checkUuid("itemId", bad as never)).toThrow(AppError)
        try {
          checkUuid("itemId", bad as never)
        } catch (e) {
          expect((e as AppError).code).toBe("BAD_REQUEST")
        }
      }
    })
  })

  it("never touches items it was not asked about", async () => {
    const a = await seedItem(db(), { state: "triage" })
    const b = await seedItem(db(), { state: "triage" })
    await stop(a.id)
    expect((await itemOf(b.id)).state).toBe("triage")
    const rows = await db().select().from(workItems)
    expect(rows).toHaveLength(2)
  })
})
