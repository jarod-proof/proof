// @vitest-environment jsdom
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router"
import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { PageTabs } from "@proof/ui/dplus/shell/page-header"

import { RouterLink } from "./router-link"

/** Renders the home page's status tabs through the real router, at `path`. */
async function tabsAt(path: string, activeTab: string) {
  const rootRoute = createRootRoute({
    component: () => (
      <PageTabs
        label="Filter runs by status"
        activeTab={activeTab}
        renderLink={RouterLink}
        tabs={[
          { id: "all", label: "All", href: "/acme" },
          { id: "failed", label: "Failed", href: "/acme?status=failed" },
          { id: "settings", label: "Settings", href: "/acme/settings" },
        ]}
      />
    ),
  })
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: [path] }),
  })
  render(<RouterProvider router={router} />)
  await screen.findByRole("link", { name: "All" })
  return screen
    .getAllByRole("link")
    .filter((link) => link.getAttribute("aria-current") === "page")
    .map((link) => link.textContent)
}

describe("RouterLink", () => {
  it("leaves one current tab when a filter adds a query string", async () => {
    expect(await tabsAt("/acme?status=failed", "failed")).toEqual(["Failed"])
  })

  it("does not mark a parent path current on a child page", async () => {
    expect(await tabsAt("/acme/settings", "settings")).toEqual(["Settings"])
  })
})
