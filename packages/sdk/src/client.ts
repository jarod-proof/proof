import createFetchClient from "openapi-fetch"
import { ProofError } from "./errors"
import type { paths as GeneratedPaths } from "./schema.gen"
import { createTransport, type TransportOptions } from "./transport"

export interface ClientOptions extends TransportOptions {
  /** The API origin, e.g. https://api.example.com (no trailing path). */
  baseURL: string
}

export type Method = "GET" | "PUT" | "POST" | "DELETE" | "OPTIONS" | "HEAD" | "PATCH" | "TRACE"

/** Input for the untyped `request` helper. Path placeholders are `{name}`, as in openapi.json. */
export interface RawRequest {
  path?: Record<string, string | number | boolean>
  query?: Record<string, unknown>
  headers?: Record<string, string>
  body?: unknown
}

export type ProofClient = ReturnType<typeof createClient>

// openapi-fetch's declarations require `Record<string, Record<HttpMethod, {}>>`. schema.gen.ts is an
// interface (no implicit index signature), and openapi-typescript marks absent methods `?: undefined`
// (not assignable to `{}`). These mapped types keep the same keys and values, with every method
// present (an absent one is `never`), so the emitted declarations check under skipLibCheck: false.
type Paths = {
  [Path in keyof GeneratedPaths]: {
    [Method in keyof GeneratedPaths[Path]]-?: Exclude<GeneratedPaths[Path][Method], undefined>
  }
}

/** The API client: typed calls from schema.gen.ts plus an untyped `request` for any operation. */
export function createClient(options: ClientOptions) {
  if (options.apiKey !== undefined && options.accessToken !== undefined) {
    throw new TypeError("Pass apiKey or accessToken, not both")
  }
  const baseURL = options.baseURL.replace(/\/+$/, "")
  const transport = createTransport(options)
  const typed = createFetchClient<Paths>({ baseUrl: baseURL, fetch: transport })

  /** Untyped call: for operations chosen at runtime (the CLI's `call`). Resolves to the JSON body. */
  async function request(method: Method, path: string, init: RawRequest = {}): Promise<unknown> {
    const url = new URL(`${baseURL}${expandPath(path, init.path ?? {})}`)
    for (const [key, value] of Object.entries(init.query ?? {})) appendQuery(url, key, value)
    const headers = new Headers(init.headers)
    let body: string | undefined
    if (init.body !== undefined) {
      headers.set("content-type", "application/json")
      body = JSON.stringify(init.body)
    }
    const response = await transport(new Request(url, { method, headers, body }))
    const text = await response.text()
    return text ? JSON.parse(text) : null
  }

  return { ...typed, baseURL, request }
}

/** Replaces `{name}` placeholders with encoded values; a missing one is a caller bug. */
export function expandPath(template: string, values: Record<string, string | number | boolean>) {
  return template.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const value = values[name]
    if (value === undefined) {
      throw new ProofError({
        status: 0,
        code: "BAD_REQUEST",
        message: `Missing path parameter "${name}"`,
      })
    }
    const text = String(value)
    // encodeURIComponent leaves dots alone, and the URL parser would resolve "." or ".." as a
    // path step, sending the call to another route.
    if (text === "." || text === "..") {
      throw new ProofError({
        status: 0,
        code: "BAD_REQUEST",
        message: `Path parameter "${name}" can't be "${text}"`,
      })
    }
    return encodeURIComponent(text)
  })
}

/** A query value as text: strings as they are, other scalars through String, anything else as JSON. */
function queryText(value: unknown): string {
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value)
  }
  return JSON.stringify(value)
}

function appendQuery(url: URL, key: string, value: unknown) {
  if (value === undefined || value === null) return
  if (Array.isArray(value)) {
    for (const item of value) url.searchParams.append(key, queryText(item))
  } else {
    url.searchParams.append(key, queryText(value))
  }
}
