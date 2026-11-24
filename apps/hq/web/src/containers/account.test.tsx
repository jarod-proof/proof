// @vitest-environment jsdom
import { describe, expect, it } from "vitest"

import { createFakeHq } from "../test/fake-hq"
import { renderApp } from "../test/render"

describe("the account menu", () => {
  it("shows the signed-in email in the sidebar", async () => {
    const app = await renderApp({ path: "/app/digest" })
    expect(await app.findByText("founder@example.com")).toBeTruthy()
  })

  it("Sign out posts /api/auth/sign-out once and lands on sign-in", async () => {
    const hq = createFakeHq()
    const app = await renderApp({ path: "/app/digest", hq })
    const button = await app.findByRole("button", { name: "Sign out" })
    await app.user.dblClick(button)

    expect(await app.findByLabelText("Email")).toBeTruthy()
    expect(app.router.history.location.pathname).toBe("/app/sign-in")
    const out = hq.sent.filter((s) => s.path === "/api/auth/sign-out")
    expect(out).toHaveLength(1)
    expect(out[0]?.method).toBe("POST")
    expect(out[0]?.body).toEqual({})
    expect(app.queryByRole("navigation", { name: "Primary" })).toBeNull()
  })

  it("clears the query cache on sign out", async () => {
    const app = await renderApp({ path: "/app/digest" })
    await app.user.click(await app.findByRole("button", { name: "Sign out" }))
    await app.findByLabelText("Email")
    expect(
      app.queryClient
        .getQueryCache()
        .getAll()
        .filter((q) => q.state.data !== undefined),
    ).toEqual([])
  })

  it("a sign-out the server refuses shows the error and stays signed in", async () => {
    const hq = createFakeHq()
    const app = await renderApp({ path: "/app/digest", hq })
    await app.findByRole("button", { name: "Sign out" })
    hq.state.nextError = {
      status: 403,
      body: { code: "INVALID_ORIGIN", message: "Invalid origin" },
    }
    await app.user.click(app.getByRole("button", { name: "Sign out" }))
    expect((await app.findByRole("alert")).textContent).toContain("canonical host")
    expect(app.router.history.location.pathname).toBe("/app/digest")
    expect(app.getByRole("navigation", { name: "Primary" })).toBeTruthy()
  })
})
