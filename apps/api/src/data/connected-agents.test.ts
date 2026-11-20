// Connected agents: list the org's API keys and OAuth clients, and revoke them. The OAuth client is
// connected through the real device grant, the same way a headless CLI would connect.
import { apikey } from "@proof/db"
import { decodeJwt } from "jose"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { BASE, createTestApp } from "../app.test.helpers"

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"
const MCP = `${BASE}/mcp`

type Agent = { id: string; type: string; name: string; access: string[]; lastUsedAt: string | null }

describe("connected agents (real device grant)", () => {
  let t: Awaited<ReturnType<typeof createTestApp>>
  beforeAll(async () => {
    t = await createTestApp()
  })
  afterAll(() => t.close())

  const json = async (res: Response) => ({ status: res.status, body: await res.json() })
  const list = async (credential = t.owner.cookie) =>
    (await json(await t.req("/v1/agents", t.as(credential)))).body.agents as Agent[]

  /** Connect an OAuth client to the owner's organization, returning its client id and refresh token. */
  async function connectDeviceClient() {
    const reg = await t.req("/api/auth/oauth2/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Device CLI",
        token_endpoint_auth_method: "none",
        grant_types: [DEVICE_GRANT, "refresh_token"],
      }),
    })
    const { client_id: clientId } = (await reg.json()) as { client_id: string }
    const code = await t.req("/api/auth/device/code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: clientId,
        scope: "read write offline_access",
        resource: MCP,
      }),
    })
    const device = (await code.json()) as {
      device_code: string
      user_code: string
      interval: number
    }
    await t.req(
      `/api/auth/device?user_code=${encodeURIComponent(device.user_code)}`,
      t.as(t.owner.cookie, { method: "GET" }),
    )
    const approved = await t.req(
      "/api/auth/device/approve",
      t.as(t.owner.cookie, {
        method: "POST",
        body: JSON.stringify({ userCode: device.user_code }),
      }),
    )
    expect(approved.status).toBe(200)
    // The plugin paces polls: wait out one interval first.
    await new Promise((resolve) => setTimeout(resolve, device.interval * 1000 + 100))
    const tokens = await t.req("/api/auth/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: DEVICE_GRANT,
        device_code: device.device_code,
        client_id: clientId,
      }),
    })
    const body = (await tokens.json()) as { access_token: string; refresh_token: string }
    expect(decodeJwt(body.access_token).org).toBe(t.owner.orgId)
    return { clientId, refreshToken: body.refresh_token }
  }

  it("lists the organization's API keys with their permissions", async () => {
    const agents = await list()
    const keys = agents.filter((a) => a.type === "apiKey")
    expect(keys.map((k) => [...k.access].sort())).toEqual(
      expect.arrayContaining([
        ["project:read"],
        ["apiKey:read", "project:create", "project:delete", "project:read", "project:update"],
      ]),
    )
    expect(keys).toHaveLength(2)
    expect(keys.every((k) => k.id.startsWith("key_"))).toBe(true)
  })

  it("lists an OAuth client that holds a refresh token, though it has no consent row", async () => {
    const { clientId } = await connectDeviceClient()
    const oauth = (await list()).find((a) => a.id === `client_${clientId}`)
    expect(oauth).toMatchObject({
      type: "oauthClient",
      name: "Device CLI",
      lastUsedAt: null,
      access: ["offline_access", "read", "write"],
    })
  }, 30_000)

  it("keeps other organizations' agents out of the list", async () => {
    const agents = await list(t.other.cookie)
    const ids = agents.map((a) => a.id)
    const mine = await list()
    expect(ids.some((id) => mine.some((m) => m.id === id))).toBe(false)
  })

  it("refuses to revoke with a key that lacks apiKey:delete, and says what would allow it", async () => {
    const res = await json(
      await t.req(`/v1/agents/${(await list())[0]?.id}`, t.as(t.fullKey, { method: "DELETE" })),
    )
    expect(res.status).toBe(403)
    expect(res.body.error.hint).toContain("apiKey:delete")
  })

  it("revokes an OAuth client for this organization: its refresh tokens stop working", async () => {
    const { clientId, refreshToken } = await connectDeviceClient()
    const revoke = await json(
      await t.req(`/v1/agents/client_${clientId}`, t.as(t.owner.cookie, { method: "DELETE" })),
    )
    expect(revoke).toEqual({ status: 200, body: { revoked: true } })

    const refresh = await t.req("/api/auth/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
      }),
    })
    expect(refresh.status).toBe(400)
    expect((await list()).some((a) => a.id === `client_${clientId}`)).toBe(false)

    // Already revoked: nothing left to revoke in this organization.
    const again = await json(
      await t.req(`/v1/agents/client_${clientId}`, t.as(t.owner.cookie, { method: "DELETE" })),
    )
    expect(again).toMatchObject({ status: 404, body: { error: { code: "NOT_FOUND" } } })
  }, 30_000)

  it("deletes an API key, which then stops authenticating", async () => {
    const agents = await list()
    const readKey = agents.find((a) => a.access.join() === "project:read")
    expect(readKey).toBeDefined()
    const revoke = await json(
      await t.req(`/v1/agents/${readKey?.id}`, t.as(t.owner.cookie, { method: "DELETE" })),
    )
    expect(revoke.status).toBe(200)
    expect((await t.req("/v1/whoami", t.as(t.readKey))).status).toBe(401)
  })

  it("answers NOT_FOUND for another organization's key, and leaves it working", async () => {
    const [otherKey] = await t.db
      .select({ id: apikey.id })
      .from(apikey)
      .where(eq(apikey.referenceId, t.other.orgId))
    expect(otherKey).toBeDefined()
    const res = await json(
      await t.req(`/v1/agents/key_${otherKey?.id}`, t.as(t.owner.cookie, { method: "DELETE" })),
    )
    expect(res).toMatchObject({ status: 404, body: { error: { code: "NOT_FOUND" } } })
    expect((await t.req("/v1/whoami", t.as(t.otherKey))).status).toBe(200)
  })

  it("answers NOT_FOUND for an id that is not an agent", async () => {
    const res = await json(
      await t.req("/v1/agents/nobody", t.as(t.owner.cookie, { method: "DELETE" })),
    )
    expect(res.body.error.code).toBe("NOT_FOUND")
  })

  it("treats stored permissions that are not the expected shape as none", async () => {
    const [key] = await t.db
      .select({ id: apikey.id, permissions: apikey.permissions })
      .from(apikey)
      .where(eq(apikey.referenceId, t.owner.orgId))
    expect(key).toBeDefined()
    const stored = key?.permissions ?? null
    const garbage = ["not json", '["project"]', '{"project":"read"}']
    try {
      for (const raw of garbage) {
        await t.db
          .update(apikey)
          .set({ permissions: raw })
          .where(eq(apikey.id, key?.id ?? ""))
        const agent = (await list()).find((a) => a.id === `key_${key?.id}`)
        expect(agent, raw).toBeDefined()
        expect(agent?.access, raw).toEqual([])
      }
    } finally {
      await t.db
        .update(apikey)
        .set({ permissions: stored })
        .where(eq(apikey.id, key?.id ?? ""))
    }
  })
})
