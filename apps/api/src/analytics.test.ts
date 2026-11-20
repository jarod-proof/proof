// Analytics over HTTP: operation calls through the invoke hooks (REST and MCP), and the web app's
// events through POST /api/events.
import {
  ANALYTICS_EVENTS_PATH,
  createAnalytics,
  createMemoryProvider,
  noopAnalytics,
} from "@proof/analytics"
import type { AuthEvent } from "@proof/auth"
import { createLogger } from "@proof/logger"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { analyticsFromEnv, captureAuthEvent } from "./analytics"
import { createTestApp } from "./app.test.helpers"

const provider = createMemoryProvider()
const analytics = createAnalytics(provider, { flushAt: 1000 })
let t: Awaited<ReturnType<typeof createTestApp>>

/** Everything captured since the last call. */
async function captured() {
  await analytics.flush()
  return provider.events.splice(0)
}

beforeAll(async () => {
  t = await createTestApp([], { analytics, limits: { unclaimed: 10 } })
})
afterAll(() => t.close())
beforeEach(() => captured())

describe("operation.called", () => {
  it("captures an API key's call with its organization and outcome", async () => {
    await t.req("/v1/projects", t.as(t.fullKey))
    await t.req("/v1/projects/nope", t.as(t.fullKey, { method: "DELETE" }))
    const events = await captured()
    expect(events).toEqual([
      expect.objectContaining({
        name: "operation.called",
        properties: { operation: "list_projects", outcome: "ok", via: "api-key" },
        actor: { type: "apiKey", keyId: expect.any(String) },
        organizationId: t.owner.orgId,
      }),
      expect.objectContaining({
        properties: { operation: "delete_project", outcome: "NOT_FOUND", via: "api-key" },
      }),
    ])
  })

  it("captures MCP calls the same way", async () => {
    const client = await t.mcpClient(t.fullKey)
    await client.callTool({ name: "list_projects", arguments: {} })
    await client.close()
    expect(await captured()).toEqual([
      expect.objectContaining({
        name: "operation.called",
        properties: { operation: "list_projects", outcome: "ok", via: "api-key" },
      }),
    ])
  })

  it("skips a person's reads in the web app, but not their writes", async () => {
    await t.req("/v1/projects", t.as(t.owner.cookie))
    await t.req(
      "/v1/projects",
      t.as(t.owner.cookie, { method: "POST", body: JSON.stringify({ name: "Site" }) }),
    )
    expect(await captured()).toEqual([
      expect.objectContaining({
        properties: { operation: "create_project", outcome: "ok", via: "session" },
        actor: { type: "user", userId: t.owner.userId },
      }),
    ])
  })

  it("captures a call the hooks refuse", async () => {
    // The other org is unclaimed, with a limit of 10 a day.
    for (let i = 0; i < 11; i++) await t.req("/v1/projects", t.as(t.otherKey))
    const outcomes = (await captured()).map(
      (e) => e.name === "operation.called" && e.properties.outcome,
    )
    expect(outcomes).toEqual([...Array.from({ length: 10 }, () => "ok"), "RATE_LIMITED"])
  })
})

describe("account.created", () => {
  it("captures a new account in its personal organization", async () => {
    const user = await t.signUp("Newcomer")
    expect(await captured()).toEqual([
      {
        name: "account.created",
        actor: { type: "user", userId: user.userId },
        organizationId: user.orgId,
        timestamp: expect.any(Date),
      },
    ])
  })
})

describe("POST /api/events", () => {
  const pageView = { name: "page.viewed", properties: { route: "/$org/runs/$runId" } }
  const send = (init: RequestInit) => t.req(ANALYTICS_EVENTS_PATH, { method: "POST", ...init })
  const body = (value: unknown) => JSON.stringify(value)

  it("captures a signed-in person's page views as them, in their organization", async () => {
    const res = await send(t.as(t.viewer.cookie, { body: body({ events: [pageView, pageView] }) }))
    expect(res.status).toBe(204)
    expect(await captured()).toEqual([
      {
        ...pageView,
        actor: { type: "user", userId: t.viewer.userId },
        organizationId: t.owner.orgId,
        timestamp: expect.any(Date),
      },
      expect.objectContaining(pageView),
    ])
  })

  it("refuses no session, an API key, and a session from another origin", async () => {
    const events = body({ events: [pageView] })
    expect((await send({ body: events })).status).toBe(401)
    expect((await send(t.as(t.fullKey, { body: events }))).status).toBe(403)
    const foreign = t.as(t.owner.cookie, { body: events })
    const headers = new Headers(foreign.headers)
    headers.set("origin", "https://evil.example")
    expect((await send({ ...foreign, headers })).status).toBe(403)
    expect(await captured()).toEqual([])
  })

  it.each([
    ["not JSON", "{"],
    ["an event the web app may not send", body({ events: [{ name: "auth.sign_in" }] })],
    ["someone else's id", body({ events: [pageView], userId: "someone-else" })],
    ["an over-long body", body({ events: [pageView], pad: "x".repeat(20_000) })],
  ])("refuses %s", async (_, raw) => {
    expect((await send(t.as(t.owner.cookie, { body: raw }))).status).toBe(400)
    expect(await captured()).toEqual([])
  })

  it("is not part of the API's contract", async () => {
    const spec = (await (await t.req("/openapi.json")).json()) as { paths: Record<string, unknown> }
    expect(Object.keys(spec.paths)).not.toContain(ANALYTICS_EVENTS_PATH)
  })
})

describe("captureAuthEvent", () => {
  const signIn: AuthEvent = {
    name: "auth.sign_in",
    userId: "u1",
    organizationId: "org1",
    outcome: "ok",
    ip: "203.0.113.9",
    path: "/sign-in/email",
  }

  it("captures a counted event with ids only", async () => {
    captureAuthEvent(analytics, signIn)
    expect(await captured()).toEqual([
      {
        name: "auth.sign_in",
        actor: { type: "user", userId: "u1" },
        organizationId: "org1",
        timestamp: expect.any(Date),
      },
    ])
  })

  it("skips failures, unknown people and events we don't count", async () => {
    captureAuthEvent(analytics, { ...signIn, outcome: "INVALID_EMAIL_OR_PASSWORD" })
    captureAuthEvent(analytics, { ...signIn, userId: null })
    captureAuthEvent(analytics, { ...signIn, name: "auth.session_revoked" })
    expect(await captured()).toEqual([])
  })

  it("leaves out the organization for account events", async () => {
    captureAuthEvent(analytics, { ...signIn, organizationId: null })
    expect((await captured())[0]).not.toHaveProperty("organizationId")
  })
})

describe("analyticsFromEnv", () => {
  const logger = createLogger({ level: "silent" })

  it("is nowhere when unset or none, except unset in development, which logs", () => {
    expect(analyticsFromEnv({}, logger)).toBe(noopAnalytics)
    expect(analyticsFromEnv({ NODE_ENV: "production" }, logger)).toBe(noopAnalytics)
    expect(analyticsFromEnv({ NODE_ENV: "development" }, logger)).not.toBe(noopAnalytics)
    expect(analyticsFromEnv({ NODE_ENV: "development", ANALYTICS_PROVIDER: "none" }, logger)).toBe(
      noopAnalytics,
    )
  })

  it("builds log and posthog", () => {
    expect(analyticsFromEnv({ ANALYTICS_PROVIDER: "log" }, logger)).not.toBe(noopAnalytics)
    expect(
      analyticsFromEnv({ ANALYTICS_PROVIDER: "posthog", POSTHOG_API_KEY: "phc_test" }, logger),
    ).not.toBe(noopAnalytics)
  })
})
