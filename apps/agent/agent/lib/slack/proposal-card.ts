/**
 * Slack cards a founder decides with a click: a pending brain proposal (approve or reject) and a
 * spend grant (grant or dismiss).
 *
 * @remarks
 * The buttons carry everything hq needs to decide in their `action_id`: for a proposal its id and
 * the version it was proposed against (`new` for a new entry), for a grant its request id and the
 * amount in cents. hq parses them (`apps/hq/src/slack/actions.ts`; `tests/slack/proposal-card.test.ts`
 * holds the two ends together) and decides only from what it verified, so a click cannot be made to
 * mean more than its card said. Nothing on a card is trusted: a proposal's text came from an agent
 * or from outside, so it is escaped for Slack (no mentions, no links) and cut to length.
 */

export interface PendingProposal {
  id: string
  kind: string
  slug: string
  title: string
  /** The version it was proposed against; null for a new entry. */
  baseVersion: number | null
  reason: string
  body: { text: string }
}

/** A Slack Block Kit block, as far as these cards use it. */
export type SlackBlock = Record<string, unknown>

/** Escape what Slack reads as markup in mrkdwn: `&`, `<` (links, mentions) and `>`. */
export const escapeMrkdwn = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")

const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`

const flat = (text: string): string => text.replaceAll(/\s+/g, " ").trim()

export const proposalActionId = (
  decision: "approve" | "reject",
  proposalId: string,
  baseVersion: number | null,
) => `hq_proposal_${decision}:${proposalId}:${baseVersion ?? "new"}`

export const grantActionId = (approve: boolean, requestId: string, cents: number) =>
  `hq_grant_${approve ? "approve" : "deny"}:${requestId}:${cents}`

const button = (text: string, actionId: string, style?: "primary" | "danger") => ({
  type: "button",
  text: { type: "plain_text", text },
  action_id: actionId,
  value: actionId,
  ...(style === undefined ? {} : { style }),
})

/** One pending proposal: what it says, why, which version it was made against, and two buttons. */
export function proposalCard(proposal: PendingProposal): SlackBlock[] {
  const against =
    proposal.baseVersion === null ? "a new entry" : `a change to version ${proposal.baseVersion}`
  return [
    {
      type: "section",
      block_id: `hq_proposal_${proposal.id}`.slice(0, 255),
      text: {
        type: "mrkdwn",
        text: [
          `*${escapeMrkdwn(clip(proposal.title, 120))}*  \`${escapeMrkdwn(proposal.kind)}/${escapeMrkdwn(proposal.slug)}\` (${against})`,
          escapeMrkdwn(clip(flat(proposal.body.text), 600)),
          `_Why:_ ${escapeMrkdwn(clip(flat(proposal.reason), 300))}`,
        ].join("\n"),
      },
    },
    {
      type: "actions",
      block_id: `hq_proposal_actions_${proposal.id}`.slice(0, 255),
      elements: [
        button(
          "Approve",
          proposalActionId("approve", proposal.id, proposal.baseVersion),
          "primary",
        ),
        button("Reject", proposalActionId("reject", proposal.id, proposal.baseVersion), "danger"),
      ],
    },
  ]
}

/**
 * A spend grant request: the amount, why, and two buttons. `requestId` and `amountUsd` are what hq
 * returned from `request_spend_grant` (the client's `requestSpendGrant`), never an id made up here:
 * hq redeems only a request it recorded, once, for the amount it recorded. The cents in the button
 * ids only repeat what the card says; hq does not read them.
 */
export function grantCard(request: {
  requestId: string
  amountUsd: number
  reason: string
}): SlackBlock[] {
  const cents = Math.round(request.amountUsd * 100)
  return [
    {
      type: "section",
      block_id: `hq_grant_${request.requestId}`.slice(0, 255),
      text: {
        type: "mrkdwn",
        text: `*Raise today's allowance by $${(cents / 100).toFixed(2)}?*\n${escapeMrkdwn(clip(flat(request.reason), 300))}`,
      },
    },
    {
      type: "actions",
      block_id: `hq_grant_actions_${request.requestId}`.slice(0, 255),
      elements: [
        button(
          `Grant $${(cents / 100).toFixed(2)}`,
          grantActionId(true, request.requestId, cents),
          "primary",
        ),
        button("Dismiss", grantActionId(false, request.requestId, cents)),
      ],
    },
  ]
}
