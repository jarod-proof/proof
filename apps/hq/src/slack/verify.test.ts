import { createHmac, timingSafeEqual } from "node:crypto"
import { describe, expect, it } from "vitest"

import {
  constantTimeCompare,
  MAX_FUTURE_SECONDS,
  MAX_PAST_SECONDS,
  slackSignature,
  verifySlackSignature,
} from "./verify"

const SECRET = "slack-signing-secret-for-tests-only" // gitleaks:allow
const NOW = new Date("2026-11-17T12:00:00Z")
const ts = (offsetSeconds = 0) => String(Math.floor(NOW.getTime() / 1000) + offsetSeconds)
const BODY = "payload=%7B%22type%22%3A%22block_actions%22%7D"

const check = (
  over: Partial<{
    body: string | Uint8Array
    signature: string
    timestamp: string
    secret: string
  }>,
) => {
  const timestamp = over.timestamp ?? ts()
  const body = over.body ?? BODY
  return verifySlackSignature({
    rawBody: body,
    signature: over.signature ?? slackSignature(SECRET, timestamp, body),
    timestamp,
    secret: over.secret ?? SECRET,
    now: NOW,
  })
}

describe("slack signature verification", () => {
  it("accepts a correct v0 signature over the exact body", () => {
    expect(check({})).toEqual({ ok: true })
  })

  it("matches Slack's documented algorithm: v0=hex(hmac_sha256(secret, v0:ts:body))", () => {
    const timestamp = ts()
    const expected = `v0=${createHmac("sha256", SECRET).update(`v0:${timestamp}:${BODY}`).digest("hex")}`
    expect(slackSignature(SECRET, timestamp, BODY)).toBe(expected)
  })

  it("rejects a wrong secret, a body that differs by one byte and a different timestamp", () => {
    const signature = slackSignature(SECRET, ts(), BODY)
    expect(check({ secret: "another-secret", signature }).ok).toBe(false)
    expect(check({ body: `${BODY} `, signature }).ok).toBe(false)
    expect(check({ body: BODY.replace("block", "Block"), signature }).ok).toBe(false)
    expect(check({ timestamp: ts(1), signature }).ok).toBe(false)
  })

  it("verifies over bytes, not a re-encoding: the same bytes pass, the same text re-serialised does not", () => {
    const bytes = new TextEncoder().encode(BODY)
    expect(check({ body: bytes, signature: slackSignature(SECRET, ts(), bytes) }).ok).toBe(true)
    const json = '{"a":1,"b":2}'
    const reordered = '{"b":2,"a":1}'
    expect(check({ body: reordered, signature: slackSignature(SECRET, ts(), json) }).ok).toBe(false)
  })

  it("requires the v0 scheme and exactly 64 lower-case hex characters", () => {
    const good = slackSignature(SECRET, ts(), BODY)
    const hex = good.slice(3)
    for (const bad of [
      `v1=${hex}`,
      hex,
      `v0=${hex.slice(0, 62)}`,
      `v0=${hex}00`,
      `v0=${hex.toUpperCase()}`,
      `v0=${"z".repeat(64)}`,
      "",
      `v0=${hex} `,
    ]) {
      expect(check({ signature: bad }).ok, bad).toBe(false)
    }
  })

  it("rejects a timestamp older than 5 minutes and one more than 1 minute in the future", () => {
    expect(MAX_PAST_SECONDS).toBe(300)
    expect(MAX_FUTURE_SECONDS).toBe(60)
    const at = (offset: number) => check({ timestamp: ts(offset) })
    expect(at(-299).ok).toBe(true)
    expect(at(-300).ok).toBe(true)
    expect(at(-301).ok).toBe(false)
    expect(at(60).ok).toBe(true)
    expect(at(61).ok).toBe(false)
    expect(at(3600).ok).toBe(false)
  })

  it("rejects a timestamp that is not plain digits", () => {
    for (const timestamp of ["", "abc", "1.5e9", " 1763380800", "1763380800 ", "-1", "0x10"]) {
      expect(check({ timestamp }).ok, timestamp).toBe(false)
    }
  })

  it("compares with timingSafeEqual, over equal-length buffers", () => {
    // The default comparison is node's constant-time one, not an equality operator.
    expect(constantTimeCompare).toBe(timingSafeEqual)
    // And the check goes through the comparison it is given, with two buffers of one length.
    const calls: [number, number][] = []
    const timestamp = ts()
    const watched = (a: Buffer, b: Buffer) => {
      calls.push([a.length, b.length])
      return timingSafeEqual(a, b)
    }
    const input = {
      rawBody: BODY,
      signature: slackSignature(SECRET, timestamp, BODY),
      timestamp,
      secret: SECRET,
      now: NOW,
    }
    expect(verifySlackSignature(input, watched).ok).toBe(true)
    expect(calls).toEqual([[67, 67]])
    // A signature of the wrong length never reaches it (timingSafeEqual would throw on it).
    calls.length = 0
    expect(verifySlackSignature({ ...input, signature: "v0=ab" }, watched).ok).toBe(false)
    expect(calls).toEqual([])
  })

  it("never accepts an empty secret", () => {
    expect(check({ secret: "", signature: slackSignature("", ts(), BODY) }).ok).toBe(false)
  })
})
