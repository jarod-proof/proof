// Provisional signup: the key works at once, the claim email goes out once, the limits hold, and an
// existing email is refused without revealing more than that it exists.
// One database for the file (not one per test): each test uses its own addresses, IPs and domains,
// so the rate limits and the outbox filters don't see each other's signups.
import { createTestDb } from "@proof/db/testing"
import { AppError } from "@proof/errors"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createAuth } from "./index"
import { resolvePrincipal } from "./principal"
import { isClaimed, provisionalSignup, SIGNUP_LIMITS } from "./signup"

const BASE = "http://localhost:3000"
const AUDIENCE = `${BASE}/mcp`

interface SentEmail {
  to: string
  subject: string
  link: string
}

async function setup() {
  const t = await createTestDb()
  // Stands in for SES: records who got what, and the first app link in the body.
  const outbox: SentEmail[] = []
  const ses = {
    send: async (command: { input: unknown }) => {
      const raw = JSON.stringify(command.input)
      const input = command.input as { Destination?: { ToAddresses?: string[] } }
      const subject = /"Subject":\{"Data":"([^"]*)"/.exec(raw)?.[1] ?? ""
      const links = raw.match(/https?:\/\/[^"\s<>\\]+/g) ?? []
      const link = (links.find((l) => l.startsWith(BASE)) ?? "").replaceAll("&amp;", "&")
      outbox.push({ to: input.Destination?.ToAddresses?.[0] ?? "", subject, link })
      return { MessageId: `test-${outbox.length}`, $metadata: { requestId: "test" } }
    },
  }
  const auth = createAuth({
    db: t.db,
    secret: "a-test-secret-that-is-long-enough-123456", // gitleaks:allow
    baseURL: BASE,
    emailFrom: "Test <auth@example.com>",
    oauthResources: [BASE, AUDIENCE],
    ses: { client: ses },
    onEmailError: (error) => {
      throw error
    },
  })
  // better-auth initialises asynchronously (it seeds the OAuth resources); wait for it, or the
  // database can close under it.
  await auth.$context
  return { t, auth, outbox }
}

describe("provisionalSignup", () => {
  let s: Awaited<ReturnType<typeof setup>>
  beforeAll(async () => {
    s = await setup()
  })
  afterAll(() => s.t.close())

  /** The claim emails sent to one address, in order. */
  const mailTo = (address: string) => s.outbox.filter((m) => m.to === address)

  it("creates an unverified user, a personal org and a key that authenticates", async () => {
    const signup = await provisionalSignup(s.auth, {
      email: "Agent@Example.com",
      name: "Agent",
      ip: "203.0.113.1",
    })
    expect(signup.apiKey.startsWith("sk_")).toBe(true)

    const principal = await resolvePrincipal(s.auth, new Headers({ "x-api-key": signup.apiKey }), {
      audience: AUDIENCE,
    })
    expect(principal).toMatchObject({
      organizationId: signup.organizationId,
      via: "api-key",
    })
    // The key can do the project operations, and nothing about the org's members.
    const granted = principal?.grants[0] ?? {}
    expect(granted).toMatchObject({ project: ["read", "create", "update", "delete"] })
    expect(granted).not.toHaveProperty("member")

    const ctx = await s.auth.$context
    const user = await ctx.adapter.findOne<{ email: string; emailVerified: boolean }>({
      model: "user",
      where: [{ field: "id", value: signup.userId }],
    })
    expect(user).toMatchObject({ email: "agent@example.com", emailVerified: false })
    expect(isClaimed(user ?? { emailVerified: false })).toBe(false)
  })

  it("sends one claim email, a password reset link that lands on /claim", async () => {
    await provisionalSignup(s.auth, { email: "claim@example.org", ip: "203.0.113.2" })
    await waitFor(() => expect(mailTo("claim@example.org")).toHaveLength(1))
    const [mail] = mailTo("claim@example.org")
    expect(mail?.link).toMatch(/^http:\/\/localhost:3000\/api\/auth\/reset-password\//)
    expect(mail?.link).toContain(`callbackURL=${encodeURIComponent(`${BASE}/claim`)}`)
  })

  it("is claimed once the emailed link sets a password", async () => {
    const signup = await provisionalSignup(s.auth, {
      email: "later@example.org",
      ip: "203.0.113.3",
    })
    await waitFor(() => expect(mailTo("later@example.org")).toHaveLength(1))
    const token = /reset-password\/([^?]+)/.exec(mailTo("later@example.org")[0]?.link ?? "")?.[1]
    expect(token).toBeTruthy()

    await s.auth.api.resetPassword({
      body: { newPassword: "a-claimed-passphrase", token: token ?? "" },
    })

    const ctx = await s.auth.$context
    const user = await ctx.adapter.findOne<{ id: string; emailVerified: boolean }>({
      model: "user",
      where: [{ field: "id", value: signup.userId }],
    })
    expect(isClaimed(user ?? { emailVerified: false })).toBe(true)
    // Whoever called signup held the key, and it may not be the person who owns the address: the
    // claim turns it off, and the refusal tells the agent how to get a credential the person grants.
    const refused = await resolvePrincipal(s.auth, new Headers({ "x-api-key": signup.apiKey }), {
      audience: AUDIENCE,
    }).catch((e: unknown) => e)
    expect(refused).toBeInstanceOf(AppError)
    expect(refused).toMatchObject({ code: "UNAUTHORIZED" })
    expect((refused as AppError).hint).toMatch(/claimed the account.*device grant/is)
  })

  it("turns the key off when the address is verified by email instead", async () => {
    const signup = await provisionalSignup(s.auth, {
      email: "verifies@example.org",
      ip: "203.0.113.30",
    })
    await waitFor(() => expect(mailTo("verifies@example.org")).toHaveLength(1))
    const ctx = await s.auth.$context
    // What better-auth's /verify-email does once the emailed link is opened.
    await ctx.internalAdapter.updateUser(signup.userId, { emailVerified: true })

    const refused = await resolvePrincipal(s.auth, new Headers({ "x-api-key": signup.apiKey }), {
      audience: AUDIENCE,
    }).catch((e: unknown) => e)
    expect(refused).toMatchObject({ code: "UNAUTHORIZED" })
  })

  it("refuses an existing email with CONFLICT, without saying more than that it exists", async () => {
    await provisionalSignup(s.auth, { email: "taken@example.org", ip: "203.0.113.4" })
    const error = await provisionalSignup(s.auth, {
      email: "taken@example.org",
      ip: "203.0.113.5",
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).code).toBe("CONFLICT")
    expect((error as AppError).message).toBe(
      "An account already exists for this email. Use sign-in.",
    )
  })

  it("rejects an address that isn't an email", async () => {
    const error = await provisionalSignup(s.auth, { email: "nope", ip: "203.0.113.6" }).catch(
      (e: unknown) => e,
    )
    expect((error as AppError).code).toBe("BAD_REQUEST")
  })

  it(`allows ${SIGNUP_LIMITS.perIpPerHour} attempts per IP per hour, then rate limits`, async () => {
    for (let i = 0; i < SIGNUP_LIMITS.perIpPerHour; i++) {
      await provisionalSignup(s.auth, { email: `ip${i}@site${i}.test`, ip: "198.51.100.9" })
    }
    const error = (await provisionalSignup(s.auth, {
      email: "one-more@site-x.test",
      ip: "198.51.100.9",
    }).catch((e: unknown) => e)) as AppError
    expect(error.code).toBe("RATE_LIMITED")
    expect(error.context).toEqual({ retryAfter: 3600 })
    expect(error.headers).toEqual({ "retry-after": "3600" })
    // Another network is unaffected.
    await provisionalSignup(s.auth, { email: "elsewhere@site-y.test", ip: "198.51.100.10" })
  })

  it(`allows ${SIGNUP_LIMITS.perDomainPerDay} signups per email domain per day, then rate limits`, async () => {
    for (let i = 0; i < SIGNUP_LIMITS.perDomainPerDay; i++) {
      await provisionalSignup(s.auth, { email: `a${i}@shared.test`, ip: `192.0.2.${i + 1}` })
    }
    const error = (await provisionalSignup(s.auth, {
      email: "over@shared.test",
      ip: "192.0.2.250",
    }).catch((e: unknown) => e)) as AppError
    expect(error.code).toBe("RATE_LIMITED")
    expect(error.context).toEqual({ retryAfter: 86_400 })
    expect(error.headers).toEqual({ "retry-after": "86400" })
    // Other domains are unaffected.
    await provisionalSignup(s.auth, { email: "fine@other.test", ip: "192.0.2.251" })
  })
})

/** Email goes out in the background after the request returns, so poll for it. */
async function waitFor(assertion: () => void, timeoutMs = 5_000) {
  const started = Date.now()
  for (;;) {
    try {
      assertion()
      return
    } catch (error) {
      if (Date.now() - started > timeoutMs) throw error
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
}
