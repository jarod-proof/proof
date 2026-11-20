import { describe, expect, test } from "vitest"
import {
  escapeMrkdwn,
  grantActionId,
  grantCard,
  type PendingProposal,
  proposalActionId,
  proposalCard,
} from "#lib/slack/proposal-card.js"
import {
  grantActionId as hqGrantActionId,
  parseActionId,
  proposalActionId as hqProposalActionId,
} from "@proof/hq/src/slack/actions"

const proposal: PendingProposal = {
  id: "7b1f3c52-0a2e-4f43-9f55-6d3a1d2c9e10",
  kind: "fact",
  slug: "pricing",
  title: "Pricing",
  baseVersion: 3,
  reason: "Said on the founders call",
  body: { text: "Free, then $20 per seat." },
}

interface Block {
  type: string
  block_id: string
  text?: { type: string; text: string }
  elements?: { type: string; action_id: string; value: string; style?: string }[]
}

describe("a proposal card", () => {
  test("has an approve and a reject button whose ids carry the proposal and the version", () => {
    const blocks = proposalCard(proposal) as unknown as Block[]
    const actions = blocks.find((b) => b.type === "actions")
    const [approve, reject] = actions?.elements ?? []
    expect(approve?.action_id).toBe(`hq_proposal_approve:${proposal.id}:3`)
    expect(reject?.action_id).toBe(`hq_proposal_reject:${proposal.id}:3`)
    expect(approve?.style).toBe("primary")
    expect(reject?.style).toBe("danger")
    // A new entry has no version to name.
    const fresh = proposalCard({ ...proposal, baseVersion: null }) as unknown as Block[]
    expect(fresh.find((b) => b.type === "actions")?.elements?.[0]?.action_id).toBe(
      `hq_proposal_approve:${proposal.id}:new`,
    )
  })

  test("is read by hq's own parser exactly as built: the two ends agree", () => {
    expect(parseActionId(proposalActionId("approve", proposal.id, 3))).toEqual({
      kind: "proposal",
      decision: "approve",
      proposalId: proposal.id,
      baseVersion: 3,
    })
    expect(parseActionId(proposalActionId("reject", proposal.id, null))).toMatchObject({
      decision: "reject",
      baseVersion: null,
    })
    expect(parseActionId(grantActionId(true, "req_1", 500))).toEqual({
      kind: "grant",
      approve: true,
      requestId: "req_1",
      cents: 500,
    })
    expect(parseActionId(grantActionId(false, "req_1", 500))).toMatchObject({ approve: false })
    for (const version of [null, 1, 2, 17]) {
      expect(proposalActionId("approve", proposal.id, version)).toBe(
        hqProposalActionId("approve", proposal.id, version),
      )
    }
    expect(grantActionId(true, "r", 5)).toBe(hqGrantActionId(true, "r", 5))
    // Every id on a real card parses.
    for (const block of proposalCard(proposal) as unknown as Block[]) {
      for (const element of block.elements ?? []) {
        expect(parseActionId(element.action_id)).not.toBeNull()
        expect(element.value).toBe(element.action_id)
      }
    }
  })

  test("text that came from outside is escaped and cut: no mention, no link, no markup", () => {
    const hostile = {
      ...proposal,
      title: "<!channel> Pricing",
      reason: "see <https://evil.example|click> & <@UADMIN>",
      body: { text: `${"x".repeat(2000)} <!everyone>` },
    }
    const text = (proposalCard(hostile) as unknown as Block[])[0]?.text?.text ?? ""
    expect(text).not.toMatch(/<[!@h]/)
    expect(text).toContain("&lt;!channel&gt;")
    expect(text).toContain("&amp;")
    expect(text.length).toBeLessThan(1100)
    expect(escapeMrkdwn("<a>&")).toBe("&lt;a&gt;&amp;")
  })
})

describe("a grant card", () => {
  test("carries the request and the amount in cents, and says the amount", () => {
    const blocks = grantCard({
      requestId: "req_9",
      amountUsd: 5,
      reason: "Launch day",
    }) as unknown as Block[]
    const [grant, dismiss] = blocks.find((b) => b.type === "actions")?.elements ?? []
    expect(grant?.action_id).toBe("hq_grant_approve:req_9:500")
    expect(dismiss?.action_id).toBe("hq_grant_deny:req_9:500")
    expect(blocks[0]?.text?.text).toContain("$5.00")
    expect(parseActionId(grant?.action_id ?? "")).toMatchObject({ approve: true, cents: 500 })
  })
})
