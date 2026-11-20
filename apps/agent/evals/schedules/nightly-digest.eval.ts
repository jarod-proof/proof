import { defineEval } from "eve/evals"
import { satisfies } from "eve/evals/expect"
import { freshDay, hq, latestRun, OFFLINE_TAG, waitForProbeEvents } from "../offline.js"

interface Post {
  channel: string
  text: string
  blocks: { type: string; block_id?: string; elements?: { action_id: string }[] }[]
}

export default defineEval({
  description:
    "With two pending proposals the nightly digest posts ONE Slack message with a card for each " +
    "(approve and reject buttons naming the proposal and its version), and records its own run.",
  tags: [OFFLINE_TAG],
  async test(t) {
    await freshDay()
    // Yesterday, as hq counts it: a run and what it cost.
    const yesterday = await hq().recordRun({
      task: "answer a pricing question",
      trigger: "slack",
      runner: "eve",
    })
    await hq().recordSpend({ runId: yesterday.id, source: "eve", amountUsd: 0.42, model: "haiku" })
    // Two proposals waiting. Other evals may leave pending ones behind: only these two are named.
    const first = await hq().proposeEntry({
      kind: "fact",
      slug: "digest-eval-one",
      title: "Digest eval one",
      body: { text: "First pending proposal." },
      reason: "the digest eval",
    })
    const second = await hq().proposeEntry({
      kind: "decision",
      slug: "digest-eval-two",
      title: "Digest eval two",
      body: { text: "Second pending proposal." },
      reason: "the digest eval",
    })
    // The next UTC day: the day before it now holds the run, the spend and the proposals' day.
    await freshDay()

    await t.target.dispatchSchedule("nightly-digest")
    const posts = (await waitForProbeEvents("slack-post")).map((e) => e.detail as Post)

    t.check(
      posts.length,
      satisfies((n: number) => n === 1, "exactly one message was posted"),
    )
    const [post] = posts
    const buttons = (post?.blocks ?? [])
      .filter((b) => b.type === "actions")
      .flatMap((b) => (b.elements ?? []).map((e) => e.action_id))
    for (const proposal of [first, second]) {
      for (const decision of ["approve", "reject"]) {
        t.check(
          buttons,
          satisfies(
            (ids: string[]) => ids.includes(`hq_proposal_${decision}:${proposal.proposalId}:new`),
            `the message has a ${decision} button for proposal ${proposal.proposalId} naming its version`,
          ),
        )
      }
    }
    const body = JSON.stringify(post?.blocks ?? [])
    t.check(
      body,
      satisfies(
        (text: string) => text.includes("Runs:* 1") && text.includes("Spend:* $0.42"),
        "yesterday's run and spend, as hq counts the day, are in it",
      ),
    )

    // Its own run in hq, finished, at no model cost.
    const run = await latestRun()
    t.check(
      run,
      satisfies(
        (r: Awaited<ReturnType<typeof latestRun>>) =>
          r?.task === "nightly digest" && r.outcome === "succeeded" && r.costUsd === 0,
        "the digest's own run is recorded as succeeded, costing nothing",
      ),
    )
  },
})
