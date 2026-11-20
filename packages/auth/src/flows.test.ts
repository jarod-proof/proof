import { createTestDb } from "@proof/db/testing"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createAuth } from "./index"

describe("auth flows (real Postgres via PGlite)", () => {
  let auth: ReturnType<typeof createAuth>
  let close: () => Promise<void>

  beforeAll(async () => {
    const t = await createTestDb()
    close = t.close
    auth = createAuth({
      db: t.db,
      secret: "a-test-secret-that-is-long-enough-123456", // gitleaks:allow
      baseURL: "http://localhost:3000",
      emailFrom: "Test <auth@example.com>",
    })
  })
  afterAll(() => close())

  const creds = { email: "ada@example.com", password: "correct-horse-battery", name: "Ada" }

  it("signs a user up and returns a session token", async () => {
    const res = await auth.api.signUpEmail({ body: creds })
    expect(res.user.email).toBe(creds.email)
    expect(res.token).toBeTruthy()
  })

  it("rejects a duplicate email", async () => {
    await expect(auth.api.signUpEmail({ body: creds })).rejects.toMatchObject({
      statusCode: 422,
      body: { code: "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL" },
    })
  })

  it("signs in with the right password", async () => {
    const res = await auth.api.signInEmail({
      body: { email: creds.email, password: creds.password },
    })
    expect(res.user.email).toBe(creds.email)
  })

  it("rejects the wrong password", async () => {
    await expect(
      auth.api.signInEmail({ body: { email: creds.email, password: "wrong-password-123" } }),
    ).rejects.toMatchObject({ statusCode: 401, body: { code: "INVALID_EMAIL_OR_PASSWORD" } })
  })
})
