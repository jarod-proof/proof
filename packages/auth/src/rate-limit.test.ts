import { sql } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { createTestAuth } from "./auth.test.helpers"
import {
  CATCH_ALL_PATH,
  CLIENT_IP_HEADER,
  GLOBAL_RATE_LIMIT,
  STRICT_RULES,
  authIpAddress,
  authRateLimit,
  unlimitedReads,
} from "./rate-limit"

describe("authRateLimit", () => {
  it("is disabled when passed false", () => {
    expect(authRateLimit(false)).toEqual({ enabled: false })
  })

  it("is enabled, database-backed, with a global window and max", () => {
    const config = authRateLimit()
    expect(config).toMatchObject({ enabled: true, storage: "database", window: 60, max: 120 })
  })

  it("takes the global window and max from the options", () => {
    expect(authRateLimit({ window: 30, max: 50 })).toMatchObject({ window: 30, max: 50 })
  })

  it("gives every listed sensitive path a rule stricter than the global one", () => {
    const { customRules } = authRateLimit()
    const { window, max } = GLOBAL_RATE_LIMIT
    const paths = [
      "/sign-in/email",
      "/sign-in/magic-link",
      "/magic-link/verify",
      "/two-factor/verify-totp",
      "/two-factor/verify-backup-code",
      "/two-factor/send-otp",
      "/request-password-reset",
      "/reset-password",
      "/send-verification-email",
      "/sign-up/email",
      "/passkey/verify-authentication",
      "/sign-in/sso",
      "/sign-in/social",
      "/change-email",
      "/change-password",
    ]
    for (const path of paths) {
      const rule = customRules?.[path]
      expect(rule, path).toBeDefined()
      if (typeof rule !== "object") throw new Error(`${path} has no static rule`)
      // Stricter: fewer requests, in a window at least as long as the global one.
      expect(rule.max, path).toBeLessThan(max)
      expect(rule.window, path).toBeGreaterThanOrEqual(window)
    }
  })

  it("has no rule for /forget-password, which 1.7.7 does not expose", () => {
    expect(STRICT_RULES).not.toHaveProperty("/forget-password")
  })

  it("ends with a catch-all that exempts a GET on the global default and keeps the rest", () => {
    const { customRules } = authRateLimit()
    expect(Object.keys(customRules ?? {}).at(-1)).toBe(CATCH_ALL_PATH)
    const catchAll = customRules?.[CATCH_ALL_PATH]
    if (typeof catchAll !== "function") throw new Error("catch-all is not a rule function")
    const rule = { window: 60, max: 120 }
    const get = new Request("http://x/api/auth/get-session", { method: "GET" })
    const post = new Request("http://x/api/auth/organization/set-active", { method: "POST" })
    expect(catchAll(get, rule)).toBe(false)
    expect(catchAll(post, rule)).toBe(rule)
  })

  it("keeps a special or plugin rule for a GET, so only the global default is exempt", () => {
    const exempt = unlimitedReads(60, 120)
    const get = new Request("http://x/api/auth/device", { method: "GET" })
    // better-auth's /sign-in* default (10s, 3) and the device plugin's rule (expiresIn, 5).
    expect(exempt(get, { window: 10, max: 3 })).toEqual({ window: 10, max: 3 })
    expect(exempt(get, { window: 1800, max: 5 })).toEqual({ window: 1800, max: 5 })
    expect(exempt(get, { window: 60, max: 120 })).toBe(false)
  })

  it("keeps the wildcard keys before the catch-all", () => {
    const { customRules } = authRateLimit()
    const keys = Object.keys(customRules ?? {})
    expect(keys.filter((key) => key.includes("*"))).toEqual([
      "/reset-password/*",
      "/callback/*",
      "/sso/callback/*",
      "/sso/saml2/sp/acs/*",
      "/sso/saml2/sp/slo/*",
      CATCH_ALL_PATH,
    ])
  })

  it("limits the device user-code lookup and the token-consuming GETs", () => {
    const { customRules } = authRateLimit()
    // The device plugin's stricter rule (5 per code lifetime) applies, so there is no override.
    expect(customRules?.["/device"]).toBeUndefined()
    expect(customRules?.["/passkey-signup/verify"]).toEqual({ window: 300, max: 10 })
    expect(customRules?.["/delete-user/callback"]).toEqual({ window: 300, max: 5 })
    expect(customRules?.["/verify-email"]).toEqual({ window: 300, max: 10 })
  })

  it("keeps /sign-in-methods and /sign-in/social off better-auth's /sign-in default", () => {
    const { customRules } = authRateLimit()
    expect(customRules?.["/sign-in/social"]).toEqual({ window: 60, max: 10 })
  })

  it("lets the options override an exempt path", () => {
    const config = authRateLimit({ rules: { "/get-session": { window: 60, max: 1 } } })
    expect(config.customRules?.["/get-session"]).toEqual({ window: 60, max: 1 })
  })

  it("lets the options override or add a rule", () => {
    const config = authRateLimit({
      rules: { "/sign-in/email": { window: 10, max: 1 }, "/x": { window: 1, max: 1 } },
    })
    expect(config.customRules).toMatchObject({
      "/sign-in/email": { window: 10, max: 1 },
      "/x": { window: 1, max: 1 },
      "/reset-password": STRICT_RULES["/reset-password"],
    })
  })
})

describe("authIpAddress", () => {
  it("reads the client address only from the header apps/api sets", () => {
    expect(authIpAddress).toEqual({ ipAddressHeaders: [CLIENT_IP_HEADER] })
    expect(CLIENT_IP_HEADER).toBe("x-proof-client-ip")
  })
})

describe("database-backed limiter writes", () => {
  const BASE = "http://localhost:3000"
  let t: Awaited<ReturnType<typeof createTestAuth>>
  let writes: string[] = []

  beforeAll(async () => {
    t = await createTestAuth({ rateLimit: {} })
    // Every statement that writes the rate_limit table goes through the PGlite client.
    const client = t.db.$client as unknown as {
      query: (sql: string, ...rest: unknown[]) => unknown
    }
    const real = client.query.bind(client)
    vi.spyOn(client, "query").mockImplementation((text: string, ...rest: unknown[]) => {
      if (/^\s*(insert|update|delete)\b/i.test(text) && /rate_limit/.test(text)) writes.push(text)
      return real(text, ...rest)
    })
  })
  afterAll(() => t.close())

  const rows = async () =>
    (await t.db.execute(sql`select key, count, last_request from "rate_limit" order by key`)).rows

  const request = (path: string, ip: string, init: RequestInit = {}) =>
    t.auth.handler(
      new Request(`${BASE}/api/auth${path}`, {
        ...init,
        headers: { ...(init.headers as Record<string, string>), [CLIENT_IP_HEADER]: ip },
      }),
    )

  const post = (path: string, ip: string, body: unknown) =>
    request(path, ip, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify(body),
    })

  it("writes no rate_limit row for 20 /get-session calls", async () => {
    writes = []
    const before = await rows()
    for (let i = 0; i < 20; i++) {
      const res = await request("/get-session", "203.0.113.20")
      expect(res.status).toBe(200)
    }
    expect(writes).toHaveLength(0)
    expect(await rows()).toEqual(before)
    expect(before).toHaveLength(0)
  })

  it("writes no rate_limit row for other read-only GETs", async () => {
    writes = []
    for (const path of [
      "/organization/list-members",
      "/api-key/list",
      "/list-sessions",
      "/sign-in-methods",
    ]) {
      for (let i = 0; i < 3; i++) await request(path, "203.0.113.22")
    }
    expect(writes).toHaveLength(0)
    expect(await rows()).toHaveLength(0)
  })

  it("limits GET /device user-code lookups: 429 after 5 wrong codes from one address", async () => {
    const statuses: number[] = []
    for (let i = 0; i < 6; i++) {
      statuses.push((await request("/device?user_code=WRONG-CODE", "203.0.113.25")).status)
    }
    expect(statuses[4]).not.toBe(429)
    expect(statuses[5]).toBe(429)
  })

  it("still limits a strict GET: /magic-link/verify answers 429 after its limit", async () => {
    writes = []
    const statuses: number[] = []
    for (let i = 0; i < 6; i++) {
      statuses.push((await request("/magic-link/verify?token=bogus", "203.0.113.23")).status)
    }
    expect(statuses[4]).not.toBe(429)
    expect(statuses[5]).toBe(429)
    expect(writes.length).toBeGreaterThan(0)
  })

  it("still counts and limits a strict POST: /sign-in/email answers 429 on the sixth", async () => {
    writes = []
    const body = { email: "nobody@example.com", password: "wrong-password" }
    const statuses: number[] = []
    for (let i = 0; i < 6; i++)
      statuses.push((await post("/sign-in/email", "203.0.113.21", body)).status)
    expect(statuses.slice(0, 5).every((s) => s === 401)).toBe(true)
    expect(statuses[5]).toBe(429)
    expect(writes.length).toBeGreaterThan(0)
  })

  it("still applies the global rule to a non-strict POST", async () => {
    writes = []
    await post("/organization/set-active", "203.0.113.24", {})
    expect(writes.length).toBeGreaterThan(0)
    const row = (await rows()).find((r) => String(r.key).includes("/organization/set-active"))
    expect(row).toBeDefined()
  })
})
