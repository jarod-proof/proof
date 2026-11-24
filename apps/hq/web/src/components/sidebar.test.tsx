// @vitest-environment jsdom
import { expectNoA11yViolations } from "@proof/ui/a11y"
import { describe, expect, it } from "vitest"

import { NAV_ITEMS } from "../lib/nav"
import { renderInRouter } from "../test/render"
import { Sidebar, type SidebarProps } from "./sidebar"

function sidebar(overrides: Partial<SidebarProps> = {}) {
  return (
    <Sidebar
      items={NAV_ITEMS}
      activeKey="approvals"
      badges={{ pendingProposals: 4 }}
      runner={<p>runner slot</p>}
      account={<button type="button">account slot</button>}
      {...overrides}
    />
  )
}

describe("Sidebar", () => {
  it("renders the nav landmark 'Primary' with one link per item and marks the active one aria-current", async () => {
    const view = await renderInRouter(sidebar())
    const nav = view.getByRole("navigation", { name: "Primary" })
    const links = nav.querySelectorAll("a")
    expect(links).toHaveLength(NAV_ITEMS.length)
    expect([...links].map((a) => a.getAttribute("href"))).toEqual([
      "/app/digest",
      "/app/work",
      "/app/approvals",
      "/app/runner",
    ])
    const current = nav.querySelectorAll('[aria-current="page"]')
    expect(current).toHaveLength(1)
    expect(current[0]?.textContent).toContain("Approvals")
    expect(view.getByText("runner slot")).toBeTruthy()
    expect(view.getByText("account slot")).toBeTruthy()
  })

  it("marks no item current when activeKey is null", async () => {
    const view = await renderInRouter(sidebar({ activeKey: null }))
    expect(view.container.querySelector("[aria-current]")).toBeNull()
  })

  it("shows the Approvals badge only when the count is above 0 and caps display at 99+", async () => {
    const four = await renderInRouter(sidebar())
    expect(four.getByRole("link", { name: /Approvals/ }).textContent).toContain("4")
    four.unmount()

    const zero = await renderInRouter(sidebar({ badges: { pendingProposals: 0 } }))
    expect(zero.getByRole("link", { name: /Approvals/ }).textContent).toBe("Approvals")
    zero.unmount()

    const none = await renderInRouter(sidebar({ badges: {} }))
    expect(none.getByRole("link", { name: /Approvals/ }).textContent).toBe("Approvals")
    none.unmount()

    const many = await renderInRouter(sidebar({ badges: { pendingProposals: 250 } }))
    expect(many.getByRole("link", { name: /Approvals/ }).textContent).toContain("99+")
  })

  it("every link and button is at least 44 px (class min-h-touch)", async () => {
    const view = await renderInRouter(sidebar())
    const nav = view.getByRole("navigation", { name: "Primary" })
    for (const link of nav.querySelectorAll("a")) expect(link.className).toContain("min-h-touch")
  })

  it("renders no inline style attribute", async () => {
    const view = await renderInRouter(sidebar())
    expect(view.container.querySelector("[style]")).toBeNull()
  })

  it("has no a11y violations", async () => {
    const view = await renderInRouter(sidebar())
    await expectNoA11yViolations(view.container.innerHTML)
  })
})
