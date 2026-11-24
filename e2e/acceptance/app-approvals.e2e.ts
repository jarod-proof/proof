import { test } from "@e2e-dev/web"
import { expect } from "e2e"

import {
  acceptanceSkip,
  agentClient,
  assertAppIsHq,
  claimRun,
  errorCode,
  founderClient,
  openAppAsFounder,
  proposalById,
  runTag,
} from "./support"

// Phase 3 acceptance on a deployed org: the Approvals screen of the hq app. A proposal the agent
// makes with its key shows under "Needs you"; a founder approves it with one click and it is in the
// brain, decided by that founder, and nothing is left to click twice. Deterministic, no model. The
// entry stays behind (history is never deleted), named `acceptance-...`.
test("an agent's proposal appears under Needs you; a founder approves it in /app/approvals and it is in the brain, decided by that founder", {
  // The founder's session cookie is put in the browser: no trace, no video, so it is not recorded.
  // Room for the sign-in fallback of openAppAsFounder waiting out a rate limit.
  timeout: 240_000,
  skip: acceptanceSkip,
  trace: "off",
  video: "off",
}, async ({ app, browser, screen }) => {
  claimRun("app-approvals")
  assertAppIsHq(app)
  const agent = agentClient()
  const tag = runTag()
  const title = `Acceptance app proposal ${tag}`
  // A word only this run's entry holds (search reads words, not hyphenated slugs).
  const word = `quokka${tag.replace(/[^a-z0-9]/g, "")}`
  const text = `Founders decide in the app what agents propose. ${word}`

  // The agent proposes with its key; the key cannot decide it.
  const proposed = await agent.post("/v1/proposals", {
    kind: "fact",
    slug: `${tag}-app-proposal`,
    title,
    body: { text },
    reason: "acceptance run",
  })
  expect(proposed.status).toBe(200)
  expect(proposed.json.status).toBe("pending")
  const id = proposed.json.proposalId as string
  expect((await agent.post("/v1/search/entries", { query: word })).json.hits).toEqual([])

  // A founder opens Approvals: the proposal is a card under Needs you, with its text as text.
  await openAppAsFounder(app, browser, screen, "/approvals")
  await expect(screen.getByRole("heading", "Approvals")).toBeVisible()
  // The section's name carries its count (`Needs you 3`).
  const needsYou = screen.getByRole("region", "Needs you", { exact: false })
  const card = needsYou.getByRole("article", title)
  await expect(card).toBeVisible()
  await expect(card.getByText(text)).toBeVisible()

  // One click on Approve decides it. The card leaves Needs you, so there is no second click, and
  // the proposal is in Recently decided as approved.
  await card.getByRole("button", "Approve").tap()
  await expect(card).toBeHidden()
  const decidedRow = screen
    .getByRole("region", "Recently decided")
    .getByRole("listitem")
    .filter({ hasText: title })
  await expect(decidedRow).toContainText("Approved")

  // Decided by the founder's own account (a person, not the key), and now in the brain.
  const founder = await founderClient()
  const decided = await proposalById(founder, id)
  expect(decided?.status).toBe("approved")
  expect(decided?.decidedBy).toBe(founder.userId)
  expect(decided?.decidedBy).not.toBe(decided?.proposedBy.id)
  const found = await agent.post("/v1/search/entries", { query: word })
  expect((found.json.hits as unknown[]).length).toBe(1)

  // hq itself refuses a second decision: the proposal was already decided.
  const again = await founder.post(`/v1/proposals/${id}/decision`, { decision: "approve" })
  expect(again.status).toBe(409)
  expect(errorCode(again)).toBe("CONFLICT")
})
