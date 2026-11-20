import { test } from "@e2e-dev/web"
import { expect } from "e2e"

import {
  acceptanceSkip,
  agentClient,
  claimRun,
  founderClient,
  founderSlackUsers,
  proposalById,
  runTag,
  slackClick,
} from "./support"

// Phase 1 acceptance on a deployed org: founder-only Slack approvals. A click signed with the
// org's real Slack signing secret, from a listed founder's Slack user, approves a proposal; the
// same signed click from a workspace member who is no founder is refused (403) and changes
// nothing, and so are a forged signature and a stale timestamp. A replay is a 409 that changes
// nothing. The click goes to hq's own /v1/slack/actions, which is what the agent forwards to. No
// model, no Slack API call. The approved fact stays behind, named `acceptance-...`.
test("a signed founder approve action approves the proposal; a non-founder's returns 403", {
  timeout: 120_000,
  skip: acceptanceSkip,
}, async () => {
  claimRun("slack")
  const agent = agentClient()
  const founder = await founderClient()
  const tag = runTag()
  const word = `quokka${tag.replace(/[^a-z0-9]/g, "")}`

  // A pending proposal, as the agent's would arrive.
  const proposed = await agent.post("/v1/proposals", {
    kind: "fact",
    slug: `${tag}-slack`,
    title: `Acceptance slack ${tag}`,
    body: { text: `Approved from a Slack card. ${word}` },
    reason: "acceptance run",
  })
  expect(proposed.status).toBe(200)
  const id = proposed.json.proposalId as string
  const approve = `hq_proposal_approve:${id}:new`
  const state = async () => (await proposalById(founder, id))?.status

  // Not Slack's signature, or too old: refused at the door.
  const [founderUser] = founderSlackUsers()
  expect(founderUser, "HQ_FOUNDERS lists a founder").toBeTruthy()
  const user = founderUser as string
  expect((await slackClick(user, approve, { badSignature: true })).status).toBe(403)
  expect((await slackClick(user, approve, { staleBySeconds: 400 })).status).toBe(403)
  expect(await state()).toBe("pending")

  // Signed by Slack, clicked by a workspace member who is no founder: 403, still pending.
  const stranger = "UNOTAFOUNDER"
  expect(founderSlackUsers()).not.toContain(stranger)
  const refused = await slackClick(stranger, approve)
  expect(refused.status).toBe(403)
  expect(refused.text).toMatch(/founder/i)
  expect(await state()).toBe("pending")

  // The founder's click approves it, as that founder.
  const approved = await slackClick(user, approve)
  expect(approved.status).toBe(200)
  expect(approved.text).toMatch(/approved/i)
  const decided = await proposalById(founder, id)
  expect(decided?.status).toBe("approved")
  // Decided by the founder hq lists for that Slack user: the signed-in founder's own user id.
  expect(decided?.decidedBy).toBe(founder.userId)
  expect(decided?.decidedBy).not.toBe(decided?.proposedBy.id)

  // Once only: the same click again changes nothing.
  const replay = await slackClick(user, approve)
  expect(replay.status).toBe(409)
  expect(await proposalById(founder, id)).toEqual(decided)

  // The brain holds what the click approved.
  const found = await agent.post("/v1/search/entries", { query: word })
  expect((found.json.hits as unknown[]).length).toBe(1)
})
