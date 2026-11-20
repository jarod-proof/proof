import { agentEnv } from "@proof/env/agent"
import type { HqClient, ProposalRow, RunRow, SpendSummary } from "../hq/client.js"
import { hqFromEnv } from "../hq/env.js"
import { log } from "../log.js"
import { offlineMode } from "../offline/mode.js"
import { traceToProbe } from "../offline/probe.js"
import { escapeMrkdwn, proposalCard, type SlackBlock } from "../slack/proposal-card.js"

/**
 * The nightly digest: yesterday's runs and spend and every pending proposal, as ONE Slack message
 * with a card per proposal a founder can approve or reject with a click.
 *
 * @remarks
 * It reads hq with the agent's key (read scope) and posts through the Slack Web API; it makes no
 * model call, so its cost is recorded as 0 with model `none`, and it needs no reservation. It is
 * its own run in hq (`record_run`, `finish_run`, `record_spend`). It fails closed: if hq cannot
 * answer, nothing is posted, the run is finished as failed when hq can still hear it, and the
 * failure is thrown to the caller. "Yesterday" is hq's: the day comes back from hq's spend
 * summary, never from this process's clock.
 */

/** Slack allows 50 blocks per message; a card is 3 with its divider. */
export const MAX_CARDS = 14
const MAX_RUN_PAGES = 10
const MAX_PROPOSAL_PAGES = 5

export interface SlackMessage {
  channel: string
  text: string
  blocks: SlackBlock[]
}

export interface DigestDeps {
  hq: () => HqClient
  /** Posts one message; resolves when Slack accepted it, throws when it did not. */
  post: (message: SlackMessage) => Promise<void>
  /** The channel to post in; unset, the digest has nowhere to go and does not run. */
  channelId: () => string | undefined
}

export interface DigestOutcome {
  posted: boolean
  day: string
  proposals: number
  cards: number
}

interface Reading {
  day: string
  spend: SpendSummary
  runs: RunRow[]
  proposals: ProposalRow[]
}

/** Everything the digest reports, read from hq. Any failure throws and nothing is posted. */
async function read(hq: HqClient): Promise<Reading> {
  const spend = await hq.getSpendSummary()
  const runs: RunRow[] = []
  let cursor: string | undefined
  for (let page = 0; page < MAX_RUN_PAGES; page++) {
    const got = await hq.listRuns({ cursor, limit: 100 })
    runs.push(...got.runs.filter((run) => run.startedAt.slice(0, 10) === spend.day))
    // Newest first: once a page reaches back before the day, the rest is older still.
    const reachedBefore = got.runs.some((run) => run.startedAt.slice(0, 10) < spend.day)
    if (!got.nextCursor || reachedBefore) break
    cursor = got.nextCursor
  }
  const proposals: ProposalRow[] = []
  cursor = undefined
  for (let page = 0; page < MAX_PROPOSAL_PAGES; page++) {
    const got = await hq.listProposals({ status: "pending", cursor, limit: 100 })
    proposals.push(...got.proposals)
    if (!got.nextCursor) break
    cursor = got.nextCursor
  }
  return { day: spend.day, spend, runs, proposals }
}

const usd = (amount: number) => `$${amount.toFixed(2)}`

/** The message: a summary of yesterday, then one card per pending proposal (up to the limit). */
export function composeDigest(reading: Reading, channel: string): SlackMessage {
  const { day, spend, runs, proposals } = reading
  const failed = runs.filter((run) => run.outcome === "failed")
  const stopped = runs.filter((run) => run.outcome === "stopped")
  const bySource = spend.bySource.map((s) => `${s.source} ${usd(s.amountUsd)}`).join(", ")
  const lines = [
    `*Runs:* ${runs.length}` +
      (runs.length === 0
        ? ""
        : ` (${runs.length - failed.length - stopped.length} ok, ${failed.length} failed, ${stopped.length} stopped)`),
    ...failed.slice(0, 5).map((run) => `• failed: ${escapeMrkdwn(run.task.slice(0, 100))}`),
    `*Spend:* ${usd(spend.totalUsd)}${bySource ? ` (${bySource})` : ""}` +
      (spend.estimatedUsd > 0 ? `, ${usd(spend.estimatedUsd)} of it estimated` : ""),
  ]
  const shown = proposals.slice(0, MAX_CARDS)
  const blocks: SlackBlock[] = [
    { type: "header", text: { type: "plain_text", text: `Nightly digest for ${day}` } },
    { type: "section", text: { type: "mrkdwn", text: lines.join("\n") } },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          proposals.length === 0
            ? "*Pending proposals:* none."
            : `*Pending proposals:* ${proposals.length}. Only a founder's click decides one.`,
      },
    },
  ]
  for (const proposal of shown) {
    blocks.push({ type: "divider" }, ...proposalCard(proposal))
  }
  if (proposals.length > shown.length) {
    blocks.push({
      type: "context",
      elements: [
        { type: "mrkdwn", text: `${proposals.length - shown.length} more are pending in hq.` },
      ],
    })
  }
  return {
    channel,
    text: `Nightly digest for ${day}: ${proposals.length} pending proposal${proposals.length === 1 ? "" : "s"}`,
    blocks,
  }
}

/**
 * Run the digest once. Throws on a failure, after recording it in hq where hq can still hear it.
 */
export async function runNightlyDigest(deps: DigestDeps): Promise<DigestOutcome | null> {
  const channel = deps.channelId()
  if (!channel) {
    log.warn("digest: SLACK_DIGEST_CHANNEL_ID is not set, so there is nowhere to post")
    return null
  }
  const hq = deps.hq()
  // The run first: with hq down there is no digest and nothing to record it in.
  const run = await hq.recordRun({
    task: "nightly digest",
    trigger: "schedule 07:00 UTC",
    runner: "eve",
  })
  const finish = (outcome: "succeeded" | "failed", worked: string[], failed: string[]) =>
    hq
      .finishRun({ id: run.id, outcome, summary: { worked, failed, stop: [] } })
      .catch((error: unknown) => log.warn("digest: could not finish its run in hq", error))

  let reading: Reading
  try {
    reading = await read(hq)
  } catch (error) {
    // Fail closed: nothing was read, so nothing is posted.
    await finish("failed", [], [`hq could not be read: ${describe(error)}`])
    throw error
  }
  const message = composeDigest(reading, channel)
  try {
    await deps.post(message)
  } catch (error) {
    await finish("failed", [], [`Slack did not take the digest: ${describe(error)}`])
    throw error
  }
  // No model ran, so the cost is recorded as nothing: the run still shows in the ledger.
  await hq
    .recordSpend({ runId: run.id, source: "eve", amountUsd: 0, model: "none" })
    .catch((error: unknown) => log.warn("digest: could not record its cost in hq", error))
  const cards = Math.min(reading.proposals.length, MAX_CARDS)
  await finish(
    "succeeded",
    [`posted one message for ${reading.day} with ${cards} proposal card${cards === 1 ? "" : "s"}`],
    [],
  )
  return { posted: true, day: reading.day, proposals: reading.proposals.length, cards }
}

const describe = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).slice(0, 300)

/** Posts with the Slack Web API and the bot token; offline, to the probe, and never the network. */
export async function postToSlack(message: SlackMessage): Promise<void> {
  if (offlineMode()) {
    await traceToProbe("slack-post", message)
    return
  }
  const token = agentEnv("SLACK_BOT_TOKEN")
  if (!token) throw new Error("SLACK_BOT_TOKEN is not set")
  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ ...message, unfurl_links: false, unfurl_media: false }),
    signal: AbortSignal.timeout(10_000),
  })
  const reply = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string }
  if (!response.ok || reply.ok !== true) {
    throw new Error(`Slack refused the post: ${reply.error ?? response.status}`)
  }
}

/** The digest on the real environment. */
export const defaultDigestDeps: DigestDeps = {
  hq: hqFromEnv,
  post: postToSlack,
  channelId: () => agentEnv("SLACK_DIGEST_CHANNEL_ID")?.trim() || undefined,
}
