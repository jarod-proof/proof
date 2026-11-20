import { createHmac, timingSafeEqual } from "node:crypto"

/** A Slack request older than this is refused (Slack's own guidance: five minutes). */
export const MAX_PAST_SECONDS = 300
/** One from the future by more than this is refused: clocks differ by seconds, not minutes. */
export const MAX_FUTURE_SECONDS = 60

const bytesOf = (body: string | Uint8Array): Uint8Array =>
  typeof body === "string" ? new TextEncoder().encode(body) : body

/** Slack's signature for a request: `v0=` and the lower-case hex HMAC-SHA256 of `v0:<ts>:<body>`. */
export function slackSignature(
  secret: string,
  timestamp: string,
  rawBody: string | Uint8Array,
): string {
  const mac = createHmac("sha256", secret)
  mac.update(`v0:${timestamp}:`)
  mac.update(bytesOf(rawBody))
  return `v0=${mac.digest("hex")}`
}

export type SlackVerification = { ok: true } | { ok: false; reason: string }

/** How two equal-length signatures are compared. Injectable only so a test can watch the call. */
export type SignatureCompare = (a: Buffer, b: Buffer) => boolean

/** The comparison used in production: constant time, so its duration says nothing about a guess. */
export const constantTimeCompare: SignatureCompare = timingSafeEqual

/**
 * Whether a request really came from Slack: a v0 signature over exactly these bytes, made with the
 * app's signing secret, on a request that is neither stale nor from the future.
 *
 * @remarks
 * `rawBody` is the bytes as received. Hash those, never a parsed and re-serialised copy: a changed
 * byte changes the signature. The signature must be `v0=` and exactly 64 lower-case hex
 * characters, the timestamp plain digits, and the comparison is `timingSafeEqual` over equal-length
 * buffers (the length is checked first because `timingSafeEqual` throws on a mismatch).
 */
export function verifySlackSignature(
  input: {
    rawBody: string | Uint8Array
    signature: string
    timestamp: string
    secret: string
    now: Date
  },
  compare: SignatureCompare = constantTimeCompare,
): SlackVerification {
  if (input.secret === "") return { ok: false, reason: "no signing secret" }
  if (!/^\d{1,15}$/.test(input.timestamp)) return { ok: false, reason: "bad timestamp" }
  const sent = Number(input.timestamp)
  const age = Math.floor(input.now.getTime() / 1000) - sent
  if (age > MAX_PAST_SECONDS) return { ok: false, reason: "stale timestamp" }
  if (-age > MAX_FUTURE_SECONDS) return { ok: false, reason: "timestamp in the future" }
  if (!/^v0=[0-9a-f]{64}$/.test(input.signature)) return { ok: false, reason: "bad signature" }
  const expected = Buffer.from(slackSignature(input.secret, input.timestamp, input.rawBody))
  const given = Buffer.from(input.signature)
  if (expected.length !== given.length || !compare(expected, given)) {
    return { ok: false, reason: "bad signature" }
  }
  return { ok: true }
}
