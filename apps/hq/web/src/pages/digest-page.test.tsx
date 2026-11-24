// @vitest-environment jsdom
import { expectNoA11yViolations } from "@proof/ui/a11y"
import { describe, expect, it, vi } from "vitest"

import type { Digest } from "../api/schemas"
import { digestFixture, factoryStatusFixture } from "../test/fixtures"
import { renderInRouter } from "../test/render"
import { DigestPage } from "./digest-page"

const allowance = factoryStatusFixture().allowance

async function show(
  digest: Digest = digestFixture(),
  props: { readMarked?: boolean; onMarkRead?: () => void; cap?: typeof allowance | null } = {},
) {
  return renderInRouter(
    <DigestPage
      digest={digest}
      allowance={props.cap === undefined ? allowance : props.cap}
      readMarked={props.readMarked ?? false}
      onMarkRead={props.onMarkRead ?? (() => {})}
    />,
  )
}

const pending = (n: number): Digest["decisions"] =>
  Array.from({ length: n }, (_, i) => ({
    proposalId: `proposal-${i + 1}`,
    entryKind: "fact" as const,
    title: `Proposal title ${i + 1}`,
    reason: `Reason ${i + 1}`,
    createdAt: "2026-11-17T09:00:00.000Z",
  }))

describe("DigestPage", () => {
  it("renders the quiet banner with counts from get_digest", async () => {
    const view = await show(
      digestFixture({
        summary: { tone: "quiet", runsFinished: 3, runsFailed: 0, pendingProposals: 2 },
      }),
    )
    const banner = view.getByRole("status", { name: "Digest summary" })
    expect(banner.textContent).toBe(
      "Quiet since Nov 16, 00:00 UTC. 3 runs finished, 0 failed, 2 need a decision.",
    )
    expect(banner.className).toContain("bg-ok-surface")
    expect(banner.className).toContain("border-ok-border")
    expect(view.getByRole("heading", { name: "Digest" })).toBeTruthy()
    expect(view.getByText("since Nov 16, 00:00 UTC · 36 h")).toBeTruthy()
  })

  it("an attention banner when a run failed or is stuck", async () => {
    const failed = await show(
      digestFixture({
        summary: { tone: "attention", runsFinished: 4, runsFailed: 1, pendingProposals: 1 },
      }),
    )
    const banner = failed.getByRole("status", { name: "Digest summary" })
    expect(banner.textContent).toContain("4 runs finished, 1 failed, 1 needs a decision")
    expect(banner.textContent).not.toMatch(/^Quiet/)
    expect(banner.className).toContain("bg-attention-surface")
    expect(banner.className).toContain("border-attention-border")
    failed.unmount()

    const stuck = await show(
      digestFixture({
        summary: { tone: "attention", runsFinished: 0, runsFailed: 0, pendingProposals: 0 },
        health: { stuckRuns: 2, lastRunStartedAt: null },
      }),
    )
    expect(stuck.getByRole("status", { name: "Digest summary" }).textContent).toContain("2 stuck")
  })

  it("product health shows the three mock labels, each Not connected, and no number", async () => {
    const view = await show()
    const section = view.getByRole("region", { name: "Product health" })
    for (const label of ["Errors per hour", "Checkout completion", "People struggling"]) {
      expect(section.textContent).toContain(label)
    }
    expect(section.textContent?.match(/Not connected/g)).toHaveLength(3)
    expect(section.textContent).toContain("Sentry")
    expect(section.textContent).toContain("PostHog")
    expect(section.textContent).not.toMatch(/\d/)
  })

  it("production changes is Not connected", async () => {
    const view = await show()
    const section = view.getByRole("region", { name: "What changed in production" })
    expect(section.textContent).toContain("Not connected")
    expect(section.textContent).not.toMatch(/\d/)
  })

  it("Needs a decision shows up to 5 with Decide linking to /app/approvals and 'See all 9 in Approvals'", async () => {
    const view = await show(
      digestFixture({
        summary: { tone: "quiet", runsFinished: 0, runsFailed: 0, pendingProposals: 9 },
        decisions: pending(5),
      }),
    )
    const section = view.getByRole("region", { name: /Needs a decision/ })
    expect(section.textContent).toContain("proposal-1 · proposal · fact")
    expect(section.textContent).toContain("Proposal title 3")
    expect(section.textContent).toContain("Why: Reason 5")
    const decide = view.getAllByRole("link", { name: /^Decide/ })
    expect(decide).toHaveLength(5)
    expect(decide[0]?.getAttribute("href")).toBe("/app/approvals")
    expect(view.getByRole("link", { name: "See all 9 in Approvals" }).getAttribute("href")).toBe(
      "/app/approvals",
    )
  })

  it("Needs a decision says so when nothing is pending", async () => {
    const view = await show(
      digestFixture({
        summary: { tone: "quiet", runsFinished: 0, runsFailed: 0, pendingProposals: 0 },
        decisions: [],
      }),
    )
    expect(view.getByText("Nothing needs a decision")).toBeTruthy()
    expect(view.queryByRole("link", { name: /See all/ })).toBeNull()
  })

  it("What the factory did lists events newest first with the outcome text", async () => {
    const view = await show(
      digestFixture({
        events: [
          {
            at: "2026-11-17T08:30:00.000Z",
            kind: "run",
            ref: "run-1",
            text: "Older run",
            result: "succeeded",
            costUsd: 0.4,
          },
          {
            at: "2026-11-17T10:15:00.000Z",
            kind: "run",
            ref: "run-2",
            text: "Newer run",
            result: "failed",
            costUsd: 1.25,
          },
          {
            at: "2026-11-17T11:00:00.000Z",
            kind: "proposal",
            ref: "proposal-1",
            text: "Pricing",
            result: "proposed",
            costUsd: null,
          },
        ],
      }),
    )
    const section = view.getByRole("region", { name: "What the factory did" })
    const items = section.querySelectorAll("li")
    expect(items).toHaveLength(3)
    expect(items[0]?.textContent).toContain("Pricing")
    expect(items[0]?.textContent).toContain("proposed")
    expect(items[1]?.textContent).toContain("Newer run")
    expect(items[1]?.textContent).toContain("failed")
    expect(items[1]?.textContent).toContain("$1.25")
    expect(items[1]?.textContent).toContain("Nov 17, 10:15 UTC")
    expect(items[2]?.textContent).toContain("Older run")
    expect(items[2]?.textContent).toContain("$0.40")
    // A proposal has no cost to show.
    expect(items[0]?.textContent).not.toContain("$")
  })

  it("an open run's cost reads as spend recorded so far, never as a final cost", async () => {
    const view = await show(
      digestFixture({
        events: [
          {
            at: "2026-11-17T08:30:00.000Z",
            kind: "run",
            ref: "run-1",
            text: "Review on the box",
            result: "started",
            costUsd: 0,
          },
        ],
      }),
    )
    const item = view.getByRole("region", { name: "What the factory did" }).querySelector("li")
    expect(item?.textContent).toContain("started")
    expect(item?.textContent).toContain("spend recorded so far $0.00")
    expect(item?.textContent).not.toMatch(/online|busy|stuck|running/i)
  })

  it("renders a run's text as text, never as markup", async () => {
    const view = await show(
      digestFixture({
        events: [
          {
            at: "2026-11-17T08:30:00.000Z",
            kind: "run",
            ref: "run-1",
            text: '<img src=x onerror="alert(1)"> **bold**',
            result: "succeeded",
            costUsd: 0.1,
          },
        ],
      }),
    )
    expect(view.container.querySelector("img")).toBeNull()
    expect(view.getByText('<img src=x onerror="alert(1)"> **bold**')).toBeTruthy()
  })

  it("Factory health shows Not reported for runner and heartbeat, the stuck count, and the window spend with its estimated part", async () => {
    const view = await show(
      digestFixture({
        health: { stuckRuns: 1, lastRunStartedAt: "2026-11-17T08:00:00.000Z" },
        spend: {
          totalUsd: 5.5,
          estimatedUsd: 0.5,
          bySource: [
            { source: "eve", amountUsd: 3.8 },
            { source: "build", amountUsd: 1.7 },
          ],
        },
      }),
    )
    const section = view.getByRole("region", { name: "Factory health" })
    const fact = (name: string) =>
      Array.from(section.querySelectorAll("dt")).find((dt) => dt.textContent === name)
        ?.nextElementSibling?.textContent
    expect(fact("Runner")).toBe("Not reported")
    expect(fact("Last heartbeat")).toBe("Not reported")
    expect(fact("Stuck runs")).toContain("1")
    expect(fact("Eve spend cap")).toBe("62% left")
    expect(fact("Last run started")).toBe("Nov 17, 08:00 UTC")
    expect(fact("Spend in this window")).toBe(
      "$5.50 (eve $3.80, build $1.70), $0.50 of it estimated",
    )
    expect(section.textContent?.toLowerCase()).not.toContain("online")
  })

  it("Factory health leaves out 'of it estimated' when nothing is estimated and says no runs yet", async () => {
    const view = await show(
      digestFixture({
        health: { stuckRuns: 0, lastRunStartedAt: null },
        spend: { totalUsd: 0, estimatedUsd: 0, bySource: [] },
      }),
    )
    const section = view.getByRole("region", { name: "Factory health" })
    expect(section.textContent).toContain("$0.00")
    expect(section.textContent).not.toContain("estimated")
    expect(section.textContent).toContain("No runs yet")
  })

  it("the Eve spend cap line says unavailable when the allowance is not there", async () => {
    const view = await show(digestFixture(), { cap: null })
    expect(view.getByRole("region", { name: "Factory health" }).textContent).toContain(
      "Unavailable",
    )
  })

  it("an empty window shows 'Nothing ran in this window'", async () => {
    const view = await show(digestFixture({ events: [] }))
    expect(view.getByText("Nothing ran in this window")).toBeTruthy()
  })

  it("Mark as read calls back once, and reads as done when marked", async () => {
    const onMarkRead = vi.fn()
    const view = await show(digestFixture(), { onMarkRead })
    const button = view.getByRole("button", { name: "Mark as read" })
    button.click()
    expect(onMarkRead).toHaveBeenCalledTimes(1)
    view.unmount()

    const done = await show(digestFixture(), { readMarked: true })
    const marked = done.getByRole("button", { name: "Marked as read" }) as HTMLButtonElement
    expect(marked.disabled).toBe(true)
  })

  it("every link and button is at least 44 px (class min-h-touch)", async () => {
    const view = await show(
      digestFixture({
        summary: { tone: "quiet", runsFinished: 0, runsFailed: 0, pendingProposals: 2 },
        decisions: pending(2),
      }),
    )
    const controls = Array.from(view.container.querySelectorAll("a, button"))
    // Mark as read, two Decide links, See all.
    expect(controls).toHaveLength(4)
    for (const control of controls) {
      expect(control.className, control.textContent ?? "").toContain("min-h-touch")
    }
  })

  it("renders a proposal's title and reason as text, never as markup", async () => {
    const hostile = {
      proposalId: "proposal-x",
      entryKind: "fact" as const,
      title: '<img src=x onerror="alert(1)"> [click](https://evil.example)',
      reason: "<script>alert(1)</script> **not bold** [link](https://evil.example)",
      createdAt: "2026-11-17T09:00:00.000Z",
    }
    const view = await show(
      digestFixture({
        summary: { tone: "quiet", runsFinished: 0, runsFailed: 0, pendingProposals: 1 },
        decisions: [hostile],
      }),
    )
    expect(view.container.querySelector("img, script")).toBeNull()
    expect(view.container.querySelector("a[href^='https://evil']")).toBeNull()
    expect(view.getByText(hostile.title)).toBeTruthy()
    expect(view.getByText(`Why: ${hostile.reason}`)).toBeTruthy()
  })

  it("has no inline style", async () => {
    const view = await show(
      digestFixture({ decisions: pending(2), summary: digestFixture().summary }),
    )
    expect(view.container.querySelectorAll("[style]")).toHaveLength(0)
  })

  it("has no accessibility violations", async () => {
    const view = await show(digestFixture({ decisions: pending(2) }))
    await expectNoA11yViolations(view.container.innerHTML)
  })
})
