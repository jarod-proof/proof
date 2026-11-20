import { createTestDb } from "@proof/db/testing"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createAuth } from "./index"

describe("OAuth dynamic client registration (real Postgres via PGlite)", () => {
  let auth: ReturnType<typeof createAuth>
  let close: () => Promise<void>

  beforeAll(async () => {
    const t = await createTestDb()
    close = t.close
    auth = createAuth({
      db: t.db,
      secret: "a-test-secret-that-is-long-enough-123456", // gitleaks:allow
      baseURL: "http://localhost:3000",
      emailFrom: "Test <auth@example.com>",
    })
  })
  afterAll(() => close())

  const register = async (body: Record<string, unknown>) => {
    const res = await auth.handler(
      new Request("http://localhost:3000/api/auth/oauth2/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_name: "Agent", token_endpoint_auth_method: "none", ...body }),
      }),
    )
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }

  it("registers a local MCP client that omits application_type", async () => {
    for (const uri of ["http://localhost:33418/callback", "http://127.0.0.1:5000/cb"]) {
      const res = await register({ redirect_uris: [uri] })
      expect(res.status).toBe(201)
      expect(res.body.client_id).toBeTruthy()
    }
  })

  it("registers an https web client unchanged", async () => {
    const res = await register({ redirect_uris: ["https://agent.example.com/callback"] })
    expect(res.status).toBe(201)
  })

  it("leaves mixed redirects and explicit application_type to the provider's rules", async () => {
    const mixed = await register({
      redirect_uris: ["http://localhost:1/cb", "https://agent.example.com/cb"],
    })
    expect(mixed.status).toBe(400)
    const web = await register({
      application_type: "web",
      redirect_uris: ["http://localhost:1/cb"],
    })
    expect(web.status).toBe(400)
    const junk = await register({ redirect_uris: ["not a url"] })
    expect(junk.status).toBe(400)
  })
})
