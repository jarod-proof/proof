import { errorFromResponse, parseRetryAfter, ProofError } from "./errors"

/** Retry policy. `false` disables retries entirely. */
export interface RetryOptions {
  /** Retries after the first attempt. Default 3. */
  maxRetries?: number
  /** First backoff step when the server gives no Retry-After. Default 500ms, doubled per attempt. */
  baseDelayMs?: number
  /** Longest wait we accept. A Retry-After beyond this is returned as the error instead. Default 30s. */
  maxDelayMs?: number
}

export interface TransportOptions {
  apiKey?: string
  accessToken?: string | (() => Promise<string>)
  /** Replaces the global fetch (tests, proxies, runtimes without it). */
  fetch?: (input: Request) => Promise<Response>
  retry?: RetryOptions | false
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>
  /** Injected for tests. Returns a number in [0, 1). */
  random?: () => number
}

/** Methods the HTTP spec defines as idempotent. POST is not, unless the caller gives a key. */
const SAFE_METHODS = new Set(["GET", "HEAD"])
const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "OPTIONS", "PUT", "DELETE"])
/** 429 and 503 mean the server turned the request away, so retrying is safe for any method. */
const RETRYABLE_STATUS = new Set([429, 503])
const IDEMPOTENCY_KEY = "idempotency-key"

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * A fetch that adds credentials, an Idempotency-Key to every non-GET request, retries 429/503 and
 * (for idempotent requests) network failures, and turns non-2xx responses into ProofError.
 * The openapi-fetch client and the untyped `request` helper both go through it.
 */
export function createTransport(options: TransportOptions): (input: Request) => Promise<Response> {
  const send = options.fetch ?? ((input: Request) => globalThis.fetch(input))
  const sleep = options.sleep ?? defaultSleep
  const random = options.random ?? Math.random
  const retry = options.retry === false ? undefined : (options.retry ?? {})
  const maxRetries = retry?.maxRetries ?? 3
  const baseDelayMs = retry?.baseDelayMs ?? 500
  const maxDelayMs = retry?.maxDelayMs ?? 30_000

  /** Full jitter on the exponential step: between half and all of it. */
  const backoff = (attempt: number) =>
    Math.min(maxDelayMs, baseDelayMs * 2 ** attempt) * (0.5 + random() / 2)

  async function authorize(headers: Headers) {
    if (!headers.has("authorization") && !headers.has("x-api-key")) {
      if (options.accessToken !== undefined) {
        const token =
          typeof options.accessToken === "string"
            ? options.accessToken
            : await options.accessToken()
        headers.set("authorization", `Bearer ${token}`)
      } else if (options.apiKey !== undefined) {
        headers.set("x-api-key", options.apiKey)
      }
    }
  }

  return async function transport(input: Request): Promise<Response> {
    const callerKey = input.headers.get(IDEMPOTENCY_KEY)
    const headers = new Headers(input.headers)
    await authorize(headers)
    if (!SAFE_METHODS.has(input.method.toUpperCase()) && callerKey === null) {
      // One key for the whole logical call, so every retry replays the same operation.
      headers.set(IDEMPOTENCY_KEY, crypto.randomUUID())
    }
    const safeToRetryNetwork =
      IDEMPOTENT_METHODS.has(input.method.toUpperCase()) || callerKey !== null
    // Build the request once; each attempt sends a clone so a body can be replayed.
    const base = new Request(input, { headers })

    for (let attempt = 0; ; attempt++) {
      const canRetry = retry !== undefined && attempt < maxRetries
      let response: Response
      try {
        response = await send(base.clone())
      } catch (cause) {
        if (!canRetry || !safeToRetryNetwork) {
          throw new ProofError({
            status: 0,
            code: "NETWORK_ERROR",
            message: `Could not reach ${base.url}`,
            hint: "Check the base URL and your network connection, then retry.",
            cause,
          })
        }
        await sleep(backoff(attempt))
        continue
      }

      if (response.ok || !RETRYABLE_STATUS.has(response.status) || !canRetry) {
        if (response.ok) return response
        throw await errorFromResponse(response)
      }

      const retryAfter = parseRetryAfter(response.headers.get("retry-after"))
      const delay = retryAfter === undefined ? backoff(attempt) : retryAfter * 1000 + random() * 250
      if (delay > maxDelayMs) throw await errorFromResponse(response)
      await response.body?.cancel()
      await sleep(delay)
    }
  }
}
