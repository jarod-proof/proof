// @vitest-environment jsdom
import { expectNoA11yViolations } from "@proof/ui/a11y"
import { render } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import type { PullRequestView, WorkItemDetail } from "../api/schemas"
import { WORK_HEAD_SHA, workItemFixture, verifyingItemFixture } from "../test/fixtures"
import { PullRequestPanel } from "./pull-request-panel"

const REPO = "acme/web"
const SHA7 = WORK_HEAD_SHA.slice(0, 7)

const pr = (overrides: Partial<PullRequestView> = {}): PullRequestView => ({
  ...(workItemFixture().pullRequest as PullRequestView),
  number: 483,
  url: "https://github.com/acme/web/pull/483",
  branch: "factory/fac-141-missing-plan",
  additions: 18,
  deletions: 4,
  files: 3,
  headSha: WORK_HEAD_SHA,
  checks: [
    { name: "Lint", state: "passed" },
    { name: "Unit tests", state: "failed" },
    { name: "End-to-end", state: "pending" },
  ],
  ...overrides,
})
const approval = (
  overrides: Partial<NonNullable<WorkItemDetail["mergeApproval"]>> = {},
): NonNullable<WorkItemDetail["mergeApproval"]> => ({
  ...(workItemFixture().mergeApproval as NonNullable<WorkItemDetail["mergeApproval"]>),
  headSha: WORK_HEAD_SHA,
  ...overrides,
})
const reviewer = {
  verdict: "approve" as const,
  summary: "The guard is right and tested.",
  headSha: WORK_HEAD_SHA,
}

function setup(props: Partial<Parameters<typeof PullRequestPanel>[0]> = {}) {
  const onApproveMerge = vi.fn()
  const view = render(
    <PullRequestPanel
      pr={pr()}
      mergeApproval={approval()}
      canApprove
      onApproveMerge={onApproveMerge}
      pending={false}
      repo={REPO}
      reviewer={reviewer}
      {...props}
    />,
  )
  return { view, onApproveMerge, user: userEvent.setup() }
}

describe("PullRequestPanel", () => {
  it("shows PR #483, +18 −4 · 3 files, the branch, the checks, the reviewer row and the assumed-deploy line", () => {
    const { view } = setup()
    expect(view.getByRole("heading", { name: "PR #483" })).toBeTruthy()
    expect(view.getByText("+18 −4 · 3 files")).toBeTruthy()
    expect(view.getByText(/factory\/fac-141-missing-plan/)).toBeTruthy()
    const checks = view.getAllByRole("listitem").map((li) => li.textContent)
    expect(checks).toContain("Lintpassed")
    expect(checks).toContain("Unit testsfailed")
    expect(checks).toContain("End-to-endpending")
    expect(view.getByText("passed").className).toContain("text-success")
    expect(view.getByText("failed").className).toContain("text-destructive")
    expect(view.getByText("pending").className).toContain("text-faint")
    expect(view.getByText(/Reviewer/).parentElement?.textContent).toContain("approved")
    expect(view.getByText("The guard is right and tested.")).toBeTruthy()
    expect(
      view.getByText(
        "Deploy is assumed 15 minutes after the merge; no deploy source is connected.",
      ),
    ).toBeTruthy()
  })

  it("says 'No checks reported' for none and never invents a check", () => {
    const { view } = setup({ pr: pr({ checks: [] }) })
    expect(view.getByText("No checks reported")).toBeTruthy()
    expect(view.queryByText("passed")).toBeNull()
  })

  it("never shows a size hq did not report as +0", () => {
    const none = setup({ pr: pr({ additions: null, deletions: null, files: null }) })
    expect(none.view.container.textContent).not.toMatch(/\+0|−0/)
    expect(none.view.getByText("Diff size not reported")).toBeTruthy()
    none.view.unmount()
    const some = setup({ pr: pr({ additions: 7, deletions: null, files: 1 }) })
    expect(some.view.getByText("+7 · 1 file")).toBeTruthy()
  })

  it("reads 'no verdict recorded' without a reviewer and names a head the reviewer did not read", () => {
    const none = setup({ reviewer: null })
    expect(none.view.getByText(/no verdict recorded/)).toBeTruthy()
    none.view.unmount()
    const stale = setup({ reviewer: { ...reviewer, headSha: "b".repeat(40) } })
    expect(stale.view.container.textContent).toContain(
      `read head ${"b".repeat(7)}, the pull request is at ${SHA7}`,
    )
    stale.view.unmount()
    const rejected = setup({ reviewer: { ...reviewer, verdict: "request_changes" } })
    expect(rejected.view.container.textContent).toContain("asked for changes")
  })

  it("a pending merge approval shows 'Merge approval waits for a founder' and Approve merge with confirmation", async () => {
    const { view, onApproveMerge, user } = setup()
    expect(view.getByText("Merge approval waits for a founder")).toBeTruthy()
    await user.click(view.getByRole("button", { name: "Approve merge" }))
    expect(onApproveMerge).not.toHaveBeenCalled()
    // the confirmation names the first 7 characters of the head and says nothing merges
    expect(view.getByRole("group").textContent).toContain(SHA7)
    expect(view.getByRole("group").textContent).toContain("does not merge anything on GitHub")
    await user.click(view.getByRole("button", { name: "Confirm" }))
    expect(onApproveMerge).toHaveBeenCalledTimes(1)
    // the whole head sha the founder saw, never the short form
    expect(onApproveMerge).toHaveBeenCalledWith(WORK_HEAD_SHA)
  })

  it("approves the head of the approval the founder saw, not another", async () => {
    const seen = "c".repeat(40)
    const { view, onApproveMerge, user } = setup({
      mergeApproval: approval({ headSha: seen }),
      pr: pr({ headSha: seen }),
    })
    await user.click(view.getByRole("button", { name: "Approve merge" }))
    await user.click(view.getByRole("button", { name: "Confirm" }))
    expect(onApproveMerge).toHaveBeenCalledWith(seen)
  })

  it("names a draft in the confirmation", async () => {
    const { view, user } = setup({ pr: pr({ isDraft: true }) })
    expect(view.getByText("draft")).toBeTruthy()
    await user.click(view.getByRole("button", { name: "Approve merge" }))
    expect(view.getByRole("group").textContent).toContain("draft")
  })

  it("does not offer Approve merge when the head moved since the approval was requested", () => {
    const { view } = setup({ pr: pr({ headSha: "d".repeat(40) }) })
    expect(view.queryByRole("button", { name: "Approve merge" })).toBeNull()
    expect(view.container.textContent).toContain("changed since the approval was requested")
  })

  it("offers no button while canApprove is false, and explains", () => {
    const { view } = setup({ canApprove: false })
    expect(view.queryByRole("button", { name: "Approve merge" })).toBeNull()
    expect(view.getByText("Merge approval waits for a founder")).toBeTruthy()
    expect(view.container.textContent).toContain("cannot be approved from here")
  })

  it("disables Approve merge and its confirmation while a write is on its way", async () => {
    const { view } = setup({ pending: true })
    expect(
      (view.getByRole("button", { name: "Approve merge" }) as HTMLButtonElement).disabled,
    ).toBe(true)
  })

  it("after approval reads 'Approved by <founder> for <sha7>; merge it on GitHub' with the PR link, and never prints an id as a name", () => {
    const approved = approval({
      status: "approved",
      decidedBy: "user_8f3a9c01",
      decidedAt: "2026-11-17T12:05:00.000Z",
    })
    const anon = setup({ mergeApproval: approved })
    expect(anon.view.container.textContent).toContain(
      `Approved by a founder for ${SHA7}; merge it on GitHub`,
    )
    expect(anon.view.container.textContent).not.toContain("user_8f3a9c01")
    expect(anon.view.queryByRole("button", { name: "Approve merge" })).toBeNull()
    const link = anon.view.getByRole("link", { name: /pull request #483/i })
    expect(link.getAttribute("href")).toBe("https://github.com/acme/web/pull/483")
    expect(link.getAttribute("rel")).toContain("noopener")
    anon.view.unmount()
    const named = setup({ mergeApproval: approved, approvedBy: "Jarod" })
    expect(named.view.container.textContent).toContain(
      `Approved by Jarod for ${SHA7}; merge it on GitHub`,
    )
  })

  it("an approval for another head than the pull request's now does not cover it", () => {
    const { view } = setup({
      mergeApproval: approval({ status: "approved", headSha: "e".repeat(40) }),
    })
    expect(view.container.textContent).toContain(
      `Approved for ${"e".repeat(7)}, but the head is now ${SHA7}`,
    )
    expect(view.container.textContent).not.toContain("merge it on GitHub")
  })

  it("a merged pull request reads 'Merged on GitHub by <login>' whatever the approval says", () => {
    const { view } = setup({
      pr: pr({ state: "merged", mergedAt: "2026-11-17T07:59:00.000Z", mergedBy: "founder-login" }),
      mergeApproval: approval({ status: "void" }),
    })
    expect(view.getByText("Merged on GitHub by founder-login")).toBeTruthy()
    expect(view.queryByText("Merge approval waits for a founder")).toBeNull()
    expect(view.queryByRole("button", { name: "Approve merge" })).toBeNull()
  })

  it("a merged pull request with no login does not invent one", () => {
    const { view } = setup({ pr: pr({ state: "merged", mergedBy: null }), mergeApproval: null })
    expect(view.getByText("Merged on GitHub")).toBeTruthy()
    expect(view.container.textContent).not.toContain("by null")
  })

  it("a merged pull request never reads as a pending approval even when one is still pending", () => {
    const { view } = setup({
      pr: pr({ state: "merged", mergedBy: "x" }),
      mergeApproval: approval(),
    })
    expect(view.queryByRole("button", { name: "Approve merge" })).toBeNull()
    expect(view.queryByText("Merge approval waits for a founder")).toBeNull()
  })

  it("a closed pull request reads 'Closed without merging' and offers no approval", () => {
    const { view } = setup({
      pr: pr({ state: "closed" }),
      mergeApproval: approval({ status: "void" }),
    })
    expect(view.getByText("Closed without merging")).toBeTruthy()
    expect(view.queryByRole("button", { name: "Approve merge" })).toBeNull()
  })

  it("with no approval and an open pull request says none waits", () => {
    const { view } = setup({ mergeApproval: null, reviewer: null })
    expect(view.getByText("No merge approval is waiting.")).toBeTruthy()
  })

  it("renders the verifying fixture's merged pull request", () => {
    const item = verifyingItemFixture()
    const { view } = setup({
      pr: item.pullRequest as PullRequestView,
      mergeApproval: item.mergeApproval,
      reviewer: null,
    })
    expect(view.getByText("Merged on GitHub by founder-login")).toBeTruthy()
    expect(view.getByRole("heading", { name: "PR #108" })).toBeTruthy()
  })

  it("a PR url that is not https://github.com/<repo>/pull/<n> renders as text, not a link", () => {
    const urls = [
      "https://evil.example/acme/web/pull/483",
      "https://github.com.evil.example/acme/web/pull/483",
      "https://github.com/acme/web/pull/484",
      "https://github.com/other/web/pull/483",
      "http://github.com/acme/web/pull/483",
      "https://github.com/acme/web/pull/483?x=1",
      "javascript:alert(1)",
    ]
    for (const url of urls) {
      const { view } = setup({ pr: pr({ url }), mergeApproval: approval({ status: "approved" }) })
      expect(view.container.querySelector("a"), url).toBeNull()
      expect(view.container.textContent, url).toContain(url)
      view.unmount()
    }
  })

  it("the link's href is the url it built, not the string it was given", () => {
    const { view } = setup({ pr: pr({ url: "https://GitHub.com/ACME/Web/pull/483" }) })
    expect(view.getByRole("link").getAttribute("href")).toBe("https://github.com/acme/web/pull/483")
  })

  it("renders hostile branch, check names and reviewer text as plain text, bounded", () => {
    const hostile = `<img src=x onerror=alert(1)> [x](https://evil.example) ${"H".repeat(100_000)}`
    const { view } = setup({
      pr: pr({ branch: hostile, checks: [{ name: hostile, state: "passed" }] }),
      reviewer: { ...reviewer, summary: hostile },
    })
    expect(view.container.querySelector("img")).toBeNull()
    expect(view.container.querySelectorAll("a")).toHaveLength(1)
    const section = view.container.querySelector("section") as HTMLElement
    expect(section.className).toContain("min-w-0")
    expect(section.className).toContain("overflow-hidden")
    expect(view.getByRole("button", { name: /Show all/ })).toBeTruthy()
  })

  it("gives each panel its own heading id so two on a page stay distinct", () => {
    const view = render(
      <>
        <PullRequestPanel
          pr={pr()}
          mergeApproval={null}
          canApprove={false}
          onApproveMerge={vi.fn()}
          pending={false}
          repo={REPO}
          reviewer={null}
        />
        <PullRequestPanel
          pr={pr({ number: 484, url: "https://github.com/acme/web/pull/484" })}
          mergeApproval={null}
          canApprove={false}
          onApproveMerge={vi.fn()}
          pending={false}
          repo={REPO}
          reviewer={null}
        />
      </>,
    )
    const ids = [...view.container.querySelectorAll("h2")].map((h) => h.id)
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
    expect(view.getByRole("region", { name: "PR #483" })).toBeTruthy()
    expect(view.getByRole("region", { name: "PR #484" })).toBeTruthy()
  })

  it("has no inline style, every control is min-h-touch and no accessibility violations", async () => {
    const { view, user } = setup()
    await user.click(view.getByRole("button", { name: "Approve merge" }))
    expect(view.container.querySelector("[style]")).toBeNull()
    for (const control of view.container.querySelectorAll("button, a")) {
      expect(control.className).toContain("min-h-touch")
    }
    await expectNoA11yViolations(view.container.innerHTML)
  })
})
