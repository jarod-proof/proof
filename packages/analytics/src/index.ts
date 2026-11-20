// Product analytics behind one interface, so the provider is a config choice: `none`, `log` or
// `posthog` today, and a new one is an adapter (`AnalyticsProvider`) beside them. Reads no env
// itself: apps/api builds the config from @proof/env (ANALYTICS_PROVIDER, docs/analytics.md).
//
// `capture` only queues: it never waits on the network and never throws, so it can sit on the
// request path. The queue is sent in batches, on a timer and when it fills; `shutdown` sends what
// is left. A failed send is reported (`onError`) and dropped, never retried.
import { AppError, reportError } from "@proof/errors"
import type { Logger } from "@proof/logger"

import type { AnalyticsEvent } from "./events"
import { createPostHogProvider, type PostHogConfig } from "./posthog"

export * from "./events"
export { createPostHogProvider, type PostHogConfig } from "./posthog"

/** Who did it: a person or an API key (a caller's actor), in which organization. */
export interface AnalyticsSubject {
  actor: { type: "user"; userId: string } | { type: "apiKey"; keyId: string }
  organizationId?: string
}

/** An event as a provider receives it. */
export type CapturedEvent = AnalyticsEvent &
  AnalyticsSubject & {
    timestamp: Date
  }

/** Sends batches to one analytics vendor. May throw; the queue reports the error and drops the batch. */
export interface AnalyticsProvider {
  send(events: readonly CapturedEvent[]): Promise<void>
}

export interface Analytics {
  /** Queue one event. Never throws, never waits. */
  capture(event: AnalyticsEvent, subject: AnalyticsSubject): void
  /** Send what is queued now. */
  flush(): Promise<void>
  /** Send what is queued and stop the timer. Call once, on shutdown. */
  shutdown(): Promise<void>
}

export interface AnalyticsOptions {
  /** Send once this many events are queued. Default 20. */
  flushAt?: number
  /** Send whatever is queued this often. Default 10 seconds. */
  flushIntervalMs?: number
  /** Events past this many queued are dropped (the vendor is down or slow). Default 1000. */
  maxQueue?: number
  /** Where failed sends go. Default `reportError`. */
  onError?: (error: unknown) => void
}

/** Captures nothing. The default when no provider is configured. */
export const noopAnalytics: Analytics = {
  capture() {},
  flush: () => Promise.resolve(),
  shutdown: () => Promise.resolve(),
}

/** The queue in front of a provider. */
export function createAnalytics(
  provider: AnalyticsProvider,
  opts: AnalyticsOptions = {},
): Analytics {
  const flushAt = opts.flushAt ?? 20
  const maxQueue = opts.maxQueue ?? 1000
  const onError =
    opts.onError ??
    ((error: unknown) => {
      reportError(error, { analytics: true })
    })
  let queue: CapturedEvent[] = []
  let dropped = 0
  let timer: ReturnType<typeof setInterval> | undefined

  async function flush(): Promise<void> {
    if (dropped > 0) {
      onError(
        new AppError("INTERNAL", `Analytics queue full: dropped ${dropped} events`, {
          context: { dropped },
        }),
      )
      dropped = 0
    }
    if (queue.length === 0) return
    const batch = queue
    queue = []
    try {
      await provider.send(batch)
    } catch (error) {
      onError(error)
    }
  }

  function startTimer() {
    if (timer) return
    timer = setInterval(() => void flush(), opts.flushIntervalMs ?? 10_000)
    // The timer alone must not keep the process (or a test run) alive.
    timer.unref?.()
  }

  return {
    capture(event, subject) {
      if (queue.length >= maxQueue) {
        dropped++
        return
      }
      queue.push({ ...event, ...subject, timestamp: new Date() } as CapturedEvent)
      startTimer()
      if (queue.length >= flushAt) void flush()
    },
    flush,
    async shutdown() {
      clearInterval(timer)
      timer = undefined
      await flush()
    },
  }
}

/** Keeps every batch in `events`, for tests. */
export function createMemoryProvider(): AnalyticsProvider & { events: CapturedEvent[] } {
  const events: CapturedEvent[] = []
  return {
    events,
    send(batch) {
      events.push(...batch)
      return Promise.resolve()
    },
  }
}

/** Writes each event to the log, for local development. */
export function createLogProvider(logger: Logger): AnalyticsProvider {
  return {
    send(batch) {
      for (const event of batch) logger.info({ analytics: event }, `analytics ${event.name}`)
      return Promise.resolve()
    },
  }
}

export type AnalyticsConfig =
  | { provider: "none" }
  | { provider: "log"; logger: Logger }
  | ({ provider: "posthog" } & PostHogConfig)

/** The analytics a config names; `none` is `noopAnalytics`. */
export function createAnalyticsFor(config: AnalyticsConfig, opts?: AnalyticsOptions): Analytics {
  switch (config.provider) {
    case "none":
      return noopAnalytics
    case "log":
      return createAnalytics(createLogProvider(config.logger), opts)
    case "posthog":
      return createAnalytics(createPostHogProvider(config), opts)
  }
}
