import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { type Caller, defineOperation, type InvokeOutcome } from "@proof/api"
import { AppError } from "@proof/errors"
import { describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { createMcpHandler, toTool } from "./index"

const seen: { idempotencyKey?: string; input: unknown }[] = []

const create = defineOperation({
  name: "create_note",
  method: "POST",
  path: "/v1/notes",
  summary: "Create a note",
  description: "Creates a note.",
  permissions: { note: ["create"] },
  input: z.object({ text: z.string() }),
  output: z.object({ text: z.string() }),
  handler: (input, ctx) => {
    seen.push({ idempotencyKey: ctx.idempotencyKey, input })
    return input
  },
})

const list = defineOperation({
  name: "list_notes",
  method: "GET",
  path: "/v1/notes",
  summary: "List notes",
  description: "Lists notes.",
  permissions: { note: ["read"] },
  input: z.object({}),
  output: z.object({ count: z.number() }),
  hints: { readOnly: true },
  handler: () => ({ count: 0 }),
})

const caller: Caller = {
  organizationId: "org1",
  actor: { type: "apiKey", keyId: "k1" },
  grants: [{ note: ["read", "create"] }],
  via: "api-key",
}

async function connect(opts: Parameters<typeof createMcpHandler>[0]["invokeOptions"], c = caller) {
  const handler = createMcpHandler({
    name: "test",
    version: "1.0.0",
    operations: [create, list],
    authenticate: async () => c,
    resourceMetadataUrl: "http://localhost/.well-known/oauth-protected-resource/mcp",
    invokeOptions: opts,
  })
  const client = new Client({ name: "test-client", version: "1.0.0" })
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
      fetch: (url, init) => handler(new Request(url, init)),
    }),
  )
  return client
}

describe("MCP idempotencyKey", () => {
  it("advertises an optional idempotencyKey argument on writes only", () => {
    const props = (op: typeof create | typeof list) =>
      Object.keys((toTool(op).inputSchema.properties ?? {}) as Record<string, unknown>)
    expect(props(create)).toEqual(["text", "idempotencyKey"])
    expect(props(list)).toEqual([])
    expect(toTool(create).inputSchema.required).toEqual(["text"])
  })

  it("strips idempotencyKey from the input and passes it on the context", async () => {
    seen.length = 0
    const client = await connect(undefined)
    const res = await client.callTool({
      name: "create_note",
      arguments: { text: "hi", idempotencyKey: "retry-1" },
    })
    expect(res.isError).toBeFalsy()
    expect(seen).toEqual([{ idempotencyKey: "retry-1", input: { text: "hi" } }])
  })

  it("leaves the context key unset when none is sent", async () => {
    seen.length = 0
    const client = await connect(undefined)
    await client.callTool({ name: "create_note", arguments: { text: "hi" } })
    expect(seen).toEqual([{ idempotencyKey: undefined, input: { text: "hi" } }])
  })

  it("rejects an empty or oversized key as a tool error", async () => {
    const client = await connect(undefined)
    const empty = await client.callTool({
      name: "create_note",
      arguments: { text: "hi", idempotencyKey: "" },
    })
    expect(empty).toMatchObject({ isError: true })
    expect(JSON.stringify(empty.content)).toContain("BAD_REQUEST")
    const long = await client.callTool({
      name: "create_note",
      arguments: { text: "hi", idempotencyKey: "x".repeat(256) },
    })
    expect(long).toMatchObject({ isError: true })
  })

  it("does not strip a key from readOnly tools", async () => {
    const client = await connect(undefined)
    const res = await client.callTool({ name: "list_notes", arguments: {} })
    expect(res.isError).toBeFalsy()
  })
})

describe("MCP invokeOptions and hints", () => {
  it("passes invokeOptions hooks through to invoke", async () => {
    const after = vi.fn(async (_e: { outcome: InvokeOutcome }) => {})
    const client = await connect({ hooks: { after } })
    await client.callTool({ name: "create_note", arguments: { text: "hi" } })
    expect(after).toHaveBeenCalledTimes(1)
    expect(after.mock.calls[0]?.[0].outcome).toMatchObject({ ok: true, replayed: false })
  })

  it("includes the error hint in the tool error result", async () => {
    const limited = defineOperation({
      name: "limited_note",
      method: "POST",
      path: "/v1/limited",
      summary: "Limited",
      description: "Always over quota.",
      permissions: { note: ["create"] },
      input: z.object({}),
      output: z.object({}),
      handler: () => {
        throw new AppError("RATE_LIMITED", "Daily quota reached", {
          hint: "Wait until tomorrow or upgrade the plan",
          docs: "https://example.test/quotas",
        })
      },
    })
    const handler = createMcpHandler({
      name: "test",
      version: "1.0.0",
      operations: [limited],
      authenticate: async () => caller,
      resourceMetadataUrl: "http://localhost/.well-known/oauth-protected-resource/mcp",
    })
    const client = new Client({ name: "test-client", version: "1.0.0" })
    await client.connect(
      new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
        fetch: (url, init) => handler(new Request(url, init)),
      }),
    )
    const res = await client.callTool({ name: "limited_note", arguments: {} })
    expect(res.isError).toBe(true)
    expect(JSON.parse((res.content as { text: string }[])[0]?.text ?? "{}")).toEqual({
      code: "RATE_LIMITED",
      message: "Daily quota reached",
      hint: "Wait until tomorrow or upgrade the plan",
      docs: "https://example.test/quotas",
    })
  })
})
