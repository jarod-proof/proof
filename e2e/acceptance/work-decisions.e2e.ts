import { test } from "@e2e-dev/web"
import { expect } from "e2e"

import {
  acceptanceSkip,
  agentClient,
  assertAppIsHq,
  claimRun,
  endWork,
  errorCode,
  fakeAgent,
  founderClient,
  openAppAsFounder,
  workItemOf,
  workRepo,
} from "./support"

// Phase 4 acceptance on a deployed org: the two decisions the pipeline waits on, taken in
// /app/approvals by a founder and by no key. `fakeAgent` (the agent's key, no model) leaves two
// items on a synthetic repository: one with an open question for a founder, one in review with a
// merge approval pending. The agent's key is refused (403 FORBIDDEN) on `answer_question` and on
// `approve_merge`, and nothing changes. The founder then answers the question in the browser, and
// hq records the answer as given by the founder's own user id. For the merge, a push lands after
// the founder's card was loaded (a second fix pushes a new head and its reviewer approves it): the
// click on the old card is refused with hq's conflict text, the card shows the new head, and
// approving that one is recorded, for that head only. Approving never merges: the item stays in
// review and its pull request stays open.
//
// Every assertion is about an end state (the deployed `work-sweep` can run in the middle of this
// journey and touches none of these states). The journey ends by stopping both items through the
// founder, so the board stays clean. It makes no sign-in of its own: the founder's session is the
// one `founderClient` keeps.
test("an agent question and a merge approval are decided in /app/approvals by a founder and by no key", {
  // The founder's session cookie is put in the browser: no trace, no video, so it is not recorded.
  // Room for the sign-in fallback of openAppAsFounder waiting out a rate limit.
  timeout: 240_000,
  skip: acceptanceSkip,
  trace: "off",
  video: "off",
}, async ({ app, browser, screen }) => {
  claimRun("work-decisions")
  assertAppIsHq(app)
  const founder = await founderClient()
  const key = agentClient()
  const agent = fakeAgent(key)
  const repo = workRepo()
  const tag = repo.slice(repo.indexOf("/") + 1)
  const askTitle = `Acceptance question ${tag}`
  const mergeTitle = `Acceptance merge ${tag}`

  let journeyError: { error: unknown } | null = null
  try {
    const asking = await agent.ask({ repo, issue: 1, title: askTitle })
    const merging = await agent.toReview({ repo, issue: 2, title: mergeTitle })

    // No key decides: both are FORBIDDEN, and hq holds still.
    const answeredByKey = await key.post(`/v1/questions/${asking.questionId}/answer`, {
      optionId: asking.defaultOptionId,
    })
    expect(answeredByKey.status).toBe(403)
    expect(errorCode(answeredByKey)).toBe("FORBIDDEN")
    const approvedByKey = await key.post(`/v1/work-items/${merging.itemId}/merge-approval`, {
      headSha: merging.headSha,
    })
    expect(approvedByKey.status).toBe(403)
    expect(errorCode(approvedByKey)).toBe("FORBIDDEN")
    expect((await workItemOf(founder, asking.itemId)).questions).toMatchObject([
      { id: asking.questionId, status: "open", answeredBy: null },
    ])
    expect((await workItemOf(founder, merging.itemId)).mergeApproval).toMatchObject({
      status: "pending",
      headSha: merging.headSha,
      decidedBy: null,
    })

    // A founder opens Approvals: both are cards under From the pipeline, text only.
    await openAppAsFounder(app, browser, screen, "/approvals")
    await expect(screen.getByRole("heading", "Approvals")).toBeVisible()
    const pipeline = screen.getByRole("region", /^From the pipeline/)
    const questionCard = pipeline.getByRole("article", askTitle)
    const mergeCard = pipeline.getByRole("article", mergeTitle)
    await expect(questionCard).toBeVisible()
    await expect(mergeCard).toBeVisible()
    await expect(mergeCard).toContainText(`head ${merging.headSha.slice(0, 7)}`)

    // The question is answered with a click on its recommended option: hq records the founder's
    // own user id as who answered, the key has no part in it.
    await questionCard.getByRole("button", `${asking.options[0]?.label} (default)`).tap()
    await expect(screen.getByText(`Answer sent for ${asking.displayId}.`)).toBeVisible()
    await expect(questionCard).toBeHidden()
    expect((await workItemOf(founder, asking.itemId)).questions).toMatchObject([
      {
        id: asking.questionId,
        status: "answered",
        answeredOptionId: asking.defaultOptionId,
        answeredBy: founder.userId,
      },
    ])

    // A push lands after the card was loaded: a second fix pushes a new head and its reviewer
    // approves that head. The card on screen still holds the old one.
    const pushed = await agent.reReview(merging)
    expect(pushed.headSha).not.toBe(merging.headSha)
    expect(pushed.headSha.slice(0, 7)).not.toBe(merging.headSha.slice(0, 7))
    await mergeCard.getByRole("button", "Approve merge").tap()
    await mergeCard.getByRole("button", "Confirm").tap()
    await expect(mergeCard.getByRole("alert")).toContainText(
      "The pull request changed since you looked",
    )
    // Nothing was approved by the stale click; the approval waiting is the new head's.
    const refused = await workItemOf(founder, merging.itemId)
    expect(refused.state).toBe("review")
    expect(refused.mergeApproval).toMatchObject({
      status: "pending",
      headSha: pushed.headSha,
      decidedBy: null,
    })

    // The board read again: the card holds the new head, and approving it is recorded.
    await expect(mergeCard).toContainText(`head ${pushed.headSha.slice(0, 7)}`)
    await mergeCard.getByRole("button", "Approve merge", { disabled: false }).tap()
    await mergeCard.getByRole("button", "Confirm").tap()
    await expect(
      screen.getByText(
        `Merge approved for ${merging.displayId} at ${pushed.headSha.slice(0, 7)}.`,
        { exact: false },
      ),
    ).toBeVisible()
    await expect(mergeCard).toBeHidden()

    // hq: approved by the founder for the new head only; nothing merged, the item stays in review.
    const approved = await workItemOf(founder, merging.itemId)
    expect(approved.state).toBe("review")
    expect(approved.mergeApproval).toMatchObject({
      status: "approved",
      headSha: pushed.headSha,
      decidedBy: founder.userId,
    })
    expect(approved.pullRequest).toMatchObject({ state: "open", mergedAt: null })
  } catch (error) {
    journeyError = { error }
  }
  await endWork(founder, agent.touched, journeyError)
})
