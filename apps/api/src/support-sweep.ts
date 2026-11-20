// Support's scheduled work (docs/support.md), run in this process: delayed and retried reply mail,
// closing solved tickets, pruning unattached uploads. `sweepAll` runs every BYO plugin's sweep, so
// notifications' delayed and retried emails (docs/notifications.md) and any later BYO plugin are
// swept here too. Runs never overlap: a tick that finds the last run still
// going does nothing. Several replicas are safe: support claims each delivery with a lease.
import { type ByoAuth, sweepAll } from "@byo-oss/core"
import type { Logger } from "@proof/logger"

export interface SupportSweepOptions {
  logger: Logger
  /** How often to sweep. Support's mail delay is 2 minutes, so a minute keeps replies on time. */
  intervalMs?: number
  /** The time one run may take, within the interval so one run ends before the next starts. */
  budgetMs?: number
}

export function startSupportSweep(
  auth: ByoAuth,
  { logger, intervalMs = 60_000, budgetMs = Math.min(20_000, intervalMs) }: SupportSweepOptions,
): { stop(): Promise<void> } {
  let inFlight: Promise<void> | undefined
  const tick = () => {
    if (inFlight) return
    inFlight = sweepAll(auth, {
      budgetMs,
      onError: (error, pluginId) => logger.error({ err: error, pluginId }, "sweep failed"),
    })
      .then((result) => {
        if (result.timedOut) logger.warn({ results: result.results }, "sweep ran out of time")
      })
      .catch((error: unknown) => {
        logger.error({ err: error }, "sweep failed")
      })
      .finally(() => {
        inFlight = undefined
      })
  }
  const timer = setInterval(tick, intervalMs)
  // A timer must not keep the process alive by itself; the server's listener does that.
  timer.unref()
  return {
    async stop() {
      clearInterval(timer)
      await inFlight
    },
  }
}
