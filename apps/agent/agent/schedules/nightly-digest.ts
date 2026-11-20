import { defineSchedule } from "eve/schedules"
import { defaultDigestDeps, runNightlyDigest } from "../lib/digest/nightly.js"
import { log } from "../lib/log.js"

/**
 * The nightly digest, 07:00 UTC every day: yesterday's runs and spend and the pending proposals,
 * as one Slack message with a card per proposal. The work is in `agent/lib/digest/nightly.ts`.
 * It posts through the Slack Web API (a handler-form schedule's `to(...).send` would start an
 * agent session and a model call; the digest needs neither) and fails closed when hq is down.
 */
export default defineSchedule({
  cron: "0 7 * * *",
  timezone: "UTC",
  run({ waitUntil }) {
    waitUntil(
      runNightlyDigest(defaultDigestDeps).catch((error: unknown) => {
        log.warn("digest: the nightly digest failed and posted nothing", error)
      }),
    )
  },
})
