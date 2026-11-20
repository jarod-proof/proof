import { createHmac, timingSafeEqual } from "node:crypto"

/**
 * Slack's request signature, checked by the agent so it can hold on to the exact bytes it verified
 * and forward them to hq, which verifies them again (`apps/hq/src/slack/verify.ts`: the same
 * rules, held together by `tests/slack/verify-parity.test.ts`).
 *
 * @remarks
 * `v0=` and 64 lower-case hex characters, over `v0:<timestamp>:<body>`; a timestamp of plain digits
 * no more than five minutes old and no more than one minute ahead; compared with `timingSafeEqual`
 * over equal-length buffers.
 */

/** A Slack request older than this is refused. */
export const MAX_PAST_SECONDS = 300
/** One from the future by more than this is refused. */
export const MAX_FUTURE_SECONDS = 60

export function slackSignature(secret: string, timestamp: string, rawBody: string): string {
  const mac = createHmac("sha256", secret)
  mac.update(`v0:${timestamp}:`)
  mac.update(Buffer.from(rawBody, "utf8"))
  return `v0=${mac.digest("hex")}`
}

export function isSlackRequestAuthentic(input: {
  rawBody: string
  signature: string
  timestamp: string
  secret: string
  now: Date
}): boolean {
  if (input.secret === "") return false
  if (!/^\d{1,15}$/.test(input.timestamp)) return false
  const age = Math.floor(input.now.getTime() / 1000) - Number(input.timestamp)
  if (age > MAX_PAST_SECONDS || -age > MAX_FUTURE_SECONDS) return false
  if (!/^v0=[0-9a-f]{64}$/.test(input.signature)) return false
  const expected = Buffer.from(slackSignature(input.secret, input.timestamp, input.rawBody))
  const given = Buffer.from(input.signature)
  return expected.length === given.length && timingSafeEqual(expected, given)
}
