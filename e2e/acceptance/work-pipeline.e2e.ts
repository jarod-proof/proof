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

// Phase 4 acceptance on a deployed org: the work pipeline up to the point where hq waits for a
// founder. A signal on a synthetic repository (`workRepo()`: it names no real repository) is taken
// through to an open pull request by `fakeAgent`, the stand-in for the agent's pipeline (the
// agent's key, no model, no GitHub): an investigation with a contract, a fix with a reviewer's
// verdict, two attempts in all. Then a founder looks at it in the app: the Work board has the card
// in In review marked `needs you`, and Item detail shows the contract, both attempts and the pull
// request with `Merge approval waits for a founder`. Nothing has merged: no code path in hq merges.
//
// Every assertion is about an end state: org B's deployed `work-sweep` schedule (every 30
// minutes) is global and can run in the middle of this journey, and nothing it does touches an
// item that waits in review. The journey ends by stopping its item through the founder, so the
// board stays clean (an item stays in hq's history; nothing in hq can be deleted). It makes no
// sign-in of its own: the founder's session is the one `founderClient` keeps.
test("a signal moves through to an opened PR and a merge approval that waits for a founder: the Work board shows the card in In review with 'needs you', Item detail shows the contract, the two attempts (an investigation and a fix) and the PR, and nothing has merged", {
  // The founder's session cookie is put in the browser: no trace, no video, so it is not recorded.
  // Room for the sign-in fallback of openAppAsFounder waiting out a rate limit.
  timeout: 240_000,
  skip: acceptanceSkip,
  trace: "off",
  video: "off",
}, async ({ app, browser, screen }) => {
  claimRun("work-pipeline")
  assertAppIsHq(app)
  const founder = await founderClient()
  const agent = fakeAgent(agentClient())
  const repo = workRepo()
  const title = `Acceptance pipeline ${repo.slice(repo.indexOf("/") + 1)}`

  let journeyError: { error: unknown } | null = null
  try {
    // The agent's side: a signal, an investigation, a fix that opens a pull request.
    const work = await agent.toReview({ repo, issue: 1, title })

    // hq, read as the founder: in review, waiting for a merge approval at the head the reviewer read.
    const item = await workItemOf(founder, work.itemId)
    expect(item.state).toBe("review")
    expect(item.attention).toBe("merge_approval")
    expect(item.cycle).toBe(1)
    expect(item.attemptList.map((a) => `${a.kind}:${a.result}`)).toEqual([
      "investigate:investigated",
      "fix:approved",
    ])
    // The two entries fakeAgent's investigation sent (the screen loop below checks each one's text).
    expect(item.contract).toHaveLength(2)
    expect(item.pullRequest).toMatchObject({
      number: work.number,
      url: work.url,
      state: "open",
      headSha: work.headSha,
      mergedAt: null,
    })
    expect(item.mergeApproval).toMatchObject({
      status: "pending",
      headSha: work.headSha,
      decidedBy: null,
    })

    // The Work board: the card is in In review, marked `needs you`, and under Needs you.
    await openAppAsFounder(app, browser, screen, "/work")
    await expect(screen.getByRole("heading", "Work")).toBeVisible()
    const card = screen.getByRole("region", "In review").getByRole("article", title)
    await expect(card).toBeVisible()
    await expect(card).toContainText("needs you")
    await expect(card).toContainText(`PR #${work.number}`)
    const waiting = screen.getByRole("region", /^Needs you/).getByRole("article", title)
    await expect(waiting).toBeVisible()
    await expect(waiting).toContainText("merge approval")

    // Item detail, opened from the card: the contract, the two attempts and the pull request.
    await card.getByRole("link", title).tap()
    await expect(browser).toHaveURL(new RegExp(`/app/work/${work.displayId}$`))
    await expect(screen.getByRole("heading", title)).toBeVisible()
    const contract = screen.getByRole("region", "Plan and verification contract")
    for (const entry of item.contract) await expect(contract).toContainText(entry.text)
    const attempts = screen.getByRole("region", "Attempts")
    await expect(attempts.getByRole("article")).toHaveCount(2)
    const [investigation, fix] = item.attemptList
    await expect(attempts.getByRole("article", `Attempt ${investigation?.number}`)).toContainText(
      "investigate",
    )
    await expect(attempts.getByRole("article", `Attempt ${fix?.number}`)).toContainText("fix")
    const pullRequest = screen.getByRole("region", `PR #${work.number}`)
    await expect(pullRequest).toContainText("Merge approval waits for a founder")
    await expect(pullRequest).toContainText(`${work.branch} into main`)
    // The button is there for a founder to press; this journey does not press it.
    await expect(pullRequest.getByRole("button", "Approve merge")).toBeVisible()
    await expect(pullRequest.getByText("Merged on GitHub", { exact: false })).toHaveCount(0)

    // Nothing has merged, and nothing was decided by looking.
    const after = await workItemOf(founder, work.itemId)
    expect(after.state).toBe("review")
    expect(after.pullRequest).toMatchObject({ state: "open", mergedAt: null })
    expect(after.mergeApproval).toMatchObject({ status: "pending", decidedBy: null })
  } catch (error) {
    journeyError = { error }
  }
  await endWork(founder, agent.touched, journeyError)
})
