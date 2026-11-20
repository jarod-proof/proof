import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { type Caller, defineOperation } from "@proof/api"
import { AppError, setErrorReporter } from "@proof/errors"
import { afterEach, describe, expect, it, onTestFinished } from "vitest"
import { z } from "zod"
import {
  createMcpHandler,
  type McpRequestContext,
  protectedResourceMetadata,
  type ToolCall,
  toTool,
} from "./index"

const whoami = defineOperation({
  name: "whoami",
  method: "GET",
  path: "/v1/whoami",
  summary: "Who am I",
  description: "Returns the caller.",
  permissions: { note: ["read"] },
  input: z.object({}),
  output: z.object({ userId: z.string() }),
  hints: { readOnly: true },
  handler: (_input, ctx) => ({ userId: ctx.caller.organizationId }),
})

const shout = defineOperation({
  name: "shout",
  method: "POST",
  path: "/v1/shout",
  summary: "Shout",
  description: "Uppercases text, or fails on request.",
  permissions: { note: ["create"] },
  input: z.object({ text: z.string(), fail: z.enum(["exposed", "internal"]).optional() }),
  output: z.string(),
  handler: ({ text, fail }) => {
    if (fail === "exposed") throw new AppError("CONFLICT", "Too loud")
    if (fail === "internal") throw new Error("db password is hunter2")
    return text.toUpperCase()
  },
})

// REST only: an agent is never a signed-in person, and a public operation has no caller.
const ownAvatar = defineOperation({
  name: "set_own_avatar",
  method: "PUT",
  path: "/v1/me/avatar",
  summary: "Set your avatar",
  description: "Web app only.",
  auth: "person",
  permissions: {},
  input: z.object({}),
  output: z.object({}),
  handler: () => ({}),
})
const openSignup = defineOperation({
  name: "open_signup",
  method: "POST",
  path: "/v1/signup",
  summary: "Sign up",
  description: "No credential.",
  auth: "none",
  permissions: {},
  input: z.object({}),
  output: z.object({}),
  handler: () => ({}),
})

// Only the operator organization ("op") sees or may call it.
const rampFlag = defineOperation({
  name: "ramp_flag",
  method: "PATCH",
  path: "/v1/flags/:key",
  summary: "Ramp a flag",
  description: "Operator only.",
  audience: "operator",
  permissions: { note: ["read"] },
  input: z.object({ key: z.string() }),
  output: z.object({ key: z.string() }),
  handler: ({ key }) => ({ key }),
})

const URL_ = "http://localhost/mcp"
let clients: Client[] = []
afterEach(async () => {
  await Promise.all(clients.map((c) => c.close()))
  clients = []
})

function setup(caller: Caller | null) {
  const handler = createMcpHandler({
    name: "test",
    version: "1.0.0",
    instructions: "Test server",
    operations: [whoami, shout, ownAvatar, openSignup, rampFlag],
    authenticate: async () => caller,
    invokeOptions: { isOperator: (c) => c.organizationId === "op" },
    resourceMetadataUrl: "http://localhost/.well-known/oauth-protected-resource/mcp",
  })
  return handler
}

async function connect(caller: Caller, ctx: McpRequestContext = {}) {
  const handler = setup(caller)
  const client = new Client({ name: "test-client", version: "1.0.0" })
  const transport = new StreamableHTTPClientTransport(new URL(URL_), {
    fetch: (url, init) => handler(new Request(url, init), ctx),
  })
  await client.connect(transport)
  clients.push(client)
  return client
}

const full: Caller = {
  organizationId: "u1",
  actor: { type: "apiKey", keyId: "k1" },
  grants: [{ note: ["read", "create"] }],
  via: "api-key",
}

describe("createMcpHandler", () => {
  it("tells onToolCall how each tool call ended, including the ones that fail", async () => {
    const calls: ToolCall[] = []
    const onToolCall = (call: ToolCall) => calls.push(call)
    const client = await connect(full, { onToolCall })
    await client.callTool({ name: "shout", arguments: { text: "hi" } })
    await client.callTool({ name: "shout", arguments: {} })
    await client.callTool({ name: "shout", arguments: { text: "hi", fail: "internal" } })
    expect(calls).toEqual([
      { operation: "shout", caller: full, outcome: "ok" },
      { operation: "shout", caller: full, outcome: "BAD_REQUEST" },
      { operation: "shout", caller: full, outcome: "INTERNAL" },
    ])
  })

  it("never lets a throwing onToolCall change the result", async () => {
    const client = await connect(full, {
      onToolCall: () => {
        throw new Error("log down")
      },
    })
    const res = await client.callTool({ name: "shout", arguments: { text: "hi" } })
    expect(res.isError).toBeUndefined()
  })

  it("answers 401 with resource metadata when unauthenticated", async () => {
    const res = await setup(null)(new Request(URL_, { method: "POST", body: "{}" }))
    expect(res.status).toBe(401)
    expect(res.headers.get("www-authenticate")).toBe(
      'Bearer resource_metadata="http://localhost/.well-known/oauth-protected-resource/mcp"',
    )
  })

  it("keeps the OAuth pointer on a refused credential, and passes its hint along", async () => {
    const handler = createMcpHandler({
      name: "test",
      version: "1.0.0",
      operations: [whoami],
      authenticate: async () => {
        throw new AppError("UNAUTHORIZED", "This API key is turned off", {
          hint: "Use the device grant.",
        })
      },
      resourceMetadataUrl: "http://localhost/.well-known/oauth-protected-resource/mcp",
    })
    const res = await handler(new Request(URL_, { method: "POST", body: "{}" }))
    expect(res.status).toBe(401)
    expect(res.headers.get("www-authenticate")).toContain("resource_metadata=")
    expect(await res.json()).toEqual({
      error: {
        code: "UNAUTHORIZED",
        message: "This API key is turned off",
        hint: "Use the device grant.",
      },
    })
  })

  it("lists only the tools the caller has permissions for", async () => {
    const all = await (await connect(full)).listTools()
    expect(all.tools.map((t) => t.name)).toEqual(["whoami", "shout"])
    const readOnly = await (await connect({ ...full, grants: [{ note: ["read"] }] })).listTools()
    expect(readOnly.tools.map((t) => t.name)).toEqual(["whoami"])
  })

  it("lists operator tools only in the operator organization, and refuses calls from others", async () => {
    const operator = await connect({ ...full, organizationId: "op" })
    expect((await operator.listTools()).tools.map((t) => t.name)).toEqual([
      "whoami",
      "shout",
      "ramp_flag",
    ])
    const ok = await operator.callTool({ name: "ramp_flag", arguments: { key: "f" } })
    expect(ok.structuredContent).toEqual({ key: "f" })
    const refused = await (await connect(full)).callTool({
      name: "ramp_flag",
      arguments: { key: "f" },
    })
    expect(refused.isError).toBe(true)
    expect(JSON.stringify(refused.content)).toContain("Only the operator organization")
  })

  it("sends server instructions on initialize", async () => {
    expect((await connect(full)).getInstructions()).toBe("Test server")
  })

  it("calls a tool and returns structured content for object outputs", async () => {
    const res = await (await connect(full)).callTool({ name: "whoami", arguments: {} })
    expect(res.structuredContent).toEqual({ userId: "u1" })
  })

  it("returns text only for non-object outputs", async () => {
    const res = await (await connect(full)).callTool({ name: "shout", arguments: { text: "hi" } })
    expect(res.structuredContent).toBeUndefined()
    expect(res.content).toEqual([{ type: "text", text: '"HI"' }])
  })

  it("returns tool errors to the model without leaking internals", async () => {
    const reported: string[] = []
    setErrorReporter((e) => reported.push(e.code))
    onTestFinished(() => setErrorReporter(undefined))
    const client = await connect(full)
    const exposed = await client.callTool({
      name: "shout",
      arguments: { text: "x", fail: "exposed" },
    })
    expect(exposed).toMatchObject({ isError: true })
    expect(JSON.stringify(exposed.content)).toContain("Too loud")
    const internal = await client.callTool({
      name: "shout",
      arguments: { text: "x", fail: "internal" },
    })
    expect(JSON.stringify(internal.content)).not.toContain("hunter2")
    const invalid = await client.callTool({ name: "shout", arguments: {} })
    expect(JSON.stringify(invalid.content)).toContain("BAD_REQUEST")
    // Only the unexpected failure is reported; model mistakes and exposed errors are not.
    expect(reported).toEqual(["INTERNAL"])
  })

  it("refuses a hidden tool with FORBIDDEN, and an unknown one as unknown", async () => {
    const client = await connect({ ...full, grants: [{ note: ["read"] }] })
    const hidden = await client.callTool({ name: "shout", arguments: { text: "x" } })
    expect(hidden).toMatchObject({ isError: true })
    expect(JSON.stringify(hidden.content)).toContain("FORBIDDEN")
    // Permission comes first, as over REST: a bad idempotencyKey doesn't change the answer.
    const badKey = await client.callTool({
      name: "shout",
      arguments: { text: "x", idempotencyKey: "" },
    })
    expect(JSON.stringify(badKey.content)).toContain("FORBIDDEN")
    // An unknown tool is a protocol error (-32602, invalid params), not a tool result.
    await expect(client.callTool({ name: "nope", arguments: {} })).rejects.toMatchObject({
      code: -32602,
      message: expect.stringContaining("Unknown tool: nope"),
    })
  })
})

describe("REST-only operations", () => {
  it("are never tools, even for a session, and calling one by name is unknown", async () => {
    const client = await connect({ ...full, actor: { type: "user", userId: "u1" }, via: "session" })
    const names = (await client.listTools()).tools.map((tool) => tool.name)
    expect(names).toEqual(["whoami", "shout"])
    for (const name of ["set_own_avatar", "open_signup"]) {
      await expect(client.callTool({ name, arguments: {} })).rejects.toMatchObject({
        code: -32602,
      })
    }
  })
})

describe("malformed tools/call", () => {
  it("answers -32602 (invalid params), not an internal error", async () => {
    const call = (params: unknown) =>
      setup(full)(
        new Request(URL_, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params }),
        }),
      )
    for (const params of [undefined, { arguments: {} }, { name: 42 }]) {
      const body = (await (await call(params)).json()) as { error?: { code: number } }
      expect(body.error?.code, JSON.stringify(params)).toBe(-32602)
    }
  })
})

describe("toTool", () => {
  it("maps hints to MCP annotations", () => {
    expect(toTool(whoami).annotations).toMatchObject({ readOnlyHint: true, title: "Who am I" })
    expect(toTool(whoami).outputSchema?.type).toBe("object")
    expect(toTool(shout).outputSchema).toBeUndefined()
  })
})

describe("protectedResourceMetadata", () => {
  it("builds RFC 9728 metadata", () => {
    expect(
      protectedResourceMetadata({
        resource: "https://a.test/mcp",
        authorizationServers: ["https://a.test/api/auth"],
        scopes: ["read"],
        name: "A",
      }),
    ).toEqual({
      resource: "https://a.test/mcp",
      authorization_servers: ["https://a.test/api/auth"],
      scopes_supported: ["read"],
      bearer_methods_supported: ["header"],
      resource_name: "A",
    })
  })
})
