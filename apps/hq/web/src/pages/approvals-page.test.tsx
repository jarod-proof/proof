// @vitest-environment jsdom
import { expectNoA11yViolations } from "@proof/ui/a11y"
import { render, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { HqError } from "../api/errors"
import type { Proposal } from "../api/schemas"
import { proposalFixture } from "../test/fixtures"
import { ApprovalsPage, type ApprovalsPageProps } from "./approvals-page"

const ready = (items: Proposal[]) => ({ status: "ready", items }) as const

function page(overrides: Partial<ApprovalsPageProps> = {}) {
  const props: ApprovalsPageProps = {
    pending: ready([]),
    decided: ready([]),
    renderPending: (proposal) => <p>card {proposal.title}</p>,
    notices: {},
    onDismissNotice: vi.fn(),
    hasMore: false,
    loadingMore: false,
    onLoadMore: vi.fn(),
    ...overrides,
  }
  return { props, ...render(<ApprovalsPage {...props} />), user: userEvent.setup() }
}

describe("ApprovalsPage", () => {
  it("names the screen and has a 'Needs you' section with an amber count", () => {
    const view = page({
      pending: ready([
        proposalFixture({ id: "a", title: "A" }),
        proposalFixture({ id: "b", title: "B" }),
      ]),
    })
    expect(view.getByRole("heading", { level: 1, name: "Approvals" })).toBeTruthy()
    const needs = view.getByRole("region", { name: /Needs you/ })
    expect(within(needs).getByText("2").className).toContain("bg-solar")
    expect(within(needs).getAllByRole("listitem")).toHaveLength(2)
  })

  it("shows the count as 'N+' while a next page exists, so it never undercounts", () => {
    const view = page({ pending: ready([proposalFixture()]), hasMore: true })
    expect(within(view.getByRole("region", { name: /Needs you/ })).getByText("1+")).toBeTruthy()
  })

  it("says 'Nothing needs you' with no pending proposals", () => {
    const view = page()
    expect(view.getByText("Nothing needs you")).toBeTruthy()
  })

  it("shows a loading block per section while its list loads", () => {
    const view = page({ pending: { status: "loading" }, decided: { status: "loading" } })
    expect(view.getByText("Loading proposals")).toBeTruthy()
    expect(view.getByText("Loading decided proposals")).toBeTruthy()
  })

  it("shows the ErrorBlock with Retry when a list failed, and the other list still renders", async () => {
    const onRetry = vi.fn()
    const view = page({
      pending: {
        status: "error",
        error: new HqError({ kind: "server", status: 500, message: "boom" }),
        onRetry,
      },
      decided: ready([proposalFixture({ id: "d", status: "approved", title: "Done one" })]),
    })
    expect(view.getByRole("alert").textContent).toContain("hq had a problem")
    await view.user.click(view.getByRole("button", { name: "Retry" }))
    expect(onRetry).toHaveBeenCalledOnce()
    expect(view.getByText("Done one")).toBeTruthy()
  })

  it("Load more shows only with a next page, and is disabled while it loads", async () => {
    const none = page()
    expect(none.queryByRole("button", { name: "Load more" })).toBeNull()
    none.unmount()

    const more = page({ pending: ready([proposalFixture()]), hasMore: true })
    await more.user.click(more.getByRole("button", { name: "Load more" }))
    expect(more.props.onLoadMore).toHaveBeenCalledOnce()
    more.unmount()

    const busy = page({ pending: ready([proposalFixture()]), hasMore: true, loadingMore: true })
    expect((busy.getByRole("button", { name: "Load more" }) as HTMLButtonElement).disabled).toBe(
      true,
    )
  })

  it("Recently decided lists the decision, a History anchor for approved ones only", () => {
    const view = page({
      decided: ready([
        proposalFixture({
          id: "ok",
          status: "approved",
          title: "Approved one",
          entryId: "entry/1",
          decidedAt: "2026-11-17T12:30:00.000Z",
        }),
        proposalFixture({ id: "no", status: "rejected", title: "Rejected one", entryId: null }),
        proposalFixture({
          id: "noentry",
          status: "approved",
          title: "Approved without entry",
          entryId: null,
        }),
      ]),
    })
    const decided = view.getByRole("region", { name: /Recently decided/ })
    const rows = within(decided).getAllByRole("listitem")
    expect(rows).toHaveLength(3)
    expect(within(rows[0] as HTMLElement).getByText("Approved")).toBeTruthy()
    const history = within(rows[0] as HTMLElement).getByRole("link", { name: /History/ })
    expect(history.getAttribute("href")).toBe("/admin/entries/entry%2F1")
    expect(within(rows[1] as HTMLElement).getByText("Rejected")).toBeTruthy()
    expect(within(rows[1] as HTMLElement).queryByRole("link")).toBeNull()
    expect(within(rows[2] as HTMLElement).queryByRole("link")).toBeNull()
  })

  it("renders a decided title as text only", () => {
    const view = page({
      decided: ready([
        proposalFixture({
          status: "approved",
          title: '<img src=x onerror="1"> **hi**',
          entryId: "e",
        }),
      ]),
    })
    const decided = view.getByRole("region", { name: /Recently decided/ })
    expect(decided.querySelector("img, strong, script")).toBeNull()
    expect(decided.textContent).toContain('<img src=x onerror="1"> **hi**')
  })

  it("never clamps a decided title (no toggle there to reveal it)", () => {
    const view = page({
      decided: ready([
        proposalFixture({ status: "approved", title: "T".repeat(200), entryId: "e" }),
      ]),
    })
    expect(view.container.querySelector("[class*='line-clamp']")).toBeNull()
  })

  it("shows a notice beside the decided proposal it is about", () => {
    const view = page({
      decided: ready([proposalFixture({ id: "p9", status: "rejected", title: "Gone" })]),
      notices: {
        p9: {
          title: "Gone",
          message: "Already decided. Refresh to see the result.",
          tone: "error",
        },
      },
    })
    expect(view.getByRole("alert").textContent).toBe("Already decided. Refresh to see the result.")
  })

  it("a notice with no card and no decided row shows at the top of Needs you, until dismissed", async () => {
    const view = page({
      pending: ready([proposalFixture({ id: "other", title: "Other" })]),
      decided: ready([]),
      notices: {
        gone: {
          title: '<img src=x onerror="1"> Gone',
          message: "Already decided. Refresh to see the result.",
          tone: "error",
        },
        ok: { title: "Fine", message: "Approved.", tone: "done" },
        other: { title: "Other", message: "Founders only.", tone: "error" },
      },
    })
    const needs = view.getByRole("region", { name: /Needs you/ })
    const alert = within(needs).getByRole("alert")
    expect(alert.textContent).toContain('<img src=x onerror="1"> Gone: Already decided.')
    expect(alert.querySelector("img")).toBeNull()
    expect(within(needs).getByRole("status").textContent).toContain("Fine: Approved.")
    // The one whose card is still on screen is not repeated here.
    expect(needs.textContent).not.toContain("Founders only.")
    await view.user.click(within(alert).getByRole("button", { name: "Dismiss" }))
    expect(view.props.onDismissNotice).toHaveBeenCalledExactlyOnceWith("gone")
  })

  it("a notice shows at the top while the decided list is loading or failed", () => {
    const view = page({
      decided: { status: "loading" },
      notices: { gone: { title: "Gone", message: "Rejected.", tone: "done" } },
    })
    const needs = view.getByRole("region", { name: /Needs you/ })
    expect(within(needs).getByRole("status").textContent).toContain("Gone: Rejected.")
  })

  it("an empty decided list says nothing has been decided", () => {
    expect(page().getByText("Nothing decided yet")).toBeTruthy()
  })

  it("builds no Pause all agents, autonomy level, or grant control", () => {
    const view = page({ pending: ready([proposalFixture()]) })
    expect(view.container.textContent).not.toMatch(/pause all|autonomy|auto-merge|grant/i)
  })

  it("renders no inline style and has no a11y violations", async () => {
    const view = page({
      pending: ready([proposalFixture()]),
      decided: ready([proposalFixture({ id: "d", status: "approved", entryId: "e" })]),
      hasMore: true,
    })
    expect(view.container.querySelector("[style]")).toBeNull()
    await expectNoA11yViolations(view.container.innerHTML)
  })
})
