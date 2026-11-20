import { type Caller, invoke } from "@proof/api"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { spend } from "../db/schema"
import { createHqHarness, type TestPerson } from "../app.test.helpers"
import { createHqOperations } from "./index"

const BASE = "http://localhost:3100"

// Runs and spend over the real app: what a key may call, what only a founder at a keyboard may,
// and the wire shapes Eve's hooks will use.
describe("runs and spend operations (PGlite)", () => {
  let now = new Date("2026-11-17T12:00:00Z")
  let hq: Awaited<ReturnType<typeof createHqHarness>>
  let founder: TestPerson
  let stranger: TestPerson

  beforeAll(async () => {
    hq = await createHqHarness({
      founderEmails: ["founder@example.com"],
      now: () => now,
    })
    founder = await hq.signUp("founder@example.com")
    stranger = await hq.signUp("stranger@example.com")
  })
  afterAll(() => hq.close())

  /** The fields of hq's JSON replies these tests read. */
  interface Json {
    error: { code: string }
    id: string
    holdId: string
    amountUsd: number
    estimated: boolean
    outcome: string
    costUsd: number
    costEstimated: boolean
    runs: { id: string; costUsd: number }[]
    day: string
    spentUsd: number
    totalUsd: number
    estimatedUsd: number
    bySource: { source: string; amountUsd: number }[]
    reservedUsd: number
    capUsd: number
    grantedUsd: number
    remainingUsd: number
  }
  type As = { cookie: string } | { key: string }
  const call = async (as: As, method: "GET" | "POST", path: string, body?: unknown) => {
    const res = await hq.app.request(`${BASE}${path}`, {
      method,
      headers: {
        origin: BASE,
        ...("cookie" in as ? { cookie: as.cookie } : { "x-api-key": as.key }),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: res.status, body: (await res.json()) as Json }
  }
  const key = async (permissions: Record<string, string[]>) => ({
    key: await hq.keyFor(founder, permissions),
  })
  const agentKey = () => key({ hq_spend: ["read", "record"], hq_run: ["read", "create", "update"] })
  const founderAs = { cookie: "" }
  beforeAll(() => {
    founderAs.cookie = founder.cookie
  })
  /** A day of its own for each test: the harness clock moves, the ledger is per UTC day. */
  let day = 0
  const newDay = () => {
    now = new Date(Date.UTC(2030, 0, ++day, 12))
  }

  it("a key reserves, settles and records spend, and records and finishes runs", async () => {
    newDay()
    const agent = await agentKey()
    const run = await call(agent, "POST", "/v1/runs", {
      task: "chat",
      trigger: "slack",
      runner: "eve",
    })
    expect(run.status).toBe(200)
    const reserved = await call(agent, "POST", "/v1/spend/reservations", {
      source: "eve",
      estimateUsd: 0.05,
      runId: run.body.id,
    })
    expect(reserved.body).toEqual({ holdId: expect.any(String) })
    const settled = await call(
      agent,
      "POST",
      `/v1/spend/holds/${reserved.body.holdId}/settlement`,
      { amountUsd: 0.0123, model: "haiku" },
    )
    expect(settled.body).toEqual({ amountUsd: 0.0123, estimated: false })
    const box = await call(agent, "POST", "/v1/spend", {
      runId: run.body.id,
      source: "box",
      amountUsd: 0.4,
      model: "opus",
    })
    expect(box.status).toBe(200)
    const finished = await call(agent, "POST", `/v1/runs/${run.body.id}/finish`, {
      outcome: "succeeded",
      summary: { worked: ["replied"], failed: [], stop: [] },
    })
    expect(finished.body).toMatchObject({
      outcome: "succeeded",
      costUsd: 0.4123,
      costEstimated: false,
    })
    const listed = await call(agent, "GET", "/v1/runs")
    expect(listed.body.runs[0]).toMatchObject({ id: run.body.id, costUsd: 0.4123 })
    const allowance = await call(agent, "GET", "/v1/spend/allowance")
    expect(allowance.body).toEqual({
      day: "2030-01-01",
      spentUsd: 0.0123,
      reservedUsd: 0,
      capUsd: 10,
      grantedUsd: 0,
      remainingUsd: 9.9877,
    })
  })

  it("a missing cost settles at the estimate, marked estimated, over the API", async () => {
    newDay()
    const agent = await agentKey()
    const reserved = await call(agent, "POST", "/v1/spend/reservations", {
      source: "eve",
      estimateUsd: 0.25,
    })
    const settled = await call(
      agent,
      "POST",
      `/v1/spend/holds/${reserved.body.holdId}/settlement`,
      { model: "haiku" },
    )
    expect(settled.body).toEqual({ amountUsd: 0.25, estimated: true })
    const recorded = await call(agent, "POST", "/v1/spend", {
      source: "eve",
      estimatedUsd: 0.1,
      model: "haiku",
    })
    expect(recorded.body).toMatchObject({ amountUsd: 0.1, estimated: true })
    expect((await call(agent, "GET", "/v1/spend/allowance")).body.spentUsd).toBe(0.35)
    // Neither amount nor estimate is a mistake in the caller, not a free turn.
    const none = await call(agent, "POST", "/v1/spend", { source: "eve", model: "haiku" })
    expect(none.status).toBe(400)
    // A second settle of the same hold changes nothing.
    const again = await call(agent, "POST", `/v1/spend/holds/${reserved.body.holdId}/settlement`, {
      amountUsd: 5,
      model: "haiku",
    })
    expect(again.status).toBe(409)
    expect((await call(agent, "GET", "/v1/spend/allowance")).body.spentUsd).toBe(0.35)
  })

  it("the day closes once 10.00 is spent: the allowance is 0 and a reservation is refused", async () => {
    newDay()
    const agent = await agentKey()
    await call(agent, "POST", "/v1/spend", { source: "eve", amountUsd: 9.9, model: "m" })
    const refused = await call(agent, "POST", "/v1/spend/reservations", {
      source: "eve",
      estimateUsd: 0.2,
    })
    expect(refused.status).toBe(200)
    expect(refused.body).toEqual({ refused: true, remainingUsd: 0.1 })
    await call(agent, "POST", "/v1/spend", { source: "eve", amountUsd: 0.1, model: "m" })
    expect((await call(agent, "GET", "/v1/spend/allowance")).body.remainingUsd).toBe(0)
    expect(
      (await call(agent, "POST", "/v1/spend/reservations", { source: "eve", estimateUsd: 0.0001 }))
        .body,
    ).toEqual({ refused: true, remainingUsd: 0 })
    // Builds and box runs are outside the cap: still recorded on a closed day.
    expect(
      (await call(agent, "POST", "/v1/spend", { source: "build", amountUsd: 3, model: "m" }))
        .status,
    ).toBe(200)
    // An estimate of nothing reserves nothing and is refused as a bad request.
    expect(
      (await call(agent, "POST", "/v1/spend/reservations", { source: "eve", estimateUsd: 0 }))
        .status,
    ).toBe(400)
  })

  it("get_spend_summary reports a UTC day by source, and by default hq's own yesterday", async () => {
    // Dates of their own, so the other tests' day counter is untouched.
    now = new Date(Date.UTC(2040, 5, 10, 12))
    const agent = await agentKey()
    const yesterday = now.toISOString().slice(0, 10)
    await call(agent, "POST", "/v1/spend", { source: "eve", amountUsd: 1.25, model: "m" })
    await call(agent, "POST", "/v1/spend", { source: "build", estimatedUsd: 2, model: "m" })
    await call(agent, "POST", "/v1/spend", { source: "box", amountUsd: 0.5, model: "m" })
    now = new Date(Date.UTC(2040, 5, 11, 12))
    await call(agent, "POST", "/v1/spend", { source: "eve", amountUsd: 9, model: "m" })

    // Left out, the day is the one before hq's today (the agent's clock is never consulted).
    const summary = await call(agent, "GET", "/v1/spend/summary")
    expect(summary.status).toBe(200)
    expect(summary.body).toMatchObject({
      day: yesterday,
      totalUsd: 3.75,
      estimatedUsd: 2,
      bySource: [
        { source: "box", amountUsd: 0.5 },
        { source: "build", amountUsd: 2 },
        { source: "eve", amountUsd: 1.25 },
      ],
    })
    expect((await call(agent, "GET", `/v1/spend/summary?day=${yesterday}`)).body).toMatchObject({
      totalUsd: 3.75,
    })
    expect((await call(agent, "GET", "/v1/spend/summary?day=2020-01-01")).body).toMatchObject({
      totalUsd: 0,
      bySource: [],
    })
    expect((await call(agent, "GET", "/v1/spend/summary?day=yesterday")).status).toBe(400)
    // Reading needs hq_spend:read.
    const other = await key({ hq_run: ["read"] })
    expect((await call(other, "GET", "/v1/spend/summary")).status).toBe(403)
  })

  it("an API key calling grant_spend gets FORBIDDEN, whatever its permissions say", async () => {
    newDay()
    const grant = (as: As) =>
      call(as, "POST", "/v1/spend/grants", { amountUsd: 5, reason: "let me spend more" })
    // A key that was never given grant, and one minted server-side with it: hq strips it.
    for (const permissions of [
      { hq_spend: ["read", "record"] },
      { hq_spend: ["grant", "read", "record"] },
    ]) {
      const res = await grant(await key(permissions))
      expect(res.status, JSON.stringify(permissions)).toBe(403)
      expect(res.body.error.code).toBe("FORBIDDEN")
    }
    expect((await call(await agentKey(), "GET", "/v1/spend/allowance")).body.grantedUsd).toBe(0)
  })

  it("the grant_spend handler refuses a key, an OAuth token and a non-founder on its own", async () => {
    newDay()
    const ops = createHqOperations({
      db: hq.db,
      now: hq.now,
    })
    const op = ops.find((o) => o.name === "grant_spend")
    if (!op) throw new Error("grant_spend is not registered")
    const grants = [{ hq_spend: ["grant", "read", "record"] }]
    // Callers built by hand skip the app's strip of person-only actions.
    const callers: Caller[] = [
      {
        organizationId: founder.orgId,
        actor: { type: "apiKey", keyId: "k" },
        grants,
        via: "apikey",
      },
      {
        organizationId: founder.orgId,
        actor: { type: "user", userId: founder.userId },
        grants,
        via: "oauth",
      },
      {
        organizationId: stranger.orgId,
        actor: { type: "user", userId: stranger.userId },
        grants,
        via: "session",
      },
    ]
    for (const caller of callers) {
      await expect(invoke(op, { amountUsd: 5, reason: "r" }, { caller })).rejects.toMatchObject({
        code: "FORBIDDEN",
      })
    }
    expect((await call(founderAs, "GET", "/v1/spend/allowance")).body.grantedUsd).toBe(0)
  })

  it("a founder's grant raises today's allowance; a signed-in non-founder gets FORBIDDEN", async () => {
    newDay()
    const agent = await agentKey()
    await call(agent, "POST", "/v1/spend", { source: "eve", amountUsd: 10, model: "m" })
    expect((await call(agent, "GET", "/v1/spend/allowance")).body.remainingUsd).toBe(0)
    const stranger_ = await call({ cookie: stranger.cookie }, "POST", "/v1/spend/grants", {
      amountUsd: 5,
      reason: "me too",
    })
    expect(stranger_.status).toBe(403)
    const granted = await call(founderAs, "POST", "/v1/spend/grants", {
      amountUsd: 2,
      reason: "launch day",
    })
    expect(granted.body).toMatchObject({ day: "2030-01-06", grantedUsd: 2 })
    const allowance = await call(agent, "GET", "/v1/spend/allowance")
    expect(allowance.body).toMatchObject({ grantedUsd: 2, remainingUsd: 2 })
    expect(
      (await call(agent, "POST", "/v1/spend/reservations", { source: "eve", estimateUsd: 2 })).body,
    ).toEqual({ holdId: expect.any(String) })
    // A grant needs an amount above zero and a reason.
    expect(
      (await call(founderAs, "POST", "/v1/spend/grants", { amountUsd: 0, reason: "x" })).status,
    ).toBe(400)
  })

  it("refuses one call above $1000, for an amount, an estimate and a settle", async () => {
    newDay()
    const agent = await agentKey()
    const reserve = (estimateUsd: number) =>
      call(agent, "POST", "/v1/spend/reservations", { source: "eve", estimateUsd })
    expect((await reserve(1000.01)).status).toBe(400)
    expect(
      (await call(agent, "POST", "/v1/spend", { source: "box", amountUsd: 999999, model: "m" }))
        .status,
    ).toBe(400)
    expect(
      (await call(agent, "POST", "/v1/spend", { source: "box", estimatedUsd: 5000, model: "m" }))
        .status,
    ).toBe(400)
    const hold = await reserve(1)
    const settle = (amountUsd: number) =>
      call(agent, "POST", `/v1/spend/holds/${hold.body.holdId}/settlement`, {
        amountUsd,
        model: "m",
      })
    expect((await settle(1000.01)).status).toBe(400)
    expect((await settle(1000)).status).toBe(200)
  })

  it("sums past one column's maximum still report: list_runs, finish_run, allowance and /admin/spend answer", async () => {
    newDay()
    const agent = await agentKey()
    const run = await call(agent, "POST", "/v1/runs", { task: "big", trigger: "x", runner: "box" })
    // Many records at the per-call ceiling can add up to more than one numeric(10,4) cell holds.
    // The API refuses a call that big, so the rows go in directly: what matters is that reading
    // them back never fails, because nothing can delete them.
    const at = new Date(now)
    const row = (source: "box" | "eve", id: string) => ({
      id,
      runId: run.body.id,
      day: at.toISOString().slice(0, 10),
      source,
      amountUsd: "999999.9999",
      model: "m",
      estimated: false,
      createdAt: at,
    })
    await hq.db
      .insert(spend)
      .values([
        row("box", "huge-1"),
        row("box", "huge-2"),
        row("eve", "huge-3"),
        row("eve", "huge-4"),
      ])

    const listed = await call(agent, "GET", "/v1/runs")
    expect(listed.status).toBe(200)
    expect(listed.body.runs[0]).toMatchObject({ id: run.body.id, costUsd: 3999999.9996 })
    const finished = await call(agent, "POST", `/v1/runs/${run.body.id}/finish`, {
      outcome: "stopped",
      summary: { worked: [], failed: [], stop: ["huge"] },
    })
    expect(finished.status).toBe(200)
    const allowance = await call(agent, "GET", "/v1/spend/allowance")
    expect(allowance.status).toBe(200)
    expect(allowance.body).toMatchObject({ spentUsd: 1999999.9998, remainingUsd: 0 })
    const page = await hq.app.request(`${BASE}/admin/spend`, {
      headers: { cookie: founder.cookie },
    })
    expect(page.status).toBe(200)
    expect(await page.text()).toContain("$1999999.9998")
    // And the cap still refuses.
    expect(
      (await call(agent, "POST", "/v1/spend/reservations", { source: "eve", estimateUsd: 0.0001 }))
        .body,
    ).toEqual({ refused: true, remainingUsd: 0 })
  })

  it("a key without hq_spend record cannot reserve, settle or record", async () => {
    newDay()
    const readOnly = await key({ hq_spend: ["read"], hq_run: ["read"] })
    for (const [path, body] of [
      ["/v1/spend/reservations", { source: "eve", estimateUsd: 0.1 }],
      ["/v1/spend/holds/h/settlement", { model: "m" }],
      ["/v1/spend", { source: "box", amountUsd: 1, model: "m" }],
      ["/v1/runs", { task: "t", trigger: "x", runner: "eve" }],
    ] as const) {
      expect((await call(readOnly, "POST", path, body)).status, path).toBe(403)
    }
    expect((await call(readOnly, "GET", "/v1/spend/allowance")).status).toBe(200)
  })
})
