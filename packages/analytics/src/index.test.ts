import { createLogger } from "@proof/logger"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  type AnalyticsProvider,
  clientEventBatchSchema,
  createAnalytics,
  createAnalyticsFor,
  createLogProvider,
  createMemoryProvider,
  MAX_CLIENT_EVENTS,
  noopAnalytics,
} from "./index"

const person = { actor: { type: "user" as const, userId: "u1" }, organizationId: "org1" }
const pageView = { name: "page.viewed" as const, properties: { route: "/$org/runs/$runId" } }

afterEach(() => vi.useRealTimers())

describe("createAnalytics", () => {
  it("queues events and sends them on flush, with who and when", async () => {
    const provider = createMemoryProvider()
    const analytics = createAnalytics(provider)
    analytics.capture(pageView, person)
    expect(provider.events).toEqual([])
    await analytics.flush()
    expect(provider.events).toEqual([{ ...pageView, ...person, timestamp: expect.any(Date) }])
  })

  it("sends once the queue reaches flushAt", async () => {
    const provider = createMemoryProvider()
    const analytics = createAnalytics(provider, { flushAt: 2 })
    analytics.capture(pageView, person)
    analytics.capture(pageView, person)
    await vi.waitFor(() => expect(provider.events).toHaveLength(2))
  })

  it("sends on the timer", async () => {
    vi.useFakeTimers()
    const provider = createMemoryProvider()
    const analytics = createAnalytics(provider, { flushIntervalMs: 1000 })
    analytics.capture(pageView, person)
    await vi.advanceTimersByTimeAsync(1000)
    expect(provider.events).toHaveLength(1)
    await analytics.shutdown()
  })

  it("reports a failed send and drops the batch, never throwing to the caller", async () => {
    const onError = vi.fn()
    const failing: AnalyticsProvider = { send: () => Promise.reject(new Error("down")) }
    const analytics = createAnalytics(failing, { onError })
    analytics.capture(pageView, person)
    await analytics.flush()
    expect(onError).toHaveBeenCalledWith(new Error("down"))
    await analytics.flush()
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it("drops events past maxQueue and says how many", async () => {
    const onError = vi.fn()
    const provider = createMemoryProvider()
    const analytics = createAnalytics(provider, { maxQueue: 1, flushAt: 10, onError })
    analytics.capture(pageView, person)
    analytics.capture(pageView, person)
    analytics.capture(pageView, person)
    await analytics.flush()
    expect(provider.events).toHaveLength(1)
    expect(onError.mock.calls[0]?.[0]).toMatchObject({ context: { dropped: 2 } })
  })

  it("sends what is left on shutdown", async () => {
    const provider = createMemoryProvider()
    const analytics = createAnalytics(provider)
    analytics.capture(pageView, person)
    await analytics.shutdown()
    expect(provider.events).toHaveLength(1)
  })
})

describe("createAnalyticsFor", () => {
  it("is noop for none", () => {
    expect(createAnalyticsFor({ provider: "none" })).toBe(noopAnalytics)
  })

  it("logs for log", async () => {
    const logger = createLogger({ name: "test", level: "silent" })
    const info = vi.spyOn(logger, "info")
    const analytics = createAnalyticsFor({ provider: "log", logger })
    analytics.capture(pageView, person)
    await analytics.shutdown()
    expect(info).toHaveBeenCalledWith(
      { analytics: expect.objectContaining(pageView) },
      "analytics page.viewed",
    )
  })

  it("posts to PostHog for posthog", async () => {
    const fetch = vi.fn(() => Promise.resolve(new Response(null, { status: 200 })))
    const analytics = createAnalyticsFor({ provider: "posthog", apiKey: "phc_test", fetch })
    analytics.capture(pageView, person)
    await analytics.shutdown()
    expect(fetch).toHaveBeenCalledOnce()
  })

  it("noop captures nothing and resolves", async () => {
    noopAnalytics.capture(pageView, person)
    await expect(noopAnalytics.flush()).resolves.toBeUndefined()
    await expect(noopAnalytics.shutdown()).resolves.toBeUndefined()
  })
})

describe("createLogProvider", () => {
  it("writes one line per event", async () => {
    const logger = createLogger({ name: "test", level: "silent" })
    const info = vi.spyOn(logger, "info")
    await createLogProvider(logger).send([
      { ...pageView, ...person, timestamp: new Date() },
      { ...pageView, ...person, timestamp: new Date() },
    ])
    expect(info).toHaveBeenCalledTimes(2)
  })
})

describe("clientEventBatchSchema", () => {
  it("accepts page views with a route template", () => {
    expect(clientEventBatchSchema.safeParse({ events: [pageView] }).success).toBe(true)
  })

  it.each([
    ["an event the browser may not send", { events: [{ name: "operation.called" }] }],
    [
      "an extra property",
      { events: [{ ...pageView, properties: { route: "/", email: "a@b.c" } }] },
    ],
    ["an extra field", { events: [pageView], userId: "someone-else" }],
    ["a full URL", { events: [{ ...pageView, properties: { route: "https://x.test/a?b=c" } }] }],
    ["no events", { events: [] }],
    ["too many events", { events: Array.from({ length: MAX_CLIENT_EVENTS + 1 }, () => pageView) }],
  ])("refuses %s", (_, body) => {
    expect(clientEventBatchSchema.safeParse(body).success).toBe(false)
  })
})
