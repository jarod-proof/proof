import { createAuth } from "@proof/auth"
import { user } from "@proof/db"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { createHqApp } from "./app"
import { isFounder, parseFounders, syncFounders } from "./data/founders"
import { founders } from "./db/schema"
import { createHqTestDb } from "./testing"

// The N5 squatter: someone registers a founder's address before the founder does, so the account
// is theirs (they know its password), and the founder later verifies the address by clicking the
// emailed link. If hq then counted "a verified account with this address" as the founder, the
// squatter would be one. A deployed hq closes this two ways: public sign-up is off (so the
// registration cannot happen), and, should an account like that exist anyway, only an entry
// pinned by user id makes a founder. These tests run the squat in full, with sign-up OPEN for the
// squatter, so they pass because of the founders rule and not only because sign-up is closed.

const BASE = "http://localhost:3100"
const SECRET = "a-test-secret-that-is-long-enough-123456" // gitleaks:allow
const NOW = new Date("2026-11-17T12:00:00Z")
const FOUNDER = "founder@example.com"
const SQUATTER_PASSWORD = "squatter-password-1" // gitleaks:allow

describe("the N5 squatter on a founder's address", () => {
  let t: Awaited<ReturnType<typeof createHqTestDb>>
  let outbox: { to: string; link: string }[]
  const emailErrors: unknown[] = []
  let open: ReturnType<typeof makeAuth>
  let closed: ReturnType<typeof makeAuth>

  function makeAuth(allowSignUp: boolean) {
    return createAuth({
      db: t.db,
      secret: SECRET,
      baseURL: BASE,
      emailFrom: "Test <auth@example.com>",
      oauthResources: [BASE, `${BASE}/mcp`],
      ses: {
        client: {
          send: async (command: { input: unknown }) => {
            const raw = JSON.stringify(command.input)
            const to = (command.input as { Destination?: { ToAddresses?: string[] } }).Destination
            const link = (raw.match(/https?:\/\/[^"\s<>\\]+/g) ?? []).find((l) =>
              l.startsWith(BASE),
            )
            outbox.push({
              to: to?.ToAddresses?.[0] ?? "",
              link: (link ?? "").replaceAll("&amp;", "&"),
            })
            return { MessageId: `test-${outbox.length}`, $metadata: { requestId: "test" } }
          },
        },
      },
      // A send that fails must fail the test, not vanish.
      onEmailError: (error) => {
        emailErrors.push(error)
      },
      passwordBreachCheck: false,
      rateLimit: false,
      allowSignUp,
    })
  }

  beforeAll(async () => {
    t = await createHqTestDb()
    outbox = []
    open = makeAuth(true)
    closed = makeAuth(false)
  })
  afterAll(() => t.close())

  const post = (auth: ReturnType<typeof makeAuth>, path: string, body: unknown) =>
    auth.handler(
      new Request(`${BASE}/api/auth${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE },
        body: JSON.stringify(body),
      }),
    )

  /** The squat, step by step: sign up with the address, then the owner opens the emailed link. */
  async function squatThenOwnerVerifies(email: string) {
    expect(
      (await post(open, "/sign-up/email", { email, password: SQUATTER_PASSWORD, name: "Squatter" }))
        .status,
    ).toBe(200)
    const [fresh] = await t.db.select().from(user).where(eq(user.email, email))
    expect(fresh?.emailVerified).toBe(false)

    // The founder is asked to verify the address (any sign-in or settings prompt can send it).
    outbox.length = 0
    const asked = await post(open, "/send-verification-email", {
      email,
      callbackURL: `${BASE}/done`,
    })
    expect(asked.status).toBe(200)
    expect(emailErrors.map(String)).toEqual([])
    const mail = outbox.find((m) => m.to === email && m.link.includes("/verify-email"))
    expect(mail?.link).toBeTruthy()
    // ... and clicks it. The squatter's account is now a verified one, password and all.
    const clicked = await open.handler(new Request(mail?.link ?? ""))
    expect([200, 302]).toContain(clicked.status)
    const [verified] = await t.db.select().from(user).where(eq(user.email, email))
    expect(verified?.emailVerified).toBe(true)
    return verified?.id ?? ""
  }

  it("a squatter's account, verified by the founder's own click, is NOT a founder in a deployed hq", async () => {
    const squatterId = await squatThenOwnerVerifies(FOUNDER)

    // HQ_FOUNDERS lists the founder by address, as a local stack does. A deployed hq ignores it.
    const sync = await syncFounders(t.db, parseFounders(`${FOUNDER}=UFOUNDER`), NOW, {
      pinnedOnly: true,
    })
    expect(sync.added).toEqual([])
    expect(sync.skipped).toEqual([{ entry: 1, kind: "email", why: expect.stringMatching(/by id/) }])
    expect(await t.db.select().from(founders)).toEqual([])
    expect(await isFounder(t.db, squatterId)).toBe(false)

    // The squatter signs in with the password they set. hq turns them away at its front door.
    const app = createHqApp({ db: t.db, auth: closed, now: () => NOW, baseURL: BASE })
    const signIn = await post(closed, "/sign-in/email", {
      email: FOUNDER,
      password: SQUATTER_PASSWORD,
    })
    expect(signIn.status).toBe(200)
    const cookie = (signIn.headers.get("set-cookie") ?? "").split(";")[0] ?? ""
    expect((await app.request(`${BASE}/v1/status`, { headers: { cookie } })).status).toBe(403)
    expect((await app.request(`${BASE}/v1/entries`, { headers: { cookie } })).status).toBe(403)
  })

  it("and an account that is merely unverified is no founder either way", async () => {
    const email = "unverified-squat@example.com"
    await post(open, "/sign-up/email", { email, password: SQUATTER_PASSWORD, name: "S" })
    for (const pinnedOnly of [true, false]) {
      const sync = await syncFounders(t.db, parseFounders(`${email}=UUNVERIFIED`), NOW, {
        pinnedOnly,
      })
      expect(sync.added, `pinnedOnly ${pinnedOnly}`).toEqual([])
      expect(await t.db.select().from(founders)).toEqual([])
    }
  })

  it("pinning by id does not accept an unverified account either", async () => {
    const [row] = await t.db
      .select()
      .from(user)
      .where(eq(user.email, "unverified-squat@example.com"))
    const sync = await syncFounders(t.db, parseFounders(`id:${row?.id}=UUNVERIFIED`), NOW, {
      pinnedOnly: true,
    })
    expect(sync.added).toEqual([])
    expect(sync.skipped).toEqual([{ entry: 1, kind: "id", why: "the address is not verified" }])
  })

  it("the same squat in a local stack (e2e, development) does reach the founders, which is why a deployed hq is pinned", async () => {
    // Documented, not endorsed: a local stack seeds founders by the address they sign up with and
    // has no public mail, so this is how it works there. It is the pinnedOnly rule, not the closed
    // sign-up, that keeps this out of a deployed hq (the first test).
    const email = "local-squat@example.com"
    const squatterId = await squatThenOwnerVerifies(email)
    const sync = await syncFounders(t.db, parseFounders(`${email}=ULOCAL`), NOW)
    expect(sync.added).toEqual([squatterId])
  })

  it("with sign-up off, the squat cannot start: no account is made for the founder's address", async () => {
    const email = "never-registered@example.com"
    const refused = await post(closed, "/sign-up/email", {
      email,
      password: SQUATTER_PASSWORD,
      name: "S",
    })
    expect(refused.status).toBeGreaterThanOrEqual(400)
    expect(await t.db.select().from(user).where(eq(user.email, email))).toEqual([])
  })
})
