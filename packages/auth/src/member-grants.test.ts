import { oauthAccessToken, oauthClient, oauthConsent, oauthRefreshToken } from "@proof/db/schema"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createTestAuth } from "./auth.test.helpers"
import { revokeGrants, revokeMemberGrants } from "./member-grants"

const T0 = new Date("2026-01-01T00:00:00Z")
const LATER = new Date("2026-02-01T00:00:00Z")
const FAR = new Date("2030-01-01T00:00:00Z")

describe("revokeGrants (real Postgres via PGlite)", () => {
  let t: Awaited<ReturnType<typeof createTestAuth>>
  let orgA: string
  let orgB: string
  let alice: string
  let bob: string
  let n = 0

  beforeAll(async () => {
    t = await createTestAuth()
    orgA = (await t.signUp("Owner")).orgId
    orgB = (await t.signUp("Other")).orgId
    alice = (await t.signUp("Alice")).userId
    bob = (await t.signUp("Bob")).userId
    for (const clientId of ["agent", "other-agent"]) {
      await t.db.insert(oauthClient).values({ id: clientId, clientId, redirectUris: [] })
    }
  })
  afterAll(() => t.close())

  /** A live refresh token, an access token and a consent for one client, org and user. */
  async function grant(clientId: string, referenceId: string, userId: string) {
    const id = `${clientId}-${referenceId}-${userId}-${++n}`
    await t.db.insert(oauthRefreshToken).values({
      id: `r-${id}`,
      token: `r-${id}`,
      clientId,
      userId,
      referenceId,
      scopes: ["read"],
      expiresAt: FAR,
      createdAt: T0,
    })
    await t.db.insert(oauthAccessToken).values({
      id: `a-${id}`,
      token: `a-${id}`,
      clientId,
      userId,
      referenceId,
      scopes: ["read"],
      expiresAt: FAR,
      createdAt: T0,
    })
    await t.db.insert(oauthConsent).values({
      id: `c-${id}`,
      clientId,
      userId,
      referenceId,
      scopes: ["read"],
      createdAt: T0,
      updatedAt: T0,
    })
  }

  const state = async () => ({
    refresh: await t.db.select().from(oauthRefreshToken),
    access: await t.db.select().from(oauthAccessToken),
    consents: await t.db.select().from(oauthConsent),
  })

  it("ends one client's grants in one organization and leaves the rest alone", async () => {
    await grant("agent", orgA, alice)
    await grant("agent", orgA, bob)
    await grant("other-agent", orgA, alice)
    await grant("agent", orgB, alice)

    const changed = await revokeGrants(t.db, { organizationId: orgA, clientId: "agent" }, LATER)

    // Two refresh tokens, two access tokens and two consents for "agent" in orgA.
    expect(changed).toBe(6)
    const s = await state()
    const live = s.refresh.filter((r) => r.revoked === null).map((r) => [r.clientId, r.referenceId])
    expect(live).toEqual([
      ["other-agent", orgA],
      ["agent", orgB],
    ])
    expect(s.access.filter((a) => a.revoked === null).map((a) => a.referenceId)).toEqual([
      orgA,
      orgB,
    ])
    expect(s.consents.map((c) => [c.clientId, c.referenceId])).toEqual([
      ["other-agent", orgA],
      ["agent", orgB],
    ])
  })

  it("narrows to one user when a user id is given, and keeps earlier revocations", async () => {
    const stamp = (await state()).refresh.find(
      (r) => r.userId === bob && r.referenceId === orgA,
    )?.revoked
    expect(stamp).toBeInstanceOf(Date)
    await grant("other-agent", orgA, bob)
    await revokeMemberGrants(t.db, bob, orgA, LATER)
    const s = await state()
    const bobs = s.refresh.filter((r) => r.userId === bob && r.referenceId === orgA)
    expect(bobs.every((r) => r.revoked !== null)).toBe(true)
    // Already revoked before: the first stamp is kept.
    expect(bobs.find((r) => r.clientId === "agent")?.revoked).toEqual(stamp)
    // Alice's grant with other-agent in orgA still stands.
    expect(
      s.refresh.some(
        (r) =>
          r.userId === alice &&
          r.clientId === "other-agent" &&
          r.referenceId === orgA &&
          r.revoked === null,
      ),
    ).toBe(true)
    expect(s.consents.some((c) => c.userId === bob)).toBe(false)
  })

  it("returns zero when nothing matches", async () => {
    expect(
      await revokeGrants(t.db, { organizationId: "no-such-org", clientId: "agent" }, LATER),
    ).toBe(0)
  })
})
