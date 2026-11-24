import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { HqError } from "#lib/hq/client.js"
import { log } from "#lib/log.js"
import {
  HOOK_HQ_TIMEOUT_MS,
  hookHq,
  recordSafely,
  recorderStats,
  resetRecorderStats,
} from "#lib/work/recorder.js"

beforeEach(() => {
  resetRecorderStats()
  vi.spyOn(log, "warn").mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

const failWith = (error: unknown) => () => Promise.reject(error)

describe("recordSafely", () => {
  test("it returns what the call returns", async () => {
    expect(await recordSafely("x", () => Promise.resolve(7))).toBe(7)
    expect(recorderStats()).toEqual({ dropped: 0, conflicts: 0, rejected: 0, unavailable: 0 })
    expect(log.warn).not.toHaveBeenCalled()
  })

  test("a 409 is logged as conflict and counted, not swallowed silently", async () => {
    const result = await recordSafely(
      "record_signal",
      failWith(new HqError("exists", 409, "CONFLICT")),
    )
    expect(result).toBeNull()
    expect(log.warn).toHaveBeenCalledWith("work_record_dropped", {
      label: "record_signal",
      kind: "conflict",
      status: 409,
      code: "CONFLICT",
    })
    expect(recorderStats()).toEqual({ dropped: 1, conflicts: 1, rejected: 0, unavailable: 0 })
  })

  test("a 400, a 503 and a timeout are counted under rejected and unavailable and return null (a 404 and a 500 likewise)", async () => {
    expect(await recordSafely("a", failWith(new HqError("bad", 400, "BAD_REQUEST")))).toBeNull()
    expect(await recordSafely("a", failWith(new HqError("nf", 404, "NOT_FOUND")))).toBeNull()
    expect(await recordSafely("b", failWith(new HqError("down", 503, "UNAVAILABLE")))).toBeNull()
    expect(await recordSafely("b", failWith(new HqError("boom", 500, "INTERNAL")))).toBeNull()
    expect(
      await recordSafely("c", failWith(new HqError("unreachable", 0, "UNREACHABLE"))),
    ).toBeNull()
    expect(recorderStats()).toEqual({ dropped: 5, conflicts: 0, rejected: 2, unavailable: 3 })
  })

  test("a non-HqError throw (an aborted body read) and a bad reply are unavailable, never thrown", async () => {
    const timeout = new DOMException("The operation timed out", "TimeoutError")
    expect(await recordSafely("a", failWith(timeout))).toBeNull()
    expect(await recordSafely("a", failWith("a string"))).toBeNull()
    expect(await recordSafely("a", failWith(new HqError("shape", 200, "BAD_REPLY")))).toBeNull()
    expect(recorderStats()).toEqual({ dropped: 3, conflicts: 0, rejected: 0, unavailable: 3 })
  })

  test("a synchronous throw inside the call is caught too", async () => {
    const result = await recordSafely("a", () => {
      throw new Error("mapper blew up")
    })
    expect(result).toBeNull()
    expect(recorderStats().dropped).toBe(1)
  })

  test("the log carries the label, kind, status and code and none of the error's text", async () => {
    await recordSafely(
      "record_pull_request",
      failWith(new HqError("SECRET issue title", 400, "BAD_REQUEST")),
    )
    const [, details] = vi.mocked(log.warn).mock.calls[0] ?? []
    expect(Object.keys(details as object).sort()).toEqual(["code", "kind", "label", "status"])
    expect(JSON.stringify(vi.mocked(log.warn).mock.calls)).not.toContain("SECRET")
  })

  test("it never throws even when the logger does", async () => {
    vi.mocked(log.warn).mockImplementation(() => {
      throw new Error("logger down")
    })
    expect(await recordSafely("a", failWith(new Error("x")))).toBeNull()
  })
})

describe("hookHq", () => {
  test("is null, quietly, with no environment or with only one of the two variables", () => {
    vi.stubEnv("HQ_BASE_URL", "")
    vi.stubEnv("HQ_AGENT_API_KEY", "")
    expect(hookHq()).toBeNull()
    vi.stubEnv("HQ_BASE_URL", "http://hq.test")
    expect(hookHq()).toBeNull()
    vi.stubEnv("HQ_BASE_URL", "")
    vi.stubEnv("HQ_AGENT_API_KEY", "k")
    expect(hookHq()).toBeNull()
    expect(log.warn).not.toHaveBeenCalled()
  })

  test("hookHq is null with no environment and builds a 3000 ms client with it", async () => {
    vi.stubEnv("HQ_BASE_URL", "")
    vi.stubEnv("HQ_AGENT_API_KEY", "")
    expect(hookHq()).toBeNull()
    vi.stubEnv("HQ_BASE_URL", "http://hq.test")
    vi.stubEnv("HQ_AGENT_API_KEY", "k")
    vi.stubGlobal("fetch", () =>
      Promise.resolve(new Response(JSON.stringify({ leaseExpiresAt: "t" }))),
    )
    const timeout = vi.spyOn(AbortSignal, "timeout")
    await hookHq()?.heartbeatAttempt({ attemptId: "00000000-0000-0000-0000-000000000000" })
    expect(timeout).toHaveBeenCalledWith(3000)
  })

  test("with both it builds a 3000 ms client on the agent's key", async () => {
    vi.stubEnv("HQ_BASE_URL", "http://hq.test/")
    vi.stubEnv("HQ_AGENT_API_KEY", "the-key")
    const seen: { url: string; key: string | null }[] = []
    vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
      seen.push({ url, key: new Headers(init.headers).get("x-api-key") })
      return Promise.resolve(
        new Response(JSON.stringify({ leaseExpiresAt: "2031-01-01T00:00:00Z" })),
      )
    })
    const timeout = vi.spyOn(AbortSignal, "timeout")
    const client = hookHq()
    expect(client).not.toBeNull()
    await client?.heartbeatAttempt({ attemptId: "00000000-0000-0000-0000-000000000000" })
    expect(HOOK_HQ_TIMEOUT_MS).toBe(3000)
    expect(timeout).toHaveBeenCalledWith(3000)
    expect(seen).toEqual([
      {
        url: "http://hq.test/v1/attempts/00000000-0000-0000-0000-000000000000/heartbeat",
        key: "the-key",
      },
    ])
  })

  test("it reads the environment on every call, no caching", () => {
    vi.stubEnv("HQ_BASE_URL", "http://hq.test")
    vi.stubEnv("HQ_AGENT_API_KEY", "k")
    expect(hookHq()).not.toBeNull()
    vi.stubEnv("HQ_AGENT_API_KEY", "")
    expect(hookHq()).toBeNull()
  })
})
