import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { defineOperation } from "@proof/api"
import { createAuth } from "@proof/auth"
import { user } from "@proof/db"
import { eq } from "drizzle-orm"
import { z } from "zod"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { createHqApp } from "./app"
import { addFounder } from "./data/founders"
import { createHqTestDb } from "./testing"

const BASE = "http://localhost:3100"
const SECRET = "a-test-secret-that-is-long-enough-123456" // gitleaks:allow

/** A write, so the body and origin checks that every later operation relies on are reached. */
const echo = defineOperation({
  name: "echo",
  method: "POST",
  path: "/v1/echo",
  summary: "Echo",
  description: "Echoes the text.",
  permissions: {},
  input: z.object({ text: z.string() }),
  output: z.object({ text: z.string() }),
  handler: (input) => ({ text: input.text }),
})

/** What a key must never be able to do: an operation behind a person-only action. */
const decide = defineOperation({
  name: "decide",
  method: "POST",
  path: "/v1/decide",
  summary: "Decide",
  description: "Needs a person-only action.",
  permissions: { hq_proposal: ["decide"] },
  input: z.object({}),
  output: z.object({ decided: z.boolean() }),
  handler: () => ({ decided: true }),
})

describe("hq app (real Postgres via PGlite)", () => {
  let close: () => Promise<void>
  let app: ReturnType<typeof createHqApp>
  let founder: { cookie: string; userId: string; orgId: string }
  let keyFor: (permissions: Record<string, string[]>) => Promise<string>

  beforeAll(async () => {
    const t = await createHqTestDb()
    const auth = createAuth({
      db: t.db,
      secret: SECRET,
      baseURL: BASE,
      emailFrom: "Test <auth@example.com>",
      oauthResources: [BASE, `${BASE}/mcp`],
      // No mail is sent in tests; a send that fails must fail the test, not vanish.
      ses: { client: { send: async () => ({ MessageId: "test", $metadata: {} }) } },
      onEmailError: (error) => {
        throw error
      },
      passwordBreachCheck: false,
      rateLimit: false,
    })
    app = createHqApp({
      db: t.db,
      auth,
      now: () => new Date("2026-11-17T12:00:00Z"),
      baseURL: BASE,
      extraOperations: [echo, decide],
    })
    close = async () => t.close()

    // A founder: signing up makes a personal organization the person owns.
    const res = await auth.api.signUpEmail({
      body: { email: "founder@example.com", password: "correct-horse-battery", name: "Founder" },
      returnHeaders: true,
    })
    const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? ""
    const session = await auth.api.getSession({ headers: new Headers({ cookie }) })
    const orgId = session?.session.activeOrganizationId
    if (!orgId) throw new Error("signup did not activate a personal organization")
    // hq lets in only founders: this person is a row of the founders table.
    await t.db.update(user).set({ emailVerified: true }).where(eq(user.id, res.response.user.id))
    await addFounder(t.db, {
      userId: res.response.user.id,
      slackUserId: "UFOUNDER1",
      now: new Date("2026-11-17T12:00:00Z"),
    })
    founder = { cookie, userId: res.response.user.id, orgId }
    keyFor = async (permissions) =>
      (
        await auth.api.createApiKey({
          body: { organizationId: orgId, userId: founder.userId, permissions },
        })
      ).key
  })
  afterAll(() => close())

  const req = (path: string, headers: Record<string, string> = {}) =>
    app.request(`${BASE}${path}`, { headers: { origin: BASE, ...headers } })

  it("GET /v1/status returns ok for a founder session", async () => {
    const res = await req("/v1/status", { cookie: founder.cookie })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, version: "0.0.0" })
    // No credential, no answer.
    expect((await req("/v1/status")).status).toBe(401)
  })

  it("MCP tools/list includes hq_status", async () => {
    const client = new Client({ name: "test", version: "1.0.0" })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
        fetch: async (url, init) => {
          const headers = new Headers(init?.headers)
          headers.set("cookie", founder.cookie)
          headers.set("origin", BASE)
          return app.request(String(url), { ...init, headers })
        },
      }),
    )
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toContain("hq_status")
    await client.close()
  })

  it("an API key with read scope can call hq_status", async () => {
    const key = await keyFor({ hq_entry: ["read"] })
    const res = await req("/v1/status", { "x-api-key": key })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, version: "0.0.0" })
    // A key for something else in the catalog may not read the brain.
    const other = await keyFor({ project: ["read"] })
    expect((await req("/v1/status", { "x-api-key": other })).status).toBe(403)
  })

  it("serves its docs, discovery documents, health and a JSON 404", async () => {
    expect(await (await req("/llms.txt")).text()).toContain("hq_status")
    expect(await (await req("/")).text()).toContain("hq_status")
    expect(await (await req("/llms-full.txt")).text()).toContain("hq_entry:read")
    const doc = (await (await req("/openapi.json")).json()) as { paths: object }
    expect(Object.keys(doc.paths)).toContain("/v1/status")
    expect((await req("/.well-known/mcp/server.json")).status).toBe(200)
    expect(await (await req("/health", { "x-request-id": "r-1" })).json()).toEqual({
      status: "ok",
      checks: {},
    })
    for (const path of [
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-authorization-server",
      "/.well-known/openid-configuration",
    ]) {
      expect((await req(path)).status).toBe(200)
    }
    const missing = await req("/nope")
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ error: { code: "NOT_FOUND", message: "Not found" } })
  })

  it("reads a JSON body, and refuses a bad one or a session write from a foreign origin", async () => {
    const post = (body: string, headers: Record<string, string> = {}) =>
      app.request(`${BASE}/v1/echo`, {
        method: "POST",
        body,
        headers: { cookie: founder.cookie, origin: BASE, ...headers },
      })
    const ok = await post(JSON.stringify({ text: "hi" }))
    expect(await ok.json()).toEqual({ text: "hi" })
    expect((await post("{nope")).status).toBe(400)
    expect((await post("[1]")).status).toBe(400)
    expect((await post("", { origin: "https://evil.example" })).status).toBe(403)
    expect((await post("x".repeat(2 * 1024 * 1024))).status).toBe(400)
  })

  it("refuses key permissions for the person-only hq actions through better-auth's key endpoint", async () => {
    for (const permissions of [
      { hq_proposal: ["decide"] },
      { hq_spend: ["grant"] },
      { hq_entry: ["update"] },
    ]) {
      const res = await app.request(`${BASE}/api/auth/api-key/create`, {
        method: "POST",
        body: JSON.stringify({ organizationId: founder.orgId, permissions }),
        headers: { cookie: founder.cookie, origin: BASE, "content-type": "application/json" },
      })
      expect(res.status, JSON.stringify(permissions)).toBe(400)
      expect(await res.json(), JSON.stringify(permissions)).toMatchObject({
        code: "SERVER_ONLY_PROPERTY",
      })
    }
  })

  it("never lets a key act on a person-only action, even one minted server-side", async () => {
    const call = (headers: Record<string, string>) =>
      app.request(`${BASE}/v1/decide`, {
        method: "POST",
        headers: { origin: BASE, ...headers },
      })
    // A founder session decides.
    expect((await call({ cookie: founder.cookie })).status).toBe(200)
    // A key holding the action (as a server-side mint could give it) is refused.
    const key = await keyFor({ hq_proposal: ["decide"], hq_entry: ["read"] })
    const refused = await call({ "x-api-key": key })
    expect(refused.status).toBe(403)
    // Its other grants survive the strip.
    expect((await req("/v1/status", { "x-api-key": key })).status).toBe(200)
  })
})
