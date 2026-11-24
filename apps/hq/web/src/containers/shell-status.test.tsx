// @vitest-environment jsdom
import { expectNoA11yViolations } from "@proof/ui/a11y"
import { act, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createQueryClient } from "../api/query-client"
import { hqKeys } from "../api/query-keys"
import { createFakeHq, FakeHqError, fakeViolations, urlOf } from "../test/fake-hq"
import { factoryStatusFixture, proposalFixture } from "../test/fixtures"
import { renderApp } from "../test/render"

type App = Awaited<ReturnType<typeof renderApp>>
// The Digest screen has its own links to Approvals: the sidebar's is the one inside the nav.
function navApprovals(app: App): HTMLElement {
  return within(app.getByRole("navigation", { name: "Primary" })).getByRole("link", {
    name: /Approvals/,
  })
}

const statusCalls = (hq: ReturnType<typeof createFakeHq>) =>
  hq.sent.filter((s) => s.path === "/v1/factory/status")

describe("ShellStatus: the live sidebar", () => {
  afterEach(() => {
    vi.useRealTimers()
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true })
  })

  it("the sidebar badge shows the pending count from get_factory_status and drops to none at 0", async () => {
    const hq = createFakeHq({ factoryStatus: factoryStatusFixture({ pendingProposals: 3 }) })
    const app = await renderApp({ path: "/app/digest", hq })
    await app.findByRole("navigation", { name: "Primary" })
    const link = navApprovals(app)
    expect(
      await within(await app.findByRole("navigation", { name: "Primary" })).findByText("3"),
    ).toBeTruthy()
    expect(link.textContent).toContain("3")
    // The live sidebar with its ready runner card (axe leaves the document empty: markup first).
    await app.findByRole("progressbar", { name: "Eve spend cap left" })
    const liveSidebar = app.container.innerHTML

    hq.state.factoryStatus = factoryStatusFixture({ pendingProposals: 0 })
    await act(() => app.queryClient.invalidateQueries({ queryKey: hqKeys.factoryStatus() }))
    await vi.waitFor(() => {
      expect(navApprovals(app).textContent).toBe("Approvals")
    })
    await expectNoA11yViolations(liveSidebar)
  })

  it("approving a proposal elsewhere refreshes the badge on invalidate", async () => {
    const hq = createFakeHq({
      proposals: [proposalFixture({ id: "proposal-1" })],
      factoryStatus: factoryStatusFixture({ pendingProposals: 1 }),
    })
    const app = await renderApp({ path: "/app/digest", hq })
    await within(await app.findByRole("navigation", { name: "Primary" })).findByText("1")
    // The decision goes through the app's own client, as the Approvals screen will send it.
    await app.router.options.context.client.decideProposal({
      proposalId: "proposal-1",
      decision: "approve",
    })
    // Not refreshed until something invalidates it.
    expect(navApprovals(app).textContent).toContain("1")
    await act(() => app.queryClient.invalidateQueries({ queryKey: hqKeys.factoryStatus() }))
    await vi.waitFor(() => {
      expect(navApprovals(app).textContent).toBe("Approvals")
    })
  })

  it("a failed status call leaves the nav usable and the runner card in its error state", async () => {
    const hq = createFakeHq()
    const real = hq.fetch
    hq.fetch = (input, init) =>
      urlOf(input).endsWith("/v1/factory/status")
        ? Promise.resolve(
            new Response('{"error":{"code":"INTERNAL","message":"boom"}}', {
              status: 500,
              headers: { "content-type": "application/json" },
            }),
          )
        : real(input, init)
    const queryClient = createQueryClient()
    queryClient.setDefaultOptions({ queries: { retry: false } })
    const app = await renderApp({ path: "/app/digest", hq, queryClient })
    expect(await app.findByText("Runner status unavailable")).toBeTruthy()
    const failedSidebar = app.container.innerHTML
    expect(app.getByRole("navigation", { name: "Primary" })).toBeTruthy()
    await app.user.click(navApprovals(app))
    expect(await app.findByRole("heading", { name: "Approvals" })).toBeTruthy()
    expect(app.router.history.location.pathname).toBe("/app/approvals")
    await expectNoA11yViolations(failedSidebar)
  })

  it("polls every 30 s while the tab is visible and not while it is hidden", async () => {
    // Only the interval is faked: the query's refetch interval is a setInterval.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
    const hq = createFakeHq()
    await renderApp({ path: "/app/digest", hq })
    await vi.waitFor(() => expect(statusCalls(hq)).toHaveLength(1))

    await act(() => vi.advanceTimersByTimeAsync(29_000))
    expect(statusCalls(hq)).toHaveLength(1)
    await act(() => vi.advanceTimersByTimeAsync(1_000))
    await vi.waitFor(() => expect(statusCalls(hq)).toHaveLength(2))

    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true })
    await act(() => vi.advanceTimersByTimeAsync(90_000))
    expect(statusCalls(hq)).toHaveLength(2)

    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true })
    await act(() => vi.advanceTimersByTimeAsync(30_000))
    await vi.waitFor(() => expect(statusCalls(hq)).toHaveLength(3))
  })
})

describe("the fake refuses a fixture hq would never send", () => {
  it("throws from createFakeHq, and a state changed later fails the test by name, not as unreachable", async () => {
    const bad = { ...factoryStatusFixture(), extra: 1 } as ReturnType<typeof factoryStatusFixture>
    expect(() => createFakeHq({ factoryStatus: bad })).toThrow(FakeHqError)

    const hq = createFakeHq()
    hq.state.factoryStatus = bad
    await expect(hq.fetch("/v1/factory/status")).rejects.toBeInstanceOf(FakeHqError)
    // Recorded for test/setup.ts, which would fail this test; this one provoked it on purpose.
    expect(fakeViolations).toHaveLength(1)
    fakeViolations.length = 0
  })
})
