import { defineOperation } from "@proof/api"
import { setErrorReporter } from "@proof/errors"
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest"
import { z } from "zod"
import { BASE, createTestApp } from "./app.test.helpers"

const boom = defineOperation({
  name: "boom",
  method: "GET",
  path: "/v1/boom",
  summary: "Fails",
  description: "Always throws an unexpected error.",
  permissions: {},
  input: z.object({}),
  output: z.object({}),
  handler: () => {
    throw new Error("secret connection string")
  },
})

/** A POST whose whole input is a path parameter, so OpenAPI documents no request body. */
const touch = defineOperation({
  name: "touch",
  method: "POST",
  path: "/v1/touch/:id",
  summary: "Touch",
  description: "Echoes the id from the path.",
  permissions: {},
  input: z.object({ id: z.string() }),
  output: z.object({ id: z.string() }),
  handler: (input) => ({ id: input.id }),
})

describe("api app (real Postgres via PGlite)", () => {
  let t: Awaited<ReturnType<typeof createTestApp>>
  beforeAll(async () => {
    t = await createTestApp([boom])
  })
  afterAll(() => t.close())

  const json = async (res: Response) => ({ status: res.status, body: await res.json() })
  const post = (credential: string, path: string, body: unknown) =>
    t.req(path, t.as(credential, { method: "POST", body: JSON.stringify(body) }))

  describe("docs for agents", () => {
    it("serves llms.txt, llms-full.txt and openapi.json", async () => {
      const llms = await t.req("/llms.txt")
      expect(llms.headers.get("content-type")).toContain("text/markdown")
      expect(await llms.text()).toContain(
        "- `POST /v1/projects` (`create_project`): Create a project",
      )
      expect(await (await t.req("/llms-full.txt")).text()).toContain("Permissions: project:delete")
      const doc = (await (await t.req("/openapi.json")).json()) as { paths: object }
      expect(Object.keys(doc.paths)).toContain("/v1/projects/{id}")
    })

    it("answers / with markdown for agents and a redirect for browsers", async () => {
      expect(await (await t.req("/")).text()).toMatch(/^# Test API/)
      const browser = await t.req("/", { headers: { accept: "text/html" } })
      expect(browser.status).toBe(302)
      expect(browser.headers.get("location")).toBe("/llms.txt")
    })

    it("serves health and JSON 404s, and echoes a request id", async () => {
      const health = await t.req("/health", { headers: { "x-request-id": "r-1" } })
      expect(await health.json()).toEqual({ status: "ok", checks: {} })
      expect(health.headers.get("x-request-id")).toBe("r-1")
      expect(await json(await t.req("/nope"))).toEqual({
        status: 404,
        body: { error: { code: "NOT_FOUND", message: "Not found" } },
      })
    })

    it("mints a request id in place of an empty, long or unsafe one", async () => {
      for (const id of ["", "a b", "x".repeat(65), "<script>"]) {
        const res = await t.req("/health", { headers: { "x-request-id": id } })
        expect(res.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/)
      }
    })
  })

  describe("OAuth discovery", () => {
    it("publishes protected-resource metadata for /mcp", async () => {
      for (const path of [
        "/.well-known/oauth-protected-resource",
        "/.well-known/oauth-protected-resource/mcp",
      ]) {
        expect(await (await t.req(path)).json()).toMatchObject({
          resource: `${BASE}/mcp`,
          authorization_servers: [`${BASE}/api/auth`],
          scopes_supported: ["read", "write", "admin", "offline_access"],
        })
      }
    })

    it("publishes authorization-server metadata at the root and with the issuer path", async () => {
      for (const path of [
        "/.well-known/oauth-authorization-server",
        "/.well-known/oauth-authorization-server/api/auth",
        "/.well-known/openid-configuration",
      ]) {
        const res = await t.req(path)
        expect(res.status).toBe(200)
        const meta = (await res.json()) as Record<string, unknown>
        expect(meta.issuer).toBe(`${BASE}/api/auth`)
        expect(meta.registration_endpoint).toBe(`${BASE}/api/auth/oauth2/register`)
        expect(meta.code_challenge_methods_supported).toContain("S256")
      }
    })

    it("lets an MCP client register itself (RFC 7591)", async () => {
      const res = await t.req("/api/auth/oauth2/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "Some Agent",
          redirect_uris: ["http://127.0.0.1:33418/callback"],
          token_endpoint_auth_method: "none",
        }),
      })
      const body = await res.json()
      expect(body, JSON.stringify(body)).toHaveProperty("client_id")
    })
  })

  describe("REST", () => {
    it("rejects requests without credentials", async () => {
      expect(await json(await t.req("/v1/whoami"))).toMatchObject({
        status: 401,
        body: { error: { code: "UNAUTHORIZED" } },
      })
    })

    it("reports the organization, actor and grants", async () => {
      const key = await json(await t.req("/v1/whoami", t.as(t.readKey)))
      expect(key.body).toMatchObject({
        organizationId: t.owner.orgId,
        actor: { type: "apiKey" },
        via: "api-key",
        grants: [{ project: ["read"] }],
      })
      const viewer = await json(await t.req("/v1/whoami", t.as(t.viewer.cookie)))
      expect(viewer.body).toMatchObject({
        organizationId: t.owner.orgId,
        actor: { type: "user", id: t.viewer.userId },
        grants: [{ project: ["read"] }],
      })
    })

    it("creates, lists and deletes projects within the organization", async () => {
      const created = await json(await post(t.fullKey, "/v1/projects", { name: "Site" }))
      expect(created).toMatchObject({ status: 200, body: { name: "Site" } })
      const listed = await json(await t.req("/v1/projects", t.as(t.readKey)))
      expect(listed.body.projects.map((p: { id: string }) => p.id)).toContain(created.body.id)
      const del = await t.req(
        `/v1/projects/${created.body.id}`,
        t.as(t.fullKey, { method: "DELETE" }),
      )
      expect(await json(del)).toEqual({ status: 200, body: { deleted: true } })
    })

    it("lets a key with no permissions call only operations that need none", async () => {
      const bare = (
        await t.auth.api.createApiKey({
          body: { organizationId: t.owner.orgId, userId: t.owner.userId },
        })
      ).key
      expect(await json(await t.req("/v1/whoami", t.as(bare)))).toMatchObject({
        status: 200,
        body: { grants: [] },
      })
      expect((await t.req("/v1/projects", t.as(bare))).status).toBe(403)
      const client = await t.mcpClient(bare)
      expect((await client.listTools()).tools.map((x) => x.name)).toEqual([
        "whoami",
        "get_upload_limits",
        "list_notifications",
        "boom",
      ])
      await client.close()
    })

    it("enforces permissions per key and per role", async () => {
      expect(await json(await post(t.readKey, "/v1/projects", { name: "x" }))).toEqual({
        status: 403,
        body: {
          error: {
            code: "FORBIDDEN",
            message: "Missing permission: project:create",
            hint: expect.stringContaining("OAuth token with scope `write`"),
          },
        },
      })
      expect((await post(t.viewer.cookie, "/v1/projects", { name: "x" })).status).toBe(403)
      expect((await post(t.owner.cookie, "/v1/projects", { name: "x" })).status).toBe(200)
    })

    it("never shows or touches another organization's projects", async () => {
      const theirs = await json(await post(t.otherKey, "/v1/projects", { name: "Theirs" }))
      const mine = await json(await t.req("/v1/projects", t.as(t.fullKey)))
      expect(mine.body.projects.map((p: { id: string }) => p.id)).not.toContain(theirs.body.id)
      // Deleting it from our org looks exactly like deleting a project that doesn't exist.
      const cross = await t.req(
        `/v1/projects/${theirs.body.id}`,
        t.as(t.fullKey, { method: "DELETE" }),
      )
      expect(await json(cross)).toEqual({
        status: 404,
        body: { error: { code: "NOT_FOUND", message: "Project not found" } },
      })
      const still = await json(await t.req("/v1/projects", t.as(t.otherKey)))
      expect(still.body.projects.map((p: { id: string }) => p.id)).toContain(theirs.body.id)
    })

    describe("create_api_key", () => {
      it("lets an owner mint a key limited to what they ask for", async () => {
        const res = await json(
          await post(t.owner.cookie, "/v1/api-keys", {
            name: "ci",
            permissions: { project: ["read"] },
          }),
        )
        expect(res.status).toBe(200)
        const who = await json(await t.req("/v1/whoami", t.as(res.body.key)))
        expect(who.body.grants).toEqual([{ project: ["read"] }])
      })

      it("refuses keys with more than the creator has, or unknown permissions", async () => {
        const admin = await t.signUp("Admin")
        await t.auth.api.addMember({
          body: { organizationId: t.owner.orgId, userId: admin.userId, role: "admin" },
        })
        await t.auth.api.setActiveOrganization({
          headers: new Headers({ cookie: admin.cookie }),
          body: { organizationId: t.owner.orgId },
        })
        // admin can create keys but can't delete the organization, so neither can its keys.
        const escalate = await post(admin.cookie, "/v1/api-keys", {
          name: "x",
          permissions: { organization: ["delete"] },
        })
        expect(await json(escalate)).toEqual({
          status: 403,
          body: {
            error: {
              code: "FORBIDDEN",
              message: "A key can't have permissions its creator doesn't have",
            },
          },
        })
        const viewerTry = await post(t.viewer.cookie, "/v1/api-keys", {
          name: "x",
          permissions: { project: ["read"] },
        })
        expect(viewerTry.status).toBe(403) // viewer has no apiKey:create
        const tooMuch = await post(t.owner.cookie, "/v1/api-keys", {
          name: "x",
          permissions: { project: ["read"], ac: ["delete"], billing: ["read"] },
        })
        expect((await json(tooMuch)).body.error.code).toBe("BAD_REQUEST")
        // Resource names that are Object.prototype members are just unknown resources.
        for (const resource of ["constructor", "toString", "hasOwnProperty"]) {
          const proto = await post(t.owner.cookie, "/v1/api-keys", {
            name: "x",
            permissions: JSON.parse(`{"${resource}":["read"]}`),
          })
          expect((await json(proto)).body.error.code, resource).toBe("BAD_REQUEST")
        }
      })

      it("can't be widened through better-auth's own key endpoints", async () => {
        const admin = await t.signUp("Admin2")
        await t.auth.api.addMember({
          body: { organizationId: t.owner.orgId, userId: admin.userId, role: "admin" },
        })
        await t.auth.api.setActiveOrganization({
          headers: new Headers({ cookie: admin.cookie }),
          body: { organizationId: t.owner.orgId },
        })
        const minted = await json(
          await post(admin.cookie, "/v1/api-keys", {
            name: "k",
            permissions: { project: ["read"] },
          }),
        )
        const authPost = (path: string, body: unknown) =>
          t.req(
            `/api/auth${path}`,
            t.as(admin.cookie, { method: "POST", body: JSON.stringify(body) }),
          )
        const update = await authPost("/api-key/update", {
          keyId: minted.body.id,
          permissions: { organization: ["delete"] },
        })
        // better-auth only accepts key permissions from the server; if that ever changes, this fails.
        expect(await json(update)).toMatchObject({
          status: 400,
          body: { code: "SERVER_ONLY_PROPERTY" },
        })
        const create = await authPost("/api-key/create", {
          organizationId: t.owner.orgId,
          permissions: { organization: ["delete"] },
        })
        expect(await json(create)).toMatchObject({
          status: 400,
          body: { code: "SERVER_ONLY_PROPERTY" },
        })
        const who = await json(await t.req("/v1/whoami", t.as(minted.body.key)))
        expect(who.body.grants).toEqual([{ project: ["read"] }])
      })

      it("refuses to let an API key mint keys", async () => {
        const res = await post(t.fullKey, "/v1/api-keys", {
          name: "x",
          permissions: { project: ["read"] },
        })
        expect(res.status).toBe(403) // the key lacks apiKey:create
      })
    })

    it("rejects bad input and non-JSON bodies", async () => {
      expect((await post(t.fullKey, "/v1/projects", { name: "" })).status).toBe(400)
      const notJson = await t.req("/v1/projects", t.as(t.fullKey, { method: "POST", body: "hi" }))
      expect(await json(notJson)).toEqual({
        status: 400,
        body: { error: { code: "BAD_REQUEST", message: "Body must be JSON" } },
      })
    })

    it("refuses a JSON body that isn't an object", async () => {
      for (const body of ["[]", '["Site"]', '"Site"', "42", "null"]) {
        const res = await t.req("/v1/projects", t.as(t.fullKey, { method: "POST", body }))
        expect(await json(res)).toMatchObject({
          status: 400,
          body: { error: { code: "BAD_REQUEST", message: "Body must be a JSON object" } },
        })
      }
    })

    it("takes a signed-in write only from a trusted origin", async () => {
      const send = (origin: string | null, contentType = "application/json") => {
        const headers = new Headers({ cookie: t.owner.cookie, "content-type": contentType })
        if (origin !== null) headers.set("origin", origin)
        return t.req("/v1/projects", {
          method: "POST",
          headers,
          body: JSON.stringify({ name: "Forged" }),
        })
      }
      // A same-site page posting a text/plain form: no preflight, and the cookie rides along.
      expect(await json(await send("https://evil.localhost:3000", "text/plain"))).toMatchObject({
        status: 403,
        body: { error: { code: "FORBIDDEN" } },
      })
      expect((await send(null)).status).toBe(403)
      expect((await send("null")).status).toBe(403)
      const listed = await json(await t.req("/v1/projects", t.as(t.readKey)))
      expect(listed.body.projects.map((p: { name: string }) => p.name)).not.toContain("Forged")

      expect((await send(BASE)).status).toBe(200)
      // Reads need no origin, and keys and tokens never do.
      expect((await t.req("/v1/whoami", { headers: { cookie: t.owner.cookie } })).status).toBe(200)
      expect((await post(t.fullKey, "/v1/projects", { name: "By key" })).status).toBe(200)
    })

    it("reports only unexpected errors, not agents' bad requests", async () => {
      const reported: string[] = []
      setErrorReporter((e) => reported.push(e.code))
      onTestFinished(() => setErrorReporter(undefined))
      await t.req("/v1/whoami") // 401
      await post(t.readKey, "/v1/projects", { name: "x" }) // 403
      await post(t.fullKey, "/v1/projects", { name: "" }) // 400
      await t.req("/v1/boom", t.as(t.fullKey)) // 500
      expect(reported).toEqual(["INTERNAL"])
    })

    it("hides unexpected errors", async () => {
      expect(await json(await t.req("/v1/boom", t.as(t.fullKey)))).toEqual({
        status: 500,
        body: { error: { code: "INTERNAL", message: "Internal error" } },
      })
    })
  })

  describe("MCP", () => {
    it("challenges unauthenticated clients toward OAuth", async () => {
      const res = await t.req("/mcp", { method: "POST", body: "{}" })
      expect(res.status).toBe(401)
      expect(res.headers.get("www-authenticate")).toContain(
        `resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`,
      )
    })

    it("lists only the tools the credential may call", async () => {
      const read = await t.mcpClient(t.readKey)
      expect((await read.listTools()).tools.map((x) => x.name)).toEqual([
        "whoami",
        "list_projects",
        "get_upload_limits",
        "list_notifications",
        "boom",
      ])
      await read.close()
      const owner = await t.mcpClient(t.owner.cookie)
      expect((await owner.listTools()).tools.map((x) => x.name)).toEqual([
        "whoami",
        "list_projects",
        "create_project",
        "delete_project",
        "create_api_key",
        "list_api_keys",
        "list_scim_tokens",
        "revoke_scim_token",
        "list_connected_agents",
        "revoke_agent_access",
        "list_audit_events",
        "list_agents",
        "get_agent",
        "create_agent",
        "update_agent",
        "delete_agent",
        "start_run",
        "list_runs",
        "get_run",
        "update_run",
        "append_run_step",
        "update_run_step",
        "request_approval",
        "decide_approval",
        "undo_approval",
        "steer_run",
        "defer_run",
        "get_inbox",
        "list_member_security",
        "reset_member_two_factor",
        "get_upload_limits",
        "set_organization_logo",
        "remove_organization_logo",
        // acme is the operator organization, so its owner sees the operator tools.
        "list_feature_flags",
        "get_feature_flag",
        "update_feature_flag",
        "target_feature_flag",
        "untarget_feature_flag",
        "reclaim_feature_flag",
        "delete_feature_flag",
        "list_notifications",
        "boom",
      ])
      // Another organization's owner holds featureFlag too, but never sees an operator tool.
      const other = await t.mcpClient(t.other.cookie)
      const otherTools = (await other.listTools()).tools.map((x) => x.name)
      expect(otherTools).toContain("list_projects")
      expect(otherTools.filter((name) => name.includes("feature_flag"))).toEqual([])
      await other.close()
      const res = await owner.callTool({ name: "create_project", arguments: { name: "Via MCP" } })
      expect(res.structuredContent).toMatchObject({ name: "Via MCP" })
      await owner.close()
    })
  })
})

// Its own app, so the extra operation doesn't change the tool lists asserted above.
describe("a POST whose input is all path parameters", () => {
  it("takes no body as an empty input, as the OpenAPI document says", async () => {
    const t = await createTestApp([touch])
    onTestFinished(() => t.close())
    const res = await t.req("/v1/touch/t1", t.as(t.fullKey, { method: "POST" }))
    expect({ status: res.status, body: await res.json() }).toEqual({
      status: 200,
      body: { id: "t1" },
    })
  })
})

describe("GET /status", () => {
  it("reports the vendors' own status pages, and isn't served when none are configured", async () => {
    const asked: string[] = []
    const t = await createTestApp([], {
      status: {
        providers: [{ kind: "statuspage", name: "Host", url: "https://status.host.example" }],
        fetch: async (url) => {
          asked.push(url)
          return Response.json({ status: { indicator: "minor", description: "Slow deploys" } })
        },
      },
    })
    onTestFinished(() => t.close())
    const res = await t.req("/status")
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      status: "degraded",
      providers: [{ name: "Host", status: "degraded", description: "Slow deploys" }],
    })
    expect(asked).toEqual(["https://status.host.example/api/v2/status.json"])
    // /health stays a liveness check: it asks no one.
    expect(await (await t.req("/health")).json()).toEqual({ status: "ok", checks: {} })
    expect(asked).toHaveLength(1)

    const plain = await createTestApp()
    onTestFinished(() => plain.close())
    expect((await plain.req("/status")).status).toBe(404)
  })
})
