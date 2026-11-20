// @vitest-environment jsdom
import { expectNoA11yViolations } from "@proof/ui/a11y"
import { fireEvent, render, screen, within } from "@testing-library/react"
import { beforeAll, describe, expect, it, vi } from "vitest"

import type { RunSummary } from "../lib/runs-api"
import { OrgHomePage, type OrgHomePageProps } from "./org-home-page"

function run(id: string, overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    id,
    agentId: "agent-1",
    title: `Run ${id}`,
    status: "done",
    summary: null,
    startedBy: null,
    createdAt: "2026-10-16T10:00:00.000Z",
    startedAt: "2026-10-16T10:00:00.000Z",
    finishedAt: "2026-10-16T10:05:00.000Z",
    deferredUntil: null,
    durationMs: 300000,
    footprint: { energyWh: 0.4, tokens: 18000, toolCalls: 7 },
    ...overrides,
  }
}

function props(overrides: Partial<OrgHomePageProps> = {}): OrgHomePageProps {
  return {
    organization: { name: "Analytical Ltd", slug: "analytical" },
    filter: "all",
    needsYou: [],
    runs: [run("r1")],
    status: "ready",
    errorMessage: null,
    onRetry: vi.fn(),
    hasNextPage: false,
    loadingMore: false,
    onLoadMore: vi.fn(),
    ...overrides,
  }
}

describe("OrgHomePage", () => {
  // jsdom has no layout: give the virtualizer a 640px scroll box so rows are measured.
  beforeAll(() => {
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 640 })
    Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        width: 800,
        height: 640,
        top: 0,
        left: 0,
        bottom: 640,
        right: 800,
        x: 0,
        y: 0,
        toJSON() {},
      }),
    })
  })

  it("shows the organization and each run as a link to its view", async () => {
    render(<OrgHomePage {...props()} />)
    expect(screen.getByRole("heading", { name: "Analytical Ltd" })).toBeTruthy()
    expect(screen.getByRole("link", { name: /Run r1/ }).getAttribute("href")).toBe(
      "/analytical/runs/r1",
    )
    await expectNoA11yViolations(document.body.innerHTML)
  })

  it("puts the runs that need a person first, in their own section", () => {
    render(
      <OrgHomePage
        {...props({
          needsYou: [run("n1", { status: "needs_you", title: "Post summary" })],
          runs: [run("r1")],
        })}
      />,
    )
    const section = screen.getByRole("region", { name: "Needs you" })
    expect(within(section).getByRole("link", { name: /Post summary/ })).toBeTruthy()
    expect(within(section).getByRole("heading", { name: "Needs you" })).toBeTruthy()
  })

  it("shows each status filter as a tab linking to it, with the selected one current", () => {
    render(<OrgHomePage {...props({ filter: "needs_you", needsYou: [] })} />)
    const tabs = within(screen.getByRole("navigation", { name: "Filter runs by status" }))
    expect(tabs.getByRole("link", { name: "Needs you" }).getAttribute("aria-current")).toBe("page")
    expect(tabs.getByRole("link", { name: "All" }).getAttribute("href")).toBe("/analytical")
    expect(tabs.getByRole("link", { name: "Failed" }).getAttribute("href")).toBe(
      "/analytical?status=failed",
    )
  })

  it("says so when there are no runs, and words the empty filter", () => {
    const { unmount } = render(<OrgHomePage {...props({ runs: [], needsYou: [] })} />)
    expect(screen.getByText(/No runs yet/)).toBeTruthy()
    unmount()
    render(<OrgHomePage {...props({ runs: [], needsYou: [], filter: "failed" })} />)
    expect(screen.getByText("No failed runs.")).toBeTruthy()
  })

  it("shows the error with a retry", () => {
    const onRetry = vi.fn()
    render(<OrgHomePage {...props({ status: "error", errorMessage: "Offline", onRetry })} />)
    expect(screen.getByRole("alert").textContent).toContain("Offline")
    fireEvent.click(screen.getByRole("button", { name: "Try again" }))
    expect(onRetry).toHaveBeenCalled()
  })

  it("loads the next page from the button when more runs exist", () => {
    const onLoadMore = vi.fn()
    render(<OrgHomePage {...props({ hasNextPage: true, onLoadMore })} />)
    fireEvent.click(screen.getByRole("button", { name: "Load more runs" }))
    expect(onLoadMore).toHaveBeenCalled()
  })

  it("renders a long list virtualized, not every row at once", () => {
    const many = Array.from({ length: 500 }, (_, i) => run(`r${i}`))
    render(<OrgHomePage {...props({ runs: many })} />)
    const rows = screen.getAllByRole("link", { name: /Run r/ })
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.length).toBeLessThan(100)
  })
})

describe("OrgHomePage landmark", () => {
  it("leaves the landmark to the app shell rather than nesting a main", () => {
    render(<OrgHomePage {...props()} />)
    expect(document.querySelector("main")).toBeNull()
  })
})

describe("OrgHomePage What's new card (whats-new-card flag)", () => {
  it("is hidden while the flag is off", () => {
    render(<OrgHomePage {...props()} />)
    expect(screen.queryByRole("heading", { name: "What's new" })).toBeNull()
  })

  it("shows above the runs when the flag is on", async () => {
    render(<OrgHomePage {...props({ whatsNew: true })} />)
    expect(screen.getByRole("region", { name: "What's new" })).toBeTruthy()
    await expectNoA11yViolations(document.body.innerHTML)
  })
})
