import { user } from "@proof/db"
import { createTestDb } from "@proof/db/testing"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createHqAuth } from "./auth"

const BASE = "http://localhost:3100"
const SECRET = "a-test-secret-that-is-long-enough-123456" // gitleaks:allow

const signUp = (auth: ReturnType<typeof createHqAuth>, email: string) =>
  auth.handler(
    new Request(`${BASE}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify({ email, password: "stranger-password-1", name: "Stranger" }),
    }),
  )

describe("hq's sign-up", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it("is closed by default: nothing in the environment, no account", async () => {
    vi.stubEnv("SKIP_ENV_VALIDATION", "1")
    vi.stubEnv("HQ_DATABASE_URL", "postgres://u:p@localhost:5432/proof_wt_x")
    vi.stubEnv("HQ_ALLOW_SIGNUP", undefined)
    vi.resetModules()
    const { hqEnv } = await import("./env")
    const config = hqEnv("3100")
    expect(config.allowSignUp).toBe(false)

    const t = await createTestDb()
    try {
      const auth = createHqAuth(t.db, {
        ...config,
        secret: SECRET,
        baseURL: BASE,
        emailFrom: "Test <auth@example.com>",
      })
      const res = await signUp(auth, "stranger@example.com")
      expect(res.status).toBeGreaterThanOrEqual(400)
      expect(res.status).toBeLessThan(500)
      // A real POST to /api/auth/sign-up/email created no user row.
      expect(await t.db.select().from(user)).toEqual([])
    } finally {
      await t.close()
    }
  })

  it("opens only when HQ_ALLOW_SIGNUP is set, as the e2e and test stacks do", async () => {
    const t = await createTestDb()
    try {
      const auth = createHqAuth(t.db, {
        secret: SECRET,
        baseURL: BASE,
        emailFrom: "Test <auth@example.com>",
        allowSignUp: true,
      })
      expect((await signUp(auth, "founder@example.com")).status).toBe(200)
      expect(await t.db.select().from(user)).toHaveLength(1)
    } finally {
      await t.close()
    }
  })
})
