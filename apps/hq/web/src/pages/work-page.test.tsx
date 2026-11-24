// @vitest-environment jsdom
import { expectNoA11yViolations } from "@proof/ui/a11y"
import { within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { HqError } from "../api/errors"
import { workBoardFixture, workSummaryFixture } from "../test/fixtures"
import { renderInRouter } from "../test/render"
import { WorkPage, type WorkPageProps } from "./work-page"

function props(overrides: Partial<WorkPageProps> = {}): WorkPageProps {
  return {
    board: workBoardFixture(),
    query: "",
    onQuery: vi.fn(),
    results: null,
    onCreate: vi.fn(),
    creating: false,
    createError: null,
    created: null,
    notice: null,
    actions: {
      onApproveMerge: vi.fn(),
      onAnswer: vi.fn(),
      onRetry: vi.fn(),
      pending: null,
      errors: {},
    },
    ...overrides,
  }
}

describe("WorkPage", () => {
  it("renders hq's board as it is: header, stats, needs you and five columns", async () => {
    const view = await renderInRouter(<WorkPage {...props()} />)
    expect(view.getByRole("heading", { level: 1, name: "Work" })).toBeTruthy()
    expect(view.getByText("acme/web · 5 in flight")).toBeTruthy()
    expect(view.getByRole("region", { name: /Needs you/ })).toBeTruthy()
    expect(within(view.getByRole("region", { name: "Board" })).getAllByRole("region")).toHaveLength(
      5,
    )
  })

  it("joins several repos with a middle dot", async () => {
    const view = await renderInRouter(
      <WorkPage {...props({ board: workBoardFixture({ repos: ["acme/web", "acme/api"] }) })} />,
    )
    expect(view.getByText("acme/web · acme/api · 5 in flight")).toBeTruthy()
  })

  it("the pill says Autopilot off with its explanation", async () => {
    const view = await renderInRouter(<WorkPage {...props()} />)
    const pill = view.getByText("Autopilot off")
    expect(pill.closest("[title]")?.getAttribute("title")).toBe(
      "Agents start work only when a founder asks. Policy arrives in Phase 5.",
    )
  })

  it("a needs-you card finds its repo from the card in a column, else from the board's repos", async () => {
    const base = workBoardFixture({ repos: ["acme/web", "other/repo"] })
    // The in-review card is in the column: its repo (acme/web) decides, not the board's other repo.
    const view = await renderInRouter(<WorkPage {...props({ board: base })} />)
    expect(view.getByRole("link", { name: "Review diff" })).toBeTruthy()
    view.unmount()
    // Past the cap of 30 the card is not in the column: the board's repos decide.
    const capped = workBoardFixture({
      columns: base.columns.map((c) =>
        c.key === "in_review" ? { ...c, count: 40, items: [] } : c,
      ),
    })
    const again = await renderInRouter(<WorkPage {...props({ board: capped })} />)
    expect(again.getByRole("link", { name: "Review diff" })).toBeTruthy()
  })

  it("a review card whose column card names another repo gets no Review diff link", async () => {
    const base = workBoardFixture()
    const board = workBoardFixture({
      columns: base.columns.map((c) =>
        c.key === "in_review"
          ? { ...c, items: c.items.map((i) => ({ ...i, repo: "someone/else" })) }
          : c,
      ),
    })
    const view = await renderInRouter(<WorkPage {...props({ board })} />)
    expect(view.queryByRole("link", { name: "Review diff" })).toBeNull()
  })

  it("search results replace the board; loading and error come with their own state", async () => {
    const results = [workSummaryFixture()]
    const view = await renderInRouter(<WorkPage {...props({ query: "cart", results })} />)
    const region = view.getByRole("region", { name: "Search results" })
    expect(within(region).getByText("Empty cart crashes the checkout")).toBeTruthy()
    expect(view.queryByRole("region", { name: "Board" })).toBeNull()
    view.unmount()

    const loading = await renderInRouter(
      <WorkPage {...props({ query: "cart", searchLoad: { status: "loading" } })} />,
    )
    expect(loading.getByText("Loading search results")).toBeTruthy()
    loading.unmount()

    const onRetry = vi.fn()
    const failed = await renderInRouter(
      <WorkPage
        {...props({
          query: "cart",
          searchLoad: {
            status: "error",
            error: new HqError({ kind: "server", status: 500, message: "x" }),
            onRetry,
          },
        })}
      />,
    )
    await userEvent.setup().click(failed.getByRole("button", { name: "Retry" }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it("says when more items match than are shown", async () => {
    const view = await renderInRouter(
      <WorkPage
        {...props({ query: "cart", results: [workSummaryFixture()], resultsTruncated: true })}
      />,
    )
    expect(view.getByText(/narrow the search/i)).toBeTruthy()
  })

  it("typing in the search calls onQuery with the text", async () => {
    const onQuery = vi.fn()
    const view = await renderInRouter(<WorkPage {...props({ onQuery })} />)
    await userEvent.setup().type(view.getByRole("searchbox", { name: "Search work items" }), "ab")
    expect(onQuery).toHaveBeenLastCalledWith("b")
    expect(onQuery).toHaveBeenCalledTimes(2)
  })

  it("passes a clean form to onCreate and trims the title", async () => {
    const onCreate = vi.fn()
    const view = await renderInRouter(<WorkPage {...props({ onCreate })} />)
    const user = userEvent.setup()
    await user.click(view.getByRole("button", { name: "New item" }))
    await user.type(view.getByLabelText("Title"), "  Fix it ")
    await user.click(view.getByRole("button", { name: "Create item" }))
    expect(onCreate).toHaveBeenCalledWith({ title: "Fix it", repo: "acme/web" })
  })

  it("renders no inline style and no a11y violation with the form open", async () => {
    const view = await renderInRouter(<WorkPage {...props()} />)
    await userEvent.setup().click(view.getByRole("button", { name: "New item" }))
    expect(view.container.querySelector("[style]")).toBeNull()
    await expectNoA11yViolations(view.container.innerHTML)
  })
})
