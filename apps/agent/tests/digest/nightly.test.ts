import { afterAll, beforeAll, describe, expect, test } from "vitest"
import schedule from "../../agent/schedules/nightly-digest.js"
import {
  composeDigest,
  type DigestDeps,
  MAX_CARDS,
  runNightlyDigest,
  type SlackMessage,
} from "#lib/digest/nightly.js"
import { createHqClient, type HqClient } from "#lib/hq/client.js"
import { parseActionId } from "@proof/hq/src/slack/actions"
import { createHqFixture, HQ_BASE_URL, type HqFixture } from "../hq/hq-fixture.js"

let hq: HqFixture
beforeAll(async () => {
  hq = await createHqFixture()
}, 60_000)
afterAll(async () => {
  await hq.close()
})

/** The ids of every button on a message, parsed by hq's own parser. */
const buttons = (message: SlackMessage) =>
  message.blocks
    .filter((b) => b.type === "actions")
    .flatMap((b) => (b.elements as { action_id: string }[]).map((e) => parseActionId(e.action_id)))

function deps(over: Partial<DigestDeps> = {}) {
  const posts: SlackMessage[] = []
  const value: DigestDeps = {
    hq: () => hq.client,
    post: async (message) => void posts.push(message),
    channelId: () => "C0DIGEST",
    ...over,
  }
  return { posts, value }
}

describe("the nightly digest", () => {
  test("runs at 07:00 UTC every day", () => {
    expect(schedule).toMatchObject({ cron: "0 7 * * *", timezone: "UTC" })
    expect(typeof (schedule as { run?: unknown }).run).toBe("function")
  })

  test("posts ONE message: yesterday's runs and spend, and a card with buttons per pending proposal", async () => {
    hq.newDay()
    // Yesterday, as hq counts it: a run that cost money, and one that failed.
    const ok = await hq.client.recordRun({
      task: "answer pricing question",
      trigger: "slack",
      runner: "eve",
    })
    await hq.client.recordSpend({ runId: ok.id, source: "eve", amountUsd: 1.25, model: "haiku" })
    await hq.client.finishRun({
      id: ok.id,
      outcome: "succeeded",
      summary: { worked: ["a"], failed: [], stop: [] },
    })
    const bad = await hq.client.recordRun({
      task: "build the widget",
      trigger: "label",
      runner: "sandbox",
    })
    await hq.client.finishRun({
      id: bad.id,
      outcome: "failed",
      summary: { worked: [], failed: ["tests"], stop: [] },
    })
    const first = await hq.client.proposeEntry({
      kind: "fact",
      slug: "digest-one",
      title: "Digest one",
      body: { text: "First." },
      reason: "r",
    })
    const second = await hq.client.proposeEntry({
      kind: "fact",
      slug: "digest-two",
      title: "Digest two",
      body: { text: "Second." },
      reason: "r",
    })
    hq.newDay()

    const { posts, value } = deps()
    const outcome = await runNightlyDigest(value)

    expect(posts).toHaveLength(1)
    const [message] = posts
    expect(message?.channel).toBe("C0DIGEST")
    const text = JSON.stringify(message?.blocks)
    expect(text).toContain("Runs:* 2 (1 ok, 1 failed, 0 stopped)")
    expect(text).toContain("failed: build the widget")
    expect(text).toContain("Spend:* $1.25 (eve $1.25)")
    // A card for each, approve and reject, naming the proposal and the version proposed against.
    const ids = buttons(message as SlackMessage)
    for (const p of [first, second]) {
      for (const decision of ["approve", "reject"] as const) {
        expect(ids).toContainEqual({
          kind: "proposal",
          decision,
          proposalId: p.proposalId,
          baseVersion: null,
        })
      }
    }
    expect(outcome).toMatchObject({ posted: true })

    // Its own run in hq, with its cost: finished, and nothing spent (no model ran).
    const runs = (await hq.asAgent("GET", "/v1/runs")).body.runs ?? []
    const mine = runs.find((r) => (r as { task?: string }).task === "nightly digest")
    expect(mine).toMatchObject({ outcome: "succeeded", costUsd: 0 })
  })

  test("with nothing pending it still posts the summary, and says so", async () => {
    const fresh = await createHqFixture()
    try {
      fresh.newDay()
      const posts: SlackMessage[] = []
      await runNightlyDigest({
        hq: () => fresh.client,
        post: async (m) => void posts.push(m),
        channelId: () => "C0DIGEST",
      })
      expect(posts).toHaveLength(1)
      expect(buttons(posts[0] as SlackMessage)).toEqual([])
      expect(JSON.stringify(posts[0]?.blocks)).toContain("none.")
    } finally {
      await fresh.close()
    }
  })

  test("with hq down it posts nothing and fails", async () => {
    const down: HqClient = createHqClient({
      baseUrl: HQ_BASE_URL,
      apiKey: "k",
      fetch: () => Promise.reject(new Error("connect ECONNREFUSED")),
    })
    const { posts, value } = deps({ hq: () => down })
    await expect(runNightlyDigest(value)).rejects.toMatchObject({ code: "UNREACHABLE" })
    expect(posts).toEqual([])
  })

  test("with a read failing it posts nothing, and its run is finished as failed in hq", async () => {
    hq.newDay()
    const broken: HqClient = {
      ...hq.client,
      listProposals: () => Promise.reject(new Error("hq answered 500")),
    }
    const { posts, value } = deps({ hq: () => broken })
    await expect(runNightlyDigest(value)).rejects.toThrow(/500/)
    expect(posts).toEqual([])
    const runs = (await hq.asAgent("GET", "/v1/runs")).body.runs ?? []
    const failedRun = runs.find(
      (r) => (r as { task?: string }).task === "nightly digest" && r.outcome === "failed",
    )
    expect(failedRun).toBeDefined()
    expect(
      (failedRun as unknown as { summary: { failed: string[] } }).summary.failed.join(" "),
    ).toContain("hq could not be read")
  })

  test("a post Slack refuses fails the run and records no cost", async () => {
    const before = ((await hq.asAgent("GET", "/v1/runs")).body.runs ?? []).length
    const { value } = deps({
      post: () => Promise.reject(new Error("Slack refused the post: channel_not_found")),
    })
    await expect(runNightlyDigest(value)).rejects.toThrow(/channel_not_found/)
    const runs = (await hq.asAgent("GET", "/v1/runs")).body.runs ?? []
    expect(runs.length).toBe(before + 1)
    expect(runs[0]).toMatchObject({ outcome: "failed", costUsd: 0 })
  })

  test("without a channel it does nothing, and does not touch hq", async () => {
    const touched: string[] = []
    const watched = new Proxy(hq.client, {
      get: (target, name) => {
        touched.push(String(name))
        return Reflect.get(target, name)
      },
    })
    const { posts, value } = deps({ channelId: () => undefined, hq: () => watched })
    expect(await runNightlyDigest(value)).toBeNull()
    expect(posts).toEqual([])
    expect(touched).toEqual([])
  })

  test("more proposals than fit in one message leave the rest to hq, inside Slack's 50 blocks", () => {
    const proposals = Array.from({ length: 20 }, (_, i) => ({
      id: `p-${i}`,
      entryId: null,
      kind: "fact",
      slug: `s-${i}`,
      baseVersion: null,
      title: `T${i}`,
      body: { text: "b" },
      reason: "r",
      status: "pending" as const,
      createdAt: "2026-01-01T00:00:00Z",
    }))
    const message = composeDigest(
      {
        day: "2026-01-01",
        spend: { day: "2026-01-01", totalUsd: 0, estimatedUsd: 0, bySource: [] },
        runs: [],
        proposals,
      },
      "C1",
    )
    expect(buttons(message)).toHaveLength(MAX_CARDS * 2)
    expect(message.blocks.length).toBeLessThanOrEqual(50)
    expect(JSON.stringify(message.blocks)).toContain("6 more are pending in hq")
  })
})
