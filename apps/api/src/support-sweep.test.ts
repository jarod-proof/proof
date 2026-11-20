import type { ByoAuth, ByoSweepResult } from "@byo-oss/core"
import type { Logger } from "@proof/logger"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { startSupportSweep } from "./support-sweep"

/** An auth-shaped object with one BYO plugin whose sweep the test controls. */
function authWith(sweep: () => Promise<ByoSweepResult>): ByoAuth {
  return {
    options: { plugins: [{ id: "support", byo: { sweep } }] },
    $context: Promise.resolve({}),
  }
}

function fakeLogger() {
  const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() }
  return { logger, asLogger: logger as unknown as Logger }
}

describe("startSupportSweep", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("sweeps every interval, and never starts a run while one is going", async () => {
    let release: () => void = () => {}
    const sweep = vi.fn(
      () =>
        new Promise<ByoSweepResult>((resolve) => {
          release = () => resolve({ hasMore: false, sent: 1 })
        }),
    )
    const { asLogger } = fakeLogger()
    const runner = startSupportSweep(authWith(sweep), { logger: asLogger, intervalMs: 1000 })

    await vi.advanceTimersByTimeAsync(1000)
    expect(sweep).toHaveBeenCalledTimes(1)
    // The first run is still going: the next ticks do nothing.
    await vi.advanceTimersByTimeAsync(2000)
    expect(sweep).toHaveBeenCalledTimes(1)
    release()
    await vi.advanceTimersByTimeAsync(1000)
    expect(sweep).toHaveBeenCalledTimes(2)
    release()
    await runner.stop()
    await vi.advanceTimersByTimeAsync(5000)
    expect(sweep).toHaveBeenCalledTimes(2)
  })

  it("logs a plugin's failure and keeps sweeping", async () => {
    const sweep = vi.fn(async (): Promise<ByoSweepResult> => {
      throw new Error("SES down")
    })
    const { logger, asLogger } = fakeLogger()
    const runner = startSupportSweep(authWith(sweep), { logger: asLogger, intervalMs: 1000 })
    await vi.advanceTimersByTimeAsync(2000)
    expect(sweep).toHaveBeenCalledTimes(2)
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ pluginId: "support" }),
      "sweep failed",
    )
    await runner.stop()
  })

  it("warns when a run uses up its budget with work left", async () => {
    // The clock moves past the budget during the sweep, so sweepAll stops with work left.
    const sweep = vi.fn(async (): Promise<ByoSweepResult> => {
      vi.setSystemTime(Date.now() + 50)
      return { hasMore: true }
    })
    const { logger, asLogger } = fakeLogger()
    const runner = startSupportSweep(authWith(sweep), {
      logger: asLogger,
      intervalMs: 1000,
      budgetMs: 10,
    })
    await vi.advanceTimersByTimeAsync(1000)
    await runner.stop()
    expect(logger.warn).toHaveBeenCalledWith(expect.anything(), "sweep ran out of time")
  })

  it("logs a sweep that rejects outright (an auth that can't be read)", async () => {
    const broken = {
      get options(): ByoAuth["options"] {
        throw new Error("no options")
      },
      $context: Promise.resolve({}),
    } as ByoAuth
    const { logger, asLogger } = fakeLogger()
    const runner = startSupportSweep(broken, { logger: asLogger, intervalMs: 1000 })
    await vi.advanceTimersByTimeAsync(1000)
    await runner.stop()
    expect(logger.error).toHaveBeenCalled()
  })
})
