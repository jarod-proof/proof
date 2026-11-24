import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { createHqHarness, type TestPerson } from "../app.test.helpers"
import { type Runner, type RunOutcome, proposals, runs, spend } from "../db/schema"

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
    expect(Object.keys(body).sort()).toEqual(["allowance", "now", "pendingProposals", "runners"])
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
