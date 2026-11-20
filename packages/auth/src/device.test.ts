// The device grant's rules at the auth layer: which approvals count, what the token endpoint answers
// for each code state, and that no code without an organization ever gets a token. The full flow
// over the app's HTTP surface is in apps/api/src/device-flow.test.ts.
import { createTestDb } from "@proof/db/testing"
import { decodeJwt } from "jose"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { AUDIENCE, BASE } from "./auth.test.helpers"
import { createAuth } from "./index"
import { firstMembership } from "./membership"

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"

/**
 * One auth instance (one PGlite database) for the whole file. Each test works with its own users,
 * so tests don't share state. The device polling interval is "0s" here: the plugin only enforces
 * slow_down for a non-zero interval, so tests never wait out the 5s default.
 */
async function harness() {
  const t = await createTestDb()
  const auth = createAuth({
    db: t.db,
    secret: "a-test-secret-that-is-long-enough-123456", // gitleaks:allow
    baseURL: BASE,
    emailFrom: "Test <auth@example.com>",
    oauthResources: [BASE, AUDIENCE],
    deviceInterval: "0s",
  })
  const ctx = await auth.$context
  let n = 0

  async function signUp(name: string) {
    n++
    const email = `device${n}@example.com`
    const res = await auth.api.signUpEmail({
      body: { email, password: "correct-horse-battery", name },
      returnHeaders: true,
    })
    const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? ""
    const member = await firstMembership(ctx.adapter, res.response.user.id)
    if (!member) throw new Error("signup did not create a personal organization")
    return { userId: res.response.user.id, cookie, orgId: member.organizationId, email }
  }

  const addMember = (organizationId: string, userId: string) =>
    auth.api.addMember({ body: { organizationId, userId, role: ["member"] } })

  const setActive = (cookie: string, organizationId: string) =>
    auth.api.setActiveOrganization({ headers: new Headers({ cookie }), body: { organizationId } })

  return { t, auth, ctx, signUp, addMember, setActive }
}

type Harness = Awaited<ReturnType<typeof harness>>

const call = (t: Harness, path: string, init: RequestInit = {}) =>
  t.auth.handler(new Request(`${BASE}/api/auth${path}`, init))

const json = (body: unknown, cookie?: string): RequestInit => ({
  method: "POST",
  headers: {
    "content-type": "application/json",
    ...(cookie ? { cookie, origin: BASE } : {}),
  },
  body: JSON.stringify(body),
})

async function publicClient(t: Harness) {
  const res = await call(
    t,
    "/oauth2/register",
    json({
      client_name: "Device CLI",
      token_endpoint_auth_method: "none",
      grant_types: [DEVICE_GRANT, "refresh_token"],
    }),
  )
  return ((await res.json()) as { client_id: string }).client_id
}

async function deviceCode(t: Harness, clientId: string) {
  const res = await call(
    t,
    "/device/code",
    json({ client_id: clientId, scope: "read", resource: AUDIENCE }),
  )
  expect(res.status).toBe(200)
  return (await res.json()) as { device_code: string; user_code: string }
}

/** The verification page's claim (GET) and the approval (POST), as the browser makes them. */
async function review(t: Harness, userCode: string, cookie: string) {
  return call(t, `/device?user_code=${encodeURIComponent(userCode)}`, {
    headers: { cookie, origin: BASE },
  })
}

async function approve(t: Harness, userCode: string, cookie: string) {
  await review(t, userCode, cookie)
  return call(t, "/device/approve", json({ userCode }, cookie))
}

async function poll(t: Harness, clientId: string, deviceCodeValue: string) {
  const res = await call(t, "/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: DEVICE_GRANT,
      device_code: deviceCodeValue,
      client_id: clientId,
    }),
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

describe("device grant rules", () => {
  let t: Harness
  beforeAll(async () => {
    t = await harness()
  })
  afterAll(() => t.t.close())

  it("answers pending, then issues a token for the approver's active organization", async () => {
    const alice = await t.signUp("Alice")
    const clientId = await publicClient(t)
    const code = await deviceCode(t, clientId)

    expect(await poll(t, clientId, code.device_code)).toMatchObject({
      status: 400,
      body: { error: "authorization_pending" },
    })

    // The user code may be typed in another case (normalised, as the plugin does).
    const approved = await approve(t, code.user_code.toLowerCase(), alice.cookie)
    expect(approved.status).toBe(200)

    const token = await poll(t, clientId, code.device_code)
    expect(token.status).toBe(200)
    expect(decodeJwt(String(token.body.access_token)).org).toBe(alice.orgId)
  })

  it("refuses approval from an organization the approver has left, and issues no token", async () => {
    const alice = await t.signUp("Alice")
    const bob = await t.signUp("Bob")
    await t.addMember(alice.orgId, bob.userId)
    await t.setActive(bob.cookie, alice.orgId)
    const clientId = await publicClient(t)
    const code = await deviceCode(t, clientId)

    // Bob's session still points at Alice's organization after he is removed from it.
    await t.ctx.adapter.delete({
      model: "member",
      where: [
        { field: "userId", value: bob.userId },
        { field: "organizationId", value: alice.orgId },
      ],
    })

    const refused = await approve(t, code.user_code, bob.cookie)
    expect(refused.status).toBe(400)
    expect(await refused.json()).toMatchObject({ error: "invalid_request" })

    // A refused approval leaves the code pending (the check runs before the plugin approves it).
    expect(await poll(t, clientId, code.device_code)).toMatchObject({
      status: 400,
      body: { error: "authorization_pending" },
    })

    // Bob picks an organization he belongs to, approves, and the token acts in that one.
    await t.setActive(bob.cookie, bob.orgId)
    expect((await approve(t, code.user_code, bob.cookie)).status).toBe(200)
    const token = await poll(t, clientId, code.device_code)
    expect(token.status).toBe(200)
    expect(decodeJwt(String(token.body.access_token)).org).toBe(bob.orgId)
  })

  it("keeps the organization of the first approval when the approver switches and approves again", async () => {
    const alice = await t.signUp("Alice")
    const bob = await t.signUp("Bob")
    await t.addMember(bob.orgId, alice.userId)
    const clientId = await publicClient(t)
    const code = await deviceCode(t, clientId)

    expect((await approve(t, code.user_code, alice.cookie)).status).toBe(200)
    await t.setActive(alice.cookie, bob.orgId)
    // The code is already approved: the plugin refuses, and the organization stays the first one.
    expect((await approve(t, code.user_code, alice.cookie)).status).toBe(400)

    const token = await poll(t, clientId, code.device_code)
    expect(token.status).toBe(200)
    expect(decodeJwt(String(token.body.access_token)).org).toBe(alice.orgId)
  })

  it("never issues a token for an approved code whose organization was not recorded", async () => {
    const alice = await t.signUp("Alice")
    const clientId = await publicClient(t)
    const code = await deviceCode(t, clientId)
    expect((await approve(t, code.user_code, alice.cookie)).status).toBe(200)

    // Drop the organization records the approvals wrote (this test runs alone in the sequence).
    await t.ctx.adapter.deleteMany({
      model: "verification",
      where: [{ field: "identifier", value: "device-org:", operator: "starts_with" }],
    })

    expect(await poll(t, clientId, code.device_code)).toMatchObject({
      status: 400,
      body: { error: "invalid_grant" },
    })
  })

  it("answers a denied code as the plugin does", async () => {
    const alice = await t.signUp("Alice")
    const clientId = await publicClient(t)
    const code = await deviceCode(t, clientId)
    await review(t, code.user_code, alice.cookie)
    const denied = await call(t, "/device/deny", json({ userCode: code.user_code }, alice.cookie))
    expect(denied.status).toBe(200)

    expect(await poll(t, clientId, code.device_code)).toMatchObject({
      status: 400,
      body: { error: "access_denied" },
    })
  })

  it("ignores approvals of unknown codes (the plugin answers them)", async () => {
    const alice = await t.signUp("Alice")
    const res = await approve(t, "NOSUCHCODE", alice.cookie)
    expect(res.status).toBe(400)
  })
})
