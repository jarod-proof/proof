import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { createHqClient, HqError } from "#lib/hq/client.js"
import { createHqFixture, type HqFixture } from "./hq-fixture.js"

/**
 * The agent's client methods for the work pipeline, against hq itself (its registry, its auth, its
 * state machine on PGlite) with the agent's UNCHANGED key scope. A path the client gets wrong is a
 * 404, a scope it lacks a 403, a reply shape it mis-parses a BAD_REPLY.
 */
let hq: HqFixture

beforeAll(async () => {
  hq = await createHqFixture()
}, 60_000)

afterAll(async () => {
  await hq.close()
})

const SHA = "a".repeat(40)
let seq = 0

const newSignal = (n = ++seq) => ({
  source: "github_issue" as const,
  externalId: `acme/web#${n}:opened:t`,
  dedupeKey: `github-issue:acme/web#${n}`,
  repo: "acme/web",
  title: `Issue ${n}`,
  summary: `GitHub issue #${n} opened by maintainer`,
  url: `https://github.com/acme/web/issues/${n}`,
  payload: { number: n },
})

describe("signals, items and attempts", () => {
  test("each new client method works with the agent's scope", async () => {
    const signal = newSignal()
    const recorded = await hq.client.recordSignal(signal)
    expect(recorded.outcome).toBe("created")
    expect(recorded.displayId).toMatch(/^FAC-\d+$/)
    const again = await hq.client.recordSignal(signal)
    expect(again).toMatchObject({ outcome: "duplicate", itemId: recorded.itemId })

    const found = await hq.client.listWorkItems({ dedupeKey: signal.dedupeKey })
    expect(found.items.map((item) => item.id)).toEqual([recorded.itemId])
    expect(found.items[0]).toMatchObject({
      state: "triage",
      repo: "acme/web",
      title: "Issue " + seq,
    })

    const detail = await hq.client.getWorkItem({ itemId: recorded.displayId })
    expect(detail.id).toBe(recorded.itemId)
    expect(detail.attempts).toEqual({ used: 0, limit: null, running: false })
    expect(detail.signal).toMatchObject({ externalId: signal.externalId, occurrences: 1 })

    // The investigation.
    const investigate = await hq.client.startAttempt({
      itemId: recorded.itemId,
      kind: "investigate",
      externalRef: "s1:call1:analyst",
    })
    expect(investigate).toMatchObject({ kind: "investigate", status: "running", number: 1 })
    expect(
      await hq.client.startAttempt({
        itemId: recorded.itemId,
        kind: "investigate",
        externalRef: "s1:call1:analyst",
      }),
    ).toMatchObject({ id: investigate.id })
    expect(
      (await hq.client.listAttempts({ externalRef: "s1:call1:analyst" })).map((a) => a.attemptId),
    ).toEqual([investigate.id])
    expect(
      (await hq.client.listAttempts({ itemId: recorded.itemId, status: "running" })).length,
    ).toBe(1)
    expect(
      (await hq.client.heartbeatAttempt({ attemptId: investigate.id, note: "reading" }))
        .leaseExpiresAt,
    ).toMatch(/^\d{4}-/)
    const investigated = await hq.client.finishAttempt({
      attemptId: investigate.id,
      result: "investigated",
      note: "found it",
    })
    expect(investigated).toMatchObject({ status: "finished", result: "investigated" })

    // The contract, then the fix.
    await hq.client.setContract({
      itemId: recorded.itemId,
      items: [
        { text: "Checkout works", verifier: { kind: "reviewer" } },
        { text: "No new signal like this", verifier: { kind: "signal_recurrence" } },
      ],
    })
    const fix = await hq.client.startAttempt({
      itemId: recorded.itemId,
      kind: "fix",
      attemptLimit: 3,
      externalRef: "s1:call2:implementer",
    })
    expect(fix.kind).toBe("fix")
    await hq.client.heartbeatAttempt({
      attemptId: fix.id,
      branch: "agent/fix-checkout",
      files: ["src/checkout.ts"],
    })
    const approved = await hq.client.finishAttempt({
      attemptId: fix.id,
      result: "approved",
      reviewer: { verdict: "approve", summary: "Looks right", headSha: SHA },
    })
    expect(approved).toMatchObject({
      result: "approved",
      branch: "agent/fix-checkout",
      reviewer: { verdict: "approve" },
    })

    // The pull request, found by the branch the fix reported.
    const pull = await hq.client.recordPullRequest({
      branch: "agent/fix-checkout",
      number: 5,
      url: "https://github.com/acme/web/pull/5",
      base: "main",
      headSha: SHA,
      isDraft: false,
      state: "open",
    })
    expect(pull).toMatchObject({ matched: true, itemId: recorded.itemId, state: "review" })
    const checks = await hq.client.recordPullRequest({
      branch: "agent/fix-checkout",
      number: 5,
      url: "https://github.com/acme/web/pull/5",
      checks: [{ name: "github-actions", state: "passed" }],
    })
    expect(checks.matched).toBe(true)
    const withPull = await hq.client.getWorkItem({ itemId: recorded.itemId })
    expect(withPull.pullRequest).toMatchObject({
      number: 5,
      headSha: SHA,
      isDraft: false,
      checks: [{ name: "github-actions", state: "passed" }],
    })
    expect(withPull.contract).toHaveLength(2)
    expect(withPull.attemptList.map((a) => a.kind)).toEqual(["investigate", "fix"])
    expect(
      (await hq.client.listWorkItems({ pullRequestNumber: 5, repo: "acme/web" })).items.map(
        (i) => i.id,
      ),
    ).toEqual([recorded.itemId])
  })

  test("a pull request for a branch no attempt reported is matched false, not an error", async () => {
    expect(
      await hq.client.recordPullRequest({
        branch: "agent/nobody-knows",
        number: 99,
        url: "https://github.com/acme/web/pull/99",
        base: "main",
        headSha: SHA,
        isDraft: false,
        state: "open",
      }),
    ).toEqual({ matched: false, itemId: null, state: null })
  })

  test("askQuestion records a question and the sweep runs", async () => {
    const { itemId } = await hq.client.recordSignal(newSignal())
    const question = await hq.client.askQuestion({
      itemId,
      prompt: "Which fix?",
      options: [
        { id: "a", label: "Patch" },
        { id: "b", label: "Rewrite", detail: "slower" },
      ],
      defaultOptionId: "a",
    })
    expect(question).toMatchObject({ status: "open", defaultOptionId: "a", prompt: "Which fix?" })
    const sweep = await hq.client.runVerificationSweep()
    expect(sweep).toMatchObject({ advanced: expect.any(Array), passed: expect.any(Array) })
    expect(Array.isArray(sweep.errors)).toBe(true)
  })

  test("claimAttempt is the claim route: an attempt that does not exist is NOT_FOUND", async () => {
    const error = await hq.client
      .claimAttempt({ attemptId: "00000000-0000-4000-8000-000000000000" })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(HqError)
    expect(error).toMatchObject({ status: 404, code: "NOT_FOUND" })
    expect((error as HqError).message).toMatch(/attempt/i)
  })

  test("a hq error is an HqError with the code hq gave", async () => {
    const error = await hq.client.getWorkItem({ itemId: "FAC-999999" }).catch((e: unknown) => e)
    expect(error).toMatchObject({ status: 404, code: "NOT_FOUND" })
    const bad = await hq.client
      .recordSignal({ ...newSignal(), dedupeKey: "not-a-key" })
      .catch((e: unknown) => e)
    expect(bad).toMatchObject({ status: 400 })
  })

  test("a record_signal for a manual source is refused by hq, which the client passes on", async () => {
    const error = await hq.client
      .recordSignal({ ...newSignal(), source: "manual" })
      .catch((e: unknown) => e)
    expect(error).toMatchObject({ status: 400, code: "BAD_REQUEST" })
  })
})

describe("the client is held to hq's shapes", () => {
  const stub = (body: unknown) =>
    createHqClient({
      baseUrl: "http://localhost:3100",
      apiKey: "k",
      fetch: () => Promise.resolve(new Response(JSON.stringify(body), { status: 200 })),
    })

  test("the client refuses a reply of an unexpected shape", async () => {
    const calls: (() => Promise<unknown>)[] = [
      () => stub({ nope: true }).recordSignal(newSignal()),
      () => stub({ items: "x", nextCursor: null }).listWorkItems({}),
      () => stub({ id: "x" }).getWorkItem({ itemId: "FAC-1" }),
      () => stub({ id: "x" }).startAttempt({ itemId: "FAC-1", kind: "fix" }),
      () => stub({ id: "x" }).claimAttempt({ attemptId: "x" }),
      () => stub({ attempts: [{}] }).listAttempts({}),
      () => stub({}).heartbeatAttempt({ attemptId: "x" }),
      () => stub({ id: "x" }).finishAttempt({ attemptId: "x", result: "failed" }),
      () => stub({ matched: "yes" }).recordPullRequest({ branch: "b", number: 1, url: "u" }),
      () => stub({ contract: 3 }).setContract({ itemId: "FAC-1", items: [] }),
      () => stub({ id: "x" }).askQuestion({ itemId: "FAC-1", prompt: "p", options: [] }),
      () => stub({ advanced: 1 }).runVerificationSweep(),
    ]
    for (const call of calls) {
      await expect(call()).rejects.toMatchObject({ code: "BAD_REPLY" })
    }
  })

  test("a key never gets a founder operation: answerQuestion-like paths are not on the client", () => {
    const founderOnly = [
      "createWorkItem",
      "requestAttempt",
      "answerQuestion",
      "approveMerge",
      "stopWorkItem",
      "reopenWorkItem",
      "retryWorkItem",
      "requestRevert",
      "decideProposal",
    ]
    for (const name of founderOnly) {
      expect(hq.client).not.toHaveProperty(name)
    }
  })

  test("and hq itself refuses the agent's key on each founder path", async () => {
    const { itemId } = await hq.client.recordSignal(newSignal())
    const id = "00000000-0000-4000-8000-000000000000"
    const paths: [string, unknown][] = [
      ["/v1/work-items", { title: "t", repo: "acme/web" }],
      [`/v1/work-items/${itemId}/attempt-requests`, { kind: "investigate" }],
      [`/v1/questions/${id}/answer`, { optionId: "a" }],
      [`/v1/work-items/${itemId}/merge-approval`, { headSha: SHA }],
      [`/v1/work-items/${itemId}/stop`, {}],
      [`/v1/work-items/${itemId}/reopen`, {}],
      [`/v1/work-items/${itemId}/retry`, { note: "n" }],
      [`/v1/work-items/${itemId}/revert-request`, {}],
    ]
    for (const [path, body] of paths) {
      expect((await hq.asAgent("POST", path, body)).status, path).toBe(403)
    }
  })
})
