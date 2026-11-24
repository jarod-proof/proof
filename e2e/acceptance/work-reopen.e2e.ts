import { test } from "@e2e-dev/web"
import { expect } from "e2e"

import {
  acceptanceSkip,
  agentClient,
  assertAppIsHq,
  claimRun,
  endWork,
  fakeAgent,
  founderClient,
  openAppAsFounder,
  workItemOf,
  workRepo,
} from "./support"

// Phase 4 acceptance on a deployed org: what happens after a merge. `fakeAgent` (the agent's key,
// no model) takes a signal on a synthetic repository to review and then records the pull request
// merged, as the agent does when GitHub says so. hq moves the item to Deploy: the 15 minute grace
// before the verification window has not passed. A founder opens Item detail, presses `Revert
// merge` and confirms: the item is reopened (hq reverts nothing on GitHub). The same signal
// arriving again attaches to it. `run_verification_sweep` answers 200 and the journey then asserts
// the end state: the item is back in triage in cycle 2 (sweep rule 2 retriages every reopened
// item, so it does not matter whether this call or org B's deployed `work-sweep`, which runs every
// 30 minutes and is global, got there first). It does not assert what the call returned: other
// items on the org can move in the same pass.
//
// What this journey cannot show on a real org: the 15 minute grace and the 6 hour verification
// window cannot be waited out. They are proven with a moved clock in hq's own tests (Tasks 6a and
// 3 of the plan), and through merges backdated by `mergedAt` in the seed of apps/hq/scripts
// seed-work.mjs (Task 15). This journey leaves `mergedAt` out, so hq stamps the merge with its
// own clock, and it asserts `deploy`, never `verify`.
//
// The journey ends by stopping its item through the founder, so the board stays clean. It makes no
// sign-in of its own: the founder's session is the one `founderClient` keeps.
test("a merged PR observed moves the item to Deploy, a revert request from Item detail reopens it, the same signal arriving again attaches, and the sweep returns it to triage in cycle 2", {
  // The founder's session cookie is put in the browser: no trace, no video, so it is not recorded.
  // Room for the sign-in fallback of openAppAsFounder waiting out a rate limit.
  timeout: 240_000,
  skip: acceptanceSkip,
  trace: "off",
  video: "off",
}, async ({ app, browser, screen }) => {
  claimRun("work-reopen")
  assertAppIsHq(app)
  const founder = await founderClient()
  const agent = fakeAgent(agentClient())
  const repo = workRepo()
  const title = `Acceptance reopen ${repo.slice(repo.indexOf("/") + 1)}`

  let journeyError: { error: unknown } | null = null
  try {
    // The pull request is merged: the item is in Deploy (the grace has not passed), cycle 1.
    const work = await agent.toReview({ repo, issue: 1, title })
    await agent.merge(work)
    const deploying = await workItemOf(founder, work.itemId)
    expect(deploying.state).toBe("deploy")
    expect(deploying.cycle).toBe(1)
    expect(deploying.pullRequest).toMatchObject({ number: work.number, state: "merged" })

    // A founder asks for the revert from Item detail: one click to ask, one to confirm.
    await openAppAsFounder(app, browser, screen, `/work/${work.displayId}`)
    await expect(screen.getByRole("heading", title)).toBeVisible()
    await screen.getByRole("button", "Revert merge").tap()
    await screen.getByRole("button", "Request revert").tap()
    await expect(
      screen.getByText(`Revert requested for ${work.displayId}.`, { exact: false }),
    ).toBeVisible()
    // Reopened in cycle 1, or already retriaged into cycle 2 if the deployed sweep ran in between:
    // never still in Deploy, and never a triage that is not the second cycle's.
    const reopened = await workItemOf(founder, work.itemId)
    expect(["reopened cycle 1", "triage cycle 2"]).toContain(
      `${reopened.state} cycle ${reopened.cycle}`,
    )

    // The same signal arriving again (a new report of the same issue) attaches to the item.
    const again = await agent.signal({ repo, issue: 1, title, occurrence: "recurred" })
    expect(again.itemId).toBe(work.itemId)
    expect(again.outcome).toBe("attached")
    expect((await workItemOf(founder, work.itemId)).signal?.occurrences).toBeGreaterThanOrEqual(2)

    // The sweep answers 200; the end state is triage in cycle 2, whoever moved it there.
    const sweep = await agent.sweep()
    expect(sweep.status).toBe(200)
    await expect
      .poll(
        async () => {
          const item = await workItemOf(founder, work.itemId)
          return `${item.state} cycle ${item.cycle}`
        },
        { timeout: 30_000 },
      )
      .toBe("triage cycle 2")
  } catch (error) {
    journeyError = { error }
  }
  await endWork(founder, agent.touched, journeyError)
})
