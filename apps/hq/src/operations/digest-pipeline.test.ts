import { sql } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { seedWork } from "../../scripts/seed-work.mjs"
import { createHqHarness, type TestPerson } from "../app.test.helpers"
import {
  minutesAfter,
  resetWork,
  seedAttempt,
  seedItem,
  seedPullRequest,
} from "../data/work.test.helpers"
import { proposals, runs, spend, workItemEvents } from "../db/schema"
import type { WorkState } from "../work/machine"

const BASE = "http://localhost:3100"
const NOW = new Date("2026-11-17T12:00:00Z")
const HOUR = 3_600_000
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs)

interface Pipeline {
  opened: number
  resolved: number
  reopened: number
  stuckAttempts: number
  needsYou: {
    kind: string
    itemId: string
    displayId: string
    title: string
    reason: string
    since: string
  }[]
  needsYouTotal: number
  merged: {
    at: string
    displayId: string
    title: string
    pullRequestUrl: string
    repo: string
    number: number
    state: string
  }[]
  events: { at: string; displayId: string; text: string; result: string }[]
}
interface DigestJson {
  error: { code: string }
  summary: { tone: string; runsFinished: number; runsFailed: number; pendingProposals: number }
  pipeline: Pipeline | null
  [key: string]: unknown
}

// get_digest's pipeline over the real app on PGlite, with the clock fixed at 2026-11-17T12:00:00Z.
describe("get_digest pipeline (PGlite)", () => {
  let hq: Awaited<ReturnType<typeof createHqHarness>>
  let founder: TestPerson
  // The clock moves in one test (the seed walk writes at NOW, and a window excludes its own end).
  let clock = NOW

  beforeAll(async () => {
    hq = await createHqHarness({ founderEmails: ["founder@example.com"], now: () => clock })
    founder = await hq.signUp("founder@example.com")
  })
  afterAll(() => hq.close())
  beforeEach(async () => {
    clock = NOW
    await hq.db.delete(spend)
    await hq.db.delete(runs)
    await hq.db.delete(proposals)
    await resetWork(hq.db)
  })

  const digest = async (query = "") => {
    const res = await hq.app.request(`${BASE}/v1/digest${query}`, {
      headers: { origin: BASE, cookie: founder.cookie },
    })
    return { status: res.status, body: (await res.json()) as DigestJson }
  }
  const pipeline = async (query = ""): Promise<Pipeline> => {
    const res = await digest(query)
    expect(res.status).toBe(200)
    expect(res.body.pipeline).not.toBeNull()
    return res.body.pipeline as Pipeline
  }

  /** One history row, written straight to the table (the trigger forbids only update and delete). */
  const addEvent = (
    itemId: string,
    when: Date,
    to: WorkState,
    reason: string,
    from: WorkState | null = null,
  ) =>
    hq.db.insert(workItemEvents).values({
      id: crypto.randomUUID(),
      itemId,
      at: when,
      kind: "transition",
      fromState: from,
      toState: to,
      actorType: "system",
      actorId: "hq",
      reason,
      cycle: 1,
    })

  it("pipeline counts opened, resolved (done in the window) and reopened events in the window only", async () => {
    const opened = await seedItem(hq.db, { title: "Opened inside" })
    const openedBefore = await seedItem(hq.db, { title: "Opened before the window" })
    const openedAtUntil = await seedItem(hq.db, { title: "Opened at until" })
    await addEvent(opened.id, at(-2 * HOUR), "triage", "ingested", "signal")
    await addEvent(
      openedBefore.id,
      new Date("2026-11-15T23:59:59Z"),
      "triage",
      "ingested",
      "signal",
    )
    // The window is [since, until): the instant of `until` is outside, the instant of `since` inside.
    await addEvent(openedAtUntil.id, NOW, "triage", "ingested", "signal")
    const onSince = await seedItem(hq.db, { title: "Opened on since" })
    await addEvent(onSince.id, new Date("2026-11-16T00:00:00Z"), "triage", "ingested", "signal")

    const done = await seedItem(hq.db, { title: "Done inside", state: "done" })
    const doneBefore = await seedItem(hq.db, { title: "Done before", state: "done" })
    await addEvent(done.id, at(-3 * HOUR), "done", "window_passed", "verify")
    await addEvent(
      doneBefore.id,
      new Date("2026-11-10T12:00:00Z"),
      "done",
      "window_passed",
      "verify",
    )

    const reopened = await seedItem(hq.db, { title: "Reopened twice", state: "reopened" })
    const reopenedBefore = await seedItem(hq.db, { title: "Reopened before", state: "reopened" })
    await addEvent(reopened.id, at(-5 * HOUR), "reopened", "recurrence", "verify")
    await addEvent(reopened.id, at(-1 * HOUR), "reopened", "recurrence", "done")
    await addEvent(reopenedBefore.id, new Date("2026-11-12T00:00:00Z"), "reopened", "recurrence")

    const p = await pipeline()
    expect(p.opened).toBe(2)
    expect(p.resolved).toBe(1)
    // an item reopened twice is one reopened item, as the board counts it
    expect(p.reopened).toBe(1)
  })

  it("counts from rows: an item that moved to done by no event, and a plain move to triage, are not counted", async () => {
    // State alone is no source (a forced state has no event), and a retriage is not an opening.
    await seedItem(hq.db, { state: "done" })
    const retriaged = await seedItem(hq.db, { state: "triage" })
    await addEvent(retriaged.id, at(-HOUR), "triage", "retriaged", "reopened")
    const p = await pipeline()
    expect([p.opened, p.resolved, p.reopened]).toEqual([0, 0, 0])
    expect(p.events).toEqual([])
  })

  it("stuckAttempts counts running attempts whose lease passed", async () => {
    const item = await seedItem(hq.db, { state: "attempt" })
    await seedAttempt(hq.db, item.id, {
      number: 1,
      status: "running",
      result: null,
      leaseExpiresAt: at(-HOUR),
    })
    const live = await seedItem(hq.db, { state: "attempt" })
    await seedAttempt(hq.db, live.id, {
      number: 1,
      status: "running",
      result: null,
      leaseExpiresAt: at(HOUR),
    })
    const finished = await seedItem(hq.db, { state: "review" })
    await seedAttempt(hq.db, finished.id, {
      number: 1,
      status: "finished",
      result: "failed",
      leaseExpiresAt: at(-2 * HOUR),
    })
    const requested = await seedItem(hq.db, { state: "plan" })
    await seedAttempt(hq.db, requested.id, {
      number: 1,
      status: "requested",
      result: null,
      leaseExpiresAt: at(-2 * HOUR),
    })
    // the lease ended at this very instant: the machine reads that as stale (lease <= now)
    const edge = await seedItem(hq.db, { state: "attempt" })
    await seedAttempt(hq.db, edge.id, {
      number: 1,
      status: "running",
      result: null,
      leaseExpiresAt: NOW,
    })
    expect((await pipeline()).stuckAttempts).toBe(2)
  })

  it("a stopped or finished item's running attempt past its lease is not counted, as the board leaves it out", async () => {
    const stopped = await seedItem(hq.db, { state: "stopped" })
    await seedAttempt(hq.db, stopped.id, {
      number: 1,
      status: "running",
      result: null,
      leaseExpiresAt: at(-HOUR),
    })
    const done = await seedItem(hq.db, { state: "done" })
    await seedAttempt(hq.db, done.id, {
      number: 1,
      status: "running",
      result: null,
      leaseExpiresAt: at(-HOUR),
    })
    const result = await digest()
    expect(result.body.pipeline?.stuckAttempts).toBe(0)
    expect(result.body.pipeline?.needsYouTotal).toBe(0)
    expect(result.body.summary.tone).toBe("quiet")
    // the same attempt on an item in flight is counted
    const live = await seedItem(hq.db, { state: "attempt" })
    await seedAttempt(hq.db, live.id, {
      number: 1,
      status: "running",
      result: null,
      leaseExpiresAt: at(-HOUR),
    })
    expect((await pipeline()).stuckAttempts).toBe(1)
  })

  it("needsYou lists at most 5 oldest first while needsYouTotal counts all", async () => {
    const titles: string[] = []
    for (let i = 0; i < 7; i++) {
      const item = await seedItem(hq.db, { title: `Stuck ${i}`, state: "attempt" })
      titles.push(item.displayId)
      await seedAttempt(hq.db, item.id, {
        number: 1,
        status: "running",
        result: null,
        // item 0 has waited the longest... except the newest lease is item 0's: order is by lease
        leaseExpiresAt: at(-(i + 1) * 10 * 60_000),
      })
    }
    const p = await pipeline()
    expect(p.needsYouTotal).toBe(7)
    expect(p.needsYou).toHaveLength(5)
    // the oldest lease belongs to the last item made
    expect(p.needsYou.map((n) => n.title)).toEqual([
      "Stuck 6",
      "Stuck 5",
      "Stuck 4",
      "Stuck 3",
      "Stuck 2",
    ])
    const [first] = p.needsYou
    expect(first?.kind).toBe("stuck_attempt")
    expect(first?.displayId).toBe(titles[6])
    expect(first?.since).toBe(at(-70 * 60_000).toISOString())
    expect(first?.reason).toContain("has not reported")
    expect(p.stuckAttempts).toBe(7)
  })

  it("needsYou is what the board says: the same kinds, reasons and times as get_work_board", async () => {
    const item = await seedItem(hq.db, { title: "Needs you", state: "attempt" })
    await seedAttempt(hq.db, item.id, {
      number: 1,
      status: "running",
      result: null,
      leaseExpiresAt: at(-HOUR),
    })
    const res = await hq.app.request(`${BASE}/v1/work/board`, {
      headers: { origin: BASE, cookie: founder.cookie },
    })
    const board = (await res.json()) as {
      needsYou: {
        kind: string
        itemId: string
        displayId: string
        title: string
        reason: string
        since: string
      }[]
    }
    const p = await pipeline()
    expect(p.needsYou).toEqual(
      board.needsYou.map(({ kind, itemId, displayId, title, reason, since }) => ({
        kind,
        itemId,
        displayId,
        title,
        reason,
        since,
      })),
    )
  })

  it("merged lists merged pull requests newest first with the item's current state", async () => {
    const make = async (title: string, state: WorkState, number: number, mergedAt: Date | null) => {
      const item = await seedItem(hq.db, { title, state })
      await seedPullRequest(hq.db, item.id, {
        number,
        state: mergedAt ? "merged" : "open",
        mergedAt,
      })
      return item
    }
    const deploying = await make("Deploying", "deploy", 11, at(-10 * 60_000))
    const verifying = await make("Verifying", "verify", 12, at(-2 * HOUR))
    const verified = await make("Verified", "done", 13, at(-5 * HOUR))
    await make("Merged before the window", "done", 16, new Date("2026-11-10T00:00:00Z"))
    await make("Still open", "review", 17, null)
    await make("Merged at until", "deploy", 18, NOW)

    const p = await pipeline()
    expect(p.merged.map((m) => [m.displayId, m.title, m.state])).toEqual([
      [deploying.displayId, "Deploying", "merged"],
      [verifying.displayId, "Verifying", "verifying"],
      [verified.displayId, "Verified", "verified"],
    ])
    expect(p.merged[0]?.at).toBe(at(-10 * 60_000).toISOString())
    expect(p.merged[0]?.pullRequestUrl).toBe("https://github.com/acme/web/pull/11")
    // what a link check needs: the item's repo and the pull request's number
    expect([p.merged[0]?.repo, p.merged[0]?.number]).toEqual(["acme/web", 11])
  })

  it("a merged pull request reads 'reopened' only when a reopen event exists at or after its merge", async () => {
    const make = async (title: string, state: WorkState, number: number, mergedAt: Date) => {
      const item = await seedItem(hq.db, { title, state })
      await seedPullRequest(hq.db, item.id, { number, state: "merged", mergedAt })
      return item
    }
    const reopened = await make("Reopened", "reopened", 14, at(-6 * HOUR))
    await addEvent(reopened.id, at(-5 * HOUR), "reopened", "recurrence", "verify")
    const retriaged = await make("Back in triage", "triage", 15, at(-7 * HOUR))
    await addEvent(retriaged.id, at(-6 * HOUR), "reopened", "recurrence", "done")
    await addEvent(retriaged.id, at(-5 * HOUR), "triage", "retriaged", "reopened")
    // the instant of the merge counts as "at or after"
    const sameInstant = await make("Reopened at the merge", "reopened", 16, at(-4 * HOUR))
    await addEvent(sameInstant.id, at(-4 * HOUR), "reopened", "founder_reopen", "done")
    // a reopen BEFORE the merge is another cycle's story: it says nothing about this merge
    const earlier = await make("Reopened earlier", "verify", 17, at(-3 * HOUR))
    await addEvent(earlier.id, at(-8 * HOUR), "reopened", "recurrence", "done")

    const states = Object.fromEntries((await pipeline()).merged.map((m) => [m.title, m.state]))
    expect(states).toEqual({
      Reopened: "reopened",
      "Back in triage": "reopened",
      "Reopened at the merge": "reopened",
      "Reopened earlier": "verifying",
    })
  })

  it("a merged pull request on an item still in attempt, review or triage with no reopen event reads 'merged'", async () => {
    // Another pull request of the cycle can be the current one, so merging this one moves nothing:
    // the item stays where it was and nothing was reopened.
    const items: Record<string, WorkState> = {
      "In attempt": "attempt",
      "In review": "review",
      "In triage": "triage",
      "In plan": "plan",
      "In signal": "signal",
      "Stopped after the merge": "stopped",
      "Forced reopened, no event": "reopened",
    }
    let number = 30
    for (const [title, state] of Object.entries(items)) {
      const item = await seedItem(hq.db, { title, state })
      await seedPullRequest(hq.db, item.id, {
        number: number++,
        state: "merged",
        mergedAt: at(-HOUR),
      })
    }
    const merged = (await pipeline()).merged
    expect(merged).toHaveLength(Object.keys(items).length)
    for (const m of merged) expect(m.state, m.title).toBe("merged")
  })

  it("merged lists at most 10", async () => {
    for (let i = 0; i < 12; i++) {
      const item = await seedItem(hq.db, { title: `PR ${i}`, state: "done" })
      await seedPullRequest(hq.db, item.id, {
        number: 100 + i,
        state: "merged",
        mergedAt: at(-(i + 1) * 60_000),
      })
    }
    const p = await pipeline()
    expect(p.merged).toHaveLength(10)
    expect(p.merged[0]?.title).toBe("PR 0")
    expect(p.merged[9]?.title).toBe("PR 9")
  })

  it("a merged pull request url is rebuilt from the item's repo, never taken from the row", async () => {
    const item = await seedItem(hq.db, { title: "Hostile url", state: "done", repo: "acme/web" })
    const pr = await seedPullRequest(hq.db, item.id, {
      number: 21,
      state: "merged",
      mergedAt: at(-HOUR),
    })
    await hq.db.execute(
      sql`update "hq"."pull_requests" set url = 'https://evil.example/phish' where id = ${pr.id}`,
    )
    expect((await pipeline()).merged[0]?.pullRequestUrl).toBe("https://github.com/acme/web/pull/21")
  })

  it("events name opened, merged, reopened, verified and stopped, newest first, capped at 30, and skip every other move", async () => {
    const item = await seedItem(hq.db, { title: "<b>Hostile</b> [x](https://evil.example)" })
    await addEvent(item.id, at(-9 * HOUR), "triage", "ingested", "signal")
    await addEvent(item.id, at(-8 * HOUR), "plan", "investigation_started", "triage")
    await addEvent(item.id, at(-7 * HOUR), "deploy", "pull_request_merged", "review")
    await addEvent(item.id, at(-6 * HOUR), "verify", "deploy_grace_elapsed", "deploy")
    await addEvent(item.id, at(-5 * HOUR), "reopened", "recurrence", "verify")
    await addEvent(item.id, at(-4 * HOUR), "triage", "retriaged", "reopened")
    await addEvent(item.id, at(-3 * HOUR), "done", "window_passed", "verify")
    await addEvent(item.id, at(-2 * HOUR), "stopped", "stopped", "triage")
    const p = await pipeline()
    expect(p.events.map((e) => e.result)).toEqual([
      "stopped",
      "verified",
      "reopened",
      "merged",
      "opened",
    ])
    expect(p.events[0]).toEqual({
      at: at(-2 * HOUR).toISOString(),
      displayId: item.displayId,
      text: "<b>Hostile</b> [x](https://evil.example)",
      result: "stopped",
    })
  })

  it("events keep the newest 30 of the window and count nothing outside it", async () => {
    const item = await seedItem(hq.db, { title: "Many" })
    for (let i = 0; i < 35; i++) {
      await addEvent(item.id, minutesAfter(at(-20 * HOUR), i), "reopened", "recurrence", "done")
    }
    await addEvent(item.id, new Date("2026-11-01T00:00:00Z"), "reopened", "recurrence", "done")
    const p = await pipeline()
    expect(p.events).toHaveLength(30)
    expect(p.events[0]?.at).toBe(minutesAfter(at(-20 * HOUR), 34).toISOString())
    expect(p.reopened).toBe(1)
  })

  it("tone is attention with one stuck attempt", async () => {
    const item = await seedItem(hq.db, { state: "attempt" })
    await seedAttempt(hq.db, item.id, {
      number: 1,
      status: "running",
      result: null,
      leaseExpiresAt: at(-HOUR),
    })
    const stuck = await digest()
    expect(stuck.body.summary.tone).toBe("attention")
    expect(stuck.body.pipeline?.stuckAttempts).toBe(1)
    // no failed run and no stuck run: the attempt alone moved the tone
    expect(stuck.body.summary.runsFailed).toBe(0)
    expect((stuck.body.health as { stuckRuns: number }).stuckRuns).toBe(0)
  })

  it("tone stays quiet with no stuck attempt, no failed run and no stuck run", async () => {
    expect((await digest()).body.summary.tone).toBe("quiet")
  })

  it("an empty pipeline is an object of zeros and empty lists, not null", async () => {
    expect(await pipeline()).toEqual({
      opened: 0,
      resolved: 0,
      reopened: 0,
      stuckAttempts: 0,
      needsYou: [],
      needsYouTotal: 0,
      merged: [],
      events: [],
    })
  })

  it("an explicit since narrows the pipeline's window too", async () => {
    const item = await seedItem(hq.db, { title: "Early" })
    await addEvent(item.id, at(-20 * HOUR), "triage", "ingested", "signal")
    expect((await pipeline()).opened).toBe(1)
    expect((await pipeline(`?since=${at(-HOUR).toISOString()}`)).opened).toBe(0)
  })

  it("after the seed walk the pipeline agrees with the board and with the real sweep: only the item the sweep closed is resolved", async () => {
    const seeded = await seedWork({
      baseUrl: BASE,
      cookie: founder.cookie,
      fetch: (input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers)
        if (!headers.has("cookie")) headers.set("cookie", founder.cookie)
        if (!headers.has("origin")) headers.set("origin", BASE)
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url
        return Promise.resolve(hq.app.request(url, { ...init, headers }))
      },
    })
    expect(seeded.built.length).toBe(10)
    clock = at(60_000)
    const res = await hq.app.request(`${BASE}/v1/work/board`, {
      headers: { origin: BASE, cookie: founder.cookie },
    })
    const board = (await res.json()) as {
      stats: { needsYou: number }
      needsYou: { displayId: string }[]
    }
    const p = await pipeline("?since=2026-11-10T00:00:00Z")
    expect(p.opened).toBe(10)
    expect(p.needsYouTotal).toBe(board.stats.needsYou)
    expect(p.needsYou.map((n) => n.displayId)).toEqual(
      board.needsYou.slice(0, 5).map((n) => n.displayId),
    )
    // one item is done (the sweep closed its window), one verifying is not counted as verified
    expect(p.resolved).toBe(1)
    expect(p.reopened).toBe(1)
    expect(p.events.filter((e) => e.result === "verified")).toHaveLength(1)
    expect(p.merged.length).toBe(4)
    expect(p.merged.map((m) => m.state).sort()).toEqual(
      ["merged", "reopened", "verified", "verifying"].sort(),
    )
  })
})

// An hq deployed before step 05 has no work tables: the Digest must keep working.
describe("get_digest without the work tables (PGlite)", () => {
  it("with the work tables dropped, get_digest answers 200 with pipeline null and every Phase 3 field intact", async () => {
    const hq = await createHqHarness({ founderEmails: ["founder@example.com"], now: () => NOW })
    try {
      const founder = await hq.signUp("founder@example.com")
      const digest = async () => {
        const res = await hq.app.request(`${BASE}/v1/digest`, {
          headers: { origin: BASE, cookie: founder.cookie },
        })
        return { status: res.status, body: (await res.json()) as DigestJson }
      }
      const before = await digest()
      expect(before.status).toBe(200)
      expect(before.body.pipeline).not.toBeNull()
      for (const table of [
        "work_item_events",
        "verification_windows",
        "merge_approvals",
        "agent_questions",
        "contract_items",
        "pull_requests",
        "attempts",
        "signals",
        "work_items",
      ]) {
        await hq.db.execute(sql.raw(`drop table "hq"."${table}" cascade`))
      }
      const after = await digest()
      expect(after.status).toBe(200)
      expect(after.body.pipeline).toBeNull()
      const { pipeline: _was, ...restBefore } = before.body
      const { pipeline: _is, ...restAfter } = after.body
      expect(restAfter).toEqual(restBefore)
      expect(Object.keys(after.body).sort()).toEqual([
        "decisions",
        "deploys",
        "events",
        "health",
        "hours",
        "pipeline",
        "productHealth",
        "since",
        "spend",
        "summary",
        "until",
      ])
      // and the tone still reads from runs alone
      expect(after.body.summary.tone).toBe("quiet")
    } finally {
      await hq.close()
    }
  })
})
