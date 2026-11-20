import { describe, expect, it } from "vitest"
import { errorFromResponse, parseRetryAfter, ProofError } from "./errors"

describe("parseRetryAfter", () => {
  it("reads delta-seconds", () => {
    expect(parseRetryAfter("30")).toBe(30)
    expect(parseRetryAfter(" 0 ")).toBe(0)
  })

  it("rounds fractional seconds up, and refuses other numbers rather than reading them as years", () => {
    // Date.parse("1.5") and Date.parse("-1") are dates in 2001, which came out as "retry now".
    expect(parseRetryAfter("1.5")).toBe(2)
    expect(parseRetryAfter("-1")).toBeUndefined()
    expect(parseRetryAfter("2030")).toBe(2030)
    expect(parseRetryAfter("1e3")).toBeUndefined()
  })

  it("reads an HTTP date relative to now, never negative", () => {
    const now = Date.parse("2030-01-01T00:00:00Z")
    expect(parseRetryAfter("Tue, 01 Jan 2030 00:01:00 GMT", now)).toBe(60)
    expect(parseRetryAfter("Mon, 01 Jan 2029 00:00:00 GMT", now)).toBe(0)
  })

  it("returns undefined when absent or unparseable", () => {
    expect(parseRetryAfter(null)).toBeUndefined()
    expect(parseRetryAfter("soon")).toBeUndefined()
  })
})

describe("errorFromResponse", () => {
  it("carries retry-after and the API's hint and docs", async () => {
    const response = new Response(
      JSON.stringify({ error: { code: "RATE_LIMITED", message: "m", hint: "h", docs: "d" } }),
      { status: 429, headers: { "retry-after": "5" } },
    )
    const error = await errorFromResponse(response)
    expect(error).toBeInstanceOf(ProofError)
    expect(error).toMatchObject({ status: 429, code: "RATE_LIMITED", hint: "h", docs: "d" })
    expect(error.retryAfter).toBe(5)
  })

  it("omits hint and docs from the JSON when they are absent", () => {
    const error = new ProofError({ status: 400, code: "BAD_REQUEST", message: "bad" })
    expect(error.toJSON()).toEqual({
      status: 400,
      error: { code: "BAD_REQUEST", message: "bad" },
    })
  })

  it("keeps the cause of a transport failure", () => {
    const cause = new Error("socket")
    const error = new ProofError({ status: 0, code: "NETWORK_ERROR", message: "m", cause })
    expect(error.cause).toBe(cause)
  })
})
