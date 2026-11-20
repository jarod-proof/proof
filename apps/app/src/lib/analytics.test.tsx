// @vitest-environment jsdom
import { MAX_CLIENT_EVENTS } from "@proof/analytics/events"
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router"
import { act, render, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createWebAnalytics, usePageViews, type WebAnalytics } from "./analytics"

afterEach(() => vi.useRealTimers())

describe("createWebAnalytics", () => {
  it("batches page views and sends them after a pause", () => {
    vi.useFakeTimers()
    const send = vi.fn()
    const analytics = createWebAnalytics({ send, flushAfterMs: 1000 })
    analytics.pageViewed("/$org")
    analytics.pageViewed("/$org/runs/$runId")
    expect(send).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1000)
    expect(send).toHaveBeenCalledExactlyOnceWith([
      { name: "page.viewed", properties: { route: "/$org" } },
      { name: "page.viewed", properties: { route: "/$org/runs/$runId" } },
    ])
  })

  it("sends a full batch at once, and what is left on flush", () => {
    const send = vi.fn()
    const analytics = createWebAnalytics({ send })
    for (let i = 0; i < MAX_CLIENT_EVENTS + 1; i++) analytics.pageViewed("/$org")
    expect(send).toHaveBeenCalledOnce()
    expect(send.mock.calls[0]?.[0]).toHaveLength(MAX_CLIENT_EVENTS)
    analytics.flush()
    expect(send).toHaveBeenCalledTimes(2)
    analytics.flush()
    expect(send).toHaveBeenCalledTimes(2)
  })
})

describe("usePageViews", () => {
  function setup() {
    const views: string[] = []
    const analytics: WebAnalytics = { pageViewed: (route) => views.push(route), flush: vi.fn() }
    const root = createRootRoute({
      component: function Root() {
        usePageViews(analytics)
        return <Outlet />
      },
    })
    const org = createRoute({ getParentRoute: () => root, path: "$org", component: () => null })
    const run = createRoute({
      getParentRoute: () => root,
      path: "$org/runs/$runId",
      component: () => null,
    })
    const router = createRouter({
      routeTree: root.addChildren([org, run]),
      history: createMemoryHistory({ initialEntries: ["/acme"] }),
    })
    render(<RouterProvider router={router} />)
    return { views, analytics, router }
  }

  it("records each new path by its route template, not its ids", async () => {
    const { views, router } = setup()
    await waitFor(() => expect(views).toEqual(["/$org"]))
    // The test router isn't the registered one, so it navigates by address.
    for (const href of ["/acme/runs/r1", "/acme/runs/r2", "/acme", "/acme?tab=2"]) {
      await act(() => router.navigate({ href }))
    }
    await waitFor(() =>
      expect(views).toEqual(["/$org", "/$org/runs/$runId", "/$org/runs/$runId", "/$org"]),
    )
  })

  it("sends the queue when the tab is hidden", async () => {
    const { analytics, views } = setup()
    await waitFor(() => expect(views).toHaveLength(1))
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden")
    document.dispatchEvent(new Event("visibilitychange"))
    expect(analytics.flush).toHaveBeenCalledOnce()
  })
})
