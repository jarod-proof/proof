// @vitest-environment jsdom
import { QueryClient } from "@tanstack/react-query"
import { describe, expect, it, vi } from "vitest"

import { createHqClient } from "./client"
import { HqError } from "./errors"
import { hqKeys } from "./query-keys"
import { createQueryClient } from "./query-client"

interface Call {
  url: string
  init: RequestInit
}

/** A fetch that records its calls and answers with `reply` (a Response, or a function of the call). */
function stub(reply: Response | ((call: Call) => Response | Promise<Response>)) {
  const calls: Call[] = []
  const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const call = {
      url: typeof url === "string" ? url : url instanceof URL ? url.href : url.url,
      init: init ?? {},
    }
    calls.push(call)
    return typeof reply === "function" ? reply(call) : reply.clone()
  }) as unknown as typeof globalThis.fetch
  return { fetch, calls }
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })

const bodyOf = (body: unknown): unknown => (typeof body === "string" ? JSON.parse(body) : undefined)

const failure = async (promise: Promise<unknown>): Promise<HqError> => {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(HqError)
  return error as HqError
}

describe("createHqClient", () => {
  it("status() sends GET /v1/status with same-origin credentials and no body", async () => {
    const { fetch, calls } = stub(json(200, { ok: true, version: "0.0.0" }))
    await expect(createHqClient({ fetch }).status()).resolves.toEqual({
      ok: true,
      version: "0.0.0",
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe("/v1/status")
    expect(calls[0]?.init.method).toBe("GET")
    expect(calls[0]?.init.credentials).toBe("same-origin")
    expect(calls[0]?.init.body).toBeUndefined()
  })

  it("writes send application/json and a JSON body and never set an Origin header", async () => {
    const { fetch, calls } = stub(json(200, { success: true }))
    const client = createHqClient({ fetch })
    await client.signOut()
    await client.signIn({ email: "a@b.co", password: "pw" })
    for (const call of calls) {
      const headers = new Headers(call.init.headers)
      expect(call.init.method).toBe("POST")
      expect(headers.get("content-type")).toBe("application/json")
      expect(headers.has("origin")).toBe(false)
      expect(typeof call.init.body).toBe("string")
    }
    expect(calls[1]?.url).toBe("/api/auth/sign-in/email")
    expect(bodyOf(calls[1]?.init.body)).toEqual({ email: "a@b.co", password: "pw" })
  })

  it("a refused hq is HqError kind refused, not server", async () => {
    const { fetch } = stub(json(503, { error: "service unavailable" }))
    const error = await failure(createHqClient({ fetch }).status())
    expect(error.kind).toBe("refused")
    expect(error.status).toBe(503)
  })

  it("a trusted-origin 403 is untrusted-origin, a founder 403 is forbidden", async () => {
    const untrusted = stub(
      json(403, {
        error: { code: "FORBIDDEN", message: "A signed-in write must come from a trusted origin" },
      }),
    )
    const first = await failure(
      createHqClient({ fetch: untrusted.fetch }).decideProposal({
        proposalId: "p",
        decision: "approve",
      }),
    )
    expect(first.kind).toBe("untrusted-origin")
    expect(first.code).toBe("FORBIDDEN")

    const founder = stub(
      json(403, { error: { code: "FORBIDDEN", message: "Only a founder can do this" } }),
    )
    const second = await failure(createHqClient({ fetch: founder.fetch }).status())
    expect(second.kind).toBe("forbidden")

    const foreign = stub(json(403, { code: "INVALID_ORIGIN", message: "Invalid origin" }))
    expect((await failure(createHqClient({ fetch: foreign.fetch }).signOut())).kind).toBe(
      "untrusted-origin",
    )
  })

  it("429 carries retryAfterSeconds", async () => {
    const message = { message: "Too many requests. Please try again later." }
    const a = await failure(
      createHqClient({ fetch: stub(json(429, message, { "x-retry-after": "60" })).fetch }).signIn({
        email: "a",
        password: "b",
      }),
    )
    expect([a.kind, a.retryAfterSeconds]).toEqual(["rate-limited", 60])
    const b = await failure(
      createHqClient({ fetch: stub(json(429, message, { "retry-after": "7" })).fetch }).status(),
    )
    expect(b.retryAfterSeconds).toBe(7)
    const c = await failure(createHqClient({ fetch: stub(json(429, message)).fetch }).status())
    expect(c.retryAfterSeconds).toBe(5)
  })

  it("a rejected fetch is unreachable", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch")
    }) as unknown as typeof globalThis.fetch
    const error = await failure(createHqClient({ fetch }).status())
    expect([error.kind, error.status]).toEqual(["unreachable", 0])
  })

  it("a non-JSON 502 is server", async () => {
    const { fetch } = stub(new Response("<html>Bad gateway</html>", { status: 502 }))
    expect((await failure(createHqClient({ fetch }).status())).kind).toBe("server")
  })

  it("maps 401, 404, 409 and 400 to their kinds and carries the AppError code", async () => {
    const cases = [
      [401, "UNAUTHORIZED", "unauthorized"],
      [404, "NOT_FOUND", "not-found"],
      [409, "CONFLICT", "conflict"],
      [400, "BAD_REQUEST", "bad-request"],
    ] as const
    for (const [status, code, kind] of cases) {
      const { fetch } = stub(json(status, { error: { code, message: "x" } }))
      const error = await failure(createHqClient({ fetch }).status())
      expect([error.kind, error.code]).toEqual([kind, code])
    }
  })

  it("a reply that does not match its schema is server", async () => {
    const { fetch } = stub(json(200, { ok: false }))
    expect((await failure(createHqClient({ fetch }).status())).kind).toBe("server")
    const html = stub(new Response("<html></html>", { status: 200 }))
    expect((await failure(createHqClient({ fetch: html.fetch }).status())).kind).toBe("server")
  })

  it("session() is the user, or null with no cookie", async () => {
    const user = { id: "u1", email: "a@b.co", name: "A" }
    const signedIn = stub(json(200, { session: { id: "s" }, user }))
    await expect(createHqClient({ fetch: signedIn.fetch }).session()).resolves.toEqual(user)
    const signedOut = stub(json(200, null))
    await expect(createHqClient({ fetch: signedOut.fetch }).session()).resolves.toBeNull()
    expect(signedOut.calls[0]?.url).toBe("/api/auth/get-session")
  })

  it("decideProposal posts to /v1/proposals/:id/decision with decision and note", async () => {
    const { fetch, calls } = stub(json(200, { status: "approved", entryId: "e1", version: 2 }))
    const result = await createHqClient({ fetch }).decideProposal({
      proposalId: "p/1",
      decision: "approve",
      note: "ok",
    })
    expect(result).toEqual({ status: "approved", entryId: "e1", version: 2 })
    expect(calls[0]?.url).toBe("/v1/proposals/p%2F1/decision")
    expect(calls[0]?.init.method).toBe("POST")
    expect(bodyOf(calls[0]?.init.body)).toEqual({ decision: "approve", note: "ok" })
  })

  it("listProposals and getDigest put their input in the query string; baseUrl prefixes it", async () => {
    const { fetch, calls } = stub(json(200, { proposals: [], nextCursor: null }))
    const client = createHqClient({ baseUrl: "http://hq.test", fetch })
    await client.listProposals({ status: "pending", limit: 20 })
    expect(calls[0]?.url).toBe("http://hq.test/v1/proposals?status=pending&limit=20")
    await client.getDigest({ since: "2026-11-01T00:00:00Z" }).catch(() => null)
    expect(calls[1]?.url).toBe("http://hq.test/v1/digest?since=2026-11-01T00%3A00%3A00Z")
  })
})

describe("createQueryClient", () => {
  const unreachable = () => new HqError({ kind: "unreachable", status: 0, message: "down" })

  it("queries retry only unreachable and server errors, twice, and mutations never retry", async () => {
    const client = createQueryClient()
    const retry = client.getDefaultOptions().queries?.retry as (n: number, e: unknown) => boolean
    const make = (kind: HqError["kind"]) => new HqError({ kind, status: 0, message: kind })
    expect(retry(0, make("unreachable"))).toBe(true)
    expect(retry(1, make("server"))).toBe(true)
    expect(retry(2, make("server"))).toBe(false)
    for (const kind of [
      "unauthorized",
      "forbidden",
      "refused",
      "conflict",
      "rate-limited",
    ] as const) {
      expect(retry(0, make(kind))).toBe(false)
    }
    expect(retry(0, new Error("boom"))).toBe(false)
    expect(client.getDefaultOptions().mutations?.retry).toBe(false)

    let attempts = 0
    await client
      .fetchQuery({
        queryKey: ["x"],
        retryDelay: 0,
        queryFn: () => {
          attempts += 1
          throw unreachable()
        },
      })
      .catch(() => null)
    expect(attempts).toBe(3)
  })

  it("an unauthorized query invalidates the status probe", async () => {
    const client = createQueryClient()
    const spy = vi.spyOn(QueryClient.prototype, "invalidateQueries")
    await client
      .fetchQuery({
        queryKey: ["p"],
        queryFn: () => {
          throw new HqError({ kind: "unauthorized", status: 401, message: "no" })
        },
      })
      .catch(() => null)
    expect(spy).toHaveBeenCalledWith({ queryKey: hqKeys.status() })
    spy.mockRestore()
  })
})

describe("an unauthorized status probe", () => {
  it("does not invalidate itself: the status probe's own 401 never invalidates the status key", async () => {
    const client = createQueryClient()
    const spy = vi.spyOn(client, "invalidateQueries")
    await client
      .fetchQuery({
        queryKey: hqKeys.status(),
        queryFn: () => {
          throw new HqError({ kind: "unauthorized", status: 401, message: "no" })
        },
      })
      .catch(() => null)
    // With an observer on the key, an invalidate here would refetch it forever.
    expect(spy).not.toHaveBeenCalledWith({ queryKey: hqKeys.status() })
  })

  it("another query's 401 still invalidates the status probe", async () => {
    const client = createQueryClient()
    const spy = vi.spyOn(client, "invalidateQueries")
    await client
      .fetchQuery({
        queryKey: hqKeys.proposals("pending"),
        queryFn: () => {
          throw new HqError({ kind: "unauthorized", status: 401, message: "no" })
        },
      })
      .catch(() => null)
    expect(spy).toHaveBeenCalledWith({ queryKey: hqKeys.status() })
  })
})

describe("hqKeys", () => {
  it("hqKeys prefixes: proposals(status) starts with ['proposals']", () => {
    expect(hqKeys.proposals("pending").slice(0, 1)).toEqual(["proposals"])
    expect(hqKeys.proposals().slice(0, 1)).toEqual(["proposals"])
    expect(hqKeys.digest("2026-11-01T00:00:00Z")).not.toEqual(hqKeys.digest())
  })
})
