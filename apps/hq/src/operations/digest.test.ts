import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { createHqHarness, type TestPerson } from "../app.test.helpers"
import { type Runner, type RunOutcome, proposals, runs, spend } from "../db/schema"

const BASE = "http://localhost:3100"
const NOW = new Date("2026-11-17T12:00:00Z")
const MIN = 60_000
const HOUR = 60 * MIN
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs)

interface DigestJson {
  error: { code: string }
  since: string
  until: string
  hours: number
  summary: { tone: string; runsFinished: number; runsFailed: number; pendingProposals: number }
  decisions: {
    proposalId: string
    entryKind: string
    title: string
    reason: string
    createdAt: string
  }[]
  events: {
    at: string
    kind: string
    ref: string
    text: string
    result: string
    costUsd: number | null
  }[]
  spend: {
    totalUsd: number
    estimatedUsd: number
    bySource: { source: string; amountUsd: number }[]
  }
  health: { stuckRuns: number; lastRunStartedAt: string | null }
  productHealth: unknown
  deploys: unknown
}

// get_digest over the real app on PGlite, with the clock fixed at 2026-11-17T12:00:00Z.
describe("get_digest (PGlite)", () => {
  let hq: Awaited<ReturnType<typeof createHqHarness>>
  let founder: TestPerson
  let stranger: TestPerson

  beforeAll(async () => {
    hq = await createHqHarness({ founderEmails: ["founder@example.com"], now: () => NOW })
    founder = await hq.signUp("founder@example.com")
    stranger = await hq.signUp("stranger@example.com")
  })
  afterAll(() => hq.close())
  beforeEach(async () => {
    await hq.db.delete(spend)
    await hq.db.delete(runs)
    await hq.db.delete(proposals)
  })

  const digest = async (query = "", as: { key: string } | { cookie: string } = founder) => {
    const headers: Record<string, string> = { origin: BASE }
    if ("key" in as) headers["x-api-key"] = as.key
    else headers.cookie = as.cookie
    const res = await hq.app.request(`${BASE}/v1/digest${query}`, { headers })
    return { status: res.status, body: (await res.json()) as DigestJson }
  }
  const ok = async (query = "") => {
    const res = await digest(query)
    expect(res.status).toBe(200)
    return res.body
  }

  let seq = 0
  const addRun = (r: {
    runner: Runner
    startedAt: Date
    endedAt?: Date
    outcome?: RunOutcome
    task?: string
    id?: string
  }) => {
    const id = r.id ?? `run-${++seq}`
    return hq.db
      .insert(runs)
      .values({
        id,
        task: r.task ?? `task ${id}`,
        trigger: "test",
        runner: r.runner,
        startedAt: r.startedAt,
        endedAt: r.endedAt ?? null,
        outcome: r.outcome ?? null,
      })
      .then(() => id)
  }
  const addProposal = (p: {
    id?: string
    status?: "pending" | "approved" | "rejected"
    createdAt: Date
    decidedAt?: Date
    title?: string
    kind?: "fact" | "decision"
  }) => {
    const id = p.id ?? `prop-${++seq}`
    return hq.db
      .insert(proposals)
      .values({
        id,
        kind: p.kind ?? "fact",
        slug: id,
        title: p.title ?? `Title ${id}`,
        body: { text: "body" },
        reason: `Reason ${id}`,
        status: p.status ?? "pending",
        proposedByType: "agent",
        proposedById: "agent-1",
        decidedAt: p.decidedAt ?? null,
        createdAt: p.createdAt,
      })
      .then(() => id)
  }
  const addSpend = (s: {
    day: string
    source: "eve" | "build" | "box"
    amount: string
    estimated?: boolean
    runId?: string
  }) =>
    hq.db.insert(spend).values({
      id: `spend-${++seq}`,
      runId: s.runId ?? null,
      day: s.day,
      source: s.source,
      amountUsd: s.amount,
      model: "haiku",
      estimated: s.estimated ?? false,
      createdAt: NOW,
    })

  it("defaults since to the start of hq's previous UTC day (2026-11-16T00:00:00Z) and hours to 36", async () => {
    const body = await ok()
    expect(body.since).toBe("2026-11-16T00:00:00.000Z")
    expect(body.until).toBe("2026-11-17T12:00:00.000Z")
    expect(body.hours).toBe(36)
  })

  it("an explicit since sets the window and hours rounds", async () => {
    const body = await ok("?since=2026-11-17T06:20:00Z")
    expect(body.since).toBe("2026-11-17T06:20:00.000Z")
    expect(body.hours).toBe(6)
  })

  it("clamps a since older than 7 days and refuses one in the future", async () => {
    const clamped = await ok("?since=2026-10-01T00:00:00Z")
    expect(clamped.since).toBe("2026-11-10T12:00:00.000Z")
    expect(clamped.hours).toBe(168)
    const future = await digest("?since=2026-11-17T12:00:01Z")
    expect(future.status).toBe(400)
    expect(future.body.error.code).toBe("BAD_REQUEST")
    const nonsense = await digest("?since=yesterday")
    expect(nonsense.status).toBe(400)
    expect(nonsense.body.error.code).toBe("BAD_REQUEST")
  })

  it("counts runs finished and failed inside the window only (a run that ended before since, or has not ended, is not finished)", async () => {
    const since = at(-36 * HOUR) // 2026-11-16T00:00:00Z
    await addRun({
      runner: "eve",
      startedAt: at(-30 * HOUR),
      endedAt: at(-29 * HOUR),
      outcome: "failed",
    })
    await addRun({
      runner: "sandbox",
      startedAt: at(-20 * HOUR),
      endedAt: at(-19 * HOUR),
      outcome: "succeeded",
    })
    // Ended exactly at since: inside [since, until).
    await addRun({ runner: "eve", startedAt: at(-40 * HOUR), endedAt: since, outcome: "stopped" })
    // Ended before since: outside.
    await addRun({
      runner: "eve",
      startedAt: at(-50 * HOUR),
      endedAt: at(-37 * HOUR),
      outcome: "failed",
    })
    // Not ended: not finished.
    await addRun({ runner: "eve", startedAt: at(-2 * HOUR) })
    // Ended exactly at until: the window is half open.
    await addRun({ runner: "eve", startedAt: at(-HOUR), endedAt: NOW, outcome: "failed" })
    const body = await ok()
    expect(body.summary.runsFinished).toBe(3)
    expect(body.summary.runsFailed).toBe(1)
  })

  it("a box run never counts as finished or failed, whatever endedAt and outcome say", async () => {
    await addRun({
      runner: "box",
      startedAt: at(-3 * HOUR),
      endedAt: at(-2 * HOUR),
      outcome: "failed",
    })
    const body = await ok()
    expect(body.summary).toMatchObject({ runsFinished: 0, runsFailed: 0, tone: "quiet" })
  })

  it("tone is quiet with no failed or stuck run and attention with one failed run", async () => {
    expect((await ok()).summary.tone).toBe("quiet")
    await addRun({
      runner: "eve",
      startedAt: at(-3 * HOUR),
      endedAt: at(-2 * HOUR),
      outcome: "succeeded",
    })
    expect((await ok()).summary.tone).toBe("quiet")
    await addRun({
      runner: "eve",
      startedAt: at(-3 * HOUR),
      endedAt: at(-2 * HOUR),
      outcome: "failed",
    })
    expect((await ok()).summary.tone).toBe("attention")
  })

  it("tone is attention for a stuck run", async () => {
    await addRun({ runner: "sandbox", startedAt: at(-2 * HOUR) })
    const body = await ok()
    expect(body.health.stuckRuns).toBe(1)
    expect(body.summary.tone).toBe("attention")
  })

  it("stuckRuns counts unfinished eve and sandbox runs older than 60 minutes and never box runs", async () => {
    await addRun({ runner: "eve", startedAt: at(-61 * MIN) })
    await addRun({ runner: "sandbox", startedAt: at(-3 * 24 * HOUR) }) // older than the window
    await addRun({ runner: "eve", startedAt: at(-60 * MIN) }) // exactly 60: not more than
    await addRun({ runner: "eve", startedAt: at(-59 * MIN) })
    await addRun({ runner: "box", startedAt: at(-5 * 24 * HOUR) })
    await addRun({ runner: "box", startedAt: at(-2 * HOUR) })
    await addRun({
      runner: "eve",
      startedAt: at(-5 * HOUR),
      endedAt: at(-4 * HOUR),
      outcome: "succeeded",
    })
    const body = await ok()
    expect(body.health.stuckRuns).toBe(2)
  })

  it("health.lastRunStartedAt is the newest start of any run, or null", async () => {
    expect((await ok()).health.lastRunStartedAt).toBeNull()
    await addRun({ runner: "eve", startedAt: at(-5 * HOUR) })
    await addRun({ runner: "box", startedAt: at(-3 * HOUR) })
    expect((await ok()).health.lastRunStartedAt).toBe(at(-3 * HOUR).toISOString())
  })

  it("decisions lists at most 5 pending proposals oldest first while pendingProposals counts all", async () => {
    for (let i = 0; i < 7; i++) {
      // Some older than the window: pending is pending whenever it was proposed.
      await addProposal({ id: `p${i}`, createdAt: at(-(60 - i * 10) * HOUR), kind: "decision" })
    }
    await addProposal({
      id: "done",
      status: "approved",
      createdAt: at(-5 * HOUR),
      decidedAt: at(-HOUR),
    })
    const body = await ok()
    expect(body.summary.pendingProposals).toBe(7)
    expect(body.decisions.map((d) => d.proposalId)).toEqual(["p0", "p1", "p2", "p3", "p4"])
    expect(body.decisions[0]).toEqual({
      proposalId: "p0",
      entryKind: "decision",
      title: "Title p0",
      reason: "Reason p0",
      createdAt: at(-60 * HOUR).toISOString(),
    })
  })

  it("events are newest first, capped at 30, one entry per run and per proposal state change", async () => {
    for (let i = 0; i < 40; i++) {
      await addProposal({ id: `cap${String(i).padStart(2, "0")}`, createdAt: at(-(i + 1) * MIN) })
    }
    const body = await ok()
    expect(body.events).toHaveLength(30)
    expect(body.events[0]?.ref).toBe("cap00")
    expect(body.events[29]?.ref).toBe("cap29")
    const times = body.events.map((e) => e.at)
    expect(times).toEqual([...times].sort().reverse())
  })

  it("more than 30 mixed runs and proposals: the newest 30 of the union, newest first", async () => {
    // Minutes ago: runs on even minutes, proposals on odd ones, 20 of each (40 events).
    for (let i = 1; i <= 40; i++) {
      if (i % 2 === 0) {
        await addRun({ id: `mix-r${i}`, runner: "eve", startedAt: at(-i * MIN) })
      } else {
        await addProposal({ id: `mix-p${i}`, createdAt: at(-i * MIN) })
      }
    }
    const body = await ok()
    expect(body.events).toHaveLength(30)
    expect(body.events.map((e) => e.at)).toEqual(
      Array.from({ length: 30 }, (_, k) => at(-(k + 1) * MIN).toISOString()),
    )
    expect(body.events.filter((e) => e.kind === "run")).toHaveLength(15)
    expect(body.events.filter((e) => e.kind === "proposal")).toHaveLength(15)
  })

  it("an event per run and per proposal state change, with its text, result and cost", async () => {
    const finished = await addRun({
      id: "r-done",
      runner: "eve",
      task: "answer a question",
      startedAt: at(-5 * HOUR),
      endedAt: at(-4 * HOUR),
      outcome: "failed",
    })
    await addRun({
      id: "r-open",
      runner: "sandbox",
      task: "build a thing",
      startedAt: at(-3 * HOUR),
    })
    await addSpend({ day: "2026-11-17", source: "build", amount: "0.4000", runId: finished })
    await addSpend({ day: "2026-11-17", source: "eve", amount: "0.0123", runId: finished })
    // Proposed and decided in the window: two events.
    await addProposal({
      id: "pa",
      status: "approved",
      title: "Both",
      createdAt: at(-10 * HOUR),
      decidedAt: at(-9 * HOUR),
    })
    // Proposed before the window, rejected in it: one event.
    await addProposal({
      id: "pb",
      status: "rejected",
      title: "Late",
      createdAt: at(-60 * HOUR),
      decidedAt: at(-8 * HOUR),
    })
    // Proposed before the window, still pending: none.
    await addProposal({ id: "pc", createdAt: at(-60 * HOUR) })
    const body = await ok()
    expect(body.events).toEqual([
      {
        at: at(-3 * HOUR).toISOString(),
        kind: "run",
        ref: "r-open",
        text: "build a thing",
        result: "started",
        costUsd: 0,
      },
      {
        at: at(-4 * HOUR).toISOString(),
        kind: "run",
        ref: "r-done",
        text: "answer a question",
        result: "failed",
        costUsd: 0.4123,
      },
      {
        at: at(-8 * HOUR).toISOString(),
        kind: "proposal",
        ref: "pb",
        text: "Late",
        result: "rejected",
        costUsd: null,
      },
      {
        at: at(-9 * HOUR).toISOString(),
        kind: "proposal",
        ref: "pa",
        text: "Both",
        result: "approved",
        costUsd: null,
      },
      {
        at: at(-10 * HOUR).toISOString(),
        kind: "proposal",
        ref: "pa",
        text: "Both",
        result: "proposed",
        costUsd: null,
      },
    ])
  })

  it("a run that started before the window and ended inside it appears once, at its end", async () => {
    await addRun({
      id: "r-span",
      runner: "eve",
      startedAt: at(-40 * HOUR),
      endedAt: at(-2 * HOUR),
      outcome: "succeeded",
    })
    await addRun({
      id: "r-before",
      runner: "eve",
      startedAt: at(-50 * HOUR),
      endedAt: at(-40 * HOUR),
      outcome: "failed",
    })
    const body = await ok()
    expect(body.events.map((e) => [e.ref, e.at, e.result])).toEqual([
      ["r-span", at(-2 * HOUR).toISOString(), "succeeded"],
    ])
  })

  it("a box run is only ever 'started', at its start, and only when it started in the window", async () => {
    await addRun({
      id: "b-in",
      runner: "box",
      startedAt: at(-6 * HOUR),
      endedAt: at(-5 * HOUR),
      outcome: "failed",
    })
    await addRun({
      id: "b-old",
      runner: "box",
      startedAt: at(-50 * HOUR),
      endedAt: at(-2 * HOUR),
      outcome: "succeeded",
    })
    const body = await ok()
    expect(body.events.map((e) => [e.ref, e.at, e.result])).toEqual([
      ["b-in", at(-6 * HOUR).toISOString(), "started"],
    ])
  })

  it("spend sums the window's days by source and reports the estimated part", async () => {
    await addSpend({ day: "2026-11-15", source: "eve", amount: "9.0000" }) // before since's day
    await addSpend({ day: "2026-11-16", source: "eve", amount: "1.5000" })
    await addSpend({ day: "2026-11-16", source: "build", amount: "2.0000", estimated: true })
    await addSpend({ day: "2026-11-17", source: "eve", amount: "0.2500" })
    await addSpend({ day: "2026-11-18", source: "box", amount: "7.0000" }) // after until's day
    const body = await ok()
    expect(body.spend).toEqual({
      totalUsd: 3.75,
      estimatedUsd: 2,
      bySource: [
        { source: "build", amountUsd: 2 },
        { source: "eve", amountUsd: 1.75 },
      ],
    })
  })

  it("spend of an empty window is zero with no sources", async () => {
    expect((await ok()).spend).toEqual({ totalUsd: 0, estimatedUsd: 0, bySource: [] })
  })

  it("productHealth and deploys are { connected: false }", async () => {
    const body = await ok()
    expect(body.productHealth).toEqual({ connected: false })
    expect(body.deploys).toEqual({ connected: false })
  })

  it("needs hq_run, hq_proposal and hq_spend read: a key without hq_spend:read gets 403", async () => {
    const all = { hq_run: ["read"], hq_proposal: ["read"], hq_spend: ["read"] }
    const good = await digest("", { key: await hq.keyFor(founder, all) })
    expect(good.status).toBe(200)
    for (const missing of Object.keys(all)) {
      const permissions = Object.fromEntries(Object.entries(all).filter(([k]) => k !== missing))
      const res = await digest("", { key: await hq.keyFor(founder, permissions) })
      expect(res.status, `without ${missing}`).toBe(403)
      expect(res.body.error.code).toBe("FORBIDDEN")
    }
    // A key that only records spend may not read the digest either.
    const record = await digest("", { key: await hq.keyFor(founder, { hq_spend: ["record"] }) })
    expect(record.status).toBe(403)
    // Nor may a signed-in account that is not a founder.
    expect((await digest("", stranger)).status).toBe(403)
    expect((await digest("", { cookie: "" })).status).toBe(401)
  })

  it("is in OpenAPI, llms.txt and MCP", async () => {
    const doc = (await (await hq.app.request(`${BASE}/openapi.json`)).json()) as {
      paths: Record<string, Record<string, { operationId?: string }>>
    }
    expect(doc.paths["/v1/digest"]?.get).toBeDefined()
    expect(await (await hq.app.request(`${BASE}/llms.txt`)).text()).toContain("get_digest")
    const client = new Client({ name: "test", version: "1.0.0" })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
        fetch: async (url, init) => {
          const headers = new Headers(init?.headers)
          headers.set("cookie", founder.cookie)
          headers.set("origin", BASE)
          return hq.app.request(String(url), { ...init, headers })
        },
      }),
    )
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toContain("get_digest")
    await client.close()
  })
})
