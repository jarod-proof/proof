import { defineSchedule } from "eve/schedules"
import { runScheduledSweep } from "../lib/work/sweep.js"

/**
 * The work sweep, every 30 minutes (UTC): one call to hq's `run_verification_sweep`, which closes
 * verification windows, retriages reopened items and abandons attempts whose lease ran out. The
 * work is in `agent/lib/work/sweep.ts`. It makes no model call and sends hq no clock; it fails
 * closed (hq down or unconfigured: log and do nothing) and never throws.
 *
 * Hobby runs a schedule at most every 15 minutes with a fixed 15 minute jitter, so every 30 minutes is
 * the cadence the plan allows (decisions/dispatch.md). A static schedule starts inactive on a preview.
 */
export default defineSchedule({
  cron: "*/30 * * * *",
  timezone: "UTC",
  run({ waitUntil }) {
    try {
      waitUntil(runScheduledSweep())
    } catch {
      // Nothing may throw out of a schedule.
    }
  },
})
