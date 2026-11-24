import { vi } from "vitest"
import type { AttemptView, WorkItemDetail } from "#lib/hq/client.js"
import { stationKey, type StationCall } from "#lib/work/attempts.js"
import type { HqFixture } from "../hq/hq-fixture.js"

/**
 * Shared by the attempts and steps tests: the steps build their own hq client from the
 * environment, so the environment names an hq and the global `fetch` is the real hq of the fixture
 * (its registry, its auth, its state machine), reached through the agent's own key.
 */
export const SHA = "a".repeat(40)
export const REPO = "acme/widgets"

export type Fault = "lose-response" | "unreachable" | "unavailable"
/** Decides, per request, whether the wire misbehaves. `lose-response` commits, then times out. */
export type Wire = (method: string, path: string) => Fault | undefined

export interface Bridge {
  /** Every request that reached the wire, as `METHOD /path`. */
  requests: string[]
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

/** Points the steps at the real hq: each request is replayed on the fixture's key. */
export function useRealHq(hq: HqFixture, wire: Wire = () => undefined): Bridge {
  const bridge: Bridge = { requests: [] }
  vi.stubEnv("HQ_BASE_URL", "http://hq.test")
  vi.stubEnv("HQ_AGENT_API_KEY", "not-the-fixtures-key")
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const { pathname, search } = new URL(url)
    const method = (init?.method ?? "GET") as "GET" | "POST"
    bridge.requests.push(`${method} ${pathname}`)
    const fault = wire(method, pathname)
    if (fault === "unreachable") {
      throw new TypeError("fetch failed")
    }
    if (fault === "unavailable") {
      return json({ error: { code: "UNAVAILABLE", message: "hq is down" } }, 503)
    }
    const body = init?.body ? JSON.parse(init.body as string) : undefined
    const reply = await hq.asAgent(method, pathname + search, body)
    if (fault === "lose-response") {
      throw new DOMException("The operation timed out", "TimeoutError")
    }
    return json(reply.body, reply.status)
  })
  return bridge
}

let issue = 1000

/** A fresh issue number per test: the dedupe key is the item's identity. */
export const nextIssue = () => ++issue

export const dedupeKeyOf = (n: number) => `github-issue:${REPO}#${n}`

/** A signal-born item in triage. */
export async function newItem(
  hq: HqFixture,
  n = nextIssue(),
): Promise<{ itemId: string; n: number }> {
  const { itemId } = await hq.client.recordSignal({
    source: "github_issue",
    externalId: `${REPO}#${n}:opened:t`,
    dedupeKey: dedupeKeyOf(n),
    repo: REPO,
    title: `Issue ${n}`,
    summary: `GitHub issue #${n} opened by maintainer`,
    url: `https://github.com/${REPO}/issues/${n}`,
    payload: { number: n },
  })
  return { itemId, n }
}

/** Triage to plan with a contract: investigate (started and finished), then the contract. */
export async function toPlan(hq: HqFixture, itemId: string): Promise<void> {
  const investigate = await hq.client.startAttempt({
    itemId,
    kind: "investigate",
    externalRef: `setup:${itemId}:investigate`,
  })
  await hq.client.finishAttempt({ attemptId: investigate.id, result: "investigated" })
  await hq.client.setContract({
    itemId,
    items: [{ text: "It works", verifier: { kind: "reviewer" } }],
  })
}

/** Starts and finishes one fix as the setup does: `failed` by default. */
export async function setupFix(
  hq: HqFixture,
  itemId: string,
  options: { result?: "failed" | "approved"; limit?: number; ref?: string } = {},
): Promise<AttemptView> {
  const fix = await hq.client.startAttempt({
    itemId,
    kind: "fix",
    attemptLimit: options.limit,
    externalRef: options.ref ?? `setup:${itemId}:fix:${Math.random()}`,
  })
  if (options.result === "approved") {
    await hq.client.heartbeatAttempt({
      attemptId: fix.id,
      branch: `agent/fix-${itemId.slice(0, 8)}`,
    })
    return hq.client.finishAttempt({
      attemptId: fix.id,
      result: "approved",
      reviewer: { verdict: "approve", summary: "ok", headSha: SHA },
    })
  }
  return options.result === undefined || options.result === "failed"
    ? hq.client.finishAttempt({ attemptId: fix.id, result: "failed", note: "setup" })
    : fix
}

/** An item in review: an approved fix and its pull request, open. */
export async function toReview(hq: HqFixture, itemId: string, pullNumber: number): Promise<void> {
  await toPlan(hq, itemId)
  const fix = await setupFix(hq, itemId, { result: "approved", limit: 3 })
  await hq.client.recordPullRequest({
    branch: fix.branch ?? "",
    number: pullNumber,
    url: `https://github.com/${REPO}/pull/${pullNumber}`,
    base: "main",
    headSha: SHA,
    isDraft: false,
    state: "open",
  })
}

export const detailOf = (hq: HqFixture, itemId: string): Promise<WorkItemDetail> =>
  hq.client.getWorkItem({ itemId })

/** The raw event kinds and reasons of an item, which the client's schema strips. */
export async function eventsOf(
  hq: HqFixture,
  itemId: string,
): Promise<{ kind: string; detail?: Record<string, unknown> }[]> {
  const reply = await hq.asAgent("GET", `/v1/work-items/${itemId}`)
  return (
    (reply.body as { events?: { kind: string; detail?: Record<string, unknown> }[] }).events ?? []
  )
}

export const callOf = (
  station: StationCall["station"],
  subject: StationCall["subject"],
  over: Partial<StationCall> = {},
): StationCall => ({
  station,
  sessionId: "wrun_session1",
  callId: "call-1",
  subject,
  ...over,
})

export const keyOf = (call: StationCall): string => stationKey(call)
