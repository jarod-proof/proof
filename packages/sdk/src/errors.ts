/** The error body every failed API call returns: `{ error: { code, message, hint?, docs? } }`. */
export interface ErrorBody {
  error: { code: string; message: string; hint?: string; docs?: string }
}

export interface ProofErrorInit {
  status: number
  code: string
  message: string
  hint?: string
  docs?: string
  retryAfter?: number
  cause?: unknown
}

/**
 * A failed call. `status` is the HTTP status (0 when no response arrived). `code` is the API's
 * error code (e.g. FORBIDDEN, RATE_LIMITED) or a transport code (NETWORK_ERROR, HTTP_<status>).
 */
export class ProofError extends Error {
  readonly status: number
  readonly code: string
  readonly hint?: string
  readonly docs?: string
  /** Seconds the server asked us to wait (Retry-After), when it said so. */
  readonly retryAfter?: number

  constructor(init: ProofErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause })
    this.name = "ProofError"
    this.status = init.status
    this.code = init.code
    this.hint = init.hint
    this.docs = init.docs
    this.retryAfter = init.retryAfter
  }

  /** The shape agents read: the same JSON the API sends, plus the HTTP status. */
  toJSON(): ErrorBody & { status: number; retryAfter?: number } {
    return {
      status: this.status,
      // The API's hints say "retry after the Retry-After seconds"; an agent reading this needs them.
      ...(this.retryAfter !== undefined ? { retryAfter: this.retryAfter } : {}),
      error: {
        code: this.code,
        message: this.message,
        ...(this.hint ? { hint: this.hint } : {}),
        ...(this.docs ? { docs: this.docs } : {}),
      },
    }
  }
}

/** Parses a Retry-After header: delta-seconds or an HTTP date. Undefined when absent or invalid. */
export function parseRetryAfter(
  value: string | null,
  now: number = Date.now(),
): number | undefined {
  if (value === null) return undefined
  const trimmed = value.trim()
  // Delta-seconds; a fraction (not in the spec, but sent) rounds up so the wait is never short.
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.ceil(Number(trimmed))
  // Anything else must look like an HTTP date (it names a weekday or month). Date.parse would
  // otherwise read "-1" or "1e3" as a year.
  if (!/[a-z]/i.test(trimmed)) return undefined
  const date = Date.parse(trimmed)
  if (Number.isNaN(date)) return undefined
  return Math.max(0, Math.ceil((date - now) / 1000))
}

function isErrorBody(value: unknown): value is ErrorBody {
  if (typeof value !== "object" || value === null || !("error" in value)) return false
  const error = (value as { error: unknown }).error
  return (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { code?: unknown }).code === "string" &&
    typeof (error as { message?: unknown }).message === "string"
  )
}

/** Builds the ProofError for a non-2xx response, reading the API's error body when it has one. */
export async function errorFromResponse(response: Response): Promise<ProofError> {
  const retryAfter = parseRetryAfter(response.headers.get("retry-after"))
  const text = await response.text().catch(() => "")
  let parsed: unknown
  try {
    parsed = text ? JSON.parse(text) : undefined
  } catch {
    parsed = undefined
  }
  if (isErrorBody(parsed)) {
    const { code, message, hint, docs } = parsed.error
    return new ProofError({ status: response.status, code, message, hint, docs, retryAfter })
  }
  return new ProofError({
    status: response.status,
    code: `HTTP_${response.status}`,
    message: response.statusText || `Request failed with status ${response.status}`,
    retryAfter,
  })
}
