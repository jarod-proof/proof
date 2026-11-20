import {
  type AnyOperation,
  type ApiInfo,
  type Caller,
  covers,
  DEFAULT_REGISTRY_META,
  invoke,
  llmsFullTxt,
  llmsTxt,
  type OperationContext,
  openApiDocument,
  serverInstructions,
  serverJson,
} from "@proof/api"
import {
  AUTH_BASE_PATH,
  type Auth,
  OAUTH_SCOPE_GRANTS,
  OAUTH_SCOPES,
  PERSON_ONLY_ACTIONS,
  oauthProviderAuthServerMetadata,
  oauthProviderOpenIdConfigMetadata,
  resolvePrincipal,
} from "@proof/auth"
import type { Database } from "@proof/db"
import { AppError, reportError, toAppError } from "@proof/errors"
import { createMcpHandler, protectedResourceMetadata } from "@proof/mcp"
import { createHealthHandler, requestIdFrom } from "@proof/observability"
import { Hono } from "hono"
import { bodyLimit } from "hono/body-limit"

import { createAdminApp } from "./admin/routes"
import { mayUseHq } from "./data/founders"
import { createHqOperations, HQ_VERSION } from "./operations"
import { createSlackActionHandler } from "./slack/actions"

export interface HqAppOptions {
  db: Database
  auth: Auth
  /** The clock: timestamps and windows read it, so tests can move time. */
  now: () => Date
  /**
   * Slack approvals (`POST /v1/slack/actions`): the app's signing secret and the one workspace
   * whose clicks count. Either unset and every click is refused. Who may click is the `founders`
   * table, not an option.
   */
  slack?: { signingSecret?: string; teamId?: string; dailyGrantCapUsd?: number }
  /** Public base URL, no trailing slash (OAuth issuer, docs links). Default http://localhost:3100. */
  baseURL?: string
  /** More operations beside hq's own. For tests (a write, to reach the body and origin checks). */
  extraOperations?: readonly AnyOperation[]
}

/** The largest request body /v1 and /mcp read, in bytes. */
const MAX_BODY_BYTES = 1024 * 1024

/** The caller with every person-only action taken out of its grants; empty grants are dropped. */
function withoutPersonOnly(caller: Caller): Caller {
  const banned: Record<string, readonly string[]> = PERSON_ONLY_ACTIONS
  const grants: Record<string, string[]>[] = []
  for (const grant of caller.grants) {
    const kept: Record<string, string[]> = {}
    for (const [resource, actions] of Object.entries(grant)) {
      const allowed = actions.filter((action) => !banned[resource]?.includes(action))
      if (allowed.length > 0) kept[resource] = allowed
    }
    if (Object.keys(kept).length > 0) grants.push(kept)
  }
  return { ...caller, grants }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

/**
 * hq, the org brain: REST under the operations' paths, MCP at /mcp, OpenAPI, llms.txt and OAuth
 * discovery, all generated from one operation registry, behind the same auth as the product API
 * (apps/api/src/app.ts is the model). Auth lives in hq's own database.
 */
export function createHqApp(opts: HqAppOptions) {
  const { auth } = opts
  const baseURL = (opts.baseURL ?? "http://localhost:3100").replace(/\/$/, "")
  const operations: readonly AnyOperation[] = [
    ...createHqOperations({ db: opts.db, now: opts.now }),
    ...(opts.extraOperations ?? []),
  ]
  const issuer = `${baseURL}${AUTH_BASE_PATH}`
  const mcpUrl = `${baseURL}/mcp`

  const info: ApiInfo = {
    title: "Proof HQ",
    version: HQ_VERSION,
    description: "The org brain: entries, proposals, runs and spend, for founders and agents.",
    baseURL,
    oauth: {
      authorizationUrl: `${issuer}/oauth2/authorize`,
      tokenUrl: `${issuer}/oauth2/token`,
      scopes: Object.fromEntries(
        OAUTH_SCOPES.map((s) => [s, `${s}: ${JSON.stringify(OAUTH_SCOPE_GRANTS[s])}`]),
      ),
      scopesFor: (permissions) =>
        OAUTH_SCOPES.filter((s) => covers(OAUTH_SCOPE_GRANTS[s], permissions)),
    },
  }
  const openapi = openApiDocument(operations, info)
  const llms = llmsTxt(operations, info, { docs: [] })
  const llmsFull = llmsFullTxt(operations, info, { docs: [] })
  const health = createHealthHandler({})
  const registryRecord = serverJson(info, DEFAULT_REGISTRY_META)

  // The trust rule, enforced wherever a key comes from: only a signed-in person holds a
  // person-only action (PERSON_ONLY_ACTIONS). A key or token that carries one has it stripped.
  // And only a founder (a row of hq.founders), or a key or token of a founder's organization,
  // reaches hq at all: everything else is FORBIDDEN, whoever signed up.
  const authenticate = async (req: Request): Promise<Caller | null> => {
    const caller = await resolvePrincipal(auth, req.headers, { audience: [baseURL, mcpUrl] })
    if (!caller) return null
    if (!(await mayUseHq(opts.db, caller))) {
      throw new AppError("FORBIDDEN", "This brain is for the organization's founders", {
        hint: "Your account is not on this org's founder list.",
      })
    }
    return caller.via === "session" ? caller : withoutPersonOnly(caller)
  }

  const mcp = createMcpHandler({
    name: info.title,
    version: HQ_VERSION,
    instructions: serverInstructions(info, operations, { skill: false }),
    operations,
    authenticate,
    resourceMetadataUrl: `${baseURL}/.well-known/oauth-protected-resource/mcp`,
  })
  const resourceMetadata = protectedResourceMetadata({
    resource: mcpUrl,
    authorizationServers: [issuer],
    scopes: [...OAUTH_SCOPES, "offline_access"],
    name: info.title,
  })
  const asMetadata = oauthProviderAuthServerMetadata(auth)
  const oidcMetadata = oauthProviderOpenIdConfigMetadata(auth)

  const app = new Hono<{ Variables: { requestId: string } }>()

  app.use(async (c, next) => {
    const requestId = requestIdFrom(c.req.raw.headers)
    c.set("requestId", requestId)
    await next()
    c.header("x-request-id", requestId)
  })

  app.onError((e, c) => {
    const error = toAppError(e)
    if (error.status >= 500 || !error.expose) {
      reportError(error, { requestId: c.get("requestId"), path: c.req.path })
    }
    for (const [name, value] of Object.entries(error.headers)) c.header(name, value)
    return c.json({ error: error.toPublic() }, error.status as 400)
  })
  app.notFound((c) => c.json({ error: { code: "NOT_FOUND", message: "Not found" } }, 404))

  // Auth: better-auth routes, plus OAuth discovery at the root (RFC 8414 path insertion too).
  app.on(["GET", "POST", "PUT", "PATCH", "DELETE"], `${AUTH_BASE_PATH}/*`, (c) =>
    auth.handler(c.req.raw),
  )
  for (const suffix of ["", AUTH_BASE_PATH]) {
    app.get(`/.well-known/oauth-authorization-server${suffix}`, (c) => asMetadata(c.req.raw))
    app.get(`/.well-known/openid-configuration${suffix}`, (c) => oidcMetadata(c.req.raw))
  }
  for (const suffix of ["", "/mcp"]) {
    app.get(`/.well-known/oauth-protected-resource${suffix}`, (c) => c.json(resourceMetadata))
  }

  // Agent-readable docs.
  const markdown = (body: string) => () =>
    new Response(body, { headers: { "content-type": "text/markdown; charset=utf-8" } })
  app.get("/llms.txt", markdown(llms))
  app.get("/llms-full.txt", markdown(llmsFull))
  app.get("/openapi.json", (c) => c.json(openapi))
  app.get("/.well-known/mcp/server.json", (c) => c.json(registryRecord))
  // Liveness only: it says this process answers, and pings no dependency.
  app.get("/health", () => health())
  app.get("/", markdown(llms))

  const limit = bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: () => {
      throw new AppError("BAD_REQUEST", `The request body is over ${MAX_BODY_BYTES / 1024} KB`)
    },
  })
  app.use("/v1/*", limit)
  app.use("/mcp", limit)

  // A founder's click on a Slack card, forwarded by the agent. Like /api/auth/*, a protocol route
  // outside the operation registry: its credential is Slack's signature over the raw body, checked
  // in handleSlackAction, so it reads the bytes as received and takes no API key. The decision runs
  // as the founder the Slack user maps to, never as the forwarder.
  const handleSlackAction = createSlackActionHandler({
    db: opts.db,
    now: opts.now,
    signingSecret: opts.slack?.signingSecret,
    teamId: opts.slack?.teamId,
    dailyGrantCapUsd: opts.slack?.dailyGrantCapUsd,
  })
  app.post("/v1/slack/actions", async (c) => {
    const rawBody = new Uint8Array(await c.req.raw.arrayBuffer())
    const result = await handleSlackAction({
      rawBody,
      signature: c.req.header("x-slack-signature") ?? "",
      timestamp: c.req.header("x-slack-request-timestamp") ?? "",
    })
    return c.json({ response_type: "ephemeral", text: result.text }, result.status)
  })

  app.all("/mcp", (c) => mcp(c.req.raw, { requestId: c.get("requestId") }))

  // A session cookie is sent by the browser with any request to this origin, so a write it
  // authenticates must come from a trusted origin, as better-auth requires on /api/auth/*.
  async function assertTrustedOrigin(req: Request) {
    const origin = req.headers.get("origin")
    if (origin && origin !== "null" && (await auth.$context).isTrustedOrigin(origin)) return
    throw new AppError("FORBIDDEN", "A signed-in write must come from a trusted origin", {
      hint: "Agents and scripts authenticate with an API key or OAuth access token.",
    })
  }

  // The admin pages (Hono JSX): proposals, an entry's history, spend. A founder's session only.
  app.route(
    "/admin",
    createAdminApp({
      db: opts.db,
      now: opts.now,
      operations,
      authenticate,
      assertTrustedOrigin,
    }),
  )

  // REST: one route per operation.
  for (const op of operations) {
    app.on(op.method, op.path, async (c) => {
      const caller = await authenticate(c.req.raw)
      if (!caller) throw new AppError("UNAUTHORIZED", "Send an API key or OAuth access token")
      if (caller.via === "session" && op.method !== "GET") await assertTrustedOrigin(c.req.raw)
      let body: unknown = {}
      if (op.method !== "GET" && op.method !== "DELETE") {
        const text = await c.req.text()
        try {
          body = text.trim() === "" ? {} : JSON.parse(text)
        } catch {
          throw new AppError("BAD_REQUEST", "Body must be JSON")
        }
        if (!isRecord(body) || Array.isArray(body)) {
          throw new AppError("BAD_REQUEST", "Body must be a JSON object")
        }
      }
      const ctx: OperationContext = { caller, requestId: c.get("requestId") }
      return c.json(
        await invoke(op, { ...c.req.query(), ...(body as object), ...c.req.param() }, ctx),
      )
    })
  }

  return app
}
