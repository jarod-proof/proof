import { getConnInfo } from "@hono/node-server/conninfo"
import {
  ANALYTICS_EVENTS_PATH,
  type Analytics,
  clientEventBatchSchema,
  noopAnalytics,
} from "@proof/analytics"
import {
  type AnyOperation,
  type ApiInfo,
  type Caller,
  covers,
  DEFAULT_REGISTRY_META,
  type DocsLinks,
  invoke,
  llmsFullTxt,
  llmsTxt,
  type OperationContext,
  openApiDocument,
  type PublicContext,
  type RegistryMeta,
  serverInstructions,
  serverJson,
} from "@proof/api"
import {
  AUTH_BASE_PATH,
  type Auth,
  CLIENT_IP_HEADER,
  OAUTH_SCOPE_GRANTS,
  OAUTH_SCOPES,
  oauthProviderAuthServerMetadata,
  oauthProviderOpenIdConfigMetadata,
  resolvePrincipal,
} from "@proof/auth"
import { AppError, reportError, toAppError } from "@proof/errors"
import { type Logger } from "@proof/logger"
import { createMcpHandler, protectedResourceMetadata } from "@proof/mcp"
import {
  createHealthHandler,
  createStatusHandler,
  requestIdFrom,
  type StatusOptions,
  type StatusProvider,
} from "@proof/observability"
import { type FileStore, IMMUTABLE } from "@proof/storage"
import { type Context, Hono } from "hono"
import { bodyLimit } from "hono/body-limit"

import { BEARER_PATHS, bearerCors } from "./cors"
import { type DevMailSink, devMailRoute } from "./dev-mail"
import type { FlagService } from "./flags"
import type { ApiHooks } from "./hooks"
import { mountOfrep } from "./ofrep"
import { mountWeb } from "./static"

export interface AppOptions {
  auth: Auth
  operations: readonly AnyOperation[]
  /** Public base URL, e.g. https://api.example.com (no trailing slash). */
  baseURL: string
  name: string
  version: string
  description: string
  logger: Logger
  /** Metering, idempotency and audit for every operation call (see hooks.ts). */
  hooks: ApiHooks
  /**
   * Take the client IP from the rightmost X-Forwarded-For entry (the one our proxy added). Only when
   * a proxy overwrites that header; otherwise the socket address is used.
   */
  trustProxy?: boolean
  /** The built web app to serve from this origin (apps/app/dist). */
  webDistDir?: string
  /**
   * The agent skill, served at GET /skill.md and linked from llms.txt (server.ts reads it from
   * skills/). Unset, the route is absent and the docs don't link it.
   */
  skill?: string
  /** The MCP registry's name and description for this server (server.json). */
  registry?: RegistryMeta
  /**
   * Vendors `GET /status` reports, from their own status pages (`parseStatusProviders`). Unset, there
   * is no /status. `fetch` is for tests.
   */
  status?: { providers: readonly StatusProvider[]; fetch?: StatusOptions["fetch"] }
  /**
   * Dev and e2e only: the in-memory mail sink the auth emails go to (dev-mail.ts). Unset, there is no
   * /api/dev/mail route at all.
   */
  devMail?: DevMailSink
  /**
   * The file store uploads go to (STORAGE_DRIVER). Its origin joins the pages' `img-src`; a store the
   * API serves itself (`local`) is mounted at `GET /files/*`. Unset, uploads are off.
   */
  files?: FileStore
  /** Other origins page images load from: social sign-in avatars (GitHub, Google) in `user.image`. */
  imageOrigins?: readonly string[]
  /**
   * Feature flag evaluation: served over OFREP at /ofrep/v1/*, and each request's evaluations are
   * remembered, so a 5xx is counted against the values it saw and its error report names them.
   * Unset, there are no /ofrep routes.
   */
  flags?: FlagService
  /**
   * Where the web app's events (POST /api/events) go. Default: nowhere. Operation calls are captured
   * by the invoke hooks, which take the same instance (createApiHooks).
   */
  analytics?: Analytics
}

/**
 * The largest request body /v1 and /mcp read, in bytes. An upload is base64 JSON: a 1 MB image is
 * about 1.4 MB of text. Checked before the body is read, unlike the input schema.
 */
export const MAX_BODY_BYTES = 2 * 1024 * 1024

/**
 * What the access log line says about a request beyond its method, path and status: the operation
 * (REST route or MCP tool), who called it, and how it ended. Filled in as the request learns them.
 */
interface RequestLog {
  operation?: string
  /** "ok", or the error code. An MCP tool's failure is a 200, so only this says it failed. */
  outcome?: string
  organizationId?: string
  actorType?: Caller["actor"]["type"]
  actorId?: string
  via?: string
  oauthClientId?: string
}

/** The caller, as the access log names it: ids only, the same ones the audit trail keeps. */
const callerFields = (caller: Caller): RequestLog => ({
  organizationId: caller.organizationId,
  actorType: caller.actor.type,
  actorId: caller.actor.type === "user" ? caller.actor.userId : caller.actor.keyId,
  via: caller.via,
  ...(caller.via === "oauth" && caller.clientId && { oauthClientId: caller.clientId }),
})

/** Idempotency-Key: 1 to 255 characters, or absent. */
function idempotencyKeyOf(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  if (value.length === 0 || value.length > 255) {
    throw new AppError("BAD_REQUEST", "Idempotency-Key must be 1 to 255 characters", {
      hint: "Send a unique string per logical action, or omit the header.",
    })
  }
  return value
}

/**
 * The request for better-auth with the client address set from what we trust. A copy the client sent
 * is dropped first. With no address (no socket, no trusted proxy header) the header stays absent.
 */
function withClientIp(req: Request, ip: string): Request {
  const headers = new Headers(req.headers)
  headers.delete(CLIENT_IP_HEADER)
  if (ip !== "unknown") headers.set(CLIENT_IP_HEADER, ip)
  return new Request(req, { headers })
}

/** Set once the proxy warning is logged: one line per process, not per request. */
let forwardedForWarned = false

/** The client's address for signup limits. X-Forwarded-For only when the proxy is trusted. */
function clientIp(c: Context, trustProxy: boolean, logger: Logger): string {
  if (trustProxy) {
    const forwarded = (c.req.header("x-forwarded-for") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
    const ours = forwarded.at(-1)
    if (ours) return ours
  } else if (!forwardedForWarned && c.req.header("x-forwarded-for") !== undefined) {
    // Behind a proxy that is not trusted, every client shares the proxy's address and so one bucket.
    forwardedForWarned = true
    logger.warn(
      "X-Forwarded-For is set but TRUST_PROXY is off: rate limits are keyed on the proxy address, so every client shares one bucket. Set TRUST_PROXY=true behind a proxy that sets X-Forwarded-For.",
    )
  }
  try {
    return getConnInfo(c).remote.address ?? "unknown"
  } catch {
    // No socket (tests call the app directly).
    return "unknown"
  }
}

/** Headers an error response carries: its own, plus retry-after from a rate limit's context. */
function errorHeaders(error: AppError): Record<string, string> {
  const headers = { ...error.headers }
  const retryAfter = error.context.retryAfter
  if (headers["retry-after"] === undefined && typeof retryAfter === "number") {
    headers["retry-after"] = String(retryAfter)
  }
  return headers
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

/**
 * The request path for the access log. better-auth's emailed reset link (also the claim link) puts a
 * live token in the path, `/api/auth/reset-password/<token>`, so that segment is replaced.
 */
const loggedPath = (path: string) =>
  path.replace(/^(\/api\/auth\/reset-password\/)[^/]+/, "$1[Redacted]")

/**
 * The API surface for people and agents, all generated from one operation registry:
 * REST under the operations' paths, MCP at /mcp, OpenAPI, llms.txt and OAuth discovery.
 */
export function createApp(opts: AppOptions) {
  const { auth, operations, baseURL, logger, hooks } = opts
  const analytics = opts.analytics ?? noopAnalytics
  const trustProxy = opts.trustProxy ?? false
  const issuer = `${baseURL}${AUTH_BASE_PATH}`
  const mcpUrl = `${baseURL}/mcp`
  const audience = [baseURL, mcpUrl]

  const info: ApiInfo = {
    title: opts.name,
    version: opts.version,
    description: opts.description,
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
  const skill = opts.skill
  const docLinks: DocsLinks = {
    docs:
      skill === undefined
        ? []
        : [
            {
              title: "Agent skill",
              url: `${baseURL}/skill.md`,
              note: "how to connect, sign in, and call operations safely (read it first)",
            },
          ],
  }
  const llms = llmsTxt(operations, info, docLinks)
  const llmsFull = llmsFullTxt(operations, info, docLinks)
  const health = createHealthHandler({})
  const registryRecord = serverJson(info, opts.registry ?? DEFAULT_REGISTRY_META)

  const authenticate = (req: Request): Promise<Caller | null> =>
    resolvePrincipal(auth, req.headers, { audience })

  const mcp = createMcpHandler({
    name: opts.name,
    version: opts.version,
    instructions: serverInstructions(info, operations, { skill: skill !== undefined }),
    operations,
    authenticate,
    resourceMetadataUrl: `${baseURL}/.well-known/oauth-protected-resource/mcp`,
    invokeOptions: hooks.invokeOptions,
  })
  const resourceMetadata = protectedResourceMetadata({
    resource: mcpUrl,
    authorizationServers: [issuer],
    // MCP clients often request exactly these. offline_access gets them a refresh token, so they
    // needn't re-authorize hourly and survive the approving web session signing out.
    scopes: [...OAUTH_SCOPES, "offline_access"],
    name: opts.name,
  })
  const asMetadata = oauthProviderAuthServerMetadata(auth)
  const oidcMetadata = oauthProviderOpenIdConfigMetadata(auth)

  const app = new Hono<{ Variables: { requestId: string; log: RequestLog } }>()

  // The flags a request evaluates are remembered for it: a 5xx counts against each value it saw.
  const flags = opts.flags
  if (flags) {
    app.use(async (c, next) =>
      flags.scope(async () => {
        await next()
        if (c.res.status >= 500) flags.failed()
      }),
    )
  }

  app.use(async (c, next) => {
    // An incoming id goes into every log line and back out in a header: short, plain ones only.
    const requestId = requestIdFrom(c.req.raw.headers)
    c.set("requestId", requestId)
    const log: RequestLog = {}
    c.set("log", log)
    const start = performance.now()
    await next()
    c.header("x-request-id", requestId)
    logger.info(
      {
        requestId,
        method: c.req.method,
        path: loggedPath(c.req.path),
        status: c.res.status,
        ms: Math.round(performance.now() - start),
        agent: c.req.header("user-agent"),
        ...log,
      },
      "request",
    )
  })

  // Browsers may call the bearer surfaces cross-origin. Never /api/auth/*: that stays same-origin.
  const cors = bearerCors()
  for (const path of BEARER_PATHS) app.use(path, cors)

  app.onError((e, c) => {
    const error = toAppError(e)
    c.get("log").outcome = error.code
    // Agents sending bad requests is normal traffic; only report what we'd want to be paged for. The
    // reporter logs it (server.ts), so it is logged once whether it came from REST, MCP or a hook.
    if (error.status >= 500 || !error.expose) {
      reportError(error, {
        requestId: c.get("requestId"),
        path: loggedPath(c.req.path),
        flags: flags?.seen(),
      })
    }
    for (const [name, value] of Object.entries(errorHeaders(error))) c.header(name, value)
    return c.json({ error: error.toPublic() }, error.status as 400)
  })

  app.notFound((c) => c.json({ error: { code: "NOT_FOUND", message: "Not found" } }, 404))

  // Auth: better-auth routes, plus OAuth discovery at the root (RFC 8414 path insertion too).
  // better-auth rate-limits by CLIENT_IP_HEADER (packages/auth/src/rate-limit.ts). The header is the
  // address we trust, so a client's own copy is dropped and replaced. SCIM (RFC 7644) also uses PUT,
  // PATCH and DELETE: an identity provider deprovisions with them.
  app.on(["GET", "POST", "PUT", "PATCH", "DELETE"], `${AUTH_BASE_PATH}/*`, (c) =>
    auth.handler(withClientIp(c.req.raw, clientIp(c, trustProxy, logger))),
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
  if (skill !== undefined) app.get("/skill.md", markdown(skill))
  app.get("/openapi.json", (c) => c.json(openapi))
  app.get("/.well-known/mcp/server.json", (c) => c.json(registryRecord))
  // Liveness only: it says this process answers, and pings no dependency. /status reports the
  // vendors, from what they publish about themselves.
  app.get("/health", () => health())
  if (opts.status) {
    const status = createStatusHandler(opts.status.providers, { fetch: opts.status.fetch, logger })
    app.get("/status", () => status())
  }
  app.get("/", (c) => {
    const accept = c.req.header("accept") ?? ""
    if (accept.includes("text/html")) return c.redirect("/llms.txt")
    return markdown(llms)()
  })

  // Dev and e2e only: the captured auth emails. Not mounted unless a sink was passed (DEV_MAIL_SINK).
  if (opts.devMail) app.get("/api/dev/mail", devMailRoute(opts.devMail))

  // A body over the limit is refused before it is read or parsed.
  const limit = bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: () => {
      throw new AppError(
        "BAD_REQUEST",
        `The request body is over ${MAX_BODY_BYTES / 1024 / 1024} MB`,
        {
          hint: "Send a smaller image (at most 1 MB; see get_upload_limits).",
        },
      )
    },
  })
  app.use("/v1/*", limit)
  app.use("/mcp", limit)

  // Uploaded files, when the store is one this API serves itself (STORAGE_DRIVER=local).
  const files = opts.files
  if (files?.read) {
    const read = files.read.bind(files)
    app.get("/files/*", async (c) => {
      let key: string
      try {
        key = decodeURIComponent(c.req.path.slice("/files/".length))
      } catch {
        throw new AppError("NOT_FOUND", "Not found")
      }
      const file = await read(key)
      if (!file) throw new AppError("NOT_FOUND", "Not found")
      return new Response(file.body, {
        headers: {
          "content-type": file.contentType,
          "cache-control": IMMUTABLE,
          "x-content-type-options": "nosniff",
          "content-security-policy": "default-src 'none'",
        },
      })
    })
  }

  // OpenFeature's remote evaluation protocol: a protocol route, outside the registry (ofrep.ts).
  if (flags) mountOfrep(app, { flags, authenticate })
  // The web app's analytics events. Not an operation: it is no part of the API agents use, and the
  // invoke hooks would meter and audit every page view. A signed-in person only, from the web app;
  // who sent it comes from the session, never the body.
  const eventsLimit = bodyLimit({
    maxSize: 16 * 1024,
    onError: () => {
      throw new AppError("BAD_REQUEST", "Too many analytics events in one request")
    },
  })
  app.post(ANALYTICS_EVENTS_PATH, eventsLimit, async (c) => {
    const caller = await authenticate(c.req.raw)
    if (!caller) throw new AppError("UNAUTHORIZED", "Sign in to send analytics events")
    Object.assign(c.get("log"), callerFields(caller))
    if (caller.via !== "session") {
      throw new AppError("FORBIDDEN", "Analytics events come from the web app only", {
        hint: "Operation calls are counted on their own; agents don't send analytics events.",
      })
    }
    await assertTrustedOrigin(c.req.raw)
    const body: unknown = await c.req.json().catch(() => undefined)
    const parsed = clientEventBatchSchema.safeParse(body)
    if (!parsed.success) throw new AppError("BAD_REQUEST", "Not a batch of web app events")
    for (const event of parsed.data.events) {
      analytics.capture(event, { actor: caller.actor, organizationId: caller.organizationId })
    }
    return c.body(null, 204)
  })

  // MCP (Streamable HTTP, stateless).
  app.all("/mcp", (c) =>
    mcp(c.req.raw, {
      requestId: c.get("requestId"),
      // A request normally carries one tools/call; the log line names the last.
      onToolCall: ({ operation, outcome, caller }) =>
        Object.assign(c.get("log"), { operation, outcome, ...callerFields(caller) }),
    }),
  )

  /**
   * The browser sends the session cookie with any request to this origin, including a form another
   * same-site page posts as text/plain. So a write the cookie authenticates must come from a trusted
   * origin, as better-auth requires on /api/auth/*. Browsers send Origin on every non-GET request.
   */
  async function assertTrustedOrigin(req: Request) {
    const origin = req.headers.get("origin")
    if (origin && origin !== "null" && (await auth.$context).isTrustedOrigin(origin)) return
    throw new AppError("FORBIDDEN", "A signed-in write must come from the web app", {
      hint: "Agents and scripts authenticate with an API key or OAuth access token, not a session cookie.",
    })
  }

  /** The operation's input from the request: query, JSON body and path params, merged. */
  async function inputOf(c: Context, op: AnyOperation): Promise<unknown> {
    let body: unknown = {}
    if (op.method !== "GET" && op.method !== "DELETE") {
      // No body is an empty input: an operation whose input is all path parameters has none.
      const text = await c.req.text()
      try {
        body = text.trim() === "" ? {} : JSON.parse(text)
      } catch {
        throw new AppError("BAD_REQUEST", "Body must be JSON")
      }
      // Spreading an array or a string would turn it into numbered fields.
      if (!isRecord(body) || Array.isArray(body)) {
        throw new AppError("BAD_REQUEST", "Body must be a JSON object", {
          hint: 'Send the input fields as one object, e.g. {"name": "..."}.',
        })
      }
    }
    return { ...c.req.query(), ...(body as object), ...c.req.param() }
  }

  // REST: one route per operation.
  for (const op of operations) {
    app.on(op.method, op.path, async (c) => {
      const log = c.get("log")
      log.operation = op.name
      // A public operation (signup) reads no credential: one sent with it is ignored. It runs
      // without hooks, so it is metered, keyed and audited by nothing, and gets no rate-limit headers.
      if (op.auth === "none") {
        const context: PublicContext = {
          public: { ip: clientIp(c, trustProxy, logger) },
          requestId: c.get("requestId"),
        }
        const result = await invoke(op, await inputOf(c, op), context)
        log.outcome = "ok"
        return c.json(result)
      }
      const caller = await authenticate(c.req.raw)
      if (!caller) throw new AppError("UNAUTHORIZED", "Send an API key or OAuth access token")
      Object.assign(log, callerFields(caller))
      if (caller.via === "session" && op.method !== "GET") await assertTrustedOrigin(c.req.raw)
      const input = await inputOf(c, op)
      const ctx: OperationContext = {
        caller,
        requestId: c.get("requestId"),
        idempotencyKey: idempotencyKeyOf(c.req.header("idempotency-key")),
      }
      try {
        const result = await invoke(op, input, ctx, hooks.invokeOptions)
        log.outcome = "ok"
        for (const [name, value] of Object.entries(hooks.rateLimitHeaders(ctx)))
          c.header(name, value)
        return c.json(result)
      } catch (e) {
        // Refusals by the rate limit still carry the counters.
        for (const [name, value] of Object.entries(hooks.rateLimitHeaders(ctx)))
          c.header(name, value)
        throw e
      }
    })
  }

  if (opts.webDistDir) {
    const imageOrigins = [...(files ? [files.origin] : []), ...(opts.imageOrigins ?? [])]
    mountWeb(app, opts.webDistDir, { imageOrigins })
  }

  return app
}
