import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createAuth } from "@proof/auth"
import { member, organization, session, user } from "@proof/db"
import { and, eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { createHqApp } from "./app"
import { CreateFounderRefused, createFounder } from "./create-founder-account"
import { founderForSlackUser, isFounder, syncFounders } from "./data/founders"
import { founders } from "./db/schema"
import { createHqTestDb } from "./testing"
import { openPasswordFile } from "./password-file"

const BASE = "http://localhost:3100"
const SECRET = "a-test-secret-that-is-long-enough-123456" // gitleaks:allow
const NOW = new Date("2026-11-17T12:00:00Z")
const FOUNDER = "founder@example.com"

/** A deployed hq: production, public sign-up off. */
const DEPLOYED: { nodeEnv: string | undefined; allowSignUp: boolean } = {
  nodeEnv: "production",
  allowSignUp: false,
}

/** An auth on the test database, as hq builds one: sign-up open or closed, mail kept in an outbox. */
function makeAuth(db: Awaited<ReturnType<typeof createHqTestDb>>["db"], allowSignUp: boolean) {
  return createAuth({
    db,
    secret: SECRET,
    baseURL: BASE,
    emailFrom: "Test <auth@example.com>",
    oauthResources: [BASE, `${BASE}/mcp`],
    ses: { client: { send: async () => ({ MessageId: "test", $metadata: {} }) } },
    onEmailError: (error) => {
      throw error
    },
    passwordBreachCheck: false,
    rateLimit: false,
    allowSignUp,
  })
}

describe("create-founder (real Postgres via PGlite)", () => {
  let t: Awaited<ReturnType<typeof createHqTestDb>>
  // What a deployed hq serves: sign-up closed. And what the script uses in-process: open, unserved.
  let served: ReturnType<typeof makeAuth>
  let inProcess: ReturnType<typeof makeAuth>
  let app: ReturnType<typeof createHqApp>

  beforeAll(async () => {
    t = await createHqTestDb()
    served = makeAuth(t.db, false)
    inProcess = makeAuth(t.db, true)
    app = createHqApp({ db: t.db, auth: served, now: () => NOW, baseURL: BASE })
  })
  afterAll(() => t.close())

  const post = (path: string, body: unknown) =>
    app.request(`${BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify(body),
    })
  const accounts = async () => (await t.db.select({ email: user.email }).from(user)).length

  const deps = (over: { env?: typeof DEPLOYED; deliver?: (p: string) => Promise<void> } = {}) => ({
    db: t.db,
    auth: inProcess,
    now: () => NOW,
    env: over.env ?? DEPLOYED,
    deliverPassword: over.deliver ?? (async () => undefined),
  })

  it("with sign-up off, the only way a founder's account exists is the script, and it works", async () => {
    // Closed: a stranger's sign-up with the founder's address makes nothing.
    const refused = await post("/api/auth/sign-up/email", {
      email: FOUNDER,
      password: "squatter-password-1",
      name: "Squatter",
    })
    expect(refused.status).toBeGreaterThanOrEqual(400)
    expect(refused.status).toBeLessThan(500)
    expect(await accounts()).toBe(0)

    let delivered = ""
    const created = await createFounder(
      deps({
        deliver: async (password) => {
          delivered = password
        },
      }),
      { email: "  Founder@Example.com ", slackUserId: "UFOUNDER" },
    )

    // The account exists: verified, no session left over, linked as the founder by id.
    const [row] = await t.db.select().from(user).where(eq(user.email, FOUNDER))
    expect(row).toMatchObject({ id: created.userId, emailVerified: true })
    expect(await t.db.select().from(session).where(eq(session.userId, created.userId))).toEqual([])
    expect(await t.db.select().from(founders)).toEqual([
      { userId: created.userId, slackUserId: "UFOUNDER", createdAt: NOW },
    ])
    expect(await isFounder(t.db, created.userId)).toBe(true)
    expect(created.entry).toBe(`id:${created.userId}=UFOUNDER`)
    // The password went to the channel, and nowhere else.
    expect(delivered.length).toBeGreaterThanOrEqual(32)
    expect(JSON.stringify(created)).not.toContain(delivered)

    // They sign in with it over HTTP, and hq lets them in; sign-up for another address still fails.
    const signIn = await post("/api/auth/sign-in/email", { email: FOUNDER, password: delivered })
    expect(signIn.status).toBe(200)
    const cookie = (signIn.headers.get("set-cookie") ?? "").split(";")[0] ?? ""
    expect((await app.request(`${BASE}/v1/status`, { headers: { cookie } })).status).toBe(200)
    expect(
      (
        await post("/api/auth/sign-up/email", {
          email: "other@example.com",
          password: "stranger-password-1",
          name: "Other",
        })
      ).status,
    ).toBeGreaterThanOrEqual(400)
    expect(await accounts()).toBe(1)

    // The id entry keeps them at every boot of a deployed hq; the email entry does not.
    const pinned = await syncFounders(
      t.db,
      [{ who: { userId: created.userId }, slackUserId: "UFOUNDER" }],
      NOW,
      { pinnedOnly: true },
    )
    expect(pinned).toEqual({ added: [], removed: [], skipped: [] })
    expect(await founderForSlackUser(t.db, "UFOUNDER")).toEqual({ userId: created.userId })

    const byEmail = await syncFounders(
      t.db,
      [{ who: { email: FOUNDER }, slackUserId: "UFOUNDER" }],
      NOW,
      { pinnedOnly: true },
    )
    expect(byEmail.removed).toEqual([created.userId])
    expect(byEmail.skipped).toEqual([
      { entry: 1, kind: "email", why: expect.stringMatching(/by id/) },
    ])
    // The skipped line names the entry, never the address.
    expect(JSON.stringify(byEmail.skipped)).not.toContain("example.com")
    expect(await isFounder(t.db, created.userId)).toBe(false)
  })

  it("the account owns an organization, so mint-agent-key can make its agent key, and that key reaches hq", async () => {
    const created = await createFounder(deps(), {
      email: "owner@example.com",
      slackUserId: "UOWNER",
    })
    // What mint-agent-key looks up: an organization the founder owns.
    const [owned] = await t.db
      .select({ organizationId: member.organizationId })
      .from(member)
      .where(and(eq(member.userId, created.userId), eq(member.role, "owner")))
    expect(owned?.organizationId).toBeTruthy()
    const key = await inProcess.api.createApiKey({
      body: {
        organizationId: owned?.organizationId ?? "",
        userId: created.userId,
        permissions: { hq_entry: ["read"], hq_spend: ["read", "record", "request"] },
      },
    })
    const status = await app.request(`${BASE}/v1/status`, { headers: { "x-api-key": key.key } })
    expect(status.status).toBe(200)
  })

  it("fails closed when sign-up answers with an id that names no account: no founder row for nothing", async () => {
    // A duplicate that better-auth hides answers with a made-up user id and creates nothing.
    const hidden: typeof inProcess = Object.create(inProcess, {
      api: {
        value: { ...inProcess.api, signUpEmail: async () => ({ user: { id: "ghost-account" } }) },
      },
    })
    const before = await accounts()
    const error = await createFounder(
      { ...deps(), auth: hidden },
      { email: "ghost@example.com", slackUserId: "UGHOST" },
    ).catch((e: unknown) => e)
    expect((error as Error).message).toMatch(/not found to verify/)
    expect(await t.db.select().from(founders).where(eq(founders.userId, "ghost-account"))).toEqual(
      [],
    )
    expect(await founderForSlackUser(t.db, "UGHOST")).toBeNull()
    expect(await accounts()).toBe(before)
  })

  it("when linking the founder fails, the new account is removed and a re-run goes through", async () => {
    const before = await accounts()
    const orgsBefore = (await t.db.select({ id: organization.id }).from(organization)).length
    // Between the checks and the link, another founder takes the Slack user.
    const error = await createFounder(
      deps({
        deliver: async () => {
          await t.db
            .insert(founders)
            .values({ userId: "taken-by-someone", slackUserId: "ULINKFAIL", createdAt: NOW })
        },
      }),
      { email: "link-fail@example.com", slackUserId: "ULINKFAIL" },
    ).catch((e: unknown) => e)
    expect(error).not.toBeInstanceOf(CreateFounderRefused)
    expect((error as Error).message).toMatch(/could not be linked.*account was removed/)
    expect(await accounts()).toBe(before)
    expect(await t.db.select().from(user).where(eq(user.email, "link-fail@example.com"))).toEqual(
      [],
    )
    // Its personal organization went with it: no empty organization is left behind.
    expect((await t.db.select({ id: organization.id }).from(organization)).length).toBe(orgsBefore)

    // The Slack user is free again; the same command now works, not refused as a squatter's.
    await t.db.delete(founders).where(eq(founders.userId, "taken-by-someone"))
    const again = await createFounder(deps(), {
      email: "link-fail@example.com",
      slackUserId: "ULINKFAIL",
    })
    expect(await isFounder(t.db, again.userId)).toBe(true)
  })

  it("refuses an address that already has an unverified account (a squatter's), and creates nothing", async () => {
    // The squat happened earlier, in some open window.
    await inProcess.api.signUpEmail({
      body: { email: "squatted@example.com", password: "squatter-password-1", name: "S" },
    })
    const before = await accounts()
    let asked = false
    const error = await createFounder(
      deps({
        deliver: async () => {
          asked = true
        },
      }),
      { email: "squatted@example.com", slackUserId: "USQUATTED" },
    ).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CreateFounderRefused)
    expect((error as Error).message).toMatch(/UNVERIFIED account.*squatter/s)
    expect(asked).toBe(false)
    expect(await accounts()).toBe(before)
    expect(await founderForSlackUser(t.db, "USQUATTED")).toBeNull()
    const [row] = await t.db.select().from(user).where(eq(user.email, "squatted@example.com"))
    expect(row?.emailVerified).toBe(false)
  })

  it("refuses an address whose account is verified too: the squatter may have held it", async () => {
    await inProcess.api.signUpEmail({
      body: { email: "verified-squat@example.com", password: "squatter-password-1", name: "S" },
    })
    await t.db
      .update(user)
      .set({ emailVerified: true })
      .where(eq(user.email, "verified-squat@example.com"))
    const error = await createFounder(deps(), {
      email: "verified-squat@example.com",
      slackUserId: "UVERIFIEDSQ",
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CreateFounderRefused)
    expect((error as Error).message).toMatch(/already exists/)
    expect(await founderForSlackUser(t.db, "UVERIFIEDSQ")).toBeNull()
  })

  it("refuses when HQ_ALLOW_SIGNUP is on in a deployed env, and says so", async () => {
    const before = await accounts()
    for (const nodeEnv of ["production", undefined]) {
      const error = await createFounder(deps({ env: { nodeEnv, allowSignUp: true } }), {
        email: "deployed-open@example.com",
        slackUserId: "UDEPLOYED",
      }).catch((e: unknown) => e)
      expect(error, String(nodeEnv)).toBeInstanceOf(CreateFounderRefused)
      expect((error as Error).message).toMatch(/HQ_ALLOW_SIGNUP is on in a deployed hq/)
    }
    expect(await accounts()).toBe(before)
    // A local stack (development, test) may keep sign-up on, as the e2e stack does.
    const local = await createFounder(
      deps({ env: { nodeEnv: "development", allowSignUp: true } }),
      { email: "local-dev@example.com", slackUserId: "ULOCALDEV" },
    )
    expect(await isFounder(t.db, local.userId)).toBe(true)
  })

  it("refuses a Slack user that is already another founder, and anything that is not an address or a Slack id", async () => {
    const taken = await createFounder(deps(), {
      email: "second@example.com",
      slackUserId: "USECONDF",
    })
    expect(taken.userId).toBeTruthy()
    const before = await accounts()
    for (const bad of [
      { email: "third@example.com", slackUserId: "USECONDF" },
      { email: "not-an-address", slackUserId: "UTHIRD" },
      { email: "third@example.com", slackUserId: "u-lower" },
    ]) {
      const error = await createFounder(deps(), bad).catch((e: unknown) => e)
      expect(error, JSON.stringify(bad)).toBeInstanceOf(CreateFounderRefused)
    }
    expect(await accounts()).toBe(before)
  })

  it("creates nothing when the channel for the password fails", async () => {
    const before = await accounts()
    const error = await createFounder(
      deps({
        deliver: async () => {
          throw new Error("disk full")
        },
      }),
      { email: "no-channel@example.com", slackUserId: "UNOCHANNEL" },
    ).catch((e: unknown) => e)
    expect((error as Error).message).toBe("disk full")
    expect(await accounts()).toBe(before)
  })
})

describe("the password file", () => {
  let dir: string
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "create-founder-"))
  })
  afterAll(() => rm(dir, { recursive: true, force: true }))

  it("is created private (0600), holds the password and nothing else, and is never overwritten", async () => {
    const path = join(dir, "password.txt")
    const file = await openPasswordFile(path)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    await file.deliver("generated-password-value")
    await file.close()
    expect(await readFile(path, "utf8")).toBe("generated-password-value\n")
    expect((await stat(path)).mode & 0o777).toBe(0o600)

    // A second run to the same path is refused, and the first password is untouched.
    await expect(openPasswordFile(path)).rejects.toThrow(/EEXIST/)
    expect(await readFile(path, "utf8")).toBe("generated-password-value\n")

    // A file that was already there, with whatever mode, is never written into.
    const other = join(dir, "existing.txt")
    await writeFile(other, "keep me", { mode: 0o644 })
    await expect(openPasswordFile(other)).rejects.toThrow(/EEXIST/)
    expect(await readFile(other, "utf8")).toBe("keep me")
  })

  it("is deleted when the run produces no founder", async () => {
    const path = join(dir, "discarded.txt")
    const file = await openPasswordFile(path)
    await file.deliver("never-used")
    await file.discard()
    await expect(stat(path)).rejects.toThrow(/ENOENT/)
  })
})
