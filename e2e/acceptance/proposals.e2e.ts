import { test } from "@e2e-dev/web"
import { expect } from "e2e"

import {
  acceptanceSkip,
  agentClient,
  claimRun,
  errorCode,
  founderClient,
  hqBase,
  need,
  proposalById,
  runTag,
} from "./support"

// Phase 1 acceptance on a deployed org: the trust rule. A proposal made with the agent's API key
// lands pending and stays pending (the key cannot decide it); a founder who signs in at /admin
// approves it on /admin/proposals, and only then is it in the brain. Deterministic, no model. The
// entry stays behind (history is never deleted), named `acceptance-...`.
test("an API-key proposal stays pending until a founder approves it in /admin/proposals", {
  // The sign-in is typed into the page: no trace, no video, so the password is not recorded.
  timeout: 180_000,
  skip: acceptanceSkip,
  trace: "off",
  video: "off",
}, async ({ app, browser, screen }) => {
  if (!app.baseUrl || new URL(app.baseUrl).origin !== new URL(hqBase()).origin) {
    throw new Error("E2E_BASE_URL must be the org's hq (the same URL as HQ_BASE_URL)")
  }
  claimRun("proposals")
  const agent = agentClient()
  const tag = runTag()
  const title = `Acceptance proposal ${tag}`
  // A word only this run's entry holds (search reads words, not hyphenated slugs).
  const word = `quokka${tag.replace(/[^a-z0-9]/g, "")}`
  const text = `Founders approve what agents propose. ${word}`

  // The agent proposes with its key.
  const proposed = await agent.post("/v1/proposals", {
    kind: "fact",
    slug: `${tag}-proposal`,
    title,
    body: { text },
    reason: "acceptance run",
  })
  expect(proposed.status).toBe(200)
  expect(proposed.json.status).toBe("pending")
  const id = proposed.json.proposalId as string

  // It is pending, the key's own decision is refused, and the brain does not hold it yet.
  expect((await proposalById(agent, id))?.status).toBe("pending")
  const attempt = await agent.post(`/v1/proposals/${id}/decision`, { decision: "approve" })
  expect(attempt.status).toBe(403)
  expect(errorCode(attempt)).toBe("FORBIDDEN")
  expect((await proposalById(agent, id))?.status).toBe("pending")
  const before = await agent.post("/v1/search/entries", { query: word })
  expect(before.json.hits).toEqual([])

  // A founder signs in at /admin and approves it there.
  await app.open("/admin/proposals")
  await expect(browser).toHaveURL(/\/admin\/login\?next=%2Fadmin%2Fproposals/)
  await screen.getByLabel("Email").fill(need("FOUNDER_EMAIL"))
  await screen.getByLabel("Password").fill(need("HQ_FOUNDER_PASSWORD"))
  await screen.getByRole("button", "Sign in").tap()
  await expect(screen.getByRole("heading", "Proposals")).toBeVisible()

  const card = screen.getByRole("article", `Proposal: ${title}`)
  await expect(card.getByText(text)).toBeVisible()
  await card.getByRole("button", "Approve").tap()
  await expect(card.getByRole("button", "Approve")).not.toBeVisible()
  await expect(card).toContainText("approved")

  // Decided by a founder (a person, not the key), and now in the brain.
  const founder = await founderClient()
  const decided = await proposalById(founder, id)
  expect(decided?.status).toBe("approved")
  // The one who signed in and clicked Approve: the founder account's own user id.
  expect(decided?.decidedBy).toBe(founder.userId)
  expect(decided?.decidedBy).not.toBe(decided?.proposedBy.id)
  const after = await agent.post("/v1/search/entries", { query: word })
  expect((after.json.hits as unknown[]).length).toBe(1)
})
