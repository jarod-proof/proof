import { describe, expect, it } from "vitest"
import { createAuth, passkeyRpID } from "./index"

const make = (extra = {}) =>
  createAuth({
    db: {} as never,
    secret: "a-test-secret-that-is-long-enough-123456", // gitleaks:allow
    baseURL: "http://localhost:3000",
    emailFrom: "Test <auth@example.com>",
    ...extra,
  })

describe("createAuth", () => {
  it("builds a handler and api", () => {
    const auth = make()
    expect(typeof auth.handler).toBe("function")
    expect(auth.api).toBeDefined()
  })

  it("accepts a Wraps API key to enable contact sync", () => {
    expect(make({ wrapsApiKey: "wraps_test" }).handler).toBeDefined()
  })

  it("refuses a live Stripe key before anything can be charged", () => {
    expect(() =>
      make({
        stripe: { secretKey: "sk_live_placeholder", webhookSecret: "whsec_x" }, // gitleaks:allow
      }),
    ).toThrow(/test mode only/)
  })

  it("mounts the stripe plugin only when a test-mode key is configured", () => {
    const ids = (auth: ReturnType<typeof make>) => (auth.options.plugins ?? []).map((p) => p.id)
    expect(ids(make())).not.toContain("stripe")
    const billed = make({
      stripe: { secretKey: "sk_test_placeholder", webhookSecret: "whsec_x" }, // gitleaks:allow
    })
    expect(ids(billed)).toContain("stripe")
    expect(ids(billed)).toEqual(expect.arrayContaining(["sso", "scim", "proof-owner-only"]))
  })
})

describe("passkeyRpID", () => {
  it("is the host of a single origin, so production is unchanged", () => {
    expect(passkeyRpID(["https://app.example.com"])).toBe("app.example.com")
    expect(passkeyRpID(["http://127.0.0.1:3000"])).toBe("127.0.0.1")
  })

  it("is the shared parent of portless and vite origins under *.localhost", () => {
    expect(passkeyRpID(["https://api-app.localhost", "https://web.localhost"])).toBe("localhost")
    expect(passkeyRpID(["https://api.proof.localhost", "https://app.proof.localhost"])).toBe(
      "proof.localhost",
    )
  })

  it("is the shared domain of sibling hosts", () => {
    expect(passkeyRpID(["https://api.example.com", "https://app.example.com"])).toBe("example.com")
  })

  it("falls back to the first host when the origins share nothing", () => {
    expect(passkeyRpID(["http://127.0.0.1:3000", "http://localhost:5173"])).toBe("127.0.0.1")
  })

  it("never uses a bare TLD or an IP suffix as the RP ID", () => {
    expect(passkeyRpID(["https://api.acme.com", "https://web.other.com"])).toBe("api.acme.com")
    expect(passkeyRpID(["http://10.0.0.1:3000", "http://192.168.0.1:5173"])).toBe("10.0.0.1")
    expect(passkeyRpID(["http://127.0.0.1:3000", "http://127.0.0.1:5173"])).toBe("127.0.0.1")
  })

  it("refuses a web origin that is not a bare origin", () => {
    expect(() => make({ webOrigins: ["http://127.0.0.1:5173/"] })).toThrow(/bare origin/)
  })
})
