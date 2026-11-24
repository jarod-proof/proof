import { AppError } from "@proof/errors"
import { and, asc, eq } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import {
  attempts,
  contractItems,
  mergeApprovals,
  pullRequests,
  workItemEvents,
  workItems,
} from "../db/schema"
import { createHqTestDb } from "../testing"
import type { RecordPullRequestInput } from "../work/types"
import { finishAttempt, heartbeatAttempt, requestAttempt, startAttempt } from "./attempts"
import { ensureMergeApproval } from "./merge-approvals"
import { recordPullRequest } from "./pull-requests"
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
const BRANCH = "factory/fix-7"
const SHA_A = "a".repeat(40)
const SHA_B = "b".repeat(40)
const SHA_C = "c".repeat(40)
const REVIEW = { verdict: "approve", summary: "Looks right." } as const

const urlOf = (n: number, repo = "acme/web") => `https://github.com/${repo}/pull/${n}`

describe("pull requests and merge approvals (in-process Postgres)", () => {
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
  const stateOf = async (itemId: string) => (await resolveItem(db(), itemId)).state
  const events = (itemId: string) =>
    db()
      .select()
      .from(workItemEvents)
      .where(eq(workItemEvents.itemId, itemId))
      .orderBy(asc(workItemEvents.at), asc(workItemEvents.id))
  const eventKinds = async (itemId: string) => (await events(itemId)).map((e) => e.kind)
  const approvalsOf = (itemId: string) =>
    db()
      .select()
      .from(mergeApprovals)
      .where(eq(mergeApprovals.itemId, itemId))
      .orderBy(asc(mergeApprovals.requestedAt), asc(mergeApprovals.id))
  const pullRequestOf = async (itemId: string, number = 7) => {
    const [row] = await db()
      .select()
      .from(pullRequests)
      .where(and(eq(pullRequests.itemId, itemId), eq(pullRequests.number, number)))
    if (!row) throw new Error("no pull request")
    return row
  }
  const expectAppError = async (p: Promise<unknown>, code: string) => {
    const error = await p.then(
      () => null,
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).code).toBe(code)
  }
  const factsOf = (itemId: string, now = NOW) =>
    db().transaction(async (tx) => loadFacts(tx, await lockItem(tx, itemId), now))

  const record = (input: Partial<RecordPullRequestInput> = {}, now = NOW) =>
    recordPullRequest(db(), {
      actor: AGENT,
      branch: BRANCH,
      number: 7,
      url: urlOf(7),
      base: "main",
      headSha: SHA_A,
      isDraft: false,
      state: "open",
      ...input,
      now,
    })

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

  /** An item in `attempt` with a running fix whose heartbeat reported BRANCH. */
  async function fixing(o: { branch?: string | null; attemptLimit?: number } = {}) {
    const item = await seedItem(db(), { state: "plan", attemptLimit: o.attemptLimit ?? null })
    await addContract(item.id)
    const attempt = await startAttempt(db(), {
      itemId: item.id,
      kind: "fix",
      actor: AGENT,
      now: NOW,
    })
    if (o.branch !== null) {
      await heartbeatAttempt(db(), {
        attemptId: attempt.id,
        branch: o.branch ?? BRANCH,
        now: minutesAfter(NOW, 1),
      })
    }
    return { item, attempt }
  }

  const finishFix = (
    attemptId: string,
    o: { result?: "approved" | "rejected"; now?: Date; branch?: string } = {},
  ) =>
    finishAttempt(db(), {
      actor: AGENT,
      attemptId,
      result: o.result ?? "approved",
      reviewer:
        (o.result ?? "approved") === "approved"
          ? REVIEW
          : { verdict: "request_changes", summary: "Not yet." },
      ...(o.branch === undefined ? {} : { branch: o.branch }),
      now: o.now ?? minutesAfter(NOW, 10),
    })

  describe("recordPullRequest", () => {
    it("a pull request with a foreign url (https://github.com/other/repo/pull/1, http://..., a javascript: url) is BAD_REQUEST", async () => {
      const { item } = await fixing()
      for (const url of [
        urlOf(7, "other/repo"),
        "https://github.com/other/repo/pull/1",
        "http://github.com/acme/web/pull/7",
        "javascript:alert(1)//github.com/acme/web/pull/7",
        `${urlOf(7)}/`,
        `${urlOf(7)}/files`,
        `${urlOf(7)}?x=1`,
        `${urlOf(7)}#top`,
        "https://github.com.evil.com/acme/web/pull/7",
        "https://evil.com/https://github.com/acme/web/pull/7",
        urlOf(8),
        "",
      ]) {
        await expectAppError(record({ url, itemId: item.id }), "BAD_REQUEST")
        await expectAppError(record({ url }), "BAD_REQUEST")
      }
      // the same shape on an unknown branch is refused too: nothing is stored for a stranger's link
      await expectAppError(record({ branch: "unknown", url: "javascript:alert(1)" }), "BAD_REQUEST")
      expect(await db().select().from(pullRequests)).toHaveLength(0)
    })

    it("compares the repo of the url lower-cased and stores the canonical url", async () => {
      const item = await seedItem(db(), { state: "plan", repo: "acme/web" })
      const result = await record({ itemId: item.id, url: urlOf(7, "Acme/Web") })
      expect(result.matched).toBe(true)
      expect((await pullRequestOf(item.id)).url).toBe(urlOf(7))
    })

    it("a pull request found by branch moves attempt to review; an unknown branch is matched false", async () => {
      const { item } = await fixing()
      const unknown = await record({ branch: "factory/nobody" })
      expect(unknown).toEqual({ matched: false, itemId: null, state: null })
      expect(await db().select().from(pullRequests)).toHaveLength(0)

      const found = await record({}, minutesAfter(NOW, 2))
      expect(found).toEqual({ matched: true, itemId: item.id, state: "review" })
      expect(await stateOf(item.id)).toBe("review")
      const row = await pullRequestOf(item.id)
      expect(row).toMatchObject({ branch: BRANCH, headSha: SHA_A, state: "open", isDraft: false })
      const moves = (await events(item.id)).filter((e) => e.kind === "transition").at(-1)
      expect(moves).toMatchObject({
        fromState: "attempt",
        toState: "review",
        reason: "pull_request_opened",
        actorType: "agent",
      })
      expect(await eventKinds(item.id)).toContain("pull_request")
    })

    it("the item is the one whose newest attempt has the branch, and the pull request remembers that attempt", async () => {
      const first = await seedItem(db(), { state: "attempt" })
      const second = await seedItem(db(), { state: "attempt" })
      await seedAttempt(db(), first.id, { number: 1, branch: BRANCH, now: NOW })
      const newest = await seedAttempt(db(), second.id, {
        number: 1,
        branch: BRANCH,
        now: minutesAfter(NOW, 5),
      })
      const result = await record({}, minutesAfter(NOW, 6))
      expect(result.itemId).toBe(second.id)
      expect((await pullRequestOf(second.id)).attemptId).toBe(newest.id)
      expect(await db().select().from(pullRequests)).toHaveLength(1)
    })

    it("an itemId that does not exist is NOT_FOUND and a draft pull request keeps isDraft", async () => {
      await expectAppError(record({ itemId: crypto.randomUUID() }), "NOT_FOUND")
      const { item } = await fixing()
      await record({ itemId: item.id, isDraft: true })
      expect((await pullRequestOf(item.id)).isDraft).toBe(true)
      await record({ itemId: item.id, isDraft: false }, minutesAfter(NOW, 1))
      expect((await pullRequestOf(item.id)).isDraft).toBe(false)
    })

    it("a new row without base, headSha, isDraft or state is BAD_REQUEST and a later call with only checks is fine", async () => {
      const { item } = await fixing()
      for (const missing of ["base", "headSha", "isDraft", "state"] as const) {
        const input: Partial<RecordPullRequestInput> = { itemId: item.id }
        await expectAppError(
          recordPullRequest(db(), {
            actor: AGENT,
            branch: BRANCH,
            number: 7,
            url: urlOf(7),
            base: "main",
            headSha: SHA_A,
            isDraft: false,
            state: "open",
            ...input,
            [missing]: undefined,
            now: NOW,
          }),
          "BAD_REQUEST",
        )
      }
      expect(await db().select().from(pullRequests)).toHaveLength(0)

      await record({ itemId: item.id })
      const before = await pullRequestOf(item.id)
      const result = await recordPullRequest(db(), {
        actor: AGENT,
        itemId: item.id,
        branch: BRANCH,
        number: 7,
        url: urlOf(7),
        checks: [{ name: "ci", state: "failed" }],
        now: minutesAfter(NOW, 3),
      })
      expect(result.matched).toBe(true)
      const after = await pullRequestOf(item.id)
      expect(after).toMatchObject({ headSha: SHA_A, base: "main", state: "open", isDraft: false })
      expect(after.checks).toEqual([{ name: "ci", state: "failed" }])
      expect(after.openedAt).toEqual(before.openedAt)
      expect(after.updatedAt).toEqual(minutesAfter(NOW, 3))
    })

    it("a checks-only call without an itemId finds the item through the pull request already on that branch", async () => {
      // the heartbeat that would have reported the branch never arrived
      const { item } = await fixing({ branch: null })
      await record({ itemId: item.id })
      const result = await recordPullRequest(db(), {
        actor: AGENT,
        branch: BRANCH,
        number: 7,
        url: urlOf(7),
        checks: [{ name: "ci", state: "passed" }],
        now: minutesAfter(NOW, 2),
      })
      expect(result).toMatchObject({ matched: true, itemId: item.id })
    })

    it("checks upsert by name", async () => {
      const { item } = await fixing()
      await record({
        itemId: item.id,
        checks: [
          { name: "ci", state: "pending" },
          { name: "lint", state: "passed" },
        ],
      })
      await record(
        {
          itemId: item.id,
          checks: [
            { name: "ci", state: "failed" },
            { name: "e2e", state: "pending" },
          ],
        },
        minutesAfter(NOW, 1),
      )
      expect((await pullRequestOf(item.id)).checks).toEqual([
        { name: "ci", state: "failed" },
        { name: "lint", state: "passed" },
        { name: "e2e", state: "pending" },
      ])
    })

    it("refuses outside text it cannot store or that is over its cap", async () => {
      const { item } = await fixing()
      const bad: Partial<RecordPullRequestInput>[] = [
        { branch: "x".repeat(201) },
        { branch: "a\u0000b" },
        { base: "" },
        { headSha: "not a sha" },
        { headSha: "z".repeat(40) },
        { number: 0 },
        { number: 1.5 },
        { additions: -1 },
        { files: 1.5 },
        { state: "reopened" as never },
        { checks: [{ name: "", state: "passed" }] },
        { checks: [{ name: "ci", state: "green" as never }] },
        { checks: Array.from({ length: 101 }, (_, i) => ({ name: `c${i}`, state: "passed" })) },
        { mergedBy: "x".repeat(101) },
        { mergedAt: "yesterday", state: "merged" },
      ]
      for (const o of bad) await expectAppError(record({ itemId: item.id, ...o }), "BAD_REQUEST")
      expect(await db().select().from(pullRequests)).toHaveLength(0)
    })

    it("merged moves review to deploy and stores mergedAt and mergedBy; a later open is CONFLICT", async () => {
      const { item } = await fixing()
      await record({ itemId: item.id })
      expect(await stateOf(item.id)).toBe("review")
      const mergedAt = minutesAfter(NOW, 30)
      const result = await record(
        { state: "merged", mergedBy: "octocat", mergedAt: mergedAt.toISOString() },
        minutesAfter(NOW, 31),
      )
      expect(result).toMatchObject({ matched: true, state: "deploy" })
      const row = await pullRequestOf(item.id)
      expect(row).toMatchObject({ state: "merged", mergedBy: "octocat" })
      expect(row.mergedAt).toEqual(mergedAt)
      const last = (await events(item.id)).filter((e) => e.kind === "transition").at(-1)
      expect(last).toMatchObject({
        fromState: "review",
        toState: "deploy",
        reason: "pull_request_merged",
        actorType: "agent",
      })
      await expectAppError(record({ state: "open" }, minutesAfter(NOW, 32)), "CONFLICT")
      await expectAppError(record({ state: "closed" }, minutesAfter(NOW, 32)), "CONFLICT")
      expect((await pullRequestOf(item.id)).state).toBe("merged")
      expect(await stateOf(item.id)).toBe("deploy")
    })

    it("mergedAt in the future is clamped to now, mergedAt with state open is BAD_REQUEST, a later merged call does not move mergedAt", async () => {
      const { item } = await fixing()
      await record({ itemId: item.id })
      await expectAppError(
        record({ mergedAt: NOW.toISOString(), state: "open" }, minutesAfter(NOW, 1)),
        "BAD_REQUEST",
      )
      await expectAppError(
        recordPullRequest(db(), {
          actor: AGENT,
          branch: BRANCH,
          number: 7,
          url: urlOf(7),
          mergedAt: NOW.toISOString(),
          now: minutesAfter(NOW, 1),
        }),
        "BAD_REQUEST",
      )
      expect((await pullRequestOf(item.id)).mergedAt).toBeNull()

      const at = minutesAfter(NOW, 5)
      await record({ state: "merged", mergedAt: minutesAfter(NOW, 600).toISOString() }, at)
      expect((await pullRequestOf(item.id)).mergedAt).toEqual(at)
      // a redelivery with another instant, even a valid earlier one, moves nothing
      await record(
        { state: "merged", mergedAt: minutesAfter(NOW, 2).toISOString() },
        minutesAfter(NOW, 9),
      )
      expect((await pullRequestOf(item.id)).mergedAt).toEqual(at)
      expect(await stateOf(item.id)).toBe("deploy")
    })

    it("a merged call with no mergedAt defaults it to now", async () => {
      const { item } = await fixing()
      await record({ itemId: item.id })
      await record({ state: "merged" }, minutesAfter(NOW, 4))
      expect((await pullRequestOf(item.id)).mergedAt).toEqual(minutesAfter(NOW, 4))
    })

    it("merged while in attempt passes through review to deploy with two transition events (the attempt>review guard sees merged)", async () => {
      const { item } = await fixing()
      const at = minutesAfter(NOW, 20)
      const result = await record({ state: "merged", mergedBy: "octocat" }, at)
      expect(result).toMatchObject({ matched: true, state: "deploy" })
      const moves = (await events(item.id)).filter((e) => e.kind === "transition")
      const mine = moves.slice(-2)
      expect(mine.map((m) => [m.fromState, m.toState, m.reason])).toEqual([
        ["attempt", "review", "pull_request_opened"],
        ["review", "deploy", "pull_request_merged"],
      ])
      // Events of one instant would order by their random ids: each is one millisecond after the
      // last (the pull request, then the first hop, then the second), so (at, id) tells the story.
      const all = await events(item.id)
      const pullEvent = all.find((e) => e.kind === "pull_request")
      expect(pullEvent?.at).toEqual(at)
      expect(mine[0]?.at).toEqual(new Date(at.getTime() + 1))
      expect(mine[1]?.at).toEqual(new Date(at.getTime() + 2))
      expect(all.slice(-3).map((e) => e.kind)).toEqual(["pull_request", "transition", "transition"])
      const state = await resolveItem(db(), item.id)
      expect(state.stateChangedAt).toEqual(new Date(at.getTime() + 2))
    })

    it("a merge ends the item's requested attempts as abandoned, after the move, so the item can be worked again", async () => {
      const { item, attempt } = await fixing()
      await record({ itemId: item.id })
      await finishFix(attempt.id)
      expect(await stateOf(item.id)).toBe("review")
      // a founder asked for another fix while it was in review; then it was merged on GitHub
      const asked = await requestAttempt(db(), {
        itemId: item.id,
        kind: "fix",
        origin: "founder_request",
        founderId: "founder-1",
        now: minutesAfter(NOW, 15),
      })
      expect((await factsOf(item.id, minutesAfter(NOW, 16))).activeAttempt).toBe("fresh")

      const at = minutesAfter(NOW, 20)
      expect(await record({ state: "merged" }, at)).toMatchObject({ state: "deploy" })
      const [row] = await db().select().from(attempts).where(eq(attempts.id, asked.id))
      expect(row).toMatchObject({ status: "finished", result: "abandoned", note: "merged" })
      expect((await factsOf(item.id, at)).activeAttempt).toBe("none")
      const all = await events(item.id)
      const tail = all.slice(-4)
      expect(tail.map((e) => [e.kind, e.actorType])).toEqual([
        ["pull_request", "agent"],
        ["merge_approval_void", "system"],
        ["transition", "agent"],
        ["attempt_abandoned", "system"],
      ])
      for (let i = 1; i < tail.length; i++) {
        expect(tail[i]!.at.getTime()).toBeGreaterThan(tail[i - 1]!.at.getTime())
      }
      expect(tail[3]).toMatchObject({
        note: "merged",
        detail: { attemptId: asked.id, reason: "merged" },
      })
    })

    it("a merge recorded while in attempt ends the requested attempts after both hops", async () => {
      const { item, attempt } = await fixing()
      await finishFix(attempt.id, { result: "rejected" })
      const asked = await requestAttempt(db(), {
        itemId: item.id,
        kind: "fix",
        origin: "founder_request",
        founderId: "founder-1",
        now: minutesAfter(NOW, 15),
      })
      const at = minutesAfter(NOW, 20)
      expect(await stateOf(item.id)).toBe("attempt")
      expect(await record({ state: "merged" }, at)).toMatchObject({ state: "deploy" })
      const [row] = await db().select().from(attempts).where(eq(attempts.id, asked.id))
      expect(row).toMatchObject({ status: "finished", result: "abandoned", note: "merged" })
      const all = await events(item.id)
      const abandoned = all.find((e) => e.kind === "attempt_abandoned" && e.at >= at)
      const hops = all.filter((e) => e.kind === "transition" && e.at >= at)
      expect(hops).toHaveLength(2)
      expect(abandoned?.at.getTime()).toBeGreaterThan(hops[1]!.at.getTime())
      expect(abandoned?.detail).toMatchObject({ attemptId: asked.id, reason: "merged" })
    })

    it("a merge leaves a running attempt alone: its lease ends it", async () => {
      const { item, attempt } = await fixing()
      await record({ state: "merged" }, minutesAfter(NOW, 20))
      const [row] = await db().select().from(attempts).where(eq(attempts.id, attempt.id))
      expect(row).toMatchObject({ status: "running", result: null })
      expect(await eventKinds(item.id)).not.toContain("attempt_abandoned")
    })

    it("a merge with no requested attempt writes no attempt_abandoned event", async () => {
      const { item } = await fixing()
      await record({ state: "merged" }, minutesAfter(NOW, 20))
      expect(await eventKinds(item.id)).not.toContain("attempt_abandoned")
    })

    it("closed moves review to stopped and voids a pending approval", async () => {
      const { item, attempt } = await fixing()
      await record({ itemId: item.id })
      await finishFix(attempt.id)
      const [pending] = await approvalsOf(item.id)
      expect(pending?.status).toBe("pending")

      const result = await record({ state: "closed" }, minutesAfter(NOW, 20))
      expect(result).toMatchObject({ state: "stopped" })
      const last = (await events(item.id)).filter((e) => e.kind === "transition").at(-1)
      expect(last).toMatchObject({
        fromState: "review",
        toState: "stopped",
        reason: "pull_request_closed",
        actorType: "agent",
      })
      const [voided] = await approvalsOf(item.id)
      expect(voided?.status).toBe("void")
      const voidEvent = (await events(item.id)).find((e) => e.kind === "merge_approval_void")
      expect(voidEvent?.reason).toBe("pull_request_closed")
      expect((await pullRequestOf(item.id)).closedAt).toEqual(minutesAfter(NOW, 20))
    })

    it("a closed pull request on an item still in attempt voids a pending approval and moves nothing", async () => {
      const { item, attempt } = await fixing()
      await record({ itemId: item.id })
      await finishFix(attempt.id)
      await forceState(db(), item.id, "attempt", minutesAfter(NOW, 12))
      const result = await record({ state: "closed" }, minutesAfter(NOW, 20))
      expect(result.state).toBe("attempt")
      expect((await approvalsOf(item.id)).map((a) => a.status)).toEqual(["void"])
    })

    it("a merge recorded while an approval is pending voids it", async () => {
      const { item, attempt } = await fixing()
      await record({ itemId: item.id })
      await finishFix(attempt.id)
      expect((await approvalsOf(item.id)).map((a) => a.status)).toEqual(["pending"])
      await record({ state: "merged" }, minutesAfter(NOW, 20))
      expect(await stateOf(item.id)).toBe("deploy")
      expect((await approvalsOf(item.id)).map((a) => a.status)).toEqual(["void"])
      const voids = (await events(item.id)).filter((e) => e.kind === "merge_approval_void")
      expect(voids).toHaveLength(1)
      expect(voids[0]).toMatchObject({ reason: "merged", actorType: "system" })
      // the void is written before the move out of review, and no approval is made after it
      const kinds = await eventKinds(item.id)
      expect(kinds.filter((k) => k === "merge_approval_requested")).toHaveLength(1)
    })

    it("a redelivered open with the same head sha does not pull a retrying item back to review, a new head sha does", async () => {
      const { item, attempt } = await fixing()
      await record({ itemId: item.id })
      await finishFix(attempt.id)
      // CI failed: a second fix starts from review
      await startAttempt(db(), {
        itemId: item.id,
        kind: "fix",
        actor: AGENT,
        now: minutesAfter(NOW, 15),
      })
      expect(await stateOf(item.id)).toBe("attempt")
      // a check update or a label event re-sends the whole set with the same head
      await record({}, minutesAfter(NOW, 16))
      await record({ checks: [{ name: "ci", state: "failed" }] }, minutesAfter(NOW, 17))
      expect(await stateOf(item.id)).toBe("attempt")
      // the push of the fix has a new head
      await record({ headSha: SHA_B }, minutesAfter(NOW, 18))
      expect(await stateOf(item.id)).toBe("review")
    })

    it("an older pull request of the item cannot move it", async () => {
      const { item } = await fixing()
      await seedPullRequest(db(), item.id, { number: 3, openedAt: NOW, state: "closed" })
      await db()
        .update(pullRequests)
        .set({ branch: BRANCH })
        .where(eq(pullRequests.itemId, item.id))
      await record({ number: 8, url: urlOf(8), branch: BRANCH }, minutesAfter(NOW, 5))
      expect(await stateOf(item.id)).toBe("review")
      // the older one is merged late: it is recorded, and #8 stays the item's pull request
      await record({ number: 3, url: urlOf(3), state: "merged" }, minutesAfter(NOW, 6))
      expect(await stateOf(item.id)).toBe("review")
      expect((await pullRequestOf(item.id, 3)).state).toBe("merged")
      expect((await factsOf(item.id)).pullRequest).toBe("open")
    })

    it("an upper-case head sha is stored lower-case, and the same sha in lower case is not a head change", async () => {
      const { item, attempt } = await fixing()
      await record({ itemId: item.id, headSha: SHA_A.toUpperCase() })
      expect((await pullRequestOf(item.id)).headSha).toBe(SHA_A)
      await finishFix(attempt.id)
      await record({ headSha: SHA_A }, minutesAfter(NOW, 12))
      expect((await approvalsOf(item.id)).map((a) => [a.status, a.headSha])).toEqual([
        ["pending", SHA_A],
      ])
      expect(await eventKinds(item.id)).not.toContain("merge_approval_void")
    })

    it("a merged pull request cannot change its head (CONFLICT)", async () => {
      const { item } = await fixing()
      await record({ itemId: item.id })
      await record({ state: "merged" }, minutesAfter(NOW, 5))
      await expectAppError(
        record({ state: "merged", headSha: SHA_B }, minutesAfter(NOW, 6)),
        "CONFLICT",
      )
      await record({ state: "merged", headSha: SHA_A }, minutesAfter(NOW, 7)) // the same head is a redelivery
      expect((await pullRequestOf(item.id)).headSha).toBe(SHA_A)
    })

    it("mergedBy alone with state open is BAD_REQUEST, and mergedBy is set once like mergedAt", async () => {
      const { item } = await fixing()
      await expectAppError(record({ itemId: item.id, mergedBy: "octocat" }), "BAD_REQUEST")
      await expectAppError(
        recordPullRequest(db(), {
          actor: AGENT,
          itemId: item.id,
          branch: BRANCH,
          number: 7,
          url: urlOf(7),
          mergedBy: "octocat",
          now: NOW,
        }),
        "BAD_REQUEST",
      )
      await record({ itemId: item.id })
      await record({ state: "merged", mergedBy: "octocat" }, minutesAfter(NOW, 5))
      await record({ state: "merged", mergedBy: "someone-else" }, minutesAfter(NOW, 6))
      expect((await pullRequestOf(item.id)).mergedBy).toBe("octocat")
    })

    it("a redelivered merge of an already merged pull request moves nothing", async () => {
      const item = await seedItem(db(), { state: "attempt" })
      await seedAttempt(db(), item.id, {
        number: 1,
        status: "running",
        result: null,
        branch: BRANCH,
        leaseExpiresAt: minutesAfter(NOW, 600),
      })
      await seedPullRequest(db(), item.id, { number: 7, state: "merged", mergedAt: NOW })
      const result = await record({ state: "merged" }, minutesAfter(NOW, 5))
      expect(result).toEqual({ matched: true, itemId: item.id, state: "attempt" })
    })

    it("two items with colliding branch slugs: closing #7 reaches the item that holds #7, voids its approval and inserts no row on the other", async () => {
      const one = await fixing()
      await record({ itemId: one.item.id })
      await finishFix(one.attempt.id)
      expect((await approvalsOf(one.item.id)).map((a) => a.status)).toEqual(["pending"])
      // another item's attempt picked the same branch name, later
      const two = await seedItem(db(), { state: "attempt" })
      await seedAttempt(db(), two.id, {
        number: 1,
        status: "running",
        result: null,
        branch: BRANCH,
        leaseExpiresAt: minutesAfter(NOW, 600),
        now: minutesAfter(NOW, 20),
      })
      const closed = await record({ state: "closed" }, minutesAfter(NOW, 21))
      expect(closed).toMatchObject({ matched: true, itemId: one.item.id, state: "stopped" })
      expect((await approvalsOf(one.item.id)).map((a) => a.status)).toEqual(["void"])
      expect(
        await db().select().from(pullRequests).where(eq(pullRequests.itemId, two.id)),
      ).toHaveLength(0)
      expect(await stateOf(two.id)).toBe("attempt")
      // a pull request number nobody has recorded still goes to the newest attempt on its branch
      const fresh = await record({ number: 8, url: urlOf(8) }, minutesAfter(NOW, 22))
      expect(fresh).toMatchObject({ matched: true, itemId: two.id, state: "review" })
    })

    it("a pull request recorded for a stopped item is stored and moves nothing", async () => {
      const item = await seedItem(db(), { state: "stopped" })
      await seedAttempt(db(), item.id, { number: 1, branch: BRANCH })
      const result = await record({}, minutesAfter(NOW, 2))
      expect(result).toEqual({ matched: true, itemId: item.id, state: "stopped" })
      await record({ state: "merged" }, minutesAfter(NOW, 3))
      expect(await stateOf(item.id)).toBe("stopped")
    })
  })

  describe("a pull request belongs to one cycle", () => {
    async function reopenedItem(state: "attempt" | "review") {
      const item = await seedItem(db(), { state, cycle: 2 })
      // cycle 1 fixed it on factory/fix-7 and PR #7 merged; the item was reopened (cycle 2)
      await seedAttempt(db(), item.id, { number: 1, cycle: 1, branch: BRANCH, result: "approved" })
      await seedPullRequest(db(), item.id, {
        number: 7,
        state: "merged",
        openedAt: NOW,
        mergedAt: minutesAfter(NOW, 10),
      })
      await seedAttempt(db(), item.id, {
        number: 2,
        cycle: 2,
        status: "running",
        result: null,
        branch: "factory/fix-9",
        leaseExpiresAt: minutesAfter(NOW, 600),
        now: minutesAfter(NOW, 100),
      })
      return item
    }

    it("loadFacts reads the current cycle's pull request only", async () => {
      const item = await reopenedItem("attempt")
      const facts = await factsOf(item.id, minutesAfter(NOW, 120))
      expect(facts.pullRequest).toBe("none")
      expect(facts.graceElapsed).toBe(false)
      // a cycle 1 item sees the same row as its own
      const first = await seedItem(db(), { state: "review" })
      await seedAttempt(db(), first.id, { number: 1, branch: BRANCH })
      await seedPullRequest(db(), first.id, { number: 7, state: "merged", mergedAt: NOW })
      expect((await factsOf(first.id, minutesAfter(NOW, 120))).pullRequest).toBe("merged")
    })

    it("a redelivered cycle 1 merge does not move a cycle 2 item to deploy", async () => {
      const item = await reopenedItem("attempt")
      const result = await record({ state: "merged" }, minutesAfter(NOW, 120))
      expect(result).toEqual({ matched: true, itemId: item.id, state: "attempt" })
      expect(await stateOf(item.id)).toBe("attempt")
      expect((await pullRequestOf(item.id)).mergedAt).toEqual(minutesAfter(NOW, 10))
    })

    it("a redelivered cycle 1 merge or close does not move a cycle 2 item out of review", async () => {
      const item = await reopenedItem("review")
      await record({ state: "merged" }, minutesAfter(NOW, 120))
      expect(await stateOf(item.id)).toBe("review")
      // an old closed pull request of another cycle cannot stop it either
      await seedPullRequest(db(), item.id, { number: 5, state: "closed", openedAt: NOW })
      await db()
        .update(pullRequests)
        .set({ branch: BRANCH })
        .where(and(eq(pullRequests.itemId, item.id), eq(pullRequests.number, 5)))
      await record({ number: 5, url: urlOf(5), state: "closed" }, minutesAfter(NOW, 121))
      expect(await stateOf(item.id)).toBe("review")
    })

    it("the cycle 2 pull request, on its own branch, moves the item as usual", async () => {
      const item = await reopenedItem("attempt")
      const result = await record(
        { branch: "factory/fix-9", number: 9, url: urlOf(9), headSha: SHA_C },
        minutesAfter(NOW, 120),
      )
      expect(result.state).toBe("review")
      expect((await factsOf(item.id, minutesAfter(NOW, 121))).pullRequest).toBe("open")
      const merged = await record(
        { branch: "factory/fix-9", number: 9, url: urlOf(9), state: "merged" },
        minutesAfter(NOW, 130),
      )
      expect(merged.state).toBe("deploy")
    })

    /** Cycle 1 merged #7 on BRANCH (attempt 1); the item was reopened and cycle 2's fix reuses BRANCH. */
    async function reusedBranch(branch2: string | null = BRANCH) {
      const item = await seedItem(db(), { state: "attempt", cycle: 2 })
      const first = await seedAttempt(db(), item.id, {
        number: 1,
        cycle: 1,
        branch: BRANCH,
        result: "approved",
      })
      await seedPullRequest(db(), item.id, {
        number: 7,
        state: "merged",
        branch: BRANCH,
        attemptId: first.id,
        mergedAt: minutesAfter(NOW, 10),
      })
      await seedAttempt(db(), item.id, {
        number: 2,
        cycle: 2,
        status: "running",
        result: null,
        branch: branch2,
        leaseExpiresAt: minutesAfter(NOW, 600),
        now: minutesAfter(NOW, 100),
      })
      return item
    }

    it("a finish in cycle 2 never takes the head of cycle 1's pull request, with the branch reused or with none", async () => {
      for (const branch2 of [BRANCH, null]) {
        await resetWork(db())
        const item = await reusedBranch(branch2)
        const [second] = await db()
          .select()
          .from(attempts)
          .where(and(eq(attempts.itemId, item.id), eq(attempts.number, 2)))
        if (!second) throw new Error("no attempt 2")
        const done = await finishFix(second.id, { now: minutesAfter(NOW, 130) })
        expect(done.reviewedHeadSha).toBeNull()
      }
    })

    it("a branch reused by the next cycle does not make the old merged pull request its own", async () => {
      const item = await reusedBranch()
      expect((await factsOf(item.id, minutesAfter(NOW, 120))).pullRequest).toBe("none")
      const redelivered = await record({ state: "merged" }, minutesAfter(NOW, 120))
      expect(redelivered).toEqual({ matched: true, itemId: item.id, state: "attempt" })
      expect(await stateOf(item.id)).toBe("attempt")
      // the cycle 2 pull request on the same branch moves it as usual, and ties to cycle 2
      const opened = await record(
        { number: 9, url: urlOf(9), headSha: SHA_C },
        minutesAfter(NOW, 130),
      )
      expect(opened.state).toBe("review")
      expect((await factsOf(item.id, minutesAfter(NOW, 131))).pullRequest).toBe("open")
      const merged = await record(
        { number: 9, url: urlOf(9), state: "merged" },
        minutesAfter(NOW, 140),
      )
      expect(merged.state).toBe("deploy")
    })

    it("a new pull request on a branch no attempt reported counts for the current cycle", async () => {
      const item = await seedItem(db(), { state: "attempt", cycle: 2 })
      await seedAttempt(db(), item.id, { number: 1, cycle: 1, branch: BRANCH })
      await seedAttempt(db(), item.id, {
        number: 2,
        cycle: 2,
        status: "running",
        result: null,
        leaseExpiresAt: minutesAfter(NOW, 600),
      })
      const result = await record({ itemId: item.id, branch: "factory/never-reported" })
      expect(result.state).toBe("review")
    })
  })

  describe("merge approvals", () => {
    it("reviewer approved then PR opened creates one pending approval bound to the head sha, and PR opened then reviewer approved creates the same", async () => {
      // reviewer first: the fix finishes while the item is still in attempt, no pull request yet
      const a = await fixing()
      await finishFix(a.attempt.id)
      expect(await approvalsOf(a.item.id)).toHaveLength(0)
      await record({ itemId: a.item.id }, minutesAfter(NOW, 12))
      const [first] = await approvalsOf(a.item.id)
      expect(await approvalsOf(a.item.id)).toHaveLength(1)
      expect(first).toMatchObject({
        status: "pending",
        headSha: SHA_A,
        itemId: a.item.id,
        decidedBy: null,
        decidedAt: null,
      })
      expect(first?.pullRequestId).toBe((await pullRequestOf(a.item.id)).id)

      // pull request first
      const b = await fixing()
      await record({ itemId: b.item.id, number: 8, url: urlOf(8), branch: BRANCH })
      expect(await approvalsOf(b.item.id)).toHaveLength(0)
      await finishFix(b.attempt.id, { now: minutesAfter(NOW, 12) })
      const [second] = await approvalsOf(b.item.id)
      expect(await approvalsOf(b.item.id)).toHaveLength(1)
      expect(second).toMatchObject({ status: "pending", headSha: SHA_A })
      expect(second?.requestedAt).toEqual(new Date(minutesAfter(NOW, 12).getTime() + 1))
      expect(await eventKinds(b.item.id)).toContain("merge_approval_requested")
    })

    it("finishAttempt calls ensureMergeApproval: the request is written one millisecond after the finish", async () => {
      const { item, attempt } = await fixing()
      await record({ itemId: item.id })
      const at = minutesAfter(NOW, 10)
      await finishFix(attempt.id, { now: at })
      const tail = (await events(item.id)).slice(-2)
      expect(tail.map((e) => e.kind)).toEqual(["attempt_finished", "merge_approval_requested"])
      expect(tail[0]?.at).toEqual(at)
      expect(tail[1]?.at).toEqual(new Date(at.getTime() + 1))
      expect(tail[1]).toMatchObject({ actorType: "system", cycle: 1 })
      expect(tail[1]?.detail).toMatchObject({ headSha: SHA_A })
    })

    it("drafts get an approval and the row exposes is_draft", async () => {
      // Founder decision: an approval only records a decision (GitHub refuses to merge a draft), so
      // a draft pull request is not excluded; the card reads isDraft from the pull request row.
      const { item, attempt } = await fixing()
      await record({ itemId: item.id, isDraft: true })
      await finishFix(attempt.id)
      const [approval] = await approvalsOf(item.id)
      expect(approval).toMatchObject({ status: "pending", headSha: SHA_A })
      const pull = await pullRequestOf(item.id)
      expect(pull).toMatchObject({ id: approval?.pullRequestId, isDraft: true })
    })

    it("a reviewer rejection creates no approval", async () => {
      const { item, attempt } = await fixing()
      await record({ itemId: item.id })
      await finishFix(attempt.id, { result: "rejected" })
      expect(await approvalsOf(item.id)).toHaveLength(0)
      expect(await eventKinds(item.id)).not.toContain("merge_approval_requested")
    })

    it("a failed or needs_answer finish creates no approval", async () => {
      const { item, attempt } = await fixing()
      await record({ itemId: item.id })
      await finishAttempt(db(), {
        actor: AGENT,
        attemptId: attempt.id,
        result: "failed",
        now: minutesAfter(NOW, 10),
      })
      expect(await approvalsOf(item.id)).toHaveLength(0)
    })

    it("ensureMergeApproval makes nothing when the item is not in review or the pull request is not open", async () => {
      const { item, attempt } = await fixing()
      await record({ itemId: item.id })
      await finishFix(attempt.id)
      // void the pending one so a fresh one could be made, then break each condition
      await db().update(mergeApprovals).set({ status: "void" })
      const run = () =>
        db().transaction(async (tx) => {
          await ensureMergeApproval(tx, item.id, minutesAfter(NOW, 30))
        })
      await forceState(db(), item.id, "attempt", NOW)
      await run()
      await forceState(db(), item.id, "review", NOW)
      await db().update(pullRequests).set({ state: "closed" })
      await run()
      expect((await approvalsOf(item.id)).map((a) => a.status)).toEqual(["void"])
      await db().update(pullRequests).set({ state: "open" })
      await run()
      expect((await approvalsOf(item.id)).map((a) => a.status)).toEqual(["void", "pending"])
      // and a second call makes no second one
      await run()
      expect(await approvalsOf(item.id)).toHaveLength(2)
    })

    it("a repeated finish or a redelivered open creates no second approval", async () => {
      const { item, attempt } = await fixing()
      await record({ itemId: item.id })
      await finishFix(attempt.id)
      await finishFix(attempt.id, { now: minutesAfter(NOW, 11) })
      await record({}, minutesAfter(NOW, 12))
      await record({ checks: [{ name: "ci", state: "passed" }] }, minutesAfter(NOW, 13))
      expect(await approvalsOf(item.id)).toHaveLength(1)
    })

    it("an approval already approved for the head is not asked for again", async () => {
      const { item, attempt } = await fixing()
      await record({ itemId: item.id })
      await finishFix(attempt.id)
      await db()
        .update(mergeApprovals)
        .set({ status: "approved", decidedBy: "founder-1", decidedAt: minutesAfter(NOW, 11) })
      await record({}, minutesAfter(NOW, 12))
      expect((await approvalsOf(item.id)).map((a) => a.status)).toEqual(["approved"])
    })

    it("a new head sha voids the pending approval and creates none until a new approved attempt", async () => {
      const { item, attempt } = await fixing()
      await record({ itemId: item.id })
      await finishFix(attempt.id)
      const result = await record({ headSha: SHA_B }, minutesAfter(NOW, 15))
      expect(result.state).toBe("review")
      expect((await approvalsOf(item.id)).map((a) => [a.status, a.headSha])).toEqual([
        ["void", SHA_A],
      ])
      expect((await pullRequestOf(item.id)).headSha).toBe(SHA_B)
      const voided = (await events(item.id)).filter((e) => e.kind === "merge_approval_void")
      expect(voided).toHaveLength(1)
      expect(voided[0]).toMatchObject({ reason: "head_sha_changed", actorType: "system" })
      // a later event with the same head does not bring it back
      await record({ headSha: SHA_B }, minutesAfter(NOW, 16))
      expect(await approvalsOf(item.id)).toHaveLength(1)
    })

    it("a push after the approval was granted voids it too", async () => {
      const { item, attempt } = await fixing()
      await record({ itemId: item.id })
      await finishFix(attempt.id)
      await db()
        .update(mergeApprovals)
        .set({ status: "approved", decidedBy: "founder-1", decidedAt: minutesAfter(NOW, 11) })
      await record({ headSha: SHA_B }, minutesAfter(NOW, 15))
      const [row] = await approvalsOf(item.id)
      expect(row).toMatchObject({ status: "void", decidedBy: "founder-1" })
      expect(await approvalsOf(item.id)).toHaveLength(1)
    })

    it("an approval whose verdict came before the pull request exists binds to the first head it sees, so a push still voids it and makes none", async () => {
      const { item, attempt } = await fixing()
      await finishFix(attempt.id) // no pull request yet: reviewed_head_sha is null
      expect(
        (await db().select().from(attempts).where(eq(attempts.id, attempt.id)))[0],
      ).toMatchObject({ reviewedHeadSha: null })
      await record({ itemId: item.id }, minutesAfter(NOW, 11))
      expect((await approvalsOf(item.id)).map((a) => [a.status, a.headSha])).toEqual([
        ["pending", SHA_A],
      ])
      expect(
        (await db().select().from(attempts).where(eq(attempts.id, attempt.id)))[0]?.reviewedHeadSha,
      ).toBe(SHA_A)
      await record({ headSha: SHA_B }, minutesAfter(NOW, 12))
      expect((await approvalsOf(item.id)).map((a) => [a.status, a.headSha])).toEqual([
        ["void", SHA_A],
      ])
    })

    it("a CI-fix revision: an item in review starts a fix (attempt), a later open record with a new head sha moves it back to review and voids the pending approval, and the reviewer's approval then creates a new one for the new sha", async () => {
      const { item, attempt } = await fixing()
      await record({ itemId: item.id })
      await finishFix(attempt.id)
      expect((await approvalsOf(item.id)).map((a) => a.status)).toEqual(["pending"])

      const second = await startAttempt(db(), {
        itemId: item.id,
        kind: "fix",
        actor: AGENT,
        now: minutesAfter(NOW, 20),
      })
      expect(await stateOf(item.id)).toBe("attempt")
      await heartbeatAttempt(db(), {
        attemptId: second.id,
        branch: BRANCH,
        now: minutesAfter(NOW, 21),
      })
      const moved = await record({ headSha: SHA_B }, minutesAfter(NOW, 22))
      expect(moved.state).toBe("review")
      expect((await approvalsOf(item.id)).map((a) => [a.status, a.headSha])).toEqual([
        ["void", SHA_A],
      ])
      await finishFix(second.id, { now: minutesAfter(NOW, 30) })
      expect((await approvalsOf(item.id)).map((a) => [a.status, a.headSha])).toEqual([
        ["void", SHA_A],
        ["pending", SHA_B],
      ])
    })

    it("a verdict with no reviewed sha is not bound to a pull request on another branch: a push to the first branch, or a close and reopen of its pull request, makes no approval", async () => {
      const retryOnOtherBranch = async () => {
        const { item, attempt } = await fixing() // fix 1 on BRANCH opens #7 at head A
        await record({ itemId: item.id })
        await finishFix(attempt.id, { result: "rejected" })
        const second = await startAttempt(db(), {
          itemId: item.id,
          kind: "fix",
          actor: AGENT,
          now: minutesAfter(NOW, 20),
        })
        await heartbeatAttempt(db(), {
          attemptId: second.id,
          branch: "factory/fix-8",
          now: minutesAfter(NOW, 21),
        })
        // fix 2 is approved before any pull request on its branch is recorded: no sha to bind
        await finishFix(second.id, { now: minutesAfter(NOW, 30) })
        expect(await stateOf(item.id)).toBe("attempt")
        const [stored] = await db().select().from(attempts).where(eq(attempts.id, second.id))
        expect(stored?.reviewedHeadSha).toBeNull()
        return { item, second }
      }
      // a collaborator pushes head B to the first branch
      const pushed = await retryOnOtherBranch()
      await record({ headSha: SHA_B }, minutesAfter(NOW, 40))
      expect(await stateOf(pushed.item.id)).toBe("review")
      expect(await approvalsOf(pushed.item.id)).toHaveLength(0)
      const [after] = await db().select().from(attempts).where(eq(attempts.id, pushed.second.id))
      expect(after?.reviewedHeadSha).toBeNull()

      // #7 is closed while the retry runs, then reopened at the head fix 1's reviewer read
      await resetWork(db())
      const reopened = await retryOnOtherBranch()
      await record({ state: "closed" }, minutesAfter(NOW, 40))
      expect(await stateOf(reopened.item.id)).toBe("attempt")
      await record({ state: "open" }, minutesAfter(NOW, 41))
      expect(await stateOf(reopened.item.id)).toBe("review")
      expect(await approvalsOf(reopened.item.id)).toHaveLength(0)
    })

    it("only the current cycle's newest fix counts: an approved fix of cycle 1 makes no approval for a cycle 2 pull request", async () => {
      const item = await seedItem(db(), { state: "review", cycle: 2 })
      await seedAttempt(db(), item.id, { number: 1, cycle: 1, result: "approved", branch: BRANCH })
      await seedAttempt(db(), item.id, {
        number: 2,
        cycle: 2,
        result: "failed",
        branch: "factory/fix-9",
      })
      await seedPullRequest(db(), item.id, { number: 9 })
      await db()
        .update(pullRequests)
        .set({ branch: "factory/fix-9" })
        .where(eq(pullRequests.itemId, item.id))
      await db().transaction(async (tx) => {
        await ensureMergeApproval(tx, item.id, minutesAfter(NOW, 5))
      })
      expect(await approvalsOf(item.id)).toHaveLength(0)
    })

    it("ensureMergeApproval on a missing item makes nothing", async () => {
      await db().transaction(async (tx) => {
        await ensureMergeApproval(tx, crypto.randomUUID(), NOW)
      })
      expect(await db().select().from(mergeApprovals)).toHaveLength(0)
      expect(await db().select().from(workItems)).toHaveLength(0)
    })
  })
})
