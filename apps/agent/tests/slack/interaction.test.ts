import { afterAll, beforeAll, describe, expect, test, vi } from "vitest"
import { createClickCapture } from "#lib/slack/capture.js"
import { forwardSlackAction } from "#lib/slack/forward-action.js"
import {
  type CardClick,
  handleCardClick,
  isResponseUrlAllowed,
  type Reply,
} from "#lib/slack/interaction.js"
import { proposalCard } from "#lib/slack/proposal-card.js"
import { slackSignature } from "#lib/slack/verify.js"
import { createSlackWebhookVerifier } from "#lib/slack/webhook-verifier.js"
import { slackConfig } from "#lib/slack/config.js"
import {
  createHqFixture,
  HQ_BASE_URL,
  type HqFixture,
  TEST_SLACK_SECRET,
  TEST_SLACK_TEAM,
} from "../hq/hq-fixture.js"

// A founder's click, from Slack's signed POST to hq's decision, through the agent's verifier, its
// capture and its forwarder, against the real hq (PGlite). Only Slack and the network are faked.

let hq: HqFixture
beforeAll(async () => {
  hq = await createHqFixture()
}, 60_000)
afterAll(async () => {
  await hq.close()
})

let n = 0
/** A pending proposal made with the agent's key, and the buttons the agent would put on its card. */
async function pendingProposal() {
  const slug = `pricing-${++n}`
  const proposed = await hq.client.proposeEntry({
    kind: "fact",
    slug,
    title: `Pricing ${slug}`,
    body: { text: "Free, then $20 per seat." },
    reason: "Said in Slack",
  })
  const blocks = proposalCard({
    id: proposed.proposalId,
    kind: "fact",
    slug,
    title: `Pricing ${slug}`,
    baseVersion: null,
    reason: "Said in Slack",
    body: { text: "Free, then $20 per seat." },
  })
  const actions = blocks.find((b) => b.type === "actions") as {
    elements: { action_id: string }[]
  }
  const [approve, reject] = actions.elements.map((e) => e.action_id) as [string, string]
  return { id: proposed.proposalId, approve, reject }
}

const statusOf = async (id: string) =>
  (await hq.asFounder("GET", "/v1/proposals")).body.proposals?.find((p) => p.id === id)?.status

/** What Slack posts for a click: the signed raw body and headers, and the action eve then parses. */
function slackClick(input: {
  user: string
  actionId: string
  triggerId?: string
  signedAt?: Date
}) {
  const triggerId = input.triggerId ?? `trigger-${++n}`
  const rawBody = `payload=${encodeURIComponent(
    JSON.stringify({
      type: "block_actions",
      team: { id: TEST_SLACK_TEAM },
      user: { id: input.user, team_id: TEST_SLACK_TEAM },
      trigger_id: triggerId,
      response_url: "https://hooks.slack.com/actions/T/1/x",
      actions: [{ action_id: input.actionId, value: input.actionId, action_ts: `${n}.0001` }],
    }),
  )}`
  const timestamp = String(Math.floor((input.signedAt ?? hq.now()).getTime() / 1000))
  const signature = slackSignature(TEST_SLACK_SECRET, timestamp, rawBody)
  const request = new Request("https://agent.test/eve/v1/slack", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-signature": signature,
      "x-slack-request-timestamp": timestamp,
    },
    body: rawBody,
  })
  const action: CardClick = {
    actionId: input.actionId,
    triggerId,
    responseUrl: "https://hooks.slack.com/actions/T/1/x",
    user: { id: input.user },
  }
  return { rawBody, signature, timestamp, request, action }
}

function setup() {
  const capture = createClickCapture()
  const verify = createSlackWebhookVerifier({
    secret: () => TEST_SLACK_SECRET,
    capture,
    now: hq.now,
  })
  const replies: Reply[] = []
  const forwarded: { rawBody: string; signature: string; timestamp: string }[] = []
  const deps = {
    capture,
    hqBaseUrl: () => HQ_BASE_URL,
    forward: (o: Parameters<typeof forwardSlackAction>[0]) => {
      forwarded.push({ rawBody: o.rawBody, signature: o.signature, timestamp: o.timestamp })
      return forwardSlackAction({ ...o, fetch: hq.fetch })
    },
    respond: async (_click: CardClick, reply: Reply) => void replies.push(reply),
  }
  return { capture, verify, replies, forwarded, deps }
}

describe("a founder's click on a proposal card", () => {
  test("is verified, forwarded unchanged, decided by hq as the founder, and the card is replaced", async () => {
    const s = setup()
    const p = await pendingProposal()
    const click = slackClick({ user: hq.founderSlack, actionId: p.approve })

    expect(await s.verify(click.request, click.rawBody)).toBe(true)
    const answer = await handleCardClick(click.action, s.deps)

    expect(answer?.status).toBe(200)
    expect(await statusOf(p.id)).toBe("approved")
    // hq received exactly what Slack sent.
    expect(s.forwarded).toEqual([
      { rawBody: click.rawBody, signature: click.signature, timestamp: click.timestamp },
    ])
    expect(s.replies).toEqual([{ replaceCard: true, text: expect.stringMatching(/^Approved/) }])
  })

  test("a non-founder's click is refused by hq, the card stays, and the proposal stays pending", async () => {
    const s = setup()
    const p = await pendingProposal()
    const click = slackClick({ user: "UNOTFOUNDER", actionId: p.approve })
    expect(await s.verify(click.request, click.rawBody)).toBe(true)
    const answer = await handleCardClick(click.action, s.deps)
    expect(answer?.status).toBe(403)
    expect(await statusOf(p.id)).toBe("pending")
    expect(s.replies).toEqual([{ replaceCard: false, text: expect.stringMatching(/founder/) }])
  })

  test("a replayed click is answered 409 by hq and changes nothing", async () => {
    const s = setup()
    const p = await pendingProposal()
    const click = slackClick({ user: hq.founderSlack, actionId: p.approve })
    await s.verify(click.request, click.rawBody)
    await handleCardClick(click.action, s.deps)
    // Slack redelivers the same signed request: it verifies again, and hq refuses it.
    expect(await s.verify(click.request.clone(), click.rawBody)).toBe(true)
    const again = await handleCardClick(click.action, s.deps)
    expect(again?.status).toBe(409)
    expect(await statusOf(p.id)).toBe("approved")
    expect(s.replies.at(-1)?.replaceCard).toBe(false)
  })

  test.each([
    ["in the order they were verified", ["A", "B"]],
    ["in the opposite order", ["B", "A"]],
  ] as const)(
    "two interleaved clicks, handled %s, each forward their own body and signature",
    async (_name, order) => {
      const s = setup()
      const a = await pendingProposal()
      const b = await pendingProposal()
      const clicks = {
        A: slackClick({ user: hq.founderSlack, actionId: a.approve }),
        B: slackClick({ user: "UNOTFOUNDER", actionId: b.approve }),
      }

      // Both are verified before either is handled: two requests in flight at once.
      expect(await s.verify(clicks.A.request, clicks.A.rawBody)).toBe(true)
      expect(await s.verify(clicks.B.request, clicks.B.rawBody)).toBe(true)
      expect(s.capture.size).toBe(2)
      const answers: Record<string, number | undefined> = {}
      for (const key of order)
        answers[key] = (await handleCardClick(clicks[key].action, s.deps))?.status

      expect(s.forwarded).toEqual(
        order.map((key) => ({
          rawBody: clicks[key].rawBody,
          signature: clicks[key].signature,
          timestamp: clicks[key].timestamp,
        })),
      )
      // The founder's click approved its own proposal; the stranger's was refused on its own.
      expect(answers).toEqual({ A: 200, B: 403 })
      expect(await statusOf(a.id)).toBe("approved")
      expect(await statusOf(b.id)).toBe("pending")
      expect(s.capture.size).toBe(0)
    },
  )

  test("clicks handled concurrently also keep their own bytes", async () => {
    const s = setup()
    const proposals = await Promise.all([pendingProposal(), pendingProposal(), pendingProposal()])
    const clicks = proposals.map((p) => slackClick({ user: hq.founderSlack, actionId: p.approve }))
    for (const c of clicks) expect(await s.verify(c.request, c.rawBody)).toBe(true)
    const answers = await Promise.all(
      clicks
        .slice()
        .reverse()
        .map((c) => handleCardClick(c.action, s.deps)),
    )
    expect(answers.map((a) => a?.status)).toEqual([200, 200, 200])
    expect(s.forwarded.map((f) => f.rawBody).sort()).toEqual(clicks.map((c) => c.rawBody).sort())
    for (const p of proposals) expect(await statusOf(p.id)).toBe("approved")
  })

  test("a click with no verified bytes behind it is refused and nothing is forwarded", async () => {
    const s = setup()
    const p = await pendingProposal()
    const click = slackClick({ user: hq.founderSlack, actionId: p.approve })
    // Never verified (as if it skipped the route), so nothing was kept.
    expect(await handleCardClick(click.action, s.deps)).toBeNull()
    expect(s.forwarded).toEqual([])
    expect(s.replies).toEqual([
      { replaceCard: false, text: expect.stringMatching(/couldn't verify/) },
    ])
    expect(await statusOf(p.id)).toBe("pending")
  })

  test("the kept bytes are used once, and only for the click they belong to", async () => {
    const s = setup()
    const p = await pendingProposal()
    const click = slackClick({ user: hq.founderSlack, actionId: p.approve })
    await s.verify(click.request, click.rawBody)

    // Another user, or another action, with this click's trigger id: not this click's bytes.
    for (const forged of [
      { ...click.action, user: { id: "UNOTFOUNDER" } },
      { ...click.action, actionId: p.reject },
    ]) {
      const fresh = setup()
      await fresh.verify(click.request.clone(), click.rawBody)
      expect(await handleCardClick(forged, fresh.deps)).toBeNull()
      expect(fresh.forwarded).toEqual([])
      expect(fresh.capture.size).toBe(0)
    }
    expect(await handleCardClick(click.action, s.deps)).not.toBeNull()
    // Taken once: a second take of the same click finds nothing.
    expect(await handleCardClick(click.action, s.deps)).toBeNull()
    expect(s.forwarded).toHaveLength(1)
  })

  test("only a request that verified is kept, and only a click on hq's buttons", async () => {
    const s = setup()
    const p = await pendingProposal()
    const click = slackClick({ user: hq.founderSlack, actionId: p.approve })
    const bad = new Request(click.request.url, {
      method: "POST",
      headers: {
        ...Object.fromEntries(click.request.headers),
        "x-slack-signature": `v0=${"0".repeat(64)}`,
      },
      body: click.rawBody,
    })
    expect(await s.verify(bad, click.rawBody)).toBe(false)
    expect(s.capture.size).toBe(0)

    const other = slackClick({ user: hq.founderSlack, actionId: "eve_input:abc" })
    expect(await s.verify(other.request, other.rawBody)).toBe(true)
    expect(s.capture.size).toBe(0)
  })

  test("entries expire and the store is bounded", async () => {
    let at = 1_000_000
    const capture = createClickCapture({ now: () => at, ttlMs: 60_000, maxEntries: 3 })
    const verify = createSlackWebhookVerifier({
      secret: () => TEST_SLACK_SECRET,
      capture,
      now: hq.now,
    })
    const clicks = [1, 2, 3, 4].map(() =>
      slackClick({ user: hq.founderSlack, actionId: "hq_proposal_approve:p:new" }),
    )
    for (const c of clicks) await verify(c.request, c.rawBody)
    // Four kept into a store of three: the oldest was dropped.
    expect(capture.size).toBe(3)
    expect(capture.take(clicks[0]?.action ?? { actionId: "", user: { id: "" } })).toBeNull()
    expect(capture.take(clicks[3]?.action ?? { actionId: "", user: { id: "" } })).not.toBeNull()
    // And the rest lapse.
    at += 61_000
    expect(capture.size).toBe(0)
  })
})

describe("the Slack channel's verifier", () => {
  const verifier = (secret?: string | null) =>
    createSlackWebhookVerifier({
      secret: () => (secret === undefined ? TEST_SLACK_SECRET : (secret ?? undefined)),
      capture: createClickCapture(),
      now: hq.now,
    })
  const eventBody = JSON.stringify({ type: "event_callback", event: { type: "app_mention" } })
  const post = (headers: Record<string, string>, body = eventBody) =>
    new Request("https://agent.test/eve/v1/slack", { method: "POST", headers, body })
  const signed = (offsetSeconds = 0, body = eventBody) => {
    const timestamp = String(Math.floor(hq.now().getTime() / 1000) + offsetSeconds)
    return {
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": slackSignature(TEST_SLACK_SECRET, timestamp, body),
    }
  }

  test("accepts any request Slack signed (an event too), with exactly `true`", async () => {
    const verify = verifier()
    expect(await verify(post(signed()), eventBody)).toBe(true)
  })

  test("refuses a bad signature on an app_mention event as it does on a click", async () => {
    const verify = verifier()
    const headers = signed()
    expect(
      await verify(post({ ...headers, "x-slack-signature": `v0=${"1".repeat(64)}` }), eventBody),
    ).toBe(false)
    expect(await verify(post(headers), `${eventBody} `)).toBe(false)
    expect(
      await verify(
        post({ "x-slack-request-timestamp": headers["x-slack-request-timestamp"] }),
        eventBody,
      ),
    ).toBe(false)
    expect(await verify(post({}), eventBody)).toBe(false)
  })

  test("refuses a stale or future timestamp, a v1 scheme, and anything with no secret configured", async () => {
    const verify = verifier()
    expect(await verify(post(signed(-301)), eventBody)).toBe(false)
    expect(await verify(post(signed(61)), eventBody)).toBe(false)
    expect(await verify(post(signed(-299)), eventBody)).toBe(true)
    const headers = signed()
    expect(
      await verify(
        post({
          ...headers,
          "x-slack-signature": headers["x-slack-signature"].replace("v0=", "v1="),
        }),
        eventBody,
      ),
    ).toBe(false)
    expect(await verifier(null)(post(signed()), eventBody)).toBe(false)
    expect(await verifier("")(post(signed()), eventBody)).toBe(false)
  })

  test("is the one the Slack channel is configured with, and clicks go to hq through onInteraction", async () => {
    expect(typeof slackConfig.credentials.webhookVerifier).toBe("function")
    expect(typeof slackConfig.onInteraction).toBe("function")
    // Nothing kept for this click: it must not throw, and must forward nothing.
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    await slackConfig.onInteraction({
      actionId: "hq_proposal_approve:p:new",
      triggerId: "never-kept",
      user: { id: "UX" },
    } as never)
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })
})

describe("replying to a click", () => {
  test("only to Slack's own response_url (loopback only when offline)", () => {
    expect(isResponseUrlAllowed("https://hooks.slack.com/actions/T/1/x")).toBe(true)
    for (const bad of [
      "http://hooks.slack.com/actions/T/1/x",
      "https://hooks.slack.com.evil.example/x",
      "https://evil.example/hooks.slack.com",
      "http://127.0.0.1:9/response",
      "file:///etc/passwd",
      "not a url",
      "",
    ]) {
      expect(isResponseUrlAllowed(bad), bad).toBe(false)
    }
  })
})
