import { reportError, toAppError } from "@proof/errors"
import type { Logger } from "@proof/logger"

export const REQUEST_ID_HEADER = "x-request-id"

/** Incoming ids are echoed into logs and response headers, so accept only short, plain ones. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/

/** Reuse the caller's request id when it is safe, otherwise mint one. */
export function requestIdFrom(headers: Headers): string {
  const incoming = headers.get(REQUEST_ID_HEADER)
  return incoming && SAFE_REQUEST_ID.test(incoming) ? incoming : crypto.randomUUID()
}

export interface RequestContext {
  requestId: string
  /** Child logger that stamps every line with the request id. */
  log: Logger
}

/** `Rest` is whatever the framework passes after the request: Next's `{ params }`, and so on. */
export type Handler<Rest extends unknown[] = []> = (
  req: Request,
  ctx: RequestContext,
  ...rest: Rest
) => Response | Promise<Response>

export interface ObserveOptions {
  logger: Logger
}

/**
 * Headers worth having in a server-error log. An allowlist, not a denylist: custom auth headers
 * (x-api-key, x-csrf-token, ...) would slip past the logger's redaction paths.
 */
const LOGGED_HEADERS = [
  "user-agent",
  "content-type",
  "content-length",
  "referer",
  "x-forwarded-for",
]

function safeHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of LOGGED_HEADERS) {
    const value = headers.get(name)
    if (value !== null) out[name] = value
  }
  return out
}

function withRequestId(res: Response, requestId: string): Response {
  const headers = new Headers(res.headers)
  headers.set(REQUEST_ID_HEADER, requestId)
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
}

/**
 * Wrap a Web-standard handler (Next route handlers, Hono, ...) on a Node runtime with a request
 * id, a per-request logger, one access-log line per request, and error handling. Arguments after
 * the request (Next's `{ params }`) are forwarded to the handler untouched.
 *
 * Thrown errors become `{ error: { code, message }, requestId }` via `AppError.toPublic()`, with
 * the error's `headers` (e.g. `retry-after`), so an INTERNAL message never reaches the client. Only
 * server-side failures (5xx, thrown or returned, or non-exposed errors) go to the registered error
 * reporter; 4xx are expected and are just logged.
 *
 * The query string is left out of the logged path because it can carry tokens.
 */
export function observe<Rest extends unknown[] = []>(
  handler: Handler<Rest>,
  { logger }: ObserveOptions,
) {
  return async (req: Request, ...rest: Rest): Promise<Response> => {
    const requestId = requestIdFrom(req.headers)
    const started = performance.now()
    const { pathname } = new URL(req.url)
    const log = logger.child({ requestId })
    const done = (status: number) => ({
      method: req.method,
      path: pathname,
      status,
      durationMs: Math.round(performance.now() - started),
    })

    try {
      const res = await handler(req, { requestId, log }, ...rest)
      if (res.status >= 500) {
        // A server failure the handler answered itself: still one we'd want to be paged for.
        log.error(
          { ...done(res.status), req: { headers: safeHeaders(req.headers) } },
          "request failed",
        )
        reportError(new Error(`${req.method} ${pathname} returned ${res.status}`), {
          requestId,
          method: req.method,
          path: pathname,
          status: res.status,
        })
      } else {
        log.info(done(res.status), "request")
      }
      return withRequestId(res, requestId)
    } catch (e) {
      const error = toAppError(e)
      const fields = { ...done(error.status), err: error, code: error.code, ...error.context }
      if (error.status >= 500 || !error.expose) {
        log.error({ ...fields, req: { headers: safeHeaders(req.headers) } }, "request failed")
        reportError(error, { requestId, method: req.method, path: pathname })
      } else {
        log.warn(fields, "request rejected")
      }
      return withRequestId(
        Response.json(
          { error: error.toPublic(), requestId },
          { status: error.status, headers: error.headers },
        ),
        requestId,
      )
    }
  }
}

/** A dependency check: throws (or rejects) when the dependency is down. It may return a promise. */
export type HealthCheck = () => unknown

export interface HealthOptions {
  /** Per-check budget before it counts as failed. Default 2000. */
  timeoutMs?: number
  logger?: Logger
}

async function runCheck(check: HealthCheck, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs)
  })
  try {
    await Promise.race([Promise.resolve().then(check), timeout])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * A health endpoint: 200 `{ status: "ok" }` when every check passes, 503 `{ status: "degraded" }`
 * otherwise. The body names each check as "ok" or "fail" and never includes error messages, which
 * go to the logger instead. e.g. `{ db: () => db.execute(sql`select 1`) }`.
 */
export function createHealthHandler(
  checks: Record<string, HealthCheck>,
  { timeoutMs = 2000, logger }: HealthOptions = {},
) {
  return async (): Promise<Response> => {
    const results = await Promise.all(
      Object.entries(checks).map(async ([name, check]) => {
        try {
          await runCheck(check, timeoutMs)
          return [name, "ok"] as const
        } catch (e) {
          logger?.error({ err: e, check: name }, "health check failed")
          return [name, "fail"] as const
        }
      }),
    )
    const healthy = results.every(([, result]) => result === "ok")
    return Response.json(
      { status: healthy ? "ok" : "degraded", checks: Object.fromEntries(results) },
      { status: healthy ? 200 : 503, headers: { "cache-control": "no-store" } },
    )
  }
}

export {
  AWS_HEALTH_URL,
  createStatusHandler,
  parseStatusProviders,
  type ProviderState,
  type ProviderStatus,
  type StatusOptions,
  type StatusProvider,
  type StatusReport,
} from "./status"
