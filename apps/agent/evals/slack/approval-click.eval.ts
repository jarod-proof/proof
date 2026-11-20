import { createHmac } from "node:crypto"
import { agentEnv } from "@proof/env/agent"
import { defineEval } from "eve/evals"
import { satisfies } from "eve/evals/expect"
import { hq, OFFLINE_TAG, probeEvents, probeUrl, useRealClock } from "../offline.js"

// A founder's Slack click through eve's real route (POST /eve/v1/slack): the agent verifies
// Slack's signature, keeps the bytes, forwards them to hq, and hq decides. Real hq over HTTP, the
// real Slack channel in eve's dev server; only Slack itself is absent (the click is signed here).

const TEAM = "T0TEST"
const FOUNDER = "UFOUNDER"

const secret = () => {
  const value = agentEnv("SLACK_SIGNING_SECRET")
  if (!value)
    throw new Error("SLACK_SIGNING_SECRET is not set: run with `pnpm --filter @proof/agent eval`.")
  return value
}

/** What Slack posts for a click, signed with the app's secret at `offsetSeconds` from now. */
function clickRequest(input: {
  user: string
  actionId: string
  offsetSeconds?: number
  badSignature?: boolean
}) {
  const triggerId = `trigger-${crypto.randomUUID()}`
  const rawBody = `payload=${encodeURIComponent(
    JSON.stringify({
      type: "block_actions",
      team: { id: TEAM },
      user: { id: input.user, team_id: TEAM, name: "someone" },
      channel: { id: "C0OFFLINE" },
      message: { ts: "1700000000.000100", thread_ts: "1700000000.000100" },
      trigger_id: triggerId,
      response_url: `${probeUrl()}/response`,
      actions: [
        {
          action_id: input.actionId,
          block_id: "b",
          value: input.actionId,
          action_ts: `${Math.floor(Date.now() / 1000)}.000200`,
        },
      ],
    }),
  )}`
  const timestamp = String(Math.floor(Date.now() / 1000) + (input.offsetSeconds ?? 0))
  const good = `v0=${createHmac("sha256", secret()).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`
  return {
    rawBody,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": input.badSignature ? `v0=${"0".repeat(64)}` : good,
    },
  }
}

const statusOf = async (id: string) => {
  const reply = await fetch(`${agentEnv("HQ_BASE_URL")}/v1/proposals`, {
    headers: { "x-api-key": agentEnv("HQ_AGENT_API_KEY") ?? "" },
  })
  const { proposals } = (await reply.json()) as { proposals: { id: string; status: string }[] }
  return proposals.find((p) => p.id === id)?.status
}

/** Waits until hq shows the proposal in `want` (or a moment passes), then says what it shows. */
async function settled(id: string, want: string): Promise<string | undefined> {
  const deadline = Date.now() + 10_000
  let status = await statusOf(id)
  while (status !== want && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200))
    status = await statusOf(id)
  }
  return status
}

const responses = async () =>
  (await probeEvents())
    .filter((e) => e.event === "slack-response")
    .map((e) => e.detail as { text: string; replace_original?: boolean })

/**
 * Waits until the agent has answered one more click than `before` (it answers every forwarded
 * click once, after hq has decided), so what is checked next is checked after hq acted: never a
 * fixed pause. Gives up after 10 seconds, and the check that follows then fails on its own.
 */
async function nextResponse(before: number): Promise<void> {
  const deadline = Date.now() + 10_000
  while ((await responses()).length <= before && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

export default defineEval({
  description:
    "A Slack click on a proposal card, through eve's route: refused unless Slack signed it, " +
    "and decided by hq only for a founder, once.",
  tags: [OFFLINE_TAG],
  async test(t) {
    await useRealClock()
    const proposed = async (slug: string) =>
      (
        await hq().proposeEntry({
          kind: "fact",
          slug,
          title: `Click ${slug}`,
          body: { text: "Pending a click." },
          reason: "the click eval",
        })
      ).proposalId
    const post = (req: ReturnType<typeof clickRequest>) =>
      t.target.fetch("/eve/v1/slack", { method: "POST", headers: req.headers, body: req.rawBody })

    // Not signed by Slack: eve answers 401 and nothing reaches hq. A bad signature on an
    // app_mention event is refused the same way (the verifier guards the whole channel).
    const target = await proposed(`target-${Date.now()}`)
    const approve = `hq_proposal_approve:${target}:new`
    const refusals: number[] = []
    for (const req of [
      clickRequest({ user: FOUNDER, actionId: approve, badSignature: true }),
      clickRequest({ user: FOUNDER, actionId: approve, offsetSeconds: -400 }),
      clickRequest({ user: FOUNDER, actionId: approve, offsetSeconds: 120 }),
    ]) {
      refusals.push((await post(req)).status)
    }
    const eventBody = JSON.stringify({
      type: "event_callback",
      event: { type: "app_mention", user: FOUNDER, text: "hi", channel: "C1", ts: "1.1" },
    })
    refusals.push(
      (
        await t.target.fetch("/eve/v1/slack", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)),
            "x-slack-signature": `v0=${"0".repeat(64)}`,
          },
          body: eventBody,
        })
      ).status,
    )
    t.check(
      refusals,
      satisfies(
        (codes: number[]) => codes.every((c) => c === 401),
        "unsigned, stale, future and event requests are 401",
      ),
    )
    t.check(
      await settled(target, "pending"),
      satisfies((s: string | undefined) => s === "pending", "and the proposal is untouched"),
    )

    // A workspace member who is no founder: Slack-signed, so eve takes it, but hq refuses it.
    const answered = (await responses()).length
    await post(clickRequest({ user: "UNOTFOUNDER", actionId: approve }))
    await nextResponse(answered)
    t.check(
      await statusOf(target),
      satisfies(
        (s: string | undefined) => s === "pending",
        "a non-founder's click leaves it pending",
      ),
    )
    t.check(
      (await responses()).map((r) => r.text).join(" | "),
      satisfies(
        (text: string) => /founder/i.test(text),
        "and the clicker is told only a founder can",
      ),
    )

    // The founder's click: 200 from eve, then hq approves it.
    const ok = await post(clickRequest({ user: FOUNDER, actionId: approve }))
    t.check(
      ok.status,
      satisfies((s: number) => s === 200, "a founder's signed click is accepted by the route"),
    )
    t.check(
      await settled(target, "approved"),
      satisfies((s: string | undefined) => s === "approved", "and hq approved the proposal"),
    )

    // The same click again (Slack redelivery or a replay): nothing changes, the clicker is told.
    const beforeReplay = (await responses()).length
    await post(clickRequest({ user: FOUNDER, actionId: approve }))
    await nextResponse(beforeReplay)
    t.check(
      await statusOf(target),
      satisfies((s: string | undefined) => s === "approved", "a replayed click leaves it approved"),
    )
    t.check(
      (await responses()).map((r) => r.text).join(" | "),
      satisfies((text: string) => /already approved/.test(text), "and says it was already decided"),
    )
  },
})
