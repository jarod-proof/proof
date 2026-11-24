import { FatalError } from "eve/workflow"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest"
import { MAX_ATTEMPTS_PER_ITEM } from "#lib/constants.js"
import {
  type AttemptView,
  createHqClient,
  type HqClient,
  type WorkItemDetail,
} from "#lib/hq/client.js"
import { log } from "#lib/log.js"
import {
  ATTEMPT_LIMIT_MESSAGE,
  adoptOrStartAttempt,
  beginStation,
  endStation,
  failStation,
  type StationSummary,
  stationKey,
  subjectOf,
  summarizeStation,
} from "#lib/work/attempts.js"
import { limitReached } from "#lib/work/attempts-shared.js"
import { recorderStats, resetRecorderStats } from "#lib/work/recorder.js"
import { CALLERS } from "../helpers.js"
import { createHqFixture, type HqFixture } from "../hq/hq-fixture.js"
import {
  callOf,
  detailOf,
  eventsOf,
  newItem,
  nextIssue,
  SHA,
  setupFix,
  toPlan,
  toReview,
  useRealHq,
} from "./attempts-support.js"

/**
 * Recording the Foreman stations as attempts, against the real hq (its registry, its auth, its
 * state machine on PGlite) through the same client the steps build from the environment.
 */
let hq: HqFixture

beforeAll(async () => {
  hq = await createHqFixture()
}, 60_000)

afterAll(async () => {
  await hq.close()
})

beforeEach(() => {
  resetRecorderStats()
  vi.spyOn(log, "warn").mockImplementation(() => undefined)
  useRealHq(hq)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

const issue = (n: number) => ({ kind: "issue", issueNumber: n }) as const

const CRITERIA = ["Checkout totals include tax", "A refund keeps its receipt"]
const ANALYSIS: StationSummary = { station: "analyst", acceptanceCriteria: CRITERIA }

describe("the recording rules", () => {
  test("MAX_ATTEMPTS_PER_ITEM is the literal 3", () => {
    expect(MAX_ATTEMPTS_PER_ITEM).toBe(3)
  })

  test("a summary-only run, a mention and a session with no issue and no ticket record nothing", () => {
    expect(subjectOf(CALLERS.summary)).toBeNull()
    expect(subjectOf(CALLERS.trusted)).toBeNull()
    expect(subjectOf(CALLERS.untrusted)).toBeNull()
    expect(subjectOf(CALLERS.anonymous)).toBeNull()
    expect(subjectOf(CALLERS.schedule)).toBeNull()
  })

  test("subjectOf names an issue intake, a ticket run and a CI-fix run", async () => {
    const { stampIssueIntake } = await import("#lib/trust.js")
    expect(subjectOf(stampIssueIntake(CALLERS.untrusted, 31))).toEqual({
      kind: "issue",
      issueNumber: 31,
    })
    expect(subjectOf(CALLERS.ticket)).toEqual({ kind: "ticket", ticketId: "a".repeat(32) })
    // autonomous, an issue number, no work-item stamp, not summary-only: the CI-fix run of PR 12
    expect(subjectOf(CALLERS.autonomous)).toEqual({ kind: "ci_fix", pullNumber: 12 })
  })

  test("an issue-intake session finds its item by the dedupe key (workItemIssue), and a CI-fix session finds it by the pull request number", async () => {
    const { itemId, n } = await newItem(hq)
    const issueRecord = await beginStation(callOf("analyst", issue(n)))
    expect(issueRecord).toMatchObject({ itemId, kind: "investigate" })

    const other = await newItem(hq)
    await toReview(hq, other.itemId, 7001)
    const ci = await beginStation(
      callOf("implementer", { kind: "ci_fix", pullNumber: 7001 }, { attemptLimit: 3 }),
    )
    expect(ci).toMatchObject({ itemId: other.itemId, kind: "fix" })

    // A pull request nobody recorded, and an issue nobody recorded, find no item.
    expect(await beginStation(callOf("analyst", { kind: "ci_fix", pullNumber: 7999 }))).toBeNull()
    expect(await beginStation(callOf("analyst", issue(nextIssue())))).toBeNull()
    expect(await beginStation(callOf("analyst", null))).toBeNull()
  })

  test("a ticket run finds the item through the attempt its dispatcher claimed (listAttempts by externalRef)", async () => {
    const { itemId } = await newItem(hq)
    await toPlan(hq, itemId)
    const ticketId = "b".repeat(32)
    const fix = await hq.client.startAttempt({
      itemId,
      kind: "fix",
      attemptLimit: 3,
      externalRef: ticketId,
    })
    const record = await beginStation(
      callOf("implementer", { kind: "ticket", ticketId }, { attemptLimit: 3 }),
    )
    // The claimed attempt keeps the dispatcher's key and is adopted: no session prefix is needed.
    expect(record).toMatchObject({ itemId, attemptId: fix.id, kind: "fix" })
    expect(
      await beginStation(callOf("analyst", { kind: "ticket", ticketId: "c".repeat(32) })),
    ).toBeNull()
  })

  test("a station key is <sessionId>:<callId>:<station>", () => {
    expect(stationKey({ sessionId: "s", callId: "c", station: "reviewer" })).toBe("s:c:reviewer")
  })
})

describe("what each station records", () => {
  test("the analyst starts an investigate attempt, sets a contract of its acceptance criteria plus the recurrence item, finishes investigated", async () => {
    const { itemId, n } = await newItem(hq)
    const call = callOf("analyst", issue(n))
    const record = await beginStation(call)
    expect(record).not.toBeNull()
    const started = await detailOf(hq, itemId)
    expect(started.attemptList).toHaveLength(1)
    expect(started.attemptList[0]).toMatchObject({
      kind: "investigate",
      status: "running",
      externalRef: stationKey(call),
    })
    expect(started.state).toBe("plan")

    await endStation(
      record,
      summarizeStation("analyst", {
        acceptance_criteria: CRITERIA,
      }),
    )
    const done = await detailOf(hq, itemId)
    expect(done.attemptList[0]).toMatchObject({ status: "finished", result: "investigated" })
    expect(done.contract.map((c) => [c.text, c.verifier.kind])).toEqual([
      ["Checkout totals include tax", "reviewer"],
      ["A refund keeps its receipt", "reviewer"],
      ["No new signal like this in the verification window", "signal_recurrence"],
    ])
    expect(recorderStats().dropped).toBe(0)
  })

  test("the implementer starts a fix with attemptLimit 3, heartbeats branch and files", async () => {
    const { itemId, n } = await newItem(hq)
    await toPlan(hq, itemId)
    const call = callOf("implementer", issue(n), { attemptLimit: MAX_ATTEMPTS_PER_ITEM })
    const record = await beginStation(call)
    expect(record).toMatchObject({ itemId, kind: "fix" })
    expect((await detailOf(hq, itemId)).attempts).toEqual({ used: 1, limit: 3, running: true })

    await endStation(
      record,
      summarizeStation("implementer", {
        pushed: true,
        branch: "agent/fix-tax",
        base: "main",
        change_summary: [
          { path: "src/tax.ts", change: "round" },
          { path: "src/tax.test.ts", change: "test" },
        ],
        known_limitations: [],
      }),
    )
    const after = await detailOf(hq, itemId)
    // The attempt stays running: the reviewer finishes it.
    expect(after.attemptList.at(-1)).toMatchObject({
      status: "running",
      branch: "agent/fix-tax",
      files: ["src/tax.ts", "src/tax.test.ts"],
    })
  })

  test("pushed false finishes failed with the first limitation as the note", async () => {
    const { itemId, n } = await newItem(hq)
    await toPlan(hq, itemId)
    const record = await beginStation(callOf("implementer", issue(n), { attemptLimit: 3 }))
    await endStation(
      record,
      summarizeStation("implementer", {
        pushed: false,
        branch: "agent/fix-tax",
        base: "main",
        change_summary: [],
        known_limitations: ["push was rejected: no permission", "second"],
      }),
    )
    expect((await detailOf(hq, itemId)).attemptList.at(-1)).toMatchObject({
      status: "finished",
      result: "failed",
      note: "push was rejected: no permission",
    })
  })

  async function implementedItem(): Promise<{ itemId: string; n: number }> {
    const item = await newItem(hq)
    await toPlan(hq, item.itemId)
    const call = callOf("implementer", issue(item.n), { attemptLimit: 3 })
    const record = await beginStation(call)
    await endStation(
      record,
      summarizeStation("implementer", {
        pushed: true,
        branch: `agent/fix-${item.n}`,
        base: "main",
        change_summary: [{ path: "a.ts", change: "x" }],
        known_limitations: [],
      }),
    )
    return item
  }

  test("a reviewer approve finishes the fix approved with the verdict and a reviewer reject finishes it rejected with the findings", async () => {
    const approved = await implementedItem()
    const review = callOf("reviewer", issue(approved.n), { callId: "call-2" })
    const record = await beginStation(review)
    expect(record).toMatchObject({ itemId: approved.itemId, kind: "fix" })
    // The reviewer adopted the running fix: it started nothing.
    expect(
      (await detailOf(hq, approved.itemId)).attemptList.filter((a) => a.kind === "fix"),
    ).toHaveLength(1)
    await endStation(
      record,
      summarizeStation(
        "reviewer",
        { verdict: "approve", summary: "Looks right", blocking_findings: [] },
        { headSha: SHA },
      ),
    )
    const fix = (await detailOf(hq, approved.itemId)).attemptList.at(-1)
    expect(fix).toMatchObject({
      result: "approved",
      reviewer: { verdict: "approve", summary: "Looks right", headSha: SHA },
    })

    const rejected = await implementedItem()
    const record2 = await beginStation(callOf("reviewer", issue(rejected.n), { callId: "call-2" }))
    await endStation(
      record2,
      summarizeStation("reviewer", {
        verdict: "request_changes",
        summary: "Two problems",
        blocking_findings: ["src/a.ts: no test", "src/b.ts: wrong rounding"],
      }),
    )
    const fix2 = (await detailOf(hq, rejected.itemId)).attemptList.at(-1)
    expect(fix2).toMatchObject({ result: "rejected", reviewer: { verdict: "request_changes" } })
    expect(fix2?.note).toContain("src/a.ts: no test")
    expect(fix2?.note).toContain("src/b.ts: wrong rounding")
  })

  test("a reviewer with no running fix starts none and records nothing", async () => {
    const { itemId, n } = await newItem(hq)
    await toPlan(hq, itemId)
    expect(await beginStation(callOf("reviewer", issue(n)))).toBeNull()
    expect((await detailOf(hq, itemId)).attemptList.filter((a) => a.kind === "fix")).toHaveLength(0)
  })

  test("failStation finishes the running attempt failed with the station's name and the capped message", async () => {
    const { itemId, n } = await newItem(hq)
    await toPlan(hq, itemId)
    const record = await beginStation(callOf("implementer", issue(n), { attemptLimit: 3 }))
    await failStation(record, "boom ".repeat(300))
    const fix = (await detailOf(hq, itemId)).attemptList.at(-1)
    expect(fix).toMatchObject({ status: "finished", result: "failed" })
    expect(fix?.note?.startsWith("The implementer station failed: boom boom")).toBe(true)
    // "The implementer station failed: " is 32 characters; the message is cut at 500.
    expect(fix?.note?.length).toBe(32 + 500)
  })

  test("the contract carries a ci item when the item has a pull request check, and is capped at 8 items", async () => {
    const { contractFor } = await import("#lib/work/attempts.js")
    const withCi = contractFor(["one"], true)
    expect(withCi.map((c) => c.verifier.kind)).toEqual(["reviewer", "signal_recurrence", "ci"])
    expect(withCi.at(-1)?.text).toBe("All checks on the pull request pass")
    const many = contractFor(
      Array.from({ length: 20 }, (_, i) => `criterion ${i}`),
      true,
    )
    expect(many).toHaveLength(8)
    expect(many.slice(-2).map((c) => c.verifier.kind)).toEqual(["signal_recurrence", "ci"])
    expect(contractFor(["x".repeat(900), "   ", ""], false).map((c) => c.text.length)).toEqual([
      300,
      "No new signal like this in the verification window".length,
    ])
  })
})

describe("adoptOrStartAttempt", () => {
  const client = () => createHqClient({ baseUrl: "http://hq.test", apiKey: "k" })

  test("adopts the running attempt with this key and starts none (ok true, adopted true) and starts one when none runs (adopted false)", async () => {
    const { itemId, n } = await newItem(hq)
    const call = callOf("analyst", issue(n))
    const first = await adoptOrStartAttempt(client(), call, itemId)
    expect(first).toMatchObject({ ok: true, adopted: false })
    const again = await adoptOrStartAttempt(client(), call, itemId)
    expect(again).toEqual({
      ok: true,
      adopted: true,
      attemptId: first.ok ? first.attemptId : "",
    })
    expect((await detailOf(hq, itemId)).attemptList).toHaveLength(1)
  })

  test("answers ok false with hq_unreachable for a timeout after the inline retry, conflict_other_session for another session's running fix, conflict_limit for fixes at the limit with none running, error for a 400, and beginStation returns null for each", async () => {
    // hq_unreachable: every request times out.
    const { itemId, n } = await newItem(hq)
    await toPlan(hq, itemId)
    useRealHq(hq, () => "unreachable")
    expect(await adoptOrStartAttempt(client(), callOf("implementer", issue(n)), itemId)).toEqual({
      ok: false,
      reason: "hq_unreachable",
    })
    expect(await beginStation(callOf("implementer", issue(n)))).toBeNull()
    expect(recorderStats().unavailable).toBeGreaterThan(0)
    useRealHq(hq)

    // conflict_other_session: a running fix started by another session.
    const other = await newItem(hq)
    await toPlan(hq, other.itemId)
    await hq.client.startAttempt({
      itemId: other.itemId,
      kind: "fix",
      attemptLimit: 3,
      externalRef: "wrun_someone_else:call-9:implementer",
    })
    resetRecorderStats()
    const call = callOf("implementer", issue(other.n), { attemptLimit: 3 })
    expect(await adoptOrStartAttempt(client(), call, other.itemId)).toEqual({
      ok: false,
      reason: "conflict_other_session",
    })
    expect(await beginStation(call)).toBeNull()
    expect(recorderStats()).toMatchObject({ dropped: 1, conflicts: 1 })
    expect(log.warn).toHaveBeenCalledWith(
      "work_record_dropped",
      expect.objectContaining({ kind: "conflict" }),
    )
    expect(
      (await detailOf(hq, other.itemId)).attemptList.filter((a) => a.kind === "fix"),
    ).toHaveLength(1)

    // conflict_limit: three fixes finished failed, started with no limit sent; none runs.
    const full = await newItem(hq)
    await toPlan(hq, full.itemId)
    for (let i = 0; i < 3; i++) {
      await setupFix(hq, full.itemId)
    }
    resetRecorderStats()
    // hq stores no limit for this item, so the local decision falls back to the call's own
    // attemptLimit (3, used 3) and answers conflict_limit WITHOUT sending a start.
    const wire = useRealHq(hq)
    const limited = callOf("implementer", issue(full.n), { attemptLimit: 3 })
    expect(await adoptOrStartAttempt(client(), limited, full.itemId)).toEqual({
      ok: false,
      reason: "conflict_limit",
    })
    expect(wire.requests.filter((r) => r.startsWith("POST") && r.endsWith("/attempts"))).toEqual([])
    expect(await beginStation(limited)).toBeNull()
    expect(recorderStats().conflicts).toBeGreaterThan(0)

    // error: hq refuses the start with a 400 (an externalRef over 200 characters).
    const bad = await newItem(hq)
    await toPlan(hq, bad.itemId)
    const tooLong = callOf("implementer", issue(bad.n), { sessionId: "s".repeat(300) })
    expect(await adoptOrStartAttempt(client(), tooLong, bad.itemId)).toEqual({
      ok: false,
      reason: "error",
    })
    resetRecorderStats()
    expect(await beginStation(tooLong)).toBeNull()
    expect(recorderStats()).toMatchObject({ dropped: 1, rejected: 1 })
  })

  test("a CI-fix implementer run on an item in review starts a fix with reason retry_started and the attempt is recorded", async () => {
    const { itemId } = await newItem(hq)
    await toReview(hq, itemId, 7100)
    expect((await detailOf(hq, itemId)).state).toBe("review")
    const record = await beginStation(
      callOf("implementer", { kind: "ci_fix", pullNumber: 7100 }, { attemptLimit: 3 }),
    )
    expect(record).toMatchObject({ itemId, kind: "fix" })
    const after = await detailOf(hq, itemId)
    expect(after.state).toBe("attempt")
    expect(after.attemptList.filter((a) => a.kind === "fix")).toHaveLength(2)
    const reasons = (await eventsOf(hq, itemId)).map(
      (e) =>
        (e as { reason?: string }).reason ?? (e.detail as { reason?: string } | undefined)?.reason,
    )
    expect(reasons).toContain("retry_started")
  })

  test("a running attempt of the other kind: the station records nothing", async () => {
    const { itemId, n } = await newItem(hq)
    // The analyst's investigation of this very session is still running.
    const analyst = await beginStation(callOf("analyst", issue(n)))
    expect(analyst).not.toBeNull()
    resetRecorderStats()
    expect(
      await beginStation(callOf("implementer", issue(n), { callId: "call-2", attemptLimit: 3 })),
    ).toBeNull()
    expect(await beginStation(callOf("reviewer", issue(n), { callId: "call-3" }))).toBeNull()
    expect((await detailOf(hq, itemId)).attemptList).toHaveLength(1)
    expect(recorderStats().dropped).toBe(2)
  })

  test("a running fix of another session is not adopted and the drop is counted", async () => {
    const { itemId, n } = await newItem(hq)
    await toPlan(hq, itemId)
    const mine = await beginStation(
      callOf("implementer", issue(n), { sessionId: "wrun_A", attemptLimit: 3 }),
    )
    expect(mine).not.toBeNull()
    resetRecorderStats()
    const theirs = await beginStation(
      callOf("reviewer", issue(n), { sessionId: "wrun_B", callId: "call-2" }),
    )
    expect(theirs).toBeNull()
    expect(recorderStats()).toMatchObject({ dropped: 1, conflicts: 1 })
    // A session id that is only a prefix of the other's is not the same session (the colon).
    const longer = await newItem(hq)
    await toPlan(hq, longer.itemId)
    expect(
      await beginStation(
        callOf("implementer", issue(longer.n), { sessionId: "wrun_A2", attemptLimit: 3 }),
      ),
    ).not.toBeNull()
    resetRecorderStats()
    expect(
      await beginStation(callOf("reviewer", issue(longer.n), { sessionId: "wrun_A", callId: "c" })),
    ).toBeNull()
    expect(recorderStats().conflicts).toBe(1)
  })
})

describe("the attempt limit", () => {
  test("with attempts.used equal to the limit and no running fix, beginStation throws FatalError with the limit message; with a running fix it adopts it; any other CONFLICT is counted and does not throw", async () => {
    // Three failed fixes under limit 3: nothing runs and the budget is spent.
    const spent = await newItem(hq)
    await toPlan(hq, spent.itemId)
    await setupFix(hq, spent.itemId, { limit: 3 })
    await setupFix(hq, spent.itemId)
    await setupFix(hq, spent.itemId)
    const call = callOf("implementer", issue(spent.n), { attemptLimit: 3 })
    const thrown = await beginStation(call).catch((e: unknown) => e)
    expect(thrown).toBeInstanceOf(FatalError)
    expect((thrown as Error).message).toBe(ATTEMPT_LIMIT_MESSAGE)
    expect(ATTEMPT_LIMIT_MESSAGE).toBe(
      "The attempt limit for this item is reached; stop and say so",
    )
    expect((await detailOf(hq, spent.itemId)).attempts).toMatchObject({ used: 3, limit: 3 })

    // The analyst is not held to the fix limit, and a reviewer adopts nothing there.
    expect(await beginStation(callOf("reviewer", issue(spent.n)))).toBeNull()

    // At the limit with the third fix still running: the running fix is adopted.
    const running = await newItem(hq)
    await toPlan(hq, running.itemId)
    await setupFix(hq, running.itemId, { limit: 3 })
    await setupFix(hq, running.itemId)
    const third = await beginStation(callOf("implementer", issue(running.n), { attemptLimit: 3 }))
    expect(third).not.toBeNull()
    expect((await detailOf(hq, running.itemId)).attempts).toMatchObject({ used: 3, running: true })
    const adopted = await beginStation(callOf("implementer", issue(running.n), { attemptLimit: 3 }))
    expect(adopted).toEqual(third)

    // Any other CONFLICT (a fix from triage) is counted and does not throw.
    const triage = await newItem(hq)
    resetRecorderStats()
    expect(
      await beginStation(callOf("implementer", issue(triage.n), { attemptLimit: 3 })),
    ).toBeNull()
    expect(recorderStats().dropped).toBe(1)
  })

  test("another session's running fix at the limit still throws the limit error, and a running fix of THIS session is adopted", async () => {
    // The stored limit is 3, two fixes failed and a third, started by another session, runs:
    // used is 3, so the budget is spent and nothing here is adoptable by this session.
    const foreign = await newItem(hq)
    await toPlan(hq, foreign.itemId)
    await setupFix(hq, foreign.itemId, { limit: 3 })
    await setupFix(hq, foreign.itemId)
    await hq.client.startAttempt({
      itemId: foreign.itemId,
      kind: "fix",
      externalRef: "wrun_someone_else:call-9:implementer",
    })
    expect((await detailOf(hq, foreign.itemId)).attempts).toEqual({
      used: 3,
      limit: 3,
      running: true,
    })
    const thrown = await beginStation(
      callOf("implementer", issue(foreign.n), { attemptLimit: 3 }),
    ).catch((e: unknown) => e)
    expect(thrown).toBeInstanceOf(FatalError)
    expect((thrown as Error).message).toBe(ATTEMPT_LIMIT_MESSAGE)
    // The same rows with the running fix THIS session's: adopted, not thrown.
    const own = await newItem(hq)
    await toPlan(hq, own.itemId)
    await setupFix(hq, own.itemId, { limit: 3 })
    await setupFix(hq, own.itemId)
    const started = await hq.client.startAttempt({
      itemId: own.itemId,
      kind: "fix",
      externalRef: "wrun_session1:call-9:implementer",
    })
    const record = await beginStation(callOf("implementer", issue(own.n), { attemptLimit: 3 }))
    expect(record).toMatchObject({ attemptId: started.id })
  })

  test("limitReached follows the plan's rule on the rows alone, whatever else is active", () => {
    const attempt = (over: Partial<AttemptView>): AttemptView =>
      ({
        id: "a",
        kind: "fix",
        status: "finished",
        externalRef: null,
        ...over,
      }) as AttemptView
    const detail = (attemptList: AttemptView[], limit: number | null, used = 3) =>
      ({ attempts: { used, limit, running: false }, attemptList }) as WorkItemDetail
    const call = callOf("implementer", issue(1), { attemptLimit: 3 })
    const key = stationKey(call)
    // spent, nothing adoptable
    expect(limitReached(detail([], 3), call)).toBe(true)
    // below the limit, no stored limit, another station
    expect(limitReached(detail([], 3, 2), call)).toBe(false)
    expect(limitReached(detail([], null), call)).toBe(false)
    expect(limitReached(detail([], 3), callOf("analyst", issue(1)))).toBe(false)
    expect(limitReached(detail([], 3), callOf("reviewer", issue(1)))).toBe(false)
    // an attempt with this call's key, in any status: a replay
    expect(limitReached(detail([attempt({ externalRef: key })], 3), call)).toBe(false)
    // a running fix of this session, or of this ticket: adoptable
    const mine = attempt({ status: "running", externalRef: "wrun_session1:other:implementer" })
    expect(limitReached(detail([mine], 3), call)).toBe(false)
    const ticket = callOf("implementer", { kind: "ticket", ticketId: "t".repeat(32) })
    const claimed = attempt({ status: "running", externalRef: "t".repeat(32) })
    expect(limitReached(detail([claimed], 3), ticket)).toBe(false)
    // another session's running fix, a requested one, this session's running investigation, and a
    // session id that only starts like ours: none of them is adoptable, so the limit stands
    for (const other of [
      attempt({ status: "running", externalRef: "wrun_other:c:implementer" }),
      attempt({ status: "requested" }),
      attempt({ status: "running", kind: "investigate", externalRef: "wrun_session1:c:analyst" }),
      attempt({ status: "running", externalRef: "wrun_session10:c:implementer" }),
    ]) {
      expect(limitReached(detail([other], 3), call)).toBe(true)
    }
  })

  test("hq refuses a start the local read thought allowed, and the re-read says conflict_limit", async () => {
    // Three failed fixes under a stored limit of 3. The first read the step makes is stale (it
    // shows an untouched item), so the decision is "start"; hq answers 409 and the second read,
    // which is fresh, shows used 3 of 3 with none running.
    const { itemId, n } = await newItem(hq)
    await toPlan(hq, itemId)
    await setupFix(hq, itemId, { limit: 3 })
    await setupFix(hq, itemId)
    await setupFix(hq, itemId)
    const wire = useRealHq(hq)
    const real = createHqClient({ baseUrl: "http://hq.test", apiKey: "k" })
    let reads = 0
    const stale: HqClient = {
      ...real,
      getWorkItem: async (input) => {
        const detail = await real.getWorkItem(input)
        return reads++ === 0
          ? { ...detail, attemptList: [], attempts: { used: 0, limit: null, running: false } }
          : detail
      },
    }
    expect(await adoptOrStartAttempt(stale, callOf("implementer", issue(n)), itemId)).toEqual({
      ok: false,
      reason: "conflict_limit",
    })
    // hq itself was asked, once, and refused.
    expect(
      wire.requests.filter((r) => r.startsWith("POST") && r.endsWith("/attempts")),
    ).toHaveLength(1)
    expect((await detailOf(hq, itemId)).attemptList.filter((a) => a.kind === "fix")).toHaveLength(3)
  })

  test("a keyed attempt that already exists at the limit is returned, not refused (a replay of the third fix)", async () => {
    const { itemId, n } = await newItem(hq)
    await toPlan(hq, itemId)
    await setupFix(hq, itemId, { limit: 3 })
    await setupFix(hq, itemId)
    const call = callOf("implementer", issue(n), { attemptLimit: 3 })
    const third = await beginStation(call)
    const record = third as NonNullable<typeof third>
    await failStation(record, "died")
    // used is 3 and nothing runs, but this call's own attempt is in hq: replay answers it.
    expect(await beginStation(call)).toEqual(third)
  })
})

describe("recording never fails or retries a build", () => {
  test("with HQ_BASE_URL unset every step records nothing and nothing throws", async () => {
    vi.unstubAllEnvs()
    vi.stubEnv("HQ_BASE_URL", "")
    vi.stubEnv("HQ_AGENT_API_KEY", "")
    expect(await beginStation(callOf("analyst", issue(1)))).toBeNull()
    const record = { itemId: "i", attemptId: "a", kind: "fix" as const, key: "s:c:implementer" }
    await expect(
      endStation(record, summarizeStation("reviewer", { verdict: "approve" })),
    ).resolves.toBeUndefined()
    await expect(failStation(record, "x")).resolves.toBeUndefined()
    await expect(endStation(null, ANALYSIS)).resolves.toBeUndefined()
    await expect(failStation(null, "x")).resolves.toBeUndefined()
  })

  test("the pure helpers never throw on a malformed output", () => {
    for (const output of [
      undefined,
      null,
      7,
      "x",
      [],
      {},
      { verdict: 3, blocking_findings: "no" },
    ]) {
      for (const station of ["analyst", "implementer", "reviewer"] as const) {
        expect(() => summarizeStation(station, output)).not.toThrow()
      }
    }
  })
})
