// The data-layer guards Task 7 (the agent-facing operations) needs: a heartbeat on a stopped or
// done item, the reviewer's head sha, the sweep's per-attempt isolation, a stale merged pull
// request, the `via` of an actor, and the shared views the operations return.
import { AppError } from "@proof/errors"
import { and, asc, eq, sql } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { attempts, contractItems, mergeApprovals, pullRequests, workItemEvents } from "../db/schema"
import { createHqTestDb } from "../testing"
import { startAttempt, finishAttempt, heartbeatAttempt } from "./attempts"
import { recordPullRequest } from "./pull-requests"
import { runVerificationSweep } from "./verification"
import {
  forceState,
  minutesAfter,
  NOW,
  resetWork,
  seedAttempt,
  seedItem,
} from "./work.test.helpers"
import { appendEvent } from "./work-events"
import { attemptViewOf, itemDetail, workBoard, workItemSummaries } from "./work-board"
import { currentPullRequest, lockItem, resolveItem } from "./work-items"

const AGENT = { type: "agent", id: "agent-key" } as const
const BRANCH = "factory/fix-7"
const SHA_A = "a".repeat(40)
const SHA_B = "b".repeat(40)
const HOUR = 60
const REVIEW = { verdict: "approve", summary: "Looks right." } as const
const urlOf = (n: number) => `https://github.com/acme/web/pull/${n}`

describe("the guards of the agent-facing operations (in-process Postgres)", () => {
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

  const expectAppError = async (p: Promise<unknown>, code: string) => {
    const error = await p.then(
      () => null,
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).code).toBe(code)
  }
  const events = (itemId: string) =>
    db()
      .select()
      .from(workItemEvents)
      .where(eq(workItemEvents.itemId, itemId))
      .orderBy(asc(workItemEvents.at), asc(workItemEvents.id))
  const addContract = (itemId: string) =>
    db().insert(contractItems).values({
      id: crypto.randomUUID(),
      itemId,
      cycle: 1,
      position: 1,
      text: "It works",
      verifierKind: "reviewer",
      status: "pending",
      createdByType: "system",
      createdById: "test",
    })
  const record = (input: Partial<Parameters<typeof recordPullRequest>[1]> = {}, now = NOW) =>
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
  /** An item in `attempt` with a running fix. */
  async function fixing(branch: string | null = BRANCH) {
    const item = await seedItem(db(), { state: "plan" })
    await addContract(item.id)
    const attempt = await startAttempt(db(), {
      itemId: item.id,
      kind: "fix",
      actor: AGENT,
      now: NOW,
    })
    if (branch)
      await heartbeatAttempt(db(), { attemptId: attempt.id, branch, now: minutesAfter(NOW, 1) })
    return { item, attempt }
  }

  describe("a heartbeat on a stopped or done item", () => {
    for (const state of ["stopped", "done"] as const) {
      it(`is CONFLICT on an item that is ${state}, and the lease does not move`, async () => {
        const { item, attempt } = await fixing()
        const before = (await db().select().from(attempts).where(eq(attempts.id, attempt.id)))[0]
        await forceState(db(), item.id, state, minutesAfter(NOW, 2))
        await expectAppError(
          heartbeatAttempt(db(), { attemptId: attempt.id, now: minutesAfter(NOW, 3) }),
          "CONFLICT",
        )
        const after = (await db().select().from(attempts).where(eq(attempts.id, attempt.id)))[0]
        expect(after?.leaseExpiresAt).toEqual(before?.leaseExpiresAt)
        expect(after?.lastHeartbeatAt).toEqual(before?.lastHeartbeatAt)
      })
    }

    it("still extends the lease of an attempt on an item in flight", async () => {
      const { attempt } = await fixing()
      const out = await heartbeatAttempt(db(), { attemptId: attempt.id, now: minutesAfter(NOW, 3) })
      expect(out.leaseExpiresAt).toEqual(minutesAfter(NOW, 3 + 45))
    })

    it("a stopped item's attempt may still be finished (the heartbeat is what is refused)", async () => {
      const { item, attempt } = await fixing()
      await forceState(db(), item.id, "stopped", minutesAfter(NOW, 2))
      const row = await finishAttempt(db(), {
        actor: AGENT,
        attemptId: attempt.id,
        result: "failed",
        now: minutesAfter(NOW, 3),
      })
      expect(row.status).toBe("finished")
    })
  })

  describe("the reviewer's head sha", () => {
    const finish = (attemptId: string, headSha?: string, now = minutesAfter(NOW, 5)) =>
      finishAttempt(db(), {
        actor: AGENT,
        attemptId,
        result: "approved",
        reviewer: { ...REVIEW, ...(headSha === undefined ? {} : { headSha }) },
        now,
      })
    const storedSha = async (attemptId: string) =>
      (await db().select().from(attempts).where(eq(attempts.id, attemptId)))[0]?.reviewedHeadSha

    it("is stored lower-cased as reviewed_head_sha, before any pull request exists", async () => {
      const { attempt } = await fixing()
      await finish(attempt.id, SHA_A.toUpperCase())
      expect(await storedSha(attempt.id)).toBe(SHA_A)
    })

    it("wins over the recorded pull request's head", async () => {
      const { item, attempt } = await fixing()
      await record({ itemId: item.id, headSha: SHA_B })
      await finish(attempt.id, SHA_A)
      expect(await storedSha(attempt.id)).toBe(SHA_A)
    })

    it("binds the approval: the push of the reviewed head creates it, a push of another head does not", async () => {
      const bound = await fixing()
      await finish(bound.attempt.id, SHA_A)
      await record({ itemId: bound.item.id, headSha: SHA_A }, minutesAfter(NOW, 8))
      const approvals = await db()
        .select()
        .from(mergeApprovals)
        .where(eq(mergeApprovals.itemId, bound.item.id))
      expect(approvals).toMatchObject([{ status: "pending", headSha: SHA_A }])

      const other = await fixing("factory/fix-8")
      await finish(other.attempt.id, SHA_A)
      await record(
        {
          itemId: other.item.id,
          number: 9,
          url: urlOf(9),
          branch: "factory/fix-8",
          headSha: SHA_B,
        },
        minutesAfter(NOW, 8),
      )
      expect(
        await db().select().from(mergeApprovals).where(eq(mergeApprovals.itemId, other.item.id)),
      ).toEqual([])
    })

    it("without one the branch lookup still applies", async () => {
      const { item, attempt } = await fixing()
      await record({ itemId: item.id, headSha: SHA_B })
      await finish(attempt.id)
      expect(await storedSha(attempt.id)).toBe(SHA_B)
    })

    it("refuses what is not a commit id", async () => {
      const { attempt } = await fixing()
      for (const bad of ["xyz", "abc", "a".repeat(65), `${"a".repeat(39)}g`, ""]) {
        await expectAppError(finish(attempt.id, bad), "BAD_REQUEST")
      }
      expect(await storedSha(attempt.id)).toBeNull()
    })
  })

  describe("the sweep isolates each stale attempt", () => {
    afterEach(async () => {
      await db().execute(sql`drop trigger if exists test_fail_events on hq.work_item_events`)
      await db().execute(sql`drop function if exists hq.test_fail_events()`)
    })

    it("one attempt that throws is recorded with its item's id and the others are still abandoned", async () => {
      const stale = async (title: string, minutes: number) => {
        const item = await seedItem(db(), { state: "attempt", title })
        const a = await seedAttempt(db(), item.id, {
          number: 1,
          status: "running",
          result: null,
          leaseExpiresAt: minutesAfter(NOW, minutes),
        })
        return { item, a }
      }
      const bad = await stale("bad", -30) // the oldest lease: it comes first
      const ok1 = await stale("ok1", -20)
      const ok2 = await stale("ok2", -10)
      await db().execute(sql`create function hq.test_fail_events() returns trigger
        language plpgsql as $$ begin raise exception 'boom'; end $$`)
      await db().execute(
        sql.raw(
          `create trigger test_fail_events before insert on hq.work_item_events
           for each row when (new.item_id = '${bad.item.id}')
           execute function hq.test_fail_events()`,
        ),
      )
      const out = await runVerificationSweep(db(), NOW)
      expect(out.abandoned).toEqual([ok1.a.id, ok2.a.id])
      expect(out.errors).toEqual([
        { itemId: bad.item.id, rule: "expire", message: expect.stringMatching(/boom/) },
      ])
      // the failed one rolled back whole; it is tried again on the next pass
      const [row] = await db().select().from(attempts).where(eq(attempts.id, bad.a.id))
      expect(row?.status).toBe("running")
    })
  })

  describe("a stale merged pull request", () => {
    const addPr = (itemId: string, number: number, openedAt: Date) =>
      record(
        { itemId, number, url: urlOf(number), branch: BRANCH, headSha: SHA_A, state: "open" },
        openedAt,
      )

    it("recorded merged with an old mergedAt after the current one does not replace it", async () => {
      const { item, attempt } = await fixing()
      await addPr(item.id, 7, NOW) // the current pull request: open, recorded now
      await finishAttempt(db(), {
        actor: AGENT,
        attemptId: attempt.id,
        result: "approved",
        reviewer: REVIEW,
        now: minutesAfter(NOW, 2),
      })
      const later = minutesAfter(NOW, 10)
      const out = await record(
        {
          itemId: item.id,
          number: 3,
          url: urlOf(3),
          state: "merged",
          mergedAt: minutesAfter(NOW, -3 * 24 * HOUR).toISOString(),
        },
        later,
      )
      expect(out.state).toBe("review") // the item did not move to deploy
      const current = await db().transaction(async (tx) =>
        currentPullRequest(tx, await lockItem(tx, item.id)),
      )
      expect(current?.number).toBe(7)
      const [stale] = await db()
        .select()
        .from(pullRequests)
        .where(and(eq(pullRequests.itemId, item.id), eq(pullRequests.number, 3)))
      expect(stale).toMatchObject({ state: "merged", mergedAt: minutesAfter(NOW, -3 * 24 * HOUR) })
      expect(stale?.openedAt).toEqual(minutesAfter(NOW, -3 * 24 * HOUR))
    })

    it("recorded merged after the current one was opened (a real, later merge) does replace it", async () => {
      const { item } = await fixing()
      await addPr(item.id, 7, NOW)
      const out = await record(
        {
          itemId: item.id,
          number: 8,
          url: urlOf(8),
          state: "merged",
          mergedAt: minutesAfter(NOW, 5).toISOString(),
        },
        minutesAfter(NOW, 10),
      )
      expect(out.state).toBe("deploy")
    })

    it("a lone pull request recorded merged 7 hours ago still reaches done in one sweep (the seed)", async () => {
      const { item, attempt } = await fixing()
      await finishAttempt(db(), {
        actor: AGENT,
        attemptId: attempt.id,
        result: "approved",
        reviewer: REVIEW,
        now: minutesAfter(NOW, 2),
      })
      const at = minutesAfter(NOW, 8 * HOUR)
      const out = await record(
        {
          itemId: item.id,
          state: "merged",
          mergedAt: minutesAfter(at, -7 * HOUR).toISOString(),
        },
        at,
      )
      expect(out.state).toBe("deploy")
      const swept = await runVerificationSweep(db(), at)
      expect(swept.passed).toEqual([item.id])
      expect((await resolveItem(db(), item.id)).state).toBe("done")
    })

    it("a merge that arrives open first keeps its opened time (the merge does not backdate it)", async () => {
      const { item } = await fixing()
      await addPr(item.id, 7, NOW)
      await record(
        {
          itemId: item.id,
          number: 7,
          state: "merged",
          mergedAt: minutesAfter(NOW, 5).toISOString(),
        },
        minutesAfter(NOW, 6),
      )
      const [row] = await db()
        .select()
        .from(pullRequests)
        .where(and(eq(pullRequests.itemId, item.id), eq(pullRequests.number, 7)))
      expect(row?.openedAt).toEqual(NOW)
    })
  })

  describe("Actor.via", () => {
    it("is recorded in the detail of every event the call writes, and nowhere else", async () => {
      const item = await seedItem(db(), { state: "triage" })
      const attempt = await startAttempt(db(), {
        itemId: item.id,
        kind: "investigate",
        actor: { type: "agent", id: "k1", via: "session" },
        now: NOW,
      })
      const written = await events(item.id)
      expect(written.map((e) => e.kind)).toEqual(["transition", "attempt_started"])
      for (const e of written) {
        expect(e.actorType).toBe("agent")
        expect(e.actorId).toBe("k1")
        expect(e.detail).toMatchObject({ via: "session" })
      }
      expect(written[1]?.detail).toMatchObject({ attemptId: attempt.id })
    })

    it("an actor without a via leaves the detail as it was", async () => {
      const item = await seedItem(db(), { state: "triage" })
      await startAttempt(db(), { itemId: item.id, kind: "investigate", actor: AGENT, now: NOW })
      const written = await events(item.id)
      expect(written[0]?.detail).toBeNull()
      expect(written[1]?.detail).not.toHaveProperty("via")
    })

    it("a detail that already says via is not overridden by a caller's text (via is the actor's)", async () => {
      const item = await seedItem(db(), { state: "triage" })
      // No operation passes a detail of its own today; build one that names a forged via.
      await db().transaction((tx) =>
        appendEvent(tx, {
          itemId: item.id,
          at: NOW,
          kind: "signal_attached",
          actor: { type: "agent", id: "k1", via: "key" },
          detail: { via: "forged", signalId: "s1" },
          cycle: item.cycle,
        }),
      )
      const [written] = await events(item.id)
      expect(written?.detail).toEqual({ via: "key", signalId: "s1" })
    })
  })

  describe("the views the operations return", () => {
    it("attemptViewOf is the attempt entry of itemDetail, field for field", async () => {
      const { item, attempt } = await fixing()
      await finishAttempt(db(), {
        actor: AGENT,
        attemptId: attempt.id,
        result: "approved",
        reviewer: { ...REVIEW, headSha: SHA_A },
        files: ["a.ts"],
        now: minutesAfter(NOW, 5),
      })
      const detail = await itemDetail(db(), item.id, minutesAfter(NOW, 6))
      const [row] = await db().select().from(attempts).where(eq(attempts.id, attempt.id))
      if (!row) throw new Error("no attempt")
      expect(await attemptViewOf(db(), row)).toEqual(detail.attemptList[0])
      expect(detail.attemptList[0]?.reviewer).toEqual({ ...REVIEW, headSha: SHA_A })
    })

    it("workItemSummaries is the board's own summary of the same items", async () => {
      const a = await seedItem(db(), { state: "triage", title: "A" })
      const b = await seedItem(db(), { state: "plan", title: "B" })
      const board = await workBoard(db(), NOW)
      const cards = board.columns.flatMap((c) => c.items)
      const rows = [a, b]
      const summaries = await workItemSummaries(db(), rows, NOW)
      expect(summaries).toEqual(rows.map((r) => cards.find((c) => c.id === r.id)))
    })
  })
})
