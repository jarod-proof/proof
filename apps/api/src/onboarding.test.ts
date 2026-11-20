// The onboarding journey as a fresh agent meets the product: HTTP only, and what discovery tells it.
//   A. A headless agent with a human approver: the device grant, MCP, an API key, idempotent
//      writes, pagination, the audit trail, and the human revoking the agent.
//   B. Self-signup: a key with no account, then the emailed claim link raises the limits.
//   C. The CLI against a live server on a real socket, approved in a browser.
// The steps under test never call auth.api.*; the human's steps go through the browser helper.
import { type ChildProcess, spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { serve } from "@hono/node-server"
import { createAuth } from "@proof/auth"
import { createTestDb } from "@proof/db/testing"
import { createLogger } from "@proof/logger"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { createApp } from "./app"
import { BASE, createTestApp, SECRET, type SentEmail } from "./app.test.helpers"
import { browser } from "./browser.test.helpers"
import { createFlagService } from "./flags"
import { createApiHooks } from "./hooks"
import { createMeter } from "./meter"
import { createOperations } from "./operations"

const PASSWORD = "correct-horse-battery"
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"
// What the agent asks for: the snippet's scope plus admin, which create_api_key needs (see the
// it.fails test below for the documented scope).
const AGENT_SCOPE = "read write admin offline_access"

type Json = Record<string, unknown>
type Form = URLSearchParams

interface DeviceCode {
  device_code: string
  user_code: string
  verification_uri: string
  interval: number
}

/** What the agent learns from discovery and the device flow, read again at each step. */
interface Journey {
  mcpUrl: string
  registerUrl: string
  registerBody: Json
  deviceCodeUrl: string
  deviceCodeBody: Json
  tokenUrl: string
  tokenForm: Form
  clientId: string
  access: string
  humanOrg: string
  agentKey: string
  keyId: string
  projectIds: string[]
}

const need = <T>(value: T | undefined, what: string): T => {
  if (value === undefined)
    throw new Error(`journey step needs ${what}, which an earlier step should set`)
  return value
}

/** The first sh fence in [from, to) that matches each predicate, in order. */
function shFences(markdown: string, from: string, to: string): string[] {
  const start = markdown.indexOf(from)
  const end = markdown.indexOf(to, start)
  if (start < 0 || end < 0) throw new Error(`no section from "${from}" to "${to}"`)
  return [...markdown.slice(start, end).matchAll(/```sh\n([\s\S]*?)```/g)].map((m) => m[1] ?? "")
}

const urlOf = (curl: string) => need(/"(https?:\/\/[^"]+)"/.exec(curl)?.[1], "a URL in the snippet")
const jsonOf = (curl: string): Json =>
  JSON.parse(need(/-d '(\{.*\})'/.exec(curl)?.[1], "a JSON body in the snippet"))
const formOf = (curl: string): Form =>
  new URLSearchParams([...curl.matchAll(/-d (\w+)=(\S+)/g)].map((m) => [m[1] ?? "", m[2] ?? ""]))
const pathOf = (url: string) => {
  const u = new URL(url)
  return `${u.pathname}${u.search}`
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** A JSON response, asserted to be a success. */
async function ok(res: Response): Promise<Json> {
  const body = (await res.json()) as Json
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(body)}`)
  return body
}

const SKILL = readFileSync(
  fileURLToPath(new URL("../../../skills/proof/SKILL.md", import.meta.url)),
  "utf8",
)

describe("onboarding journey A: headless agent, human approves", () => {
  let t: Awaited<ReturnType<typeof createTestApp>>
  const j: Partial<Journey> = {}
  const human = () => browser((url, init) => t.app.request(url, init))
  let grace: ReturnType<typeof browser>

  beforeAll(async () => {
    t = await createTestApp([], { skill: SKILL })
  })
  afterAll(() => t.close())

  /** The agent's device request, as the discovered snippet shapes it. */
  async function requestDevice(clientId: string, scope: string): Promise<DeviceCode> {
    const res = await t.req(pathOf(need(j.deviceCodeUrl, "the device code URL")), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...need(j.deviceCodeBody, "the device body"),
        client_id: clientId,
        scope,
      }),
    })
    expect(res.status).toBe(200)
    return (await res.json()) as DeviceCode
  }

  /** The human's two calls on the verification page, then the approval. */
  async function approve(person: ReturnType<typeof browser>, userCode: string) {
    const page = await person.request(`/api/auth/device?user_code=${encodeURIComponent(userCode)}`)
    expect(page.status).toBe(200)
    const approved = await person.request("/api/auth/device/approve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userCode }),
    })
    expect(approved.status).toBe(200)
  }

  /** Polls the token endpoint the way the snippet says: wait `interval`, back off on slow_down. */
  async function pollForToken(clientId: string, device: DeviceCode): Promise<Json> {
    const form = new URLSearchParams(need(j.tokenForm, "the token form"))
    form.set("device_code", device.device_code)
    form.set("client_id", clientId)
    let wait = device.interval
    for (let attempt = 0; attempt < 10; attempt++) {
      const res = await t.req(pathOf(need(j.tokenUrl, "the token URL")), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form,
      })
      const body = (await res.json()) as Json
      if (res.status === 200) return body
      if (body.error === "slow_down") wait += 5
      else if (body.error !== "authorization_pending") throw new Error(JSON.stringify(body))
      await sleep(wait * 1000)
    }
    throw new Error("the device grant was not approved in time")
  }

  it("1. reads the install section and the device-grant steps from GET /", async () => {
    const res = await t.req("/", { headers: { accept: "text/markdown" } })
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/markdown")
    const md = await res.text()

    const mcp = /The MCP server is `([^`]+)`/.exec(md)?.[1]
    expect(mcp).toBe(`${BASE}/mcp`)
    j.mcpUrl = need(mcp, "the MCP URL")

    const [register, deviceCode, token] = shFences(
      md,
      "### Headless or CI: device grant",
      "Send `Authorization",
    )
    j.registerUrl = urlOf(need(register, "the register snippet"))
    j.registerBody = jsonOf(need(register, "the register snippet"))
    j.deviceCodeUrl = urlOf(need(deviceCode, "the device code snippet"))
    j.deviceCodeBody = jsonOf(need(deviceCode, "the device code snippet"))
    j.tokenUrl = urlOf(need(token, "the token snippet"))
    j.tokenForm = formOf(need(token, "the token snippet"))
    expect(j.registerBody).toMatchObject({ token_endpoint_auth_method: "none" })
    expect(j.deviceCodeBody).toMatchObject({ resource: j.mcpUrl })
    expect(j.tokenForm.get("grant_type")).toBe(DEVICE_GRANT)
  })

  it("2. follows the protected-resource, authorization-server and registry metadata", async () => {
    const prm = await ok(await t.req("/.well-known/oauth-protected-resource/mcp"))
    expect(prm.resource).toBe(need(j.mcpUrl, "the MCP URL"))
    const issuer = String((prm.authorization_servers as string[] | undefined)?.[0] ?? "")
    expect(issuer).toBeTruthy()

    // RFC 8414 path insertion: the metadata for an issuer with a path lives under the well-known path.
    const as = await ok(
      await t.req(`/.well-known/oauth-authorization-server${new URL(issuer).pathname}`),
    )
    expect(as).toMatchObject({
      issuer,
      token_endpoint: `${BASE}${new URL(need(j.tokenUrl, "the token URL")).pathname}`,
      registration_endpoint: `${BASE}${new URL(need(j.registerUrl, "the register URL")).pathname}`,
    })
    // RFC 8628 section 4: the metadata should name the device endpoint too.
    expect(as.device_authorization_endpoint).toBe(
      `${BASE}${new URL(need(j.deviceCodeUrl, "the device code URL")).pathname}`,
    )

    const card = await ok(await t.req("/.well-known/mcp/server.json"))
    expect(card.remotes).toEqual([{ type: "streamable-http", url: j.mcpUrl }])
  })

  it("3. registers as a public client and gets a device code, which the human approves", async () => {
    const reg = await t.req(pathOf(need(j.registerUrl, "the register URL")), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(need(j.registerBody, "the register body")),
    })
    expect(reg.status).toBe(201)
    j.clientId = String(((await reg.json()) as Json).client_id)
    expect(j.clientId).toBeTruthy()

    const device = await requestDevice(j.clientId, AGENT_SCOPE)
    expect(device.verification_uri).toBe(`${BASE}/device`)

    // The human: signs up, opens the verification page, approves. The approval binds the token to
    // the organization their session has active, which is their personal one after sign-up.
    grace = human()
    const signed = await grace.client.signUp.email({
      email: "grace@example.com",
      password: PASSWORD,
      name: "Grace",
    })
    expect(signed.error).toBeNull()
    const session = await grace.client.getSession()
    j.humanOrg = need(session.data?.session.activeOrganizationId ?? undefined, "an active org")
    await approve(grace, device.user_code)

    // The agent polls and receives tokens bound to the approved organization.
    const tokens = await pollForToken(j.clientId, device)
    j.access = String(tokens.access_token)
    expect(tokens.refresh_token).toBeTruthy()
    expect(JSON.stringify(tokens)).not.toContain("sk_")
  }, 60_000)

  it("4. initializes MCP, lists tools, and calls whoami and create_api_key as a user", async () => {
    const mcp = await t.mcpClient({ authorization: `Bearer ${need(j.access, "an access token")}` })
    const { tools } = await mcp.listTools()
    const names = tools.map((tool) => tool.name)
    expect(names).toEqual(expect.arrayContaining(["whoami", "create_api_key", "create_project"]))

    const who = await mcp.callTool({ name: "whoami", arguments: {} })
    expect(who.isError).toBeFalsy()
    expect(who.structuredContent).toMatchObject({
      organizationId: need(j.humanOrg, "the org"),
      actor: { type: "user" },
      via: "oauth",
    })

    const created = await mcp.callTool({
      name: "create_api_key",
      arguments: { name: "onboarding", permissions: { project: ["create", "read"] } },
    })
    expect(created.isError).toBeFalsy()
    const key = created.structuredContent as { id: string; key: string }
    expect(key.key).toMatch(/^sk_/)
    j.agentKey = key.key
    j.keyId = key.id
    await mcp.close()
  }, 60_000)

  it("5. with the sk_ key over REST: idempotent create, paginated list, and the audit trail", async () => {
    const key = need(j.agentKey, "the API key")
    const idem = { "idempotency-key": "onboarding-create-1" }
    const first = await t.req(
      "/v1/projects",
      t.as(key, { method: "POST", headers: idem, body: JSON.stringify({ name: "Onboarded" }) }),
    )
    const replay = await t.req(
      "/v1/projects",
      t.as(key, { method: "POST", headers: idem, body: JSON.stringify({ name: "Onboarded" }) }),
    )
    expect(first.status).toBe(200)
    expect(replay.status).toBe(200)
    const firstBody = await first.text()
    expect(await replay.text()).toBe(firstBody)

    const second = await t.req(
      "/v1/projects",
      t.as(key, {
        method: "POST",
        headers: { "idempotency-key": "onboarding-create-2" },
        body: JSON.stringify({ name: "Second" }),
      }),
    )
    expect(second.status).toBe(200)

    // limit=1 walks every project; the last page has a null nextCursor.
    const seen: string[] = []
    let cursor: string | null = null
    let pages = 0
    do {
      const query = new URLSearchParams({ limit: "1" })
      if (cursor) query.set("cursor", cursor)
      const page = await ok(await t.req(`/v1/projects?${query}`, t.as(key)))
      const projects = page.projects as { id: string; name: string }[]
      seen.push(...projects.map((p) => p.name))
      cursor = (page.nextCursor as string | null) ?? null
      pages++
    } while (cursor && pages < 10)
    expect(pages).toBe(2)
    expect(seen.filter((name) => name === "Onboarded")).toHaveLength(1)
    expect(seen.sort()).toEqual(["Onboarded", "Second"])

    // The human reads the audit trail with their session: the key's write, and the agent's own
    // OAuth client on the key it was given.
    const audit = await ok(await grace.request("/v1/audit-events?limit=100"))
    const events = audit.events as { operation: string; actor: Json; clientId: string | null }[]
    expect(events).toContainEqual(
      expect.objectContaining({
        operation: "create_project",
        actor: { type: "apiKey", id: need(j.keyId, "the key id") },
      }),
    )
    expect(events.some((e) => e.operation === "create_api_key" && e.clientId === j.clientId)).toBe(
      true,
    )
  }, 60_000)

  // The audit trail names an agent by its OAuth client id; list_connected_agents carries the same id
  // in `clientId`, so an agent can match its audit rows to the entry it revokes. Runs before the revoke.
  it("list_connected_agents carries the client id its audit rows use", async () => {
    const listed = await ok(await grace.request("/v1/agents"))
    const agents = listed.agents as { id: string; type: string; clientId: string | null }[]
    expect(
      agents.some((a) => a.type === "oauthClient" && a.clientId === need(j.clientId, "client id")),
    ).toBe(true)
  })

  it("6. the human revokes the agent; its token then gets 401", async () => {
    const listed = await ok(await grace.request("/v1/agents"))
    const agents = listed.agents as { id: string; type: string; clientId: string | null }[]
    const client = agents.find(
      (a) => a.type === "oauthClient" && a.clientId === need(j.clientId, "the client id"),
    )
    expect(client).toBeDefined()

    const revoked = await grace.request(`/v1/agents/${encodeURIComponent(client?.id ?? "")}`, {
      method: "DELETE",
    })
    expect(revoked.status).toBe(200)

    const access = need(j.access, "an access token")
    const whoami = await t.req("/v1/whoami", { headers: { authorization: `Bearer ${access}` } })
    expect(whoami.status).toBe(401)
    const mcp = await t.req("/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${access}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    })
    expect(mcp.status).toBe(401)

    // Revoking the agent leaves the human's keys alone.
    const stillKey = await t.req("/v1/whoami", t.as(need(j.agentKey, "the key")))
    expect(stillKey.status).toBe(200)
  }, 60_000)

  // The documented default scope is least-privilege: it can't create keys. The refusal must tell the
  // agent which scope would (`admin`), and the install docs must say so too.
  it("a token from the default scope is refused create_api_key with a hint naming admin", async () => {
    const reg = await t.req(pathOf(need(j.registerUrl, "the register URL")), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(need(j.registerBody, "the register body")),
    })
    expect(reg.status).toBe(201)
    const clientId = String(((await reg.json()) as Json).client_id)
    const device = await requestDevice(clientId, "read write offline_access")
    await approve(grace, device.user_code)
    const tokens = await pollForToken(clientId, device)
    const mcp = await t.mcpClient({ authorization: `Bearer ${String(tokens.access_token)}` })
    const created = await mcp.callTool({
      name: "create_api_key",
      arguments: { name: "documented", permissions: { project: ["read"] } },
    })
    await mcp.close()
    expect(created.isError).toBe(true)
    const text = JSON.stringify(created.content)
    expect(text).toContain("FORBIDDEN")
    expect(text).toContain("`admin`")
    const llms = await (await t.req("/llms.txt")).text()
    expect(llms).toMatch(/add `admin`/i)
  }, 60_000)

  // An agent that starts from llms.txt finds the skill in its Docs section, fetches it, and reads the
  // same text the repo ships.
  it("finds the agent skill from llms.txt and fetches it", async () => {
    const llms = await (await t.req("/llms.txt")).text()
    const link = /\[Agent skill\]\((https?:\/\/[^)]+)\)/.exec(llms)?.[1]
    expect(link).toBeDefined()
    const path = new URL(link ?? "").pathname
    const res = await t.req(path)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/markdown")
    expect(await res.text()).toBe(SKILL)
  })
})

describe("onboarding journey B: self-signup and claim", () => {
  let t: Awaited<ReturnType<typeof createTestApp>>
  beforeAll(async () => {
    t = await createTestApp()
  })
  afterAll(() => t.close())

  it("signs up with no credential, uses the key until the claim, then signs in with the device grant", async () => {
    const email = "ada@example.com"
    // Signup is the one operation discovery lists with no credential.
    const signup = await t.req("/v1/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, name: "Ada" }),
    })
    expect(signup.status).toBe(200)
    const created = (await signup.json()) as {
      organizationId: string
      apiKey: string
      claimUrlSentTo: string
      apiKeyEndsWhenClaimed: boolean
      limits: { requestsPerDay: number }
    }
    expect(created.apiKey).toMatch(/^sk_/)
    expect(created.claimUrlSentTo).toBe(email)
    // The response says up front that the key is temporary.
    expect(created.apiKeyEndsWhenClaimed).toBe(true)

    const before = await ok(await t.req("/v1/whoami", t.as(created.apiKey)))
    expect(before).toMatchObject({
      organizationId: created.organizationId,
      claimed: false,
      usage: { limit: created.limits.requestsPerDay },
    })
    expect(created.limits.requestsPerDay).toBe(500)

    // The claim email: a reset link whose callback is /claim. Following it lands on a token.
    let mail: SentEmail | undefined
    await vi.waitFor(() => {
      mail = t.outbox.find((m) => m.to === email)
      if (!mail) throw new Error("waiting for the claim email")
    })
    const person = browser((url, init) => t.app.request(url, init))
    const landing = await person.request(need(mail, "the claim email").link)
    expect(landing.status).toBe(302)
    const page = new URL(landing.headers.get("location") ?? "")
    expect(page.pathname).toBe("/claim")
    const token = need(page.searchParams.get("token") ?? undefined, "a claim token")

    // Set the password: the person's browser, through the client.
    const reset = await person.client.resetPassword({ newPassword: PASSWORD, token })
    expect(reset.error).toBeNull()

    // The claim ends the signup key (whoever called signup held it), and the refusal says what next.
    const ended = await t.req("/v1/whoami", t.as(created.apiKey))
    expect(ended.status).toBe(401)
    const refusal = ((await ended.json()) as { error: { hint?: string } }).error
    expect(refusal.hint).toMatch(/claimed the account/)
    expect(refusal.hint).toContain("POST /api/auth/device/code")

    // Following the hint: the device grant, approved by the person who now owns the account.
    const reg = await ok(
      await t.req("/api/auth/oauth2/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "Agent",
          token_endpoint_auth_method: "none",
          grant_types: [DEVICE_GRANT, "refresh_token"],
        }),
      }),
    )
    const clientId = String(reg.client_id)
    const device = (await ok(
      await t.req("/api/auth/device/code", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_id: clientId, scope: AGENT_SCOPE, resource: `${BASE}/mcp` }),
      }),
    )) as unknown as DeviceCode
    expect((await person.client.signIn.email({ email, password: PASSWORD })).error).toBeNull()
    await person.request(`/api/auth/device?user_code=${encodeURIComponent(device.user_code)}`)
    const approved = await person.request("/api/auth/device/approve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userCode: device.user_code }),
    })
    expect(approved.status).toBe(200)
    const tokens = await ok(
      await t.req("/api/auth/oauth2/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: DEVICE_GRANT,
          device_code: device.device_code,
          client_id: clientId,
        }),
      }),
    )

    const mcp = await t.mcpClient({ authorization: `Bearer ${String(tokens.access_token)}` })
    const after = await mcp.callTool({ name: "whoami", arguments: {} })
    expect(after.structuredContent).toMatchObject({
      organizationId: created.organizationId,
      claimed: true,
      usage: { limit: 10_000 },
    })
    await mcp.close()
  }, 60_000)
})

describe("onboarding journey C: the CLI against a live server", () => {
  const cliBin = fileURLToPath(new URL("../../../packages/cli/src/bin.ts", import.meta.url))
  const tsx = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url))
  let origin = ""
  let server: { close: () => void } | undefined
  let t: Awaited<ReturnType<typeof createTestDb>> | undefined
  let dir = ""

  beforeAll(async () => {
    // Serve on an ephemeral port. The app is built after the port is known, so its baseURL, OAuth
    // resources and issuer all name the live origin the CLI calls.
    let handler: (req: Request) => Response | Promise<Response> = () =>
      new Response(null, { status: 503 })
    const port = await new Promise<number>((resolve) => {
      server = serve({ fetch: (req) => handler(req), port: 0, hostname: "127.0.0.1" }, (info) =>
        resolve(info.port),
      )
    })
    origin = `http://127.0.0.1:${port}`

    t = await createTestDb()
    const auth = createAuth({
      db: t.db,
      secret: "a-test-secret-that-is-long-enough-123456", // gitleaks:allow
      baseURL: origin,
      emailFrom: "Test <auth@example.com>",
      oauthResources: [origin, `${origin}/mcp`],
      deviceInterval: "1s",
      ses: {
        client: { send: async () => ({ MessageId: "live", $metadata: { requestId: "live" } }) },
      },
    })
    const meter = createMeter({ db: t.db, entitlements: auth.entitlements })
    const flags = createFlagService({ db: t.db, autoFlush: false })
    const app = createApp({
      hooks: createApiHooks({ db: t.db, meter, secret: SECRET }),
      trustProxy: false,
      auth,
      operations: createOperations({ auth, db: t.db, meter, flags }),
      flags,
      baseURL: origin,
      name: "Live API",
      version: "1.0.0",
      description: "A live test API.",
      logger: createLogger({ level: "silent" }),
    })
    handler = (req) => app.fetch(req)
    dir = await mkdtemp(join(tmpdir(), "proof-cli-live-"))
  })

  afterAll(async () => {
    server?.close()
    await t?.close()
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  /** The CLI as a subprocess, with its own config directory and no inherited credentials. */
  function startCli(args: string[]) {
    const env = {
      PATH: process.env.PATH ?? "",
      HOME: dir,
      PROOF_CONFIG_DIR: join(dir, "config"),
    }
    const proc = { stdout: "", stderr: "" }
    const child: ChildProcess = spawn(tsx, [cliBin, ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    child.stdout?.on("data", (chunk: Buffer) => {
      proc.stdout += chunk.toString("utf8")
    })
    child.stderr?.on("data", (chunk: Buffer) => {
      proc.stderr += chunk.toString("utf8")
    })
    const exited = new Promise<number>((resolve) =>
      child.on("close", (code) => resolve(code ?? -1)),
    )
    return { proc, exited, child }
  }

  it("logs in through the device grant, then whoami and call list_projects succeed", async () => {
    expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)

    const login = startCli(["login", "--base-url", origin])
    try {
      // The CLI prints the code it wants approved on stderr, then polls.
      const userCode = await vi.waitFor(
        () => {
          const match = /confirm the code (\S+?)\. Waiting/.exec(login.proc.stderr)
          if (!match) throw new Error("waiting for the CLI to print its code")
          return match[1] ?? ""
        },
        { timeout: 30_000 },
      )

      // The human: signs up in their browser, opens the verification page, approves.
      const person = browser((url, init) => fetch(url.replace(BASE, origin), init), origin)
      const signed = await person.client.signUp.email({
        email: "lin@example.com",
        password: PASSWORD,
        name: "Lin",
      })
      expect(signed.error).toBeNull()
      const page = await person.request(
        `/api/auth/device?user_code=${encodeURIComponent(userCode)}`,
      )
      expect(page.status).toBe(200)
      const approved = await person.request("/api/auth/device/approve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userCode }),
      })
      expect(approved.status).toBe(200)

      expect(await login.exited, login.proc.stderr).toBe(0)
    } finally {
      login.child.kill()
    }

    const who = startCli(["whoami"])
    expect(await who.exited, who.proc.stderr).toBe(0)
    const me = JSON.parse(who.proc.stdout) as Json
    expect(me).toMatchObject({ via: "oauth" })
    expect(typeof me.organizationId).toBe("string")

    const listed = startCli(["call", "list_projects", "--json", "{}"])
    expect(await listed.exited, listed.proc.stderr).toBe(0)
    expect(JSON.parse(listed.proc.stdout)).toMatchObject({ projects: [] })
  }, 120_000)
})
