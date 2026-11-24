// @vitest-environment jsdom
import { within } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { createFakeHq } from "./test/fake-hq"
import { renderApp } from "./test/render"

describe("the app router", () => {
  it("/app redirects to /app/digest", async () => {
    const app = await renderApp({ path: "/app" })
    expect(app.router.history.location.pathname).toBe("/app/digest")
    expect(await app.findByRole("heading", { name: "Digest" })).toBeTruthy()
  })

  it("an unknown path under /app renders a not-found state inside the frame", async () => {
    const app = await renderApp({ path: "/app/nope" })
    expect(await app.findByText("Page not found")).toBeTruthy()
    expect(app.getByRole("navigation", { name: "Primary" })).toBeTruthy()
  })

  it("renders each screen route inside the frame with the active nav item marked", async () => {
    const screens = [
      ["/app/digest", "Digest"],
      ["/app/approvals", "Approvals"],
      ["/app/runner", "Runner & policy"],
    ] as const
    for (const [path, label] of screens) {
      const app = await renderApp({ path, hq: createFakeHq() })
      // Every screen is built: assert its own content, not a placeholder.
      const built: Record<(typeof screens)[number][0], () => Promise<unknown>> = {
        "/app/digest": () => app.findByRole("status", { name: "Digest summary" }),
        "/app/approvals": () => app.findByRole("region", { name: /Needs you/ }),
        "/app/runner": () => app.findByRole("heading", { level: 1, name: "Runner and policy" }),
      }
      expect(await built[path]()).toBeTruthy()
      const current = app
        .getByRole("navigation", { name: "Primary" })
        .querySelector("[aria-current]")
      expect(current?.textContent).toContain(label)
      app.unmount()
    }
  })

  it("navigates between screens from the sidebar", async () => {
    const app = await renderApp({ path: "/app/digest" })
    const nav = within(await app.findByRole("navigation", { name: "Primary" }))
    await app.user.click(nav.getByRole("link", { name: /Approvals/ }))
    expect(app.router.history.location.pathname).toBe("/app/approvals")
  })

  it("the sign-in route sits outside the frame and keeps ?next", async () => {
    const app = await renderApp({ path: "/app/sign-in?next=%2Fapprovals" })
    expect(await app.findByLabelText("Email")).toBeTruthy()
    expect(app.queryByRole("navigation", { name: "Primary" })).toBeNull()
    expect(app.router.state.location.search).toEqual({ next: "/approvals" })
  })
})
