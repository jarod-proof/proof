export type HqErrorKind =
  | "unauthorized"
  | "forbidden"
  | "untrusted-origin"
  | "not-found"
  | "conflict"
  | "bad-request"
  | "rate-limited"
  | "refused"
  | "unreachable"
  | "server"

export interface HqErrorInit {
  kind: HqErrorKind
  status: number
  message: string
  code?: string | null
  retryAfterSeconds?: number | null
}

/** What every failed call to hq becomes: one class, one `kind` table, no raw Response leaks. */
export class HqError extends Error {
  readonly kind: HqErrorKind
  /** 0 when hq could not be reached. */
  readonly status: number
  /** The AppError code of `{ error: { code } }` (or better-auth's `{ code }`), when there is one. */
  readonly code: string | null
  /** Seconds to wait; set for `rate-limited` only. */
  readonly retryAfterSeconds: number | null

  constructor(init: HqErrorInit) {
    super(init.message)
    this.name = "HqError"
    this.kind = init.kind
    this.status = init.status
    this.code = init.code ?? null
    this.retryAfterSeconds = init.retryAfterSeconds ?? null
  }
}

const TRUSTED_ORIGIN_PREFIX = "A signed-in write must come from a trusted origin"
const DEFAULT_RETRY_AFTER_SECONDS = 5

/** hq's refused boot answers exactly `{"error":"service unavailable"}` (a string, not an object). */
export function isRefusedBody(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    Object.keys(body).length === 1 &&
    (body as { error?: unknown }).error === "service unavailable"
  )
}

function messageAndCode(body: unknown): { message: string | null; code: string | null } {
  if (typeof body !== "object" || body === null) return { message: null, code: null }
  const record = body as Record<string, unknown>
  // hq's own errors are `{ error: { code, message } }`; better-auth's are `{ code, message }`.
  const inner = typeof record.error === "object" && record.error !== null ? record.error : record
  const fields = inner as Record<string, unknown>
  return {
    message: typeof fields.message === "string" ? fields.message : null,
    code: typeof fields.code === "string" ? fields.code : null,
  }
}

function retryAfter(headers: Headers): number {
  for (const name of ["x-retry-after", "retry-after"]) {
    const value = Number(headers.get(name))
    if (headers.get(name) !== null && Number.isFinite(value) && value >= 0) return Math.ceil(value)
  }
  return DEFAULT_RETRY_AFTER_SECONDS
}

/**
 * The one table from a failed reply to an HqError. `body` is the parsed JSON, or `undefined` when
 * the reply was not JSON.
 */
export function errorFromReply(status: number, headers: Headers, body: unknown): HqError {
  const { message, code } = messageAndCode(body)
  const make = (kind: HqErrorKind, extra: Partial<HqErrorInit> = {}) =>
    new HqError({ kind, status, code, message: message ?? `hq answered ${status}`, ...extra })

  if (status >= 500) return make(status === 503 && isRefusedBody(body) ? "refused" : "server")
  if (body === undefined) return make("server")
  if (status === 401) return make("unauthorized")
  if (status === 403) {
    // better-auth's own origin check answers INVALID_ORIGIN; hq's /v1 check answers FORBIDDEN.
    const untrusted = message?.startsWith(TRUSTED_ORIGIN_PREFIX) || code === "INVALID_ORIGIN"
    return make(untrusted ? "untrusted-origin" : "forbidden")
  }
  if (status === 404) return make("not-found")
  if (status === 409) return make("conflict")
  if (status === 429) return make("rate-limited", { retryAfterSeconds: retryAfter(headers) })
  return make("bad-request")
}
