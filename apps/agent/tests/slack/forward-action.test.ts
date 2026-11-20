import { describe, expect, test } from "vitest"
import { forwardSlackAction } from "#lib/slack/forward-action.js"

// What the agent hands to hq: the raw request, unchanged, and nothing that is a credential.

const SIGNATURE = `v0=${"ab".repeat(32)}`
const TIMESTAMP = "1795000000"

/** A body with every byte class that a re-encoding would disturb: escapes, '+', unicode, newlines. */
const BODY =
  "payload=%7B%22type%22%3A%22block_actions%22%2C%22text%22%3A%22caf%C3%A9+%E2%9C%93%22%7D" +
  "&note=line1%0Aline2&raw=é✓ \t  &empty=&dup=1&dup=2"

interface Sent {
  url: string
  method: string
  headers: Record<string, string>
  bytes: Buffer
}

/** A fake hq: keeps what arrived, byte for byte, by reading it through a real Request. */
function fakeHq(
  reply: { status: number; body: unknown } = { status: 200, body: { text: "Approved: x" } },
) {
  const seen: Sent[] = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    seen.push({
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers),
      bytes: Buffer.from(await request.arrayBuffer()),
    })
    return new Response(JSON.stringify(reply.body), { status: reply.status })
  }
  return { seen, fetch }
}

describe("forwarding a Slack click to hq", () => {
  test("forwards body and Slack headers byte-for-byte", async () => {
    const hq = fakeHq()
    const answer = await forwardSlackAction({
      hqBaseUrl: "http://hq.test:3100/",
      rawBody: BODY,
      signature: SIGNATURE,
      timestamp: TIMESTAMP,
      fetch: hq.fetch,
    })

    expect(hq.seen).toHaveLength(1)
    const [sent] = hq.seen
    expect(sent?.url).toBe("http://hq.test:3100/v1/slack/actions")
    expect(sent?.method).toBe("POST")
    // The bytes hq receives are the bytes Slack signed: no parsing, no re-serialising.
    expect(sent?.bytes.equals(Buffer.from(BODY, "utf8"))).toBe(true)
    expect(sent?.headers["x-slack-signature"]).toBe(SIGNATURE)
    expect(sent?.headers["x-slack-request-timestamp"]).toBe(TIMESTAMP)
    expect(sent?.headers["content-type"]).toBe("application/x-www-form-urlencoded")
    expect(answer).toEqual({ status: 200, text: "Approved: x" })
  })

  test("sends no credential: no key, no cookie, no authorization header", async () => {
    const hq = fakeHq()
    await forwardSlackAction({
      hqBaseUrl: "http://hq.test:3100",
      rawBody: BODY,
      signature: SIGNATURE,
      timestamp: TIMESTAMP,
      fetch: hq.fetch,
    })
    const names = Object.keys(hq.seen[0]?.headers ?? {})
    expect(names.filter((n) => /key|auth|cookie|token|secret/i.test(n))).toEqual([])
    expect(names.sort()).toEqual(["content-type", "x-slack-request-timestamp", "x-slack-signature"])
  })

  test("hq's refusals come back as the text to show, with their status", async () => {
    for (const status of [403, 409]) {
      const hq = fakeHq({ status, body: { text: "Only a founder can decide this." } })
      expect(
        await forwardSlackAction({
          hqBaseUrl: "http://hq.test",
          rawBody: BODY,
          signature: SIGNATURE,
          timestamp: TIMESTAMP,
          fetch: hq.fetch,
        }),
      ).toEqual({ status, text: "Only a founder can decide this." })
    }
  })

  test("an unreachable hq is an answer that says nothing changed, not an exception", async () => {
    const answer = await forwardSlackAction({
      hqBaseUrl: "http://hq.test",
      rawBody: BODY,
      signature: SIGNATURE,
      timestamp: TIMESTAMP,
      fetch: async () => {
        throw new Error("ECONNREFUSED")
      },
    })
    expect(answer.status).toBe(0)
    expect(answer.text).toMatch(/nothing changed/)
  })
})
