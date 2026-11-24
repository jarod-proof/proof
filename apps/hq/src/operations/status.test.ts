import { sql } from "drizzle-orm"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { createHqHarness, type TestPerson } from "../app.test.helpers"
import { resetWork, seedItem, seedPullRequest } from "../data/work.test.helpers"
import {
  agentQuestions,
  mergeApprovals,
  type Runner,
  type RunOutcome,
  proposals,
  runs,
  spend,
} from "../db/schema"

const BASE = "http://localhost:3100"
const NOW = new Date("2026-11-17T12:00:00Z")
const HOUR = 3_600_000
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs)

interface StatusJson {
  error: { code: string }
  now: string
  pendingProposals: number
  runners: { runner: string; lastStartedAt: string | null; lastOutcome: string | null }[]
  allowance: Record<string, unknown>
  work: {
    inFlight: number
    needsYou: number
    pendingMergeApprovals: number
    openQuestions: number
  } | null
}

// get_factory_status over the real app on PGlite, with the clock fixed at 2026-11-17T12:00:00Z.
describe("get_factory_status (PGlite)", () => {
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

  const status = async (as: { key: string } | { cookie: string } = founder) => {
    const headers: Record<string, string> = { origin: BASE }
    if ("key" in as) headers["x-api-key"] = as.key
    else headers.cookie = as.cookie
    const res = await hq.app.request(`${BASE}/v1/factory/status`, { headers })
    return { status: res.status, body: (await res.json()) as StatusJson }
  }
  const ok = async () => {
    const res = await status()
    expect(res.status).toBe(200)
    return res.body
  }

  let seq = 0
  const addRun = (r: { runner: Runner; startedAt: Date; endedAt?: Date; outcome?: RunOutcome }) =>
    hq.db.insert(runs).values({
      id: `run-${++seq}`,
      task: "task",
      trigger: "test",
      runner: r.runner,
      startedAt: r.startedAt,
      endedAt: r.endedAt ?? null,
      outcome: r.outcome ?? null,
    })
  const addProposal = (s: "pending" | "approved" | "rejected") =>
    hq.db.insert(proposals).values({
      id: `prop-${++seq}`,
      kind: "fact",
      slug: `slug-${seq}`,
      title: "Title",
      body: { text: "body" },
      reason: "Reason",
      status: s,
      proposedByType: "agent",
      proposedById: "agent-1",
      decidedAt: s === "pending" ? null : NOW,
      createdAt: NOW,
    })

  it("counts pending proposals; decided ones do not count", async () => {
    expect((await ok()).pendingProposals).toBe(0)
    await addProposal("pending")
    await addProposal("pending")
    await addProposal("approved")
    await addProposal("rejected")
    expect((await ok()).pendingProposals).toBe(2)
  })

  it("reports eve, sandbox and box once each, in RUNNERS order, even with no runs", async () => {
    const body = await ok()
    expect(body.now).toBe("2026-11-17T12:00:00.000Z")
    expect(body.runners).toEqual([
      { runner: "eve", lastStartedAt: null, lastOutcome: null },
      { runner: "sandbox", lastStartedAt: null, lastOutcome: null },
      { runner: "box", lastStartedAt: null, lastOutcome: null },
    ])
  })

  it("lastStartedAt and lastOutcome are the newest run's", async () => {
    await addRun({
      runner: "eve",
      startedAt: at(-5 * HOUR),
      endedAt: at(-4 * HOUR),
      outcome: "failed",
    })
    await addRun({
      runner: "eve",
      startedAt: at(-2 * HOUR),
      endedAt: at(-HOUR),
      outcome: "succeeded",
    })
    await addRun({ runner: "sandbox", startedAt: at(-3 * HOUR) })
    const body = await ok()
    expect(body.runners[0]).toEqual({
      runner: "eve",
      lastStartedAt: "2026-11-17T10:00:00.000Z",
      lastOutcome: "succeeded",
    })
    // The newest sandbox run is still open: no outcome yet.
    expect(body.runners[1]).toEqual({
      runner: "sandbox",
      lastStartedAt: "2026-11-17T09:00:00.000Z",
      lastOutcome: null,
    })
  })

  it("a runner entry has exactly the keys runner, lastStartedAt, lastOutcome", async () => {
    await addRun({ runner: "eve", startedAt: at(-HOUR) })
    await addRun({ runner: "box", startedAt: at(-HOUR) })
    const body = await ok()
    expect(Object.keys(body).sort()).toEqual([
      "allowance",
      "now",
      "pendingProposals",
      "runners",
      "work",
    ])
    for (const r of body.runners) {
      expect(Object.keys(r).sort()).toEqual(["lastOutcome", "lastStartedAt", "runner"])
    }
  })

  it("a box run is only ever started: its outcome is never reported, even if one was set", async () => {
    await addRun({
      runner: "box",
      startedAt: at(-2 * HOUR),
      endedAt: at(-HOUR),
      outcome: "failed",
    })
    const box = (await ok()).runners[2]
    expect(box).toEqual({
      runner: "box",
      lastStartedAt: "2026-11-17T10:00:00.000Z",
      lastOutcome: null,
    })
  })

  it("the allowance equals get_spend_allowance's reply", async () => {
    await hq.db.insert(spend).values({
      id: "spend-a",
      runId: null,
      day: "2026-11-17",
      source: "eve",
      amountUsd: "3.8000",
      model: "haiku",
      estimated: false,
      createdAt: NOW,
    })
    const expected = await hq.call(founder, "GET", "/v1/spend/allowance")
    expect(expected.status).toBe(200)
    const body = await ok()
    expect(body.allowance).toEqual(expected.body)
    expect(body.allowance).toEqual({
      day: "2026-11-17",
      spentUsd: 3.8,
      reservedUsd: 0,
      capUsd: 10,
      grantedUsd: 0,
      remainingUsd: 6.2,
    })
  })

  it("get_factory_status.work counts in-flight, needsYou, pendingMergeApprovals and openQuestions and still has every Phase 3 field", async () => {
    await resetWork(hq.db)
    expect((await ok()).work).toEqual({
      inFlight: 0,
      needsYou: 0,
      pendingMergeApprovals: 0,
      openQuestions: 0,
    })
    const sha = "a".repeat(40)
    // A: in review with a pending merge approval AND an open question (one card, two needs)
    const a = await seedItem(hq.db, { state: "review", title: "A" })
    const pr = await seedPullRequest(hq.db, a.id, { state: "open" })
    await hq.db.insert(mergeApprovals).values({
      id: crypto.randomUUID(),
      itemId: a.id,
      pullRequestId: pr.id,
      headSha: sha,
      status: "pending",
      requestedAt: NOW,
    })
    const question = (itemId: string, status: "open" | "withdrawn" = "open") =>
      hq.db.insert(agentQuestions).values({
        id: crypto.randomUUID(),
        itemId,
        prompt: "Which?",
        options: [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
        ],
        status,
        createdAt: NOW,
      })
    await question(a.id)
    // B: in plan with an open question
    const b = await seedItem(hq.db, { state: "plan", title: "B" })
    await question(b.id)
    // C: nothing waits; D: done; E: stopped with a question that is not open any more
    await seedItem(hq.db, { state: "triage", title: "C" })
    await seedItem(hq.db, { state: "done", title: "D" })
    const e = await seedItem(hq.db, { state: "stopped", title: "E" })
    await question(e.id, "withdrawn")

    const body = await ok()
    expect(body.work).toEqual({
      inFlight: 3,
      needsYou: 2,
      pendingMergeApprovals: 1,
      openQuestions: 2,
    })
    // every Phase 3 field is still there
    expect(Object.keys(body).sort()).toEqual([
      "allowance",
      "now",
      "pendingProposals",
      "runners",
      "work",
    ])
    expect(body.runners.map((r) => r.runner)).toEqual(["eve", "sandbox", "box"])
    expect(Object.keys(body.allowance).sort()).toEqual([
      "capUsd",
      "day",
      "grantedUsd",
      "remainingUsd",
      "reservedUsd",
      "spentUsd",
    ])
    // the badge's number is the board's own: one source
    const board = await hq.call(founder, "GET", "/v1/work/board")
    expect((board.body as unknown as { stats: { needsYou: number } }).stats.needsYou).toBe(
      body.work?.needsYou,
    )
    await resetWork(hq.db)
  })

  it("a pending approval on a pull request that is no longer open or no longer the item's current one is not counted", async () => {
    await resetWork(hq.db)
    const item = await seedItem(hq.db, { state: "review" })
    const pr = await seedPullRequest(hq.db, item.id, { state: "closed" })
    await hq.db.insert(mergeApprovals).values({
      id: crypto.randomUUID(),
      itemId: item.id,
      pullRequestId: pr.id,
      headSha: "a".repeat(40),
      status: "pending",
      requestedAt: NOW,
    })
    expect((await ok()).work?.pendingMergeApprovals).toBe(0)
    await resetWork(hq.db)
  })

  it("a key with hq_run:read and hq_proposal:read but not hq_spend:read gets 403", async () => {
    const all = { hq_run: ["read"], hq_proposal: ["read"], hq_spend: ["read"] }
    for (const missing of Object.keys(all)) {
      const permissions = Object.fromEntries(Object.entries(all).filter(([k]) => k !== missing))
      const res = await status({ key: await hq.keyFor(founder, permissions) })
      expect(res.status, `without ${missing}`).toBe(403)
      expect(res.body.error.code).toBe("FORBIDDEN")
    }
    expect((await status(stranger)).status).toBe(403)
    expect((await status({ cookie: "" })).status).toBe(401)
  })

  it("a founder session and a full-read key both get 200", async () => {
    const all = { hq_run: ["read"], hq_proposal: ["read"], hq_spend: ["read"] }
    expect((await status(founder)).status).toBe(200)
    expect((await status({ key: await hq.keyFor(founder, all) })).status).toBe(200)
  })

  it("is in OpenAPI, llms.txt and MCP tools/list", async () => {
    const doc = (await (await hq.app.request(`${BASE}/openapi.json`)).json()) as {
      paths: Record<string, Record<string, unknown>>
    }
    expect(doc.paths["/v1/factory/status"]?.get).toBeDefined()
    expect(await (await hq.app.request(`${BASE}/llms.txt`)).text()).toContain("get_factory_status")
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
    expect(tools.map((t) => t.name)).toContain("get_factory_status")
    await client.close()
  })
})

// An hq deployed before step 05 has no work tables: the older screens must keep working.
describe("get_factory_status without the work tables (PGlite)", () => {
  it("with the work tables dropped, get_factory_status answers 200 with work null and every Phase 3 field intact", async () => {
    const hq = await createHqHarness({ founderEmails: ["founder@example.com"], now: () => NOW })
    try {
      const founder = await hq.signUp("founder@example.com")
      const before = await hq.app.request(`${BASE}/v1/factory/status`, {
        headers: { origin: BASE, cookie: founder.cookie },
      })
      const withTables = (await before.json()) as StatusJson
      expect(withTables.work).toEqual({
        inFlight: 0,
        needsYou: 0,
        pendingMergeApprovals: 0,
        openQuestions: 0,
      })
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
      const res = await hq.app.request(`${BASE}/v1/factory/status`, {
        headers: { origin: BASE, cookie: founder.cookie },
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as StatusJson
      expect(body.work).toBeNull()
      const { work: _gone, ...rest } = body
      const { work: _was, ...restBefore } = withTables
      expect(rest).toEqual(restBefore)
      expect(Object.keys(body).sort()).toEqual([
        "allowance",
        "now",
        "pendingProposals",
        "runners",
        "work",
      ])
    } finally {
      await hq.close()
    }
  })
})
