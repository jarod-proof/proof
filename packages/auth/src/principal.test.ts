import { allowed } from "@proof/api"
import type { AppError } from "@proof/errors"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { AUDIENCE, BASE, createTestAuth } from "./auth.test.helpers"
import { resolvePrincipal } from "./principal"

// Real tokens from /oauth2/token are covered end to end in apps/api (oauth-flow.test.ts).
const ISSUER = `${BASE}/api/auth`

describe("resolvePrincipal (real Postgres via PGlite)", () => {
  let t: Awaited<ReturnType<typeof createTestAuth>>
  let owner: Awaited<ReturnType<typeof t.signUp>>
  let viewer: Awaited<ReturnType<typeof t.signUp>>

  beforeAll(async () => {
    t = await createTestAuth()
    owner = await t.signUp("Owner")
    viewer = await t.signUp("Viewer")
    await t.addMember(owner.orgId, viewer.userId, "viewer")
  })
  afterAll(() => t.close())

  const resolve = (headers: Record<string, string>) =>
    resolvePrincipal(t.auth, new Headers(headers), { audience: AUDIENCE })
  const orgKey = (permissions: Record<string, string[]>, extra: object = {}) =>
    t.auth.api.createApiKey({
      body: { organizationId: owner.orgId, userId: owner.userId, permissions, ...extra },
    })
  const sign = async (payload: Record<string, unknown>, issuer = ISSUER) =>
    (await t.auth.api.signJWT({ body: { payload, overrideOptions: { jwt: { issuer } } } })).token

  it("returns null with no credentials", async () => {
    expect(await resolve({})).toBeNull()
  })

  describe("sessions", () => {
    it("act in the active organization with the member's role", async () => {
      const p = await resolve({ cookie: owner.cookie })
      expect(p).toMatchObject({
        organizationId: owner.orgId,
        actor: { type: "user", userId: owner.userId },
        via: "session",
      })
      expect(allowed(p?.grants ?? [], { organization: ["delete"] })).toBe(true)
    })

    it("carry when the session was created, for a fresh-session check", async () => {
      const before = Date.now()
      const p = await resolve({ cookie: owner.cookie })
      expect(p?.sessionCreatedAt).toBeInstanceOf(Date)
      expect(p?.sessionCreatedAt?.getTime()).toBeLessThanOrEqual(before)
    })

    it("show an old session's real age, not the time of the request", async () => {
      const u = await t.signUp("Old")
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
      await (await t.auth.$context).adapter.update({
        model: "session",
        where: [{ field: "userId", value: u.userId }],
        update: { createdAt: twoHoursAgo },
      })
      const p = await resolve({ cookie: u.cookie })
      expect(p?.sessionCreatedAt?.getTime()).toBe(twoHoursAgo.getTime())
    })

    it("follow a switch of active organization, with that org's role", async () => {
      await t.setActive(viewer.cookie, owner.orgId)
      const p = await resolve({ cookie: viewer.cookie })
      expect(p?.organizationId).toBe(owner.orgId)
      expect(allowed(p?.grants ?? [], { project: ["read"] })).toBe(true)
      expect(allowed(p?.grants ?? [], { project: ["create"] })).toBe(false)
    })

    it("stop working in an org the user was removed from", async () => {
      const u = await t.signUp("Leaver")
      await t.addMember(owner.orgId, u.userId, "member")
      await t.setActive(u.cookie, owner.orgId)
      expect(await resolve({ cookie: u.cookie })).not.toBeNull()
      await t.auth.api.removeMember({
        headers: new Headers({ cookie: owner.cookie }),
        body: { organizationId: owner.orgId, memberIdOrEmail: u.email },
      })
      expect(await resolve({ cookie: u.cookie })).toBeNull()
    })
  })

  describe("organization API keys", () => {
    it("have no sign-in age: a key principal carries no sessionCreatedAt", async () => {
      const key = await orgKey({ project: ["read"] })
      expect((await resolve({ "x-api-key": key.key }))?.sessionCreatedAt).toBeUndefined()
    })

    it("act for the org with exactly the permissions they were given", async () => {
      const key = await orgKey({ project: ["read"] })
      expect(key.key.startsWith("sk_")).toBe(true)
      const expected = {
        organizationId: owner.orgId,
        actor: { type: "apiKey", keyId: key.id },
        via: "api-key",
        grants: [{ project: ["read"] }],
        clientId: key.id,
      }
      expect(await resolve({ "x-api-key": key.key })).toEqual(expected)
      expect(await resolve({ authorization: `Bearer ${key.key}` })).toEqual(expected)
    })

    it("grant nothing by default", async () => {
      const key = await t.auth.api.createApiKey({
        body: { organizationId: owner.orgId, userId: owner.userId },
      })
      expect((await resolve({ "x-api-key": key.key }))?.grants).toEqual([])
    })

    it("can't be created by a member without apiKey:create", async () => {
      await expect(
        t.auth.api.createApiKey({ body: { organizationId: owner.orgId, userId: viewer.userId } }),
      ).rejects.toMatchObject({ statusCode: 403 })
    })

    it("stop working when their organization is deleted", async () => {
      const u = await t.signUp("Temp")
      const key = await t.auth.api.createApiKey({
        body: { organizationId: u.orgId, userId: u.userId, permissions: { project: ["read"] } },
      })
      expect(await resolve({ "x-api-key": key.key })).not.toBeNull()
      await t.auth.api.deleteOrganization({
        headers: new Headers({ cookie: u.cookie }),
        body: { organizationId: u.orgId },
      })
      expect(await resolve({ "x-api-key": key.key })).toBeNull()
    })

    it("report over-limit as RATE_LIMITED, not as unauthenticated", async () => {
      const key = await orgKey(
        { project: ["read"] },
        { rateLimitEnabled: true, rateLimitTimeWindow: 60_000, rateLimitMax: 1 },
      )
      expect(await resolve({ "x-api-key": key.key })).not.toBeNull()
      await expect(resolve({ "x-api-key": key.key })).rejects.toMatchObject({
        code: "RATE_LIMITED",
        status: 429,
      })
    })

    it("carry Retry-After in whole seconds when over the limit", async () => {
      const key = await orgKey(
        { project: ["read"] },
        { rateLimitEnabled: true, rateLimitTimeWindow: 60_000, rateLimitMax: 1 },
      )
      await resolve({ "x-api-key": key.key })
      const error = await resolve({ "x-api-key": key.key }).then(
        () => null,
        (e: AppError) => e,
      )
      expect(error).toMatchObject({ code: "RATE_LIMITED", status: 429 })
      const retryAfter = Number(error?.headers["retry-after"])
      // The window is 60s and the second call came right after the first: about the full minute.
      expect(Number.isInteger(retryAfter)).toBe(true)
      expect(retryAfter).toBeGreaterThanOrEqual(55)
      expect(retryAfter).toBeLessThanOrEqual(60)
    })

    it("reject an unknown key", async () => {
      expect(await resolve({ "x-api-key": "sk_not-a-real-key" })).toBeNull()
    })
  })

  describe("OAuth access tokens", () => {
    // iat is required (better-auth always sets it); the revocation check compares against it.
    const claims = () => ({
      sub: viewer.userId,
      aud: AUDIENCE,
      azp: "client-1",
      org: owner.orgId,
      iat: Math.floor(Date.now() / 1000),
    })

    // A token needs a live grant for its client, org and user. These clients consented, as an
    // authorization code grant writes it (createdAt floored to the second, as better-auth does).
    beforeAll(async () => {
      const adapter = (await t.auth.$context).adapter
      const now = new Date()
      // Floored to the second, one second back: tokens signed below carry the current second.
      const consentedAt = new Date(Math.floor(now.getTime() / 1000) * 1000 - 1000)
      for (const clientId of ["client-1", "client-2"]) {
        await adapter.create({
          model: "oauthClient",
          data: { clientId, redirectUris: [], createdAt: now, updatedAt: now },
        })
        await adapter.create({
          model: "oauthConsent",
          data: {
            clientId,
            userId: viewer.userId,
            referenceId: owner.orgId,
            scopes: ["read", "write"],
            createdAt: consentedAt,
            updatedAt: consentedAt,
          },
        })
      }
    })

    it("act in the token's org with role ∩ scopes", async () => {
      const token = await sign({ ...claims(), scope: "openid write" })
      const p = await resolve({ authorization: `Bearer ${token}` })
      expect(p).toMatchObject({ organizationId: owner.orgId, via: "oauth", clientId: "client-1" })
      // viewer role allows reads only; the write scope can't raise that.
      expect(p?.grants).toEqual([{ project: ["read"], agent: ["read"], run: ["read"] }])
    })

    it("accept client_id when azp is absent", async () => {
      const { azp: _, ...rest } = claims()
      const token = await sign({ ...rest, client_id: "client-2", scope: "read" })
      expect((await resolve({ authorization: `Bearer ${token}` }))?.clientId).toBe("client-2")
    })

    it("reject wrong audience or issuer, missing client, org or subject, non-members, garbage", async () => {
      const { azp: _a, ...noClient } = claims()
      const { org: _o, ...noOrg } = claims()
      const { sub: _s, ...noSub } = claims()
      const stranger = await t.signUp("Stranger")
      const tokens = [
        await sign({ ...claims(), aud: "https://elsewhere.example.com" }),
        await sign(claims(), BASE),
        await sign(noClient),
        await sign(noOrg),
        await sign(noSub),
        await sign({ ...claims(), sub: stranger.userId }),
        "not.a.jwt",
      ]
      for (const token of tokens) {
        expect(await resolve({ authorization: `Bearer ${token}` })).toBeNull()
      }
    })

    it("need a grant for the client, the org and the user", async () => {
      // No grant at all for this client.
      const unknown = await sign({ ...claims(), azp: "client-3" })
      expect(await resolve({ authorization: `Bearer ${unknown}` })).toBeNull()
      // The owner has no consent from client-1: the viewer's grant doesn't cover them.
      const ownerToken = await sign({ ...claims(), sub: owner.userId })
      expect(await resolve({ authorization: `Bearer ${ownerToken}` })).toBeNull()
    })

    describe("grants that were revoked", () => {
      const refreshRow = (clientId: string, extra: Record<string, unknown> = {}) => ({
        model: "oauthRefreshToken",
        data: {
          token: `rt-${crypto.randomUUID()}`,
          clientId,
          userId: viewer.userId,
          referenceId: owner.orgId,
          scopes: ["read"],
          expiresAt: new Date(Date.now() + 86_400_000),
          createdAt: new Date(),
          ...extra,
        },
      })
      const oauthClient = (clientId: string) => ({
        model: "oauthClient",
        data: { clientId, redirectUris: [], createdAt: new Date(), updatedAt: new Date() },
      })

      it("accept a device-grant client through a live refresh token, and stop once revoked", async () => {
        const adapter = (await t.auth.$context).adapter
        await adapter.create(oauthClient("client-dev"))
        await adapter.create(refreshRow("client-dev"))
        const token = await sign({ ...claims(), azp: "client-dev", scope: "read" })
        expect(await resolve({ authorization: `Bearer ${token}` })).toMatchObject({
          clientId: "client-dev",
          organizationId: owner.orgId,
        })

        // Stamped one second ahead, so the token above is certainly issued before it.
        await adapter.updateMany({
          model: "oauthRefreshToken",
          where: [{ field: "clientId", value: "client-dev" }],
          update: { revoked: new Date(Date.now() + 1000) },
        })
        expect(await resolve({ authorization: `Bearer ${token}` })).toBeNull()

        // A new grant made after the revocation does not revive the older token.
        await adapter.create(refreshRow("client-dev"))
        expect(await resolve({ authorization: `Bearer ${token}` })).toBeNull()
      })

      it("ignore expired refresh tokens, and rotation (revoked with rotatedAt) is not a revocation", async () => {
        const adapter = (await t.auth.$context).adapter
        await adapter.create(oauthClient("client-rot"))
        await adapter.create(refreshRow("client-rot", { expiresAt: new Date(Date.now() - 1000) }))
        const token = await sign({ ...claims(), azp: "client-rot", scope: "read" })
        expect(await resolve({ authorization: `Bearer ${token}` })).toBeNull()

        // Rotation consumes the old row (revoked and rotatedAt both set); the new row is live.
        const stamp = new Date(Date.now() + 1000)
        await adapter.create(refreshRow("client-rot", { revoked: stamp, rotatedAt: stamp }))
        await adapter.create(refreshRow("client-rot"))
        expect(await resolve({ authorization: `Bearer ${token}` })).not.toBeNull()
      })
    })
  })

  it("does not hand out session JWTs that could pass as access tokens", async () => {
    const res = await t.auth.api.getSession({
      headers: new Headers({ cookie: owner.cookie }),
      asResponse: true,
    })
    expect(res.status).toBe(200)
    expect(res.headers.get("set-auth-jwt")).toBeNull()
  })
})
