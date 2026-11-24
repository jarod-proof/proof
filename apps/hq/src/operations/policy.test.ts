import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { PERSON_ONLY_ACTIONS } from "@proof/auth"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { createHqHarness, type TestPerson } from "../app.test.helpers"
import { countFounders } from "../data/founders"
import {
  DEFAULT_SLACK_DAILY_GRANT_CAP_USD,
  MAX_GRANT_REQUEST_USD,
  MAX_GRANT_REQUESTS_PER_DAY,
} from "../data/grant-requests"
import { DAILY_CAP, unitsToUsd } from "../data/money"
import { STALE_HOLD_MS } from "../data/spend"

const BASE = "http://localhost:3100"

interface PolicyJson {
  spend: {
    dailyCapUsd: number
    maxGrantRequestUsd: number
    maxGrantRequestsPerDay: number
    staleHoldMinutes: number
    slackDailyGrantCapUsd: number
    grantedTodayUsd: number
  }
  approvals: { personOnly: { resource: string; actions: string[] }[] }
  founders: number
}

describe("get_policy (PGlite)", () => {
  let hq: Awaited<ReturnType<typeof createHqHarness>>
  let capped: Awaited<ReturnType<typeof createHqHarness>>
  let founder: TestPerson
  let cappedFounder: TestPerson
  let stranger: TestPerson

  beforeAll(async () => {
    hq = await createHqHarness({ founderEmails: ["founder@example.com"] })
    founder = await hq.signUp("founder@example.com")
    stranger = await hq.signUp("stranger@example.com")
    capped = await createHqHarness({
      founderEmails: ["founder@example.com"],
      slackDailyGrantCapUsd: 20,
    })
    cappedFounder = await capped.signUp("founder@example.com")
  })
  afterAll(async () => {
    await hq.close()
    await capped.close()
  })

  const get = async (h: typeof hq, as: { cookie: string } | { key: string }) => {
    const res = await h.app.request(`${BASE}/v1/policy`, {
      headers: {
        origin: BASE,
        ...("cookie" in as ? { cookie: as.cookie } : { "x-api-key": as.key }),
      },
    })
    return { status: res.status, body: (await res.json()) as PolicyJson }
  }

  it("reports the cap, grant limits and stale hold from the constants hq enforces", async () => {
    const res = await get(hq, { cookie: founder.cookie })
    expect(res.status).toBe(200)
    expect(res.body.spend).toMatchObject({
      dailyCapUsd: unitsToUsd(DAILY_CAP),
      maxGrantRequestUsd: MAX_GRANT_REQUEST_USD,
      maxGrantRequestsPerDay: MAX_GRANT_REQUESTS_PER_DAY,
      staleHoldMinutes: STALE_HOLD_MS / 60_000,
    })
  })

  it("slackDailyGrantCapUsd is the app option when set (20) and hq's default (50) when not", async () => {
    expect(
      (await get(capped, { cookie: cappedFounder.cookie })).body.spend.slackDailyGrantCapUsd,
    ).toBe(20)
    const unset = (await get(hq, { cookie: founder.cookie })).body.spend.slackDailyGrantCapUsd
    expect(unset).toBe(DEFAULT_SLACK_DAILY_GRANT_CAP_USD)
    expect(unset).toBe(50)
  })

  it("personOnly lists exactly the hq_ resources of PERSON_ONLY_ACTIONS", async () => {
    const { body } = await get(hq, { cookie: founder.cookie })
    const expected = Object.entries(PERSON_ONLY_ACTIONS)
      .filter(([resource]) => resource.startsWith("hq_"))
      .map(([resource, actions]) => ({ resource, actions: [...actions] }))
    expect(expected.length).toBeGreaterThan(0)
    expect(body.approvals.personOnly).toEqual(expected)
  })

  it("counts founders", async () => {
    expect((await get(hq, { cookie: founder.cookie })).body.founders).toBe(1)
    expect(await countFounders(hq.db)).toBe(1)
    await hq.addFounder(stranger)
    expect(await countFounders(hq.db)).toBe(2)
    expect((await get(hq, { cookie: founder.cookie })).body.founders).toBe(2)
  })

  it("grantedTodayUsd follows a grant", async () => {
    const before = (await get(capped, { cookie: cappedFounder.cookie })).body.spend.grantedTodayUsd
    expect(before).toBe(0)
    const granted = await capped.app.request(`${BASE}/v1/spend/grants`, {
      method: "POST",
      headers: {
        origin: BASE,
        cookie: cappedFounder.cookie,
        "content-type": "application/json",
      },
      body: JSON.stringify({ amountUsd: 5, reason: "Launch day" }),
    })
    expect(granted.status).toBe(200)
    expect((await get(capped, { cookie: cappedFounder.cookie })).body.spend.grantedTodayUsd).toBe(5)
  })

  it("needs hq_proposal:read and hq_spend:read: a project-only key gets 403", async () => {
    const ok = { key: await hq.keyFor(founder, { hq_proposal: ["read"], hq_spend: ["read"] }) }
    expect((await get(hq, ok)).status).toBe(200)
    const denied: Record<string, string[]>[] = [
      { project: ["read"] },
      { hq_proposal: ["read"] },
      { hq_spend: ["read"] },
    ]
    for (const permissions of denied) {
      const as = { key: await hq.keyFor(founder, permissions) }
      expect((await get(hq, as)).status, JSON.stringify(permissions)).toBe(403)
    }
    expect((await get(hq, { cookie: "" })).status).toBe(401)
  })

  it("is in OpenAPI, llms.txt and MCP, read-only", async () => {
    const headers = { origin: BASE, cookie: founder.cookie }
    const doc = (await (await hq.app.request(`${BASE}/openapi.json`, { headers })).json()) as {
      paths: Record<string, Record<string, unknown>>
    }
    expect(Object.keys(doc.paths["/v1/policy"] ?? {})).toEqual(["get"])
    expect(await (await hq.app.request(`${BASE}/llms.txt`, { headers })).text()).toContain(
      "get_policy",
    )
    const client = new Client({ name: "test", version: "1.0.0" })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
        fetch: async (url, init) => {
          const h = new Headers(init?.headers)
          h.set("cookie", founder.cookie)
          h.set("origin", BASE)
          return hq.app.request(String(url), { ...init, headers: h })
        },
      }),
    )
    const { tools } = await client.listTools()
    const tool = tools.find((t) => t.name === "get_policy")
    expect(tool?.annotations?.readOnlyHint).toBe(true)
    await client.close()
  })
})
