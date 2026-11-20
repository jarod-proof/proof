import type { Auth } from "@proof/auth"
import type { Logger } from "@proof/logger"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createTestApp } from "./app.test.helpers"
import type { ApiHooks } from "./hooks"

// better-auth reads the client address from x-proof-client-ip (its rate limiter keys on it).
// These check what reaches auth.handler, with the real app and auth on PGlite.
const HEADER = "x-proof-client-ip"

type TestApp = Awaited<ReturnType<typeof createTestApp>>

describe("client IP for better-auth", () => {
  let t: TestApp | undefined

  afterEach(async () => {
    await t?.close()
    t = undefined
    vi.restoreAllMocks()
  })

  /** Sends one request to an auth route and returns the header better-auth received. */
  async function seenByAuth(app: TestApp, headers: Record<string, string>): Promise<string | null> {
    const spy = vi.spyOn(app.auth, "handler")
    await app.req("/api/auth/ok", { headers })
    const received = spy.mock.calls[0]?.[0]
    if (!(received instanceof Request)) throw new Error("auth.handler was not called")
    return received.headers.get(HEADER)
  }

  it("replaces a client-sent copy with the address behind a trusted proxy", async () => {
    t = await createTestApp([], { trustProxy: true })
    const seen = await seenByAuth(t, {
      "x-forwarded-for": "203.0.113.7",
      [HEADER]: "9.9.9.9",
    })
    expect(seen).toBe("203.0.113.7")
  })

  it("uses the rightmost X-Forwarded-For entry, the one our proxy added", async () => {
    t = await createTestApp([], { trustProxy: true })
    const seen = await seenByAuth(t, { "x-forwarded-for": "10.0.0.1, 198.51.100.4" })
    expect(seen).toBe("198.51.100.4")
  })

  it("ignores X-Forwarded-For and a spoofed copy when the proxy is not trusted", async () => {
    t = await createTestApp([], { trustProxy: false })
    const seen = await seenByAuth(t, {
      "x-forwarded-for": "203.0.113.7",
      [HEADER]: "9.9.9.9",
    })
    // No socket in app.request, so there is no address to set: the spoofed copy is gone.
    expect(seen).toBeNull()
  })
})

describe("untrusted X-Forwarded-For warning", () => {
  // The warning is once per process, so each test loads a fresh copy of app.ts.
  async function freshApp(warn: ReturnType<typeof vi.fn>) {
    vi.resetModules()
    const { createApp } = await import("./app")
    const logger = { warn, info: vi.fn(), error: vi.fn() } as unknown as Logger
    const auth = { handler: async () => new Response("ok") } as unknown as Auth
    return createApp({
      auth,
      operations: [],
      baseURL: "http://localhost:3000",
      name: "Test API",
      version: "1.0.0",
      description: "A test API.",
      logger,
      hooks: {} as ApiHooks,
      trustProxy: false,
    })
  }
  const send = (app: Awaited<ReturnType<typeof freshApp>>, headers: Record<string, string> = {}) =>
    app.request("http://localhost:3000/api/auth/ok", { headers })

  it("warns once per process when X-Forwarded-For arrives without TRUST_PROXY", async () => {
    const warn = vi.fn()
    const app = await freshApp(warn)
    await send(app, { "x-forwarded-for": "203.0.113.7" })
    await send(app, { "x-forwarded-for": "203.0.113.8" })
    await send(app, { "x-forwarded-for": "203.0.113.9" })
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0]?.[0]).toMatch(/TRUST_PROXY/)
    expect(warn.mock.calls[0]?.[0]).toMatch(/rate limits are keyed on the proxy address/)
  })

  it("does not warn for a request without X-Forwarded-For", async () => {
    const warn = vi.fn()
    const app = await freshApp(warn)
    await send(app)
    expect(warn).not.toHaveBeenCalled()
  })
})
