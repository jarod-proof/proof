// @vitest-environment jsdom
import { expectNoA11yViolations } from "@proof/ui/a11y"
import { within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { HqError } from "../api/errors"
import { needsYouFixture, workBoardFixture } from "../test/fixtures"
import { renderInRouter } from "../test/render"
import { type NeedsYouActions } from "./needs-you-card"
import { WorkNeedsSection } from "./work-needs-section"

function actions(overrides: Partial<NeedsYouActions> = {}): NeedsYouActions {
  return {
    onApproveMerge: vi.fn(),
    onAnswer: vi.fn(),
    onRetry: vi.fn(),
    pending: null,
    errors: {},
    ...overrides,
  }
}

const four = () =>
  workBoardFixture({
    needsYou: [
      needsYouFixture("agent_question"),
      needsYouFixture("attempt_budget"),
      needsYouFixture("stuck_attempt"),
      needsYouFixture("merge_approval"),
    ],
  })

describe("WorkNeedsSection", () => {
  it("lists all four kinds as cards under 'From the pipeline' with the count of cards", async () => {
    const view = await renderInRouter(
      <WorkNeedsSection
        load={{ status: "ready", items: four() }}
        actions={actions()}
        notice={null}
      />,
    )
    const region = view.getByRole("region", { name: /From the pipeline/ })
    expect(within(region).getAllByRole("article")).toHaveLength(4)
    for (const label of ["merge approval", "agent question", "attempt budget", "stuck attempt"]) {
      expect(within(region).getByText(new RegExp(`· ${label}$`))).toBeTruthy()
    }
    expect(region.querySelector("h2 span")?.textContent).toBe("4")
    expect(region.querySelector("h2 span")?.className).toContain("bg-solar")
  })

  it("says 'Nothing from the pipeline needs you' with no cards and no count", async () => {
    const view = await renderInRouter(
      <WorkNeedsSection
        load={{ status: "ready", items: workBoardFixture({ needsYou: [] }) }}
        actions={actions()}
        notice={null}
      />,
    )
    expect(view.getByText("Nothing from the pipeline needs you")).toBeTruthy()
    expect(view.queryByRole("article")).toBeNull()
    expect(view.container.querySelector("h2 span")).toBeNull()
  })

  it("shows loading, and an error with Retry, inside the section only", async () => {
    const loading = await renderInRouter(
      <WorkNeedsSection load={{ status: "loading" }} actions={actions()} notice={null} />,
    )
    expect(loading.getByText("Loading the pipeline")).toBeTruthy()
    loading.unmount()
    const onRetry = vi.fn()
    const failed = await renderInRouter(
      <WorkNeedsSection
        load={{
          status: "error",
          error: new HqError({ kind: "server", status: 500, message: "boom" }),
          onRetry,
        }}
        actions={actions()}
        notice={null}
      />,
    )
    const region = failed.getByRole("region", { name: /From the pipeline/ })
    expect(within(region).getByRole("alert")).toBeTruthy()
    within(region).getByRole("button", { name: "Retry" }).click()
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it("shows the last action as a status line and no a11y violations", async () => {
    const view = await renderInRouter(
      <WorkNeedsSection
        load={{ status: "ready", items: four() }}
        actions={actions()}
        notice="Merge approved for FAC-6 at aaaaaaa. Nothing was merged: merge it on GitHub."
      />,
    )
    expect(view.getByRole("status", { name: "Last action" }).textContent).toContain(
      "Nothing was merged: merge it on GitHub.",
    )
    expect(view.container.querySelector("[style]")).toBeNull()
    await expectNoA11yViolations(view.container.innerHTML)
  })
})
