import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import {
  type CallToolRequest,
  CallToolRequestSchema,
  type CallToolResult,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js"
import {
  allowed,
  type AnyOperation,
  assertAllowed,
  assertAudience,
  type Caller,
  inAudience,
  inputSchema,
  invoke,
  type InvokeOptions,
  outputSchema,
} from "@proof/api"
import { AppError, type ErrorCode as AppErrorCode, reportError, toAppError } from "@proof/errors"
import { z } from "zod"

export interface McpHandlerOptions {
  name: string
  version: string
  /** Sent to the client on initialize: tell the agent what this server is for. */
  instructions?: string
  operations: readonly AnyOperation[]
  /** Resolve the caller from the request, or null when unauthenticated. */
  authenticate: (request: Request) => Promise<Caller | null>
  /** URL of this server's /.well-known/oauth-protected-resource document (RFC 9728). */
  resourceMetadataUrl: string
  /**
   * Passed to every `invoke`: hooks (audit, metering, idempotency) and permission hints. Public
   * operations (auth "none") are left out of the tools entirely.
   */
  invokeOptions?: InvokeOptions
}

/** One tools/call as it ended: which operation, who called it, and "ok" or the error code. */
export interface ToolCall {
  operation: string
  caller: Caller
  outcome: "ok" | AppErrorCode
}

/** Per request: the request id for logs, and who hears of each tool call (the access log). */
export interface McpRequestContext {
  requestId?: string
  /** Called once per tools/call. A tool's failure is a 200 with `isError`, so the status can't say. */
  onToolCall?: (call: ToolCall) => void
}

const canCall = (op: AnyOperation, caller: Caller) => allowed(caller.grants, op.permissions)

/**
 * tools/call with params left to the SDK's own check. Registered with the strict schema, a malformed
 * call fails the registration's parse first and comes back as -32603 (internal error) instead.
 */
const LooseCallToolRequestSchema = CallToolRequestSchema.extend({ params: z.unknown().optional() })

/** Writes (non-readOnly operations) take an optional `idempotencyKey` argument; the server strips it. */
const IDEMPOTENCY_ARG = "idempotencyKey"
const idempotencyKeyArg = z.string().min(1).max(255)

const isMutating = (op: AnyOperation) => op.hints?.readOnly !== true

function withIdempotencyArg(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = (schema.properties ?? {}) as Record<string, object>
  if (IDEMPOTENCY_ARG in properties) return schema
  return {
    ...schema,
    properties: {
      ...properties,
      [IDEMPOTENCY_ARG]: {
        type: "string",
        minLength: 1,
        maxLength: 255,
        description:
          "Optional. Use a unique value per logical action so a retry after a timeout does not run it twice. " +
          "Sending the same key with a different body is an error.",
      },
    },
  }
}

export function toTool(op: AnyOperation): Tool {
  const output = outputSchema(op)
  const input = { ...inputSchema(op), type: "object" }
  return {
    name: op.name,
    title: op.summary,
    description: op.description,
    inputSchema: (isMutating(op) ? withIdempotencyArg(input) : input) as Tool["inputSchema"],
    // MCP structured output must be an object; other outputs are returned as text only.
    ...(output.type === "object" && { outputSchema: { ...output, type: "object" } }),
    annotations: {
      title: op.summary,
      readOnlyHint: op.hints?.readOnly,
      destructiveHint: op.hints?.destructive,
      idempotentHint: op.hints?.idempotent,
      openWorldHint: false,
    },
  }
}

/** Pull the idempotency key out of a write's arguments so the operation's input schema never sees it. */
function splitIdempotencyKey(
  op: AnyOperation,
  args: unknown,
): { input: unknown; idempotencyKey?: string } {
  if (!isMutating(op) || args === null || typeof args !== "object" || Array.isArray(args)) {
    return { input: args }
  }
  const { [IDEMPOTENCY_ARG]: raw, ...input } = args as Record<string, unknown>
  if (raw === undefined) return { input }
  const key = idempotencyKeyArg.safeParse(raw)
  if (!key.success) {
    throw new AppError("BAD_REQUEST", `${IDEMPOTENCY_ARG} must be 1 to 255 characters`, {
      hint: "Omit idempotencyKey, or pass a unique string per logical action.",
    })
  }
  return { input, idempotencyKey: key.data }
}

async function callTool(
  op: AnyOperation,
  args: unknown,
  caller: Caller,
  opts: McpRequestContext & { invokeOptions?: InvokeOptions } = {},
): Promise<CallToolResult> {
  const ended = (outcome: ToolCall["outcome"]) => {
    try {
      opts.onToolCall?.({ operation: op.name, caller, outcome })
    } catch (e) {
      reportError(e, { operation: op.name, phase: "onToolCall" })
    }
  }
  try {
    // Audience and permission first, as over REST, so a bad idempotencyKey can't mask FORBIDDEN.
    assertAudience(op, caller, opts.invokeOptions)
    assertAllowed(op, caller, opts.invokeOptions)
    const { input, idempotencyKey } = splitIdempotencyKey(op, args)
    const result = await invoke(
      op,
      input,
      { caller, requestId: opts.requestId, idempotencyKey },
      opts.invokeOptions,
    )
    const text = JSON.stringify(result, null, 2)
    const structured = result !== null && typeof result === "object" && !Array.isArray(result)
    ended("ok")
    return {
      content: [{ type: "text", text }],
      ...(structured && { structuredContent: result as Record<string, unknown> }),
    }
  } catch (e) {
    const error = toAppError(e)
    ended(error.code)
    // A model sending bad arguments is expected; only report what we'd want to be paged for.
    if (error.status >= 500 || !error.expose) {
      reportError(error, { operation: op.name, requestId: opts.requestId })
    }
    // Tool errors go back to the model so it can correct itself; never leak INTERNAL details.
    return { isError: true, content: [{ type: "text", text: JSON.stringify(error.toPublic()) }] }
  }
}

function buildServer(opts: McpHandlerOptions, caller: Caller, request: McpRequestContext): Server {
  const server = new Server(
    { name: opts.name, version: opts.version },
    { capabilities: { tools: {} }, instructions: opts.instructions },
  )
  // Public operations (auth "none") are REST only: they need no caller, so they are never tools.
  // Nor are person-only ones (auth "person"): an MCP client is an agent, never a signed-in person.
  const tools = opts.operations.filter((op) => op.auth === undefined)
  // Operator operations are tools only in the operator organization; nobody else learns of them.
  const visible = tools.filter(
    (op) => canCall(op, caller) && inAudience(op, caller, opts.invokeOptions),
  )
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: visible.map(toTool) }))
  server.setRequestHandler(LooseCallToolRequestSchema, (loose) => {
    // The SDK validates the strict schema itself, as invalid params (-32602), before this runs.
    const req = loose as CallToolRequest
    // Hidden tools are still callable by name: invoke refuses them with FORBIDDEN and a hint naming
    // the scope or permission that would allow it, which is more use to an agent than "unknown".
    // The operation list is public anyway (openapi.json, llms.txt). An operator tool called from
    // another organization is refused by its audience the same way.
    const op = tools.find((o) => o.name === req.params.name)
    // A name that is no operation at all is a protocol error, as the MCP spec has it.
    if (!op) throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${req.params.name}`)
    return callTool(op, req.params.arguments, caller, {
      ...request,
      invokeOptions: opts.invokeOptions,
    })
  })
  return server
}

/**
 * A stateless MCP server over Streamable HTTP, as a Web `Request` -> `Response` handler.
 * Every operation the caller has permissions for is a tool. Unauthenticated requests get a 401 that
 * points MCP clients at the OAuth metadata, so they can sign the user in.
 */
export function createMcpHandler(opts: McpHandlerOptions) {
  return async (request: Request, ctx: McpRequestContext = {}): Promise<Response> => {
    const unauthorized = (error: AppError) =>
      Response.json(
        { error: error.toPublic() },
        {
          status: 401,
          headers: {
            "www-authenticate": `Bearer resource_metadata="${opts.resourceMetadataUrl}"`,
          },
        },
      )
    let caller: Caller | null
    try {
      caller = await opts.authenticate(request)
    } catch (e) {
      // A credential refused with a reason (a provisional key ended by the claim) still points the
      // client at OAuth discovery, and keeps the hint saying what to do.
      if (e instanceof AppError && e.code === "UNAUTHORIZED") return unauthorized(e)
      throw e
    }
    if (!caller) {
      return unauthorized(new AppError("UNAUTHORIZED", "Sign in or send an organization API key"))
    }
    const server = buildServer(opts, caller, ctx)
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    })
    await server.connect(transport)
    try {
      return await transport.handleRequest(request)
    } finally {
      await server.close()
    }
  }
}

export interface ProtectedResourceOptions {
  /** This MCP server's URL, e.g. https://api.example.com/mcp */
  resource: string
  /** Issuer URL(s) of the OAuth authorization server. */
  authorizationServers: string[]
  scopes: readonly string[]
  name?: string
}

/** RFC 9728 metadata. Serve at /.well-known/oauth-protected-resource (and with the /mcp suffix). */
export function protectedResourceMetadata(opts: ProtectedResourceOptions) {
  return {
    resource: opts.resource,
    authorization_servers: opts.authorizationServers,
    scopes_supported: [...opts.scopes],
    bearer_methods_supported: ["header"],
    ...(opts.name && { resource_name: opts.name }),
  }
}
