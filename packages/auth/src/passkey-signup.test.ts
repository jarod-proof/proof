// Passkey sign-up, email first (passkey-signup.ts). A new email gets an unverified account and a
// link, and nothing else: no credential, no session. Opening the link proves the mailbox and signs
// in; the passkey is then added under that session by passkey()'s own defaults. The attack case: a
// stranger who starts sign-up for someone else's address can't register a passkey for it.
import { passkey } from "@better-auth/passkey"
import * as schema from "@proof/db/schema"
import { createTestDb } from "@proof/db/testing"
import { betterAuth } from "better-auth"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { organization } from "better-auth/plugins"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { type Adapter, personalOrganization } from "./membership"
import {
  PASSKEY_SIGNUP_LANDING_PATH,
  PASSKEY_SIGNUP_LINK_ERROR,
  PASSKEY_SIGNUP_VERIFY_PATH,
  passkeySignupPlugin,
  safePath,
} from "./passkey-signup"

const BASE = "http://localhost:3000"

interface SentLink {
  email: string
  url: string
}

async function setup() {
  const t = await createTestDb()
  const outbox: SentLink[] = []
  // A ref, as index.ts does: the user hook needs the adapter, which exists only after init.
  const ref: { adapter?: Adapter } = {}
  const auth = betterAuth({
    secret: "a-test-secret-that-is-long-enough-123456", // gitleaks:allow
    baseURL: BASE,
    database: drizzleAdapter(t.db, { provider: "pg", schema, transaction: true }),
    emailAndPassword: { enabled: true },
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            if (ref.adapter) await personalOrganization(ref.adapter, user)
          },
        },
      },
    },
    plugins: [
      organization(),
      // Default options: passkey adds need a fresh session, exactly as in production.
      passkey({ rpID: "localhost", rpName: "Test", origin: BASE }),
      passkeySignupPlugin({
        db: t.db,
        sendLink: async ({ email, url }) => {
          outbox.push({ email, url })
        },
      }),
    ],
  })
  const ctx = await auth.$context
  ref.adapter = ctx.adapter as unknown as Adapter
  return { t, auth, ctx, outbox }
}

/** A request from its own address, so the per-IP limit never mixes tests. */
let ipCounter = 0
const fromNewIp = () => {
  ipCounter++
  return new Headers({
    "x-forwarded-for": `10.1.${Math.floor(ipCounter / 250)}.${ipCounter % 250}`,
  })
}

/** The Cookie header a browser would send back, from a response's Set-Cookie headers. */
const cookieOf = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ")

describe("passkey sign-up", () => {
  let s: Awaited<ReturnType<typeof setup>>
  beforeAll(async () => {
    s = await setup()
  })
  afterAll(() => s.t.close())

  // The endpoint takes an untyped body (this package has no schema library), so type its call here.
  const startApi = (input: { body: { email: string; name: string }; headers: Headers }) =>
    (s.auth.api.passkeySignupStart as unknown as (i: typeof input) => Promise<{ sent: boolean }>)(
      input,
    )
  const start = (email: string, name = "New Person") =>
    startApi({ body: { email, name }, headers: fromNewIp() })

  /** Opens a link the way the browser does: a GET to the verify route. */
  const open = (url: string) => s.auth.handler(new Request(url, { redirect: "manual" }))

  /** A refused link: back to the landing page with the code, and no session cookie. */
  const expectRefused = (res: Response) => {
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe(
      `${PASSKEY_SIGNUP_LANDING_PATH}?error=${PASSKEY_SIGNUP_LINK_ERROR}`,
    )
    expect(res.headers.get("set-cookie")).toBeNull()
  }

  const linkFor = (email: string) => {
    const link = s.outbox.filter((m) => m.email === email).at(-1)
    if (!link) throw new Error(`no link sent to ${email}`)
    return link.url
  }

  const userRow = async (email: string) =>
    (await s.ctx.internalAdapter.findUserByEmail(email))?.user

  const passkeysOf = (userId: string) =>
    s.t.db.select().from(schema.passkey).where(eq(schema.passkey.userId, userId))

  it("a new email gets an unverified account, a personal organization and a link, but no credential", async () => {
    const result = await (
      s.auth.api.passkeySignupStart as unknown as (i: unknown) => Promise<{
        headers: Headers
        response: unknown
      }>
    )({
      body: { email: "fresh.person@example.com", name: "Fresh" },
      headers: fromNewIp(),
      returnHeaders: true,
    })
    expect(result.headers.get("set-cookie")).toBeNull()
    expect(result.response).toEqual({ sent: true })

    const user = await userRow("fresh.person@example.com")
    expect(user?.emailVerified).toBe(false)
    const member = await s.ctx.adapter.findOne<{ organizationId: string }>({
      model: "member",
      where: [{ field: "userId", value: user?.id ?? "" }],
    })
    expect(member).not.toBeNull()
    expect(linkFor("fresh.person@example.com")).toContain(PASSKEY_SIGNUP_VERIFY_PATH)
    expect(await passkeysOf(user?.id ?? "")).toHaveLength(0)
  })

  it("the attack: someone who starts sign-up for a victim's address can't register a passkey for it", async () => {
    await start("victim@example.com")
    const victim = await userRow("victim@example.com")
    // The attacker has no session: passkey's own registration check refuses.
    await expect(
      s.auth.api.generatePasskeyRegistrationOptions({ query: {} }),
    ).rejects.toMatchObject({ body: { code: "UNAUTHORIZED" } })
    expect(await passkeysOf(victim?.id ?? "")).toHaveLength(0)
  })

  it("opening the link proves the mailbox, signs the person in, and then a passkey can be added", async () => {
    await start("link.person@example.com", "Link Person")
    const res = await open(linkFor("link.person@example.com"))
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe("/")
    const cookie = cookieOf(res)
    expect(cookie).toContain("better-auth.session_token")
    expect((await userRow("link.person@example.com"))?.emailVerified).toBe(true)

    // The session from the link is fresh, so passkey's default registration accepts it.
    const options = await s.auth.api.generatePasskeyRegistrationOptions({
      headers: new Headers({ cookie }),
    })
    expect(options.user.name).toBe("link.person@example.com")
  })

  it("the link works once: a replay is refused", async () => {
    await start("replay.person@example.com")
    const url = linkFor("replay.person@example.com")
    expect((await open(url)).status).toBe(302)
    expectRefused(await open(url))
  })

  it("a forged link is refused", async () => {
    const res = await open(`${BASE}/api/auth${PASSKEY_SIGNUP_VERIFY_PATH}?token=${"A".repeat(43)}`)
    expectRefused(res)
  })

  it("a refused link never redirects to the callbackURL it carries", async () => {
    const res = await open(
      `${BASE}/api/auth${PASSKEY_SIGNUP_VERIFY_PATH}?token=${"B".repeat(43)}&callbackURL=${encodeURIComponent("https://evil.example.com")}`,
    )
    expectRefused(res)
  })

  it("an expired link is refused and verifies nothing", async () => {
    await start("expired.person@example.com")
    const url = linkFor("expired.person@example.com")
    const token = new URL(url).searchParams.get("token") ?? ""
    await s.t.db
      .update(schema.verification)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.verification.identifier, `passkey-signup:${token}`))
    expectRefused(await open(url))
    expect((await userRow("expired.person@example.com"))?.emailVerified).toBe(false)
  })

  it("an existing email is refused with CONFLICT, so no passkey can attach to that account", async () => {
    await s.auth.api.signUpEmail({
      body: { email: "taken@example.com", password: "correct-horse-battery", name: "Taken" },
    })
    await expect(start("taken@example.com")).rejects.toMatchObject({
      body: { code: "ACCOUNT_EXISTS" },
    })
  })

  it("keeps the callback only when it stays on this site", () => {
    expect(safePath("/sign-up/passkey")).toBe("/sign-up/passkey")
    expect(safePath("https://evil.example.com")).toBe("/")
    expect(safePath("//evil.example.com")).toBe("/")
    expect(safePath("/\\evil.example.com")).toBe("/")
    expect(safePath(undefined)).toBe("/")
  })
})
