// A password reset that reclaims an account: what the squatter planted before the reset stops
// working. Sign-up can also be closed (hq), and a closed sign-up creates no user over HTTP.
import { apikey, oauthAccessToken, oauthClient, oauthConsent, user } from "@proof/db/schema"
import { createTestDb } from "@proof/db/testing"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createAuth } from "./index"
import { firstMembership } from "./membership"
import { provisionalSignup } from "./signup"

const BASE = "http://localhost:3000"
const FAR = new Date("2030-01-01T00:00:00Z")
const T0 = new Date("2026-01-01T00:00:00Z")

async function setup(options: { allowSignUp?: boolean } = {}) {
  const t = await createTestDb()
  const outbox: { to: string; link: string }[] = []
  const ses = {
    send: async (command: { input: unknown }) => {
      const raw = JSON.stringify(command.input)
      const to = (command.input as { Destination?: { ToAddresses?: string[] } }).Destination
      const link = (raw.match(/https?:\/\/[^"\s<>\\]+/g) ?? []).find((l) => l.startsWith(BASE))
      outbox.push({ to: to?.ToAddresses?.[0] ?? "", link: (link ?? "").replaceAll("&amp;", "&") })
      return { MessageId: `test-${outbox.length}`, $metadata: { requestId: "test" } }
    },
  }
  const auth = createAuth({
    db: t.db,
    secret: "a-test-secret-that-is-long-enough-123456", // gitleaks:allow
    baseURL: BASE,
    emailFrom: "Test <auth@example.com>",
    oauthResources: [BASE, `${BASE}/mcp`],
    ses: { client: ses },
    ...options,
    rateLimit: false,
  })
  await auth.$context
  return { t, auth, outbox }
}

/** POST JSON to a better-auth route, as a browser would (a trusted Origin). */
const post = (auth: { handler: (r: Request) => Promise<Response> }, path: string, body: unknown) =>
  auth.handler(
    new Request(`${BASE}/api/auth${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify(body),
    }),
  )

describe("a password reset that reclaims an account (HTTP)", () => {
  let s: Awaited<ReturnType<typeof setup>>
  beforeAll(async () => {
    s = await setup()
    await s.t.db.insert(oauthClient).values({ id: "agent", clientId: "agent", redirectUris: [] })
  })
  afterAll(() => s.t.close())

  async function squat(email: string) {
    const signUp = await post(s.auth, "/sign-up/email", {
      email,
      password: "squatter-password-1",
      name: "Squatter",
    })
    expect(signUp.status).toBe(200)
    const [row] = await s.t.db.select().from(user).where(eq(user.email, email))
    if (!row) throw new Error("no user")
    const member = await firstMembership((await s.auth.$context).adapter, row.id)
    if (!member) throw new Error("no organization")
    // What the squatter planted: an organization key and an OAuth grant.
    const key = await s.auth.api.createApiKey({
      body: {
        organizationId: member.organizationId,
        userId: row.id,
        permissions: { hq_entry: ["read"] },
      },
    })
    await s.t.db.insert(oauthConsent).values({
      id: `c-${row.id}`,
      clientId: "agent",
      userId: row.id,
      referenceId: member.organizationId,
      scopes: ["read"],
      createdAt: T0,
      updatedAt: T0,
    })
    await s.t.db.insert(oauthAccessToken).values({
      id: `a-${row.id}`,
      token: `a-${row.id}`,
      clientId: "agent",
      userId: row.id,
      referenceId: member.organizationId,
      scopes: ["read"],
      expiresAt: FAR,
      createdAt: T0,
    })
    return { userId: row.id, orgId: member.organizationId, keyId: key.id }
  }

  async function reset(email: string) {
    s.outbox.length = 0
    const asked = await post(s.auth, "/request-password-reset", {
      email,
      redirectTo: `${BASE}/reset`,
    })
    expect(asked.status).toBe(200)
    const mail = s.outbox.find((m) => m.to === email)
    const token = /reset-password\/([^?]+)/.exec(mail?.link ?? "")?.[1]
    if (!token) throw new Error(`no reset mail for ${email}`)
    const done = await post(s.auth, "/reset-password", {
      token,
      newPassword: "the-real-owner-password-9",
    })
    expect(done.status).toBe(200)
  }

  const keyEnabled = async (id: string) =>
    (await s.t.db.select({ enabled: apikey.enabled }).from(apikey).where(eq(apikey.id, id)))[0]
      ?.enabled
  const grantsLeft = async (userId: string) => ({
    consents: (await s.t.db.select().from(oauthConsent).where(eq(oauthConsent.userId, userId)))
      .length,
    live: (
      await s.t.db.select().from(oauthAccessToken).where(eq(oauthAccessToken.userId, userId))
    ).filter((t) => t.revoked === null).length,
  })

  it("disables the keys and ends the OAuth grants an unverified account held before the reset", async () => {
    const email = "founder@example.com"
    const squatted = await squat(email)
    expect(await keyEnabled(squatted.keyId)).toBe(true)

    await reset(email)

    expect(await keyEnabled(squatted.keyId)).toBe(false)
    expect(await grantsLeft(squatted.userId)).toEqual({ consents: 0, live: 0 })
    // The owner now holds the account: the address counts as verified.
    const [row] = await s.t.db.select().from(user).where(eq(user.id, squatted.userId))
    expect(row?.emailVerified).toBe(true)
  })

  it("a key made after the reset works: only what predates it is disabled", async () => {
    const email = "founder2@example.com"
    const squatted = await squat(email)
    await reset(email)
    const fresh = await s.auth.api.createApiKey({
      body: {
        organizationId: squatted.orgId,
        userId: squatted.userId,
        permissions: { hq_entry: ["read"] },
      },
    })
    expect(await keyEnabled(squatted.keyId)).toBe(false)
    expect(await keyEnabled(fresh.id)).toBe(true)
  })

  it("a reset of an already verified account ends its OAuth grants but leaves its keys alone", async () => {
    const email = "verified@example.com"
    const owner = await squat(email)
    await s.t.db.update(user).set({ emailVerified: true }).where(eq(user.id, owner.userId))

    await reset(email)

    expect(await keyEnabled(owner.keyId)).toBe(true)
    expect(await grantsLeft(owner.userId)).toEqual({ consents: 0, live: 0 })
  })
})

describe("closed sign-up (allowSignUp: false)", () => {
  let s: Awaited<ReturnType<typeof setup>>
  beforeAll(async () => {
    s = await setup({ allowSignUp: false })
  })
  afterAll(() => s.t.close())

  it("a POST to /api/auth/sign-up/email is refused and creates no user", async () => {
    const res = await post(s.auth, "/sign-up/email", {
      email: "stranger@example.com",
      password: "stranger-password-1",
      name: "Stranger",
    })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
    expect(await s.t.db.select().from(user)).toEqual([])
  })

  it("closes the other ways to make an account too: a provisional sign-up creates no user", async () => {
    await expect(
      provisionalSignup(s.auth, { email: "provisional@example.com", ip: "203.0.113.9" }),
    ).rejects.toThrow()
    expect(await s.t.db.select().from(user)).toEqual([])
  })

  it("sign-up stays open by default", async () => {
    const open = await setup()
    try {
      const res = await post(open.auth, "/sign-up/email", {
        email: "anyone@example.com",
        password: "anyone-password-1",
        name: "Anyone",
      })
      expect(res.status).toBe(200)
    } finally {
      await open.t.close()
    }
  })
})
