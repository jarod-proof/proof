// The device grant (RFC 8628) end to end over HTTP: a public client registers, asks for a device
// code, a person approves it in the browser, and the client polls /oauth2/token. The tokens are
// ordinary OAuth JWTs bound to the approving session's active organization, so resolvePrincipal
// accepts them unchanged; refresh keeps the organization.
import { resolvePrincipal } from "@proof/auth"
import { decodeJwt } from "jose"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { BASE, createTestApp } from "./app.test.helpers"

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"
const MCP = `${BASE}/mcp`

interface DeviceCode {
  device_code: string
  user_code: string
  verification_uri: string
  interval: number
}

interface TokenSet {
  access_token: string
  refresh_token?: string
  token_type: string
  scope?: string
}

describe("device authorization grant (real tokens)", () => {
  let t: Awaited<ReturnType<typeof createTestApp>>
  beforeAll(async () => {
    t = await createTestApp()
  })
  afterAll(() => t.close())

  const form = (body: Record<string, string>) =>
    t.req("/api/auth/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body),
    })

  /** A public client, registered the way a self-registering CLI or agent does. */
  async function registerPublicClient() {
    const res = await t.req("/api/auth/oauth2/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Device CLI",
        token_endpoint_auth_method: "none",
        // Refresh has to be registered too: the plugin only implies it for authorization_code clients.
        grant_types: [DEVICE_GRANT, "refresh_token"],
      }),
    })
    expect(res.status).toBe(201)
    return ((await res.json()) as { client_id: string }).client_id
  }

  async function requestDeviceCode(clientId: string) {
    const res = await t.req("/api/auth/device/code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: clientId,
        scope: "read write offline_access",
        resource: MCP,
      }),
    })
    expect(res.status).toBe(200)
    return (await res.json()) as DeviceCode
  }

  /** The verification page's two calls, as the signed-in person's browser makes them. */
  async function approve(userCode: string, cookie: string) {
    const claim = await t.req(
      `/api/auth/device?user_code=${encodeURIComponent(userCode)}`,
      t.as(cookie, { method: "GET" }),
    )
    expect(claim.status).toBe(200)
    return t.req(
      "/api/auth/device/approve",
      t.as(cookie, { method: "POST", body: JSON.stringify({ userCode }) }),
    )
  }

  const poll = (clientId: string, deviceCode: string) =>
    form({ grant_type: DEVICE_GRANT, device_code: deviceCode, client_id: clientId })

  it("issues an OAuth token for the approving session's organization, and refreshes it", async () => {
    const clientId = await registerPublicClient()
    const device = await requestDeviceCode(clientId)
    expect(device.verification_uri).toBe(`${BASE}/device`)

    // No poll before approval: the plugin paces polls (5s by default) and a poll that lands inside
    // the interval is slow_down. The pending state is covered in packages/auth (device.test.ts).
    const approved = await approve(device.user_code, t.owner.cookie)
    expect(approved.status).toBe(200)

    const tokenRes = await poll(clientId, device.device_code)
    expect(tokenRes.status).toBe(200)
    const tokens = (await tokenRes.json()) as TokenSet
    expect(tokens.token_type).toBe("Bearer")
    expect(tokens.refresh_token).toBeTruthy()

    // A JWT for this resource and client, naming the organization it acts in.
    const claims = decodeJwt(tokens.access_token)
    expect(claims).toMatchObject({ azp: clientId, org: t.owner.orgId, sub: t.owner.userId })
    expect(claims.aud).toContain(MCP)

    const principal = await resolvePrincipal(
      t.auth,
      new Headers({ authorization: `Bearer ${tokens.access_token}` }),
      { audience: MCP },
    )
    expect(principal).toMatchObject({
      organizationId: t.owner.orgId,
      actor: { type: "user", userId: t.owner.userId },
      via: "oauth",
      clientId,
    })
    expect(principal?.grants.length).toBeGreaterThan(0)

    // The token works against the REST surface too.
    const whoami = await t.req("/v1/whoami", {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    })
    expect(whoami.status).toBe(200)

    // Refresh keeps the organization: the refresh token carries the same binding.
    const refreshed = await form({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token ?? "",
      client_id: clientId,
    })
    expect(refreshed.status).toBe(200)
    const next = (await refreshed.json()) as TokenSet
    expect(decodeJwt(next.access_token).org).toBe(t.owner.orgId)
    expect(
      await resolvePrincipal(
        t.auth,
        new Headers({ authorization: `Bearer ${next.access_token}` }),
        {
          audience: MCP,
        },
      ),
    ).toMatchObject({ organizationId: t.owner.orgId })
  })

  it("binds the token to the organization the approver had active, not their own", async () => {
    // The viewer is a member of the owner's organization, and their session is set to it.
    const clientId = await registerPublicClient()
    const device = await requestDeviceCode(clientId)
    const approved = await approve(device.user_code, t.viewer.cookie)
    expect(approved.status).toBe(200)

    const tokenRes = await poll(clientId, device.device_code)
    expect(tokenRes.status).toBe(200)
    const { access_token } = (await tokenRes.json()) as TokenSet
    expect(decodeJwt(access_token).org).toBe(t.owner.orgId)
    expect(
      await resolvePrincipal(t.auth, new Headers({ authorization: `Bearer ${access_token}` }), {
        audience: MCP,
      }),
    ).toMatchObject({
      organizationId: t.owner.orgId,
      actor: { type: "user", userId: t.viewer.userId },
    })
  })

  it("never issues a session token from /device/token", async () => {
    const res = await t.req("/api/auth/device/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: DEVICE_GRANT, device_code: "anything" }),
    })
    expect(res.status).toBe(404)
  })
})
