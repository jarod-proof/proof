import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  type MockInstance,
  test,
  vi,
} from "vitest"
import schedule from "../../agent/schedules/work-sweep.js"
import { createHqClient, type HqClient } from "#lib/hq/client.js"
import { log } from "#lib/log.js"
import {
  resetSweepStats,
  runScheduledSweep,
  runWorkSweep,
  SWEEP_HQ_TIMEOUT_MS,
  sweepErrorRepeats,
  sweepHq,
} from "#lib/work/sweep.js"
import { createHqFixture, HQ_BASE_URL, type HqFixture } from "../hq/hq-fixture.js"
import { newItem, useRealHq } from "./attempts-support.js"

/**
 * The work sweep: one call to hq's `run_verification_sweep` on the agent's key, on a schedule.
 * The reads and writes are hq's (the real hq on PGlite); the only fakes are wires that misbehave.
 */
let hq: HqFixture
beforeAll(async () => {
  hq = await createHqFixture()
}, 60_000)
afterAll(async () => {
  await hq.close()
})

let warn: MockInstance<typeof log.warn>
beforeEach(() => {
  resetSweepStats()
  warn = vi.spyOn(log, "warn").mockImplementation(() => undefined)
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const SWEEP_PATH = "/v1/work/verification-sweep"
const EMPTY = {
  advanced: [],
  passed: [],
  reopened: [],
  retriaged: [],
  abandoned: [],
  errors: [],
}

/** The REAL client over a wire that answers with `reply`, so the reply goes through the real parser. */
function clientAnswering(reply: unknown, status = 200) {
  const requests: { method: string; url: string; body: string | undefined }[] = []
  const client = createHqClient({
    baseUrl: HQ_BASE_URL,
    apiKey: "k",
    fetch: async (url, init) => {
      requests.push({
        method: init?.method ?? "GET",
        url: typeof url === "string" ? url : url instanceof URL ? url.href : url.url,
        body: init?.body as string,
      })
      return new Response(JSON.stringify(reply), { status })
    },
  })
  return { client, requests }
}

/**
 * The REAL client over a wire that answers with `body` exactly as written. `clientAnswering` JSON-encodes
 * every reply, so a string it is given still arrives as valid JSON; this one sends bytes that are not.
 */
function clientAnsweringRaw(body: string, status: number, contentType?: string) {
  const requests: string[] = []
  const client = createHqClient({
    baseUrl: HQ_BASE_URL,
    apiKey: "k",
    fetch: async (url) => {
      requests.push(typeof url === "string" ? url : url instanceof URL ? url.href : url.url)
      return new Response(body, {
        status,
        headers: contentType === undefined ? undefined : { "content-type": contentType },
      })
    },
  })
  return { client, requests }
}

/** The details of every `warn` call whose message is `name`. */
const logged = (name: string) =>
  warn.mock.calls.filter(([message]) => message === name).map(([, ...details]) => details)

describe("runWorkSweep", () => {
  test("the sweep result is returned and an hq outage returns { sweep: null, dispatched: 0 } without throwing", async () => {
    // A started attempt whose lease ran out: the sweep abandons it.
    const { itemId } = await newItem(hq)
    const attempt = await hq.client.startAttempt({ itemId, kind: "investigate" })
    hq.newDay()

    const got = await runWorkSweep({ hq: hq.client })
    expect(got.dispatched).toBe(0)
    expect(got.sweep?.abandoned).toContain(attempt.id)
    expect(got.sweep?.errors).toEqual([])

    // Every way hq can be out is the same answer, and each is one request, never a retry.
    for (const wire of ["unreachable", "unavailable"] as const) {
      const bridge = useRealHq(hq, () => wire)
      const outage = await runWorkSweep({ hq: hqOnGlobalFetch() })
      expect(outage).toEqual({ sweep: null, dispatched: 0 })
      expect(bridge.requests).toEqual([`POST ${SWEEP_PATH}`])
      vi.unstubAllGlobals()
    }
    for (const [status, reply] of [
      [403, { error: { code: "FORBIDDEN", message: "no" } }],
      [500, "not json at all"],
      [200, { advanced: "nope" }],
    ] as const) {
      const { client, requests } = clientAnswering(reply, status)
      expect(await runWorkSweep({ hq: client })).toEqual({ sweep: null, dispatched: 0 })
      expect(requests).toHaveLength(1)
    }
    expect(logged("work_sweep_unavailable")).toHaveLength(5)
  })

  test("a reply that is not JSON at all (an HTML error page, plain text, nothing) is the same answer, one request each, and its text is never logged", async () => {
    for (const [status, body, type] of [
      [502, "<html><body>Bad Gateway SECRET-PAGE ghp_abcdef</body></html>", "text/html"],
      [500, "upstream connect error SECRET-TEXT", "text/plain"],
      [200, "{not json SECRET-BROKEN", "application/json"],
      [200, "", "application/json"],
      [504, "", undefined],
    ] as const) {
      const { client, requests } = clientAnsweringRaw(body, status, type)
      expect(await runWorkSweep({ hq: client })).toEqual({ sweep: null, dispatched: 0 })
      expect(requests).toEqual([`${HQ_BASE_URL}${SWEEP_PATH}`])
    }
    expect(logged("work_sweep_unavailable")).toHaveLength(5)
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/SECRET-|ghp_|<html>|upstream/)
    // The text of a reply that is valid JSON but the wrong shape is not logged either.
    const { client } = clientAnswering({ advanced: "SECRET-SHAPE" })
    await runWorkSweep({ hq: client })
    expect(JSON.stringify(warn.mock.calls)).not.toContain("SECRET-SHAPE")
  })

  test("an outage is logged by status and code only, never by the reply's text", async () => {
    const { client } = clientAnswering(
      { error: { code: "BOOM", message: "SECRET-BODY ghp_abcdef sk_live_123" } },
      502,
    )
    await runWorkSweep({ hq: client })
    const [[details]] = logged("work_sweep_unavailable")
    expect(details).toEqual({ status: 502, code: "BOOM" })
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/SECRET-BODY|ghp_|sk_live/)
  })

  test("two runs in a row: the second sweep reports nothing to do (against the real hq)", async () => {
    const { itemId } = await newItem(hq)
    const attempt = await hq.client.startAttempt({ itemId, kind: "investigate" })
    hq.newDay()

    const first = await runWorkSweep({ hq: hq.client })
    expect(first.sweep?.abandoned).toContain(attempt.id)
    const after = await hq.client.getWorkItem({ itemId })

    const second = await runWorkSweep({ hq: hq.client })
    expect(second).toEqual({ sweep: EMPTY, dispatched: 0 })
    // A double fire changes nothing: the item is exactly what the first sweep left.
    expect(await hq.client.getWorkItem({ itemId })).toEqual(after)
  })

  test("with no dispatcher no attempt request is touched", async () => {
    const touched: string[] = []
    const base = hq.client
    const spy = new Proxy(base, {
      get(target, prop, receiver) {
        if (typeof prop === "string" && prop !== "runVerificationSweep") {
          touched.push(prop)
        }
        return Reflect.get(target, prop, receiver)
      },
    }) as HqClient
    expect(await runWorkSweep({ hq: spy })).toMatchObject({ dispatched: 0 })
    expect(touched).toEqual([])
  })

  test("it sends no clock: one POST with an empty body and no query", async () => {
    const { client, requests } = clientAnswering(EMPTY)
    await runWorkSweep({ hq: client })
    expect(requests).toEqual([{ method: "POST", url: `${HQ_BASE_URL}${SWEEP_PATH}`, body: "{}" }])
  })

  test("errors are logged with itemId, rule and message only, and counted per item across runs", async () => {
    const failing = (...errors: { itemId: string | null; rule: string; message: string }[]) =>
      clientAnswering({ ...EMPTY, errors }).client
    const a = { itemId: "item-a", rule: "settle", message: "could not settle" }
    const b = { itemId: "item-b", rule: "advance", message: "x".repeat(500) }
    const loose = { itemId: null, rule: "expire", message: "one stale attempt threw" }

    const first = await runWorkSweep({ hq: failing(a, b, loose) })
    // The result still comes back whole: the errors are hq's report, not a failure of the run.
    expect(first.sweep?.errors).toHaveLength(3)
    expect(logged("work_sweep_item_error").map(([d]) => d)).toEqual([
      { itemId: "item-a", rule: "settle", message: "could not settle", repeats: 1 },
      { itemId: "item-b", rule: "advance", message: "x".repeat(200), repeats: 1 },
      { itemId: null, rule: "expire", message: "one stale attempt threw", repeats: 1 },
    ])
    expect(logged("work_sweep_errors")).toEqual([[{ count: 3 }]])

    warn.mockClear()
    await runWorkSweep({ hq: failing(a) })
    expect(logged("work_sweep_item_error").map(([d]) => d)).toEqual([
      { itemId: "item-a", rule: "settle", message: "could not settle", repeats: 2 },
    ])
    expect(sweepErrorRepeats()).toEqual({ "item-a:settle": 2 })

    // A clean sweep forgets: the next failure starts again at 1 (a repeat is a CONSECUTIVE one).
    await runWorkSweep({ hq: failing() })
    expect(sweepErrorRepeats()).toEqual({})
    warn.mockClear()
    await runWorkSweep({ hq: failing(a) })
    expect(logged("work_sweep_item_error")[0]?.[0]).toMatchObject({ repeats: 1 })
  })

  test("an item that errors under two rules is counted under each", async () => {
    const { client } = clientAnswering({
      ...EMPTY,
      errors: [
        { itemId: "item-a", rule: "advance", message: "m1" },
        { itemId: "item-a", rule: "settle", message: "m2" },
      ],
    })
    await runWorkSweep({ hq: client })
    expect(sweepErrorRepeats()).toEqual({ "item-a:advance": 1, "item-a:settle": 1 })
  })

  test("a clean sweep logs nothing", async () => {
    await runWorkSweep({ hq: clientAnswering(EMPTY).client })
    expect(warn).not.toHaveBeenCalled()
  })
})

/** A client on the (stubbed) global fetch, as the schedule's own client is. */
function hqOnGlobalFetch(): HqClient {
  return createHqClient({ baseUrl: "http://hq.test", apiKey: "k" })
}

describe("sweepHq and runScheduledSweep fail closed", () => {
  test("with HQ_BASE_URL or HQ_AGENT_API_KEY unset there is no client, no request, and one log line", async () => {
    const fetched = vi.fn()
    vi.stubGlobal("fetch", fetched)
    for (const [url, key] of [
      ["", ""],
      ["http://hq.test", ""],
      ["", "k"],
      ["   ", "k"],
    ] as const) {
      vi.stubEnv("HQ_BASE_URL", url)
      vi.stubEnv("HQ_AGENT_API_KEY", key)
      expect(sweepHq()).toBeNull()
      warn.mockClear()
      await expect(runScheduledSweep()).resolves.toBeUndefined()
      expect(logged("work_sweep_skipped")).toHaveLength(1)
    }
    expect(fetched).not.toHaveBeenCalled()
  })

  test("the sweep's client gives hq 25 seconds, pinned without waiting for them", async () => {
    expect(SWEEP_HQ_TIMEOUT_MS).toBe(25_000)
    vi.stubEnv("HQ_BASE_URL", "http://hq.test")
    vi.stubEnv("HQ_AGENT_API_KEY", "k")
    const timeout = vi.spyOn(AbortSignal, "timeout")
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(EMPTY), { status: 200 })),
    )
    await runScheduledSweep()
    expect(timeout).toHaveBeenCalledTimes(1)
    expect(timeout).toHaveBeenCalledWith(25_000)
  })

  test("with the environment set it builds a client for that hq and sweeps once", async () => {
    vi.stubEnv("HQ_BASE_URL", "http://hq.test")
    vi.stubEnv("HQ_AGENT_API_KEY", "not-the-fixtures-key")
    const bridge = useRealHq(hq)
    hq.newDay()
    await runScheduledSweep()
    expect(bridge.requests).toEqual([`POST ${SWEEP_PATH}`])
  })

  test("a factory that throws, or an hq that is down, never throws out of it", async () => {
    await expect(
      runScheduledSweep(() => {
        throw new Error("boom")
      }),
    ).resolves.toBeUndefined()
    expect(logged("work_sweep_failed")).toHaveLength(1)

    const bridge = useRealHq(hq, () => "unreachable")
    vi.stubEnv("HQ_BASE_URL", "http://hq.test")
    vi.stubEnv("HQ_AGENT_API_KEY", "k")
    await expect(runScheduledSweep()).resolves.toBeUndefined()
    expect(bridge.requests).toEqual([`POST ${SWEEP_PATH}`])
  })
})

describe("the schedule file", () => {
  test("exports cron every 30 minutes, timezone UTC and a run handler that never throws", async () => {
    expect(schedule).toMatchObject({ cron: "*/30 * * * *", timezone: "UTC" })
    const run = (schedule as { run?: (args: unknown) => void }).run
    expect(typeof run).toBe("function")

    // Env unset: the run hands one promise to waitUntil and it resolves. The two variables are
    // removed here, not assumed absent, so a developer's shell cannot make this test sweep for real.
    vi.stubEnv("HQ_BASE_URL", undefined)
    vi.stubEnv("HQ_AGENT_API_KEY", undefined)
    expect(process.env.HQ_BASE_URL).toBeUndefined()
    expect(process.env.HQ_AGENT_API_KEY).toBeUndefined()
    const fetched = vi.fn()
    vi.stubGlobal("fetch", fetched)
    const tasks: Promise<unknown>[] = []
    expect(() => run?.({ waitUntil: (task: Promise<unknown>) => tasks.push(task) })).not.toThrow()
    expect(tasks).toHaveLength(1)
    await expect(Promise.all(tasks)).resolves.toBeDefined()
    expect(fetched).not.toHaveBeenCalled()
    expect(logged("work_sweep_skipped")).toHaveLength(1)

    // A waitUntil that itself throws still does not throw out of the schedule.
    expect(() =>
      run?.({
        waitUntil: () => {
          throw new Error("waitUntil is gone")
        },
      }),
    ).not.toThrow()
  })

  test("a double fire against the real hq changes nothing the second time", async () => {
    vi.stubEnv("HQ_BASE_URL", "http://hq.test")
    vi.stubEnv("HQ_AGENT_API_KEY", "k")
    const { itemId } = await newItem(hq)
    await hq.client.startAttempt({ itemId, kind: "investigate" })
    expect((await hq.client.getWorkItem({ itemId })).attempts.running).toBe(true)
    hq.newDay()
    const bridge = useRealHq(hq)
    const run = (schedule as { run: (args: unknown) => void }).run
    const fire = async () => {
      const tasks: Promise<unknown>[] = []
      run({ waitUntil: (task: Promise<unknown>) => tasks.push(task) })
      await Promise.all(tasks)
    }
    await fire()
    const afterFirst = await hq.client.getWorkItem({ itemId })
    await fire()
    expect(await hq.client.getWorkItem({ itemId })).toEqual(afterFirst)
    expect(bridge.requests).toEqual([`POST ${SWEEP_PATH}`, `POST ${SWEEP_PATH}`])
    expect((await hq.client.getWorkItem({ itemId })).attempts.running).toBe(false)
  })
})
