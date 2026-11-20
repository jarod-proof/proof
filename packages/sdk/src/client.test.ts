import { describe, expect, it } from "vitest"
import { createClient, expandPath } from "./client"
import { ProofError } from "./errors"

interface Seen {
  method: string
  url: string
  headers: Headers
  body: string
}

type Reply = Response | Error | ((seen: Seen) => Response)

/** A fetch stub that answers each call with the next reply and records what it was sent. */
function fakeFetch(replies: Reply[]) {
  const calls: Seen[] = []
  const fetch = async (request: Request) => {
    calls.push({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: await request.text(),
    })
    const reply = replies.shift()
    if (reply === undefined) throw new Error("no reply scripted")
    if (reply instanceof Error) throw reply
    if (typeof reply === "function") return reply(calls[calls.length - 1] as Seen)
    return reply
  }
  return { fetch, calls }
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  })

const noSleep = { sleep: async () => {}, random: () => 0 }

/** The error a call rejects with; fails the test if the call succeeds. */
async function rejection(promise: Promise<unknown>): Promise<ProofError> {
  try {
    await promise
  } catch (error) {
    return error as ProofError
  }
  throw new Error("expected the call to fail")
}

describe("createClient auth", () => {
  it("sends the API key as x-api-key", async () => {
    const { fetch, calls } = fakeFetch([json({ ok: true })])
    const client = createClient({ baseURL: "https://api.test/", apiKey: "sk_1", fetch })
    await client.request("GET", "/v1/whoami")
    expect(calls[0]?.url).toBe("https://api.test/v1/whoami")
    expect(calls[0]?.headers.get("x-api-key")).toBe("sk_1")
    expect(calls[0]?.headers.get("authorization")).toBeNull()
  })

  it("sends an access token as a bearer, resolving a function token per request", async () => {
    const { fetch, calls } = fakeFetch([json({}), json({})])
    let n = 0
    const client = createClient({
      baseURL: "https://api.test",
      accessToken: async () => `tok-${++n}`,
      fetch,
    })
    await client.request("GET", "/v1/whoami")
    await client.request("GET", "/v1/whoami")
    expect(calls.map((c) => c.headers.get("authorization"))).toEqual([
      "Bearer tok-1",
      "Bearer tok-2",
    ])
  })

  it("refuses both an API key and an access token", () => {
    expect(() =>
      createClient({ baseURL: "https://api.test", apiKey: "a", accessToken: "b" }),
    ).toThrow(TypeError)
  })
})

describe("createClient typed calls", () => {
  it("returns the parsed body from openapi-fetch", async () => {
    const { fetch } = fakeFetch([json({ organizationId: "org_1", via: "apiKey" })])
    const client = createClient({ baseURL: "https://api.test", apiKey: "k", fetch })
    const { data } = await client.GET("/v1/whoami")
    expect(data).toMatchObject({ organizationId: "org_1" })
  })

  it("throws a ProofError for a typed call that fails", async () => {
    const { fetch } = fakeFetch([
      json(
        { error: { code: "FORBIDDEN", message: "No.", hint: "Ask an admin." } },
        { status: 403 },
      ),
    ])
    const client = createClient({ baseURL: "https://api.test", apiKey: "k", fetch })
    await expect(client.GET("/v1/whoami")).rejects.toMatchObject({
      status: 403,
      code: "FORBIDDEN",
      hint: "Ask an admin.",
    })
  })
})

describe("createClient.request", () => {
  it("expands path parameters, serialises query arrays and sends a JSON body", async () => {
    const { fetch, calls } = fakeFetch([json({ ok: 1 })])
    const client = createClient({ baseURL: "https://api.test", apiKey: "k", fetch })
    const out = await client.request("PATCH", "/v1/things/{id}", {
      path: { id: "a/b" },
      query: { tags: ["x", "y"], empty: undefined, limit: 5 },
      headers: { "x-extra": "1" },
      body: { name: "n" },
    })
    expect(out).toEqual({ ok: 1 })
    expect(calls[0]?.method).toBe("PATCH")
    expect(calls[0]?.url).toBe("https://api.test/v1/things/a%2Fb?tags=x&tags=y&limit=5")
    expect(calls[0]?.headers.get("content-type")).toBe("application/json")
    expect(calls[0]?.headers.get("x-extra")).toBe("1")
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual({ name: "n" })
  })

  it("resolves null for an empty body and sends no content type without a body", async () => {
    const { fetch, calls } = fakeFetch([new Response(null, { status: 200 })])
    const client = createClient({ baseURL: "https://api.test", apiKey: "k", fetch })
    expect(await client.request("DELETE", "/v1/projects/{id}", { path: { id: 1 } })).toBeNull()
    expect(calls[0]?.headers.get("content-type")).toBeNull()
  })

  it("rejects a path with a missing parameter", () => {
    expect(() => expandPath("/v1/projects/{id}", {})).toThrow(ProofError)
  })

  it("refuses a dot segment, which would resolve to another route", () => {
    for (const id of [".", ".."]) {
      expect(() => expandPath("/v1/runs/{id}/steps", { id })).toThrow(ProofError)
    }
    expect(expandPath("/v1/runs/{id}", { id: "..x" })).toBe("/v1/runs/..x")
  })
})

describe("idempotency keys", () => {
  it("adds a key to every non-GET request, not to GET", async () => {
    const { fetch, calls } = fakeFetch([json({}), json({}), json({})])
    const client = createClient({ baseURL: "https://api.test", apiKey: "k", fetch })
    await client.request("GET", "/v1/projects")
    await client.request("POST", "/v1/projects", { body: { name: "a" } })
    await client.request("DELETE", "/v1/projects/{id}", { path: { id: "p" } })
    expect(calls[0]?.headers.get("idempotency-key")).toBeNull()
    expect(calls[1]?.headers.get("idempotency-key")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    expect(calls[2]?.headers.get("idempotency-key")).toBeTruthy()
    expect(calls[1]?.headers.get("idempotency-key")).not.toBe(
      calls[2]?.headers.get("idempotency-key"),
    )
  })

  it("keeps the caller's key and replays the same key on every retry", async () => {
    const { fetch, calls } = fakeFetch([
      json({}, { status: 503 }),
      json({}, { status: 503 }),
      json({ created: true }),
    ])
    const client = createClient({
      baseURL: "https://api.test",
      apiKey: "k",
      fetch,
      retry: { baseDelayMs: 1 },
      ...noSleep,
    })
    await client.request("POST", "/v1/projects", {
      headers: { "Idempotency-Key": "mine-1" },
      body: { name: "a" },
    })
    expect(calls.map((c) => c.headers.get("idempotency-key"))).toEqual([
      "mine-1",
      "mine-1",
      "mine-1",
    ])
  })

  it("uses one generated key across retries of an auto-keyed POST", async () => {
    const { fetch, calls } = fakeFetch([json({}, { status: 429 }), json({ ok: true })])
    const client = createClient({
      baseURL: "https://api.test",
      apiKey: "k",
      fetch,
      retry: { baseDelayMs: 1 },
      ...noSleep,
    })
    await client.request("POST", "/v1/projects", { body: {} })
    expect(calls[0]?.headers.get("idempotency-key")).toBe(calls[1]?.headers.get("idempotency-key"))
  })
})

describe("retries", () => {
  it("honours Retry-After in seconds, then succeeds", async () => {
    const waits: number[] = []
    const { fetch } = fakeFetch([
      new Response("", { status: 429, headers: { "retry-after": "2" } }),
      json({ ok: true }),
    ])
    const client = createClient({
      baseURL: "https://api.test",
      apiKey: "k",
      fetch,
      sleep: async (ms) => {
        waits.push(ms)
      },
      random: () => 0,
    })
    expect(await client.request("GET", "/v1/projects")).toEqual({ ok: true })
    expect(waits).toEqual([2000])
  })

  it("honours a Retry-After HTTP date", async () => {
    const waits: number[] = []
    const date = new Date(Date.now() + 3000).toUTCString()
    const { fetch } = fakeFetch([
      new Response("", { status: 503, headers: { "retry-after": date } }),
      json({}),
    ])
    const client = createClient({
      baseURL: "https://api.test",
      apiKey: "k",
      fetch,
      sleep: async (ms) => {
        waits.push(ms)
      },
      random: () => 0,
    })
    await client.request("GET", "/v1/projects")
    expect(waits[0]).toBeGreaterThan(1000)
    expect(waits[0]).toBeLessThanOrEqual(3000)
  })

  it("backs off with jitter when there is no Retry-After", async () => {
    const waits: number[] = []
    const { fetch } = fakeFetch([
      new Response("", { status: 503 }),
      new Response("", { status: 503 }),
      json({}),
    ])
    const client = createClient({
      baseURL: "https://api.test",
      apiKey: "k",
      fetch,
      retry: { baseDelayMs: 100, maxDelayMs: 10_000 },
      sleep: async (ms) => {
        waits.push(ms)
      },
      random: () => 1,
    })
    await client.request("GET", "/v1/projects")
    expect(waits).toEqual([100, 200])
  })

  it("gives up after maxRetries and throws the rate-limit error with retryAfter", async () => {
    const body = { error: { code: "RATE_LIMITED", message: "Slow down." } }
    const { fetch, calls } = fakeFetch([
      json(body, { status: 429, headers: { "retry-after": "1" } }),
      json(body, { status: 429, headers: { "retry-after": "1" } }),
    ])
    const client = createClient({
      baseURL: "https://api.test",
      apiKey: "k",
      fetch,
      retry: { maxRetries: 1 },
      ...noSleep,
    })
    const error = await client.request("GET", "/v1/projects").catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ProofError)
    expect(error).toMatchObject({ status: 429, code: "RATE_LIMITED", retryAfter: 1 })
    // The JSON an agent reads (the CLI prints it) keeps the wait.
    expect((error as ProofError).toJSON()).toMatchObject({ status: 429, retryAfter: 1 })
    expect(calls).toHaveLength(2)
  })

  it("does not wait past maxDelayMs; the error comes back at once", async () => {
    const waits: number[] = []
    const { fetch, calls } = fakeFetch([
      new Response("", { status: 429, headers: { "retry-after": "3600" } }),
    ])
    const client = createClient({
      baseURL: "https://api.test",
      apiKey: "k",
      fetch,
      sleep: async (ms) => {
        waits.push(ms)
      },
    })
    await expect(client.request("GET", "/v1/projects")).rejects.toMatchObject({
      status: 429,
      retryAfter: 3600,
    })
    expect(waits).toEqual([])
    expect(calls).toHaveLength(1)
  })

  it("retries network errors on GET", async () => {
    const { fetch, calls } = fakeFetch([new TypeError("socket hang up"), json({ ok: true })])
    const client = createClient({
      baseURL: "https://api.test",
      apiKey: "k",
      fetch,
      retry: { baseDelayMs: 1 },
      ...noSleep,
    })
    expect(await client.request("GET", "/v1/projects")).toEqual({ ok: true })
    expect(calls).toHaveLength(2)
  })

  it("does not retry a network error on a POST without a caller key", async () => {
    const { fetch, calls } = fakeFetch([new TypeError("reset")])
    const client = createClient({ baseURL: "https://api.test", apiKey: "k", fetch, ...noSleep })
    const error = await rejection(client.request("POST", "/v1/projects", { body: {} }))
    expect(error).toMatchObject({ status: 0, code: "NETWORK_ERROR" })
    expect(calls).toHaveLength(1)
  })

  it("retries a network error on a POST that carries a caller key", async () => {
    const { fetch, calls } = fakeFetch([new TypeError("reset"), json({ ok: true })])
    const client = createClient({
      baseURL: "https://api.test",
      apiKey: "k",
      fetch,
      retry: { baseDelayMs: 1 },
      ...noSleep,
    })
    await client.request("POST", "/v1/projects", { headers: { "idempotency-key": "k1" }, body: {} })
    expect(calls).toHaveLength(2)
  })

  it("reports a network error that exhausts the retries", async () => {
    const { fetch } = fakeFetch([new TypeError("down"), new TypeError("down")])
    const client = createClient({
      baseURL: "https://api.test",
      apiKey: "k",
      fetch,
      retry: { maxRetries: 1, baseDelayMs: 1 },
      ...noSleep,
    })
    await expect(client.request("GET", "/x")).rejects.toMatchObject({
      code: "NETWORK_ERROR",
      message: "Could not reach https://api.test/x",
    })
  })

  it("does not retry at all with retry: false", async () => {
    const { fetch, calls } = fakeFetch([new Response("", { status: 503 })])
    const client = createClient({
      baseURL: "https://api.test",
      apiKey: "k",
      fetch,
      retry: false,
      ...noSleep,
    })
    await expect(client.request("GET", "/x")).rejects.toMatchObject({ status: 503 })
    expect(calls).toHaveLength(1)
  })

  it("does not retry other failures", async () => {
    const { fetch, calls } = fakeFetch([new Response("", { status: 500 })])
    const client = createClient({ baseURL: "https://api.test", apiKey: "k", fetch, ...noSleep })
    await expect(client.request("GET", "/x")).rejects.toMatchObject({ code: "HTTP_500" })
    expect(calls).toHaveLength(1)
  })
})

describe("error mapping", () => {
  it("keeps the API's code, message, hint and docs", async () => {
    const { fetch } = fakeFetch([
      json(
        {
          error: {
            code: "NOT_FOUND",
            message: "No project.",
            hint: "List them.",
            docs: "https://d",
          },
        },
        { status: 404 },
      ),
    ])
    const client = createClient({ baseURL: "https://api.test", apiKey: "k", fetch })
    const error = await rejection(client.request("GET", "/x"))
    expect(error.toJSON()).toEqual({
      status: 404,
      error: { code: "NOT_FOUND", message: "No project.", hint: "List them.", docs: "https://d" },
    })
    expect(error.name).toBe("ProofError")
  })

  it("maps a non-JSON failure to HTTP_<status> with the status text", async () => {
    const { fetch } = fakeFetch([
      new Response("<html>", { status: 502, statusText: "Bad Gateway" }),
    ])
    const client = createClient({ baseURL: "https://api.test", apiKey: "k", fetch })
    const error = await rejection(client.request("GET", "/x"))
    expect(error).toMatchObject({ status: 502, code: "HTTP_502", message: "Bad Gateway" })
    expect(error.toJSON()).toEqual({
      status: 502,
      error: { code: "HTTP_502", message: "Bad Gateway" },
    })
  })

  it("falls back to a generic message when the status text is empty", async () => {
    const { fetch } = fakeFetch([new Response("", { status: 500, statusText: "" })])
    const client = createClient({ baseURL: "https://api.test", apiKey: "k", fetch })
    await expect(client.request("GET", "/x")).rejects.toMatchObject({
      message: "Request failed with status 500",
    })
  })

  it("maps an error body that is valid JSON but not the error shape", async () => {
    const { fetch } = fakeFetch([json({ error: "boom" }, { status: 400 })])
    const client = createClient({ baseURL: "https://api.test", apiKey: "k", fetch })
    await expect(client.request("GET", "/x")).rejects.toMatchObject({ code: "HTTP_400" })
  })
})
