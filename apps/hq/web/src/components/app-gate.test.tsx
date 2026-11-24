// @vitest-environment jsdom
import { describe, expect, it } from "vitest"

import { HqError } from "../api/errors"
import { createQueryClient } from "../api/query-client"
import { hqKeys } from "../api/query-keys"
import { createFakeHq, urlOf } from "../test/fake-hq"
import { renderApp } from "../test/render"

/** A client that does not wait between retries, so a failing probe fails at once. */
function fastQueryClient() {
  const queryClient = createQueryClient()
  queryClient.setDefaultOptions({
    ...queryClient.getDefaultOptions(),
    queries: { ...queryClient.getDefaultOptions().queries, retryDelay: 0 },
  })
  return queryClient
}

describe("AppGate", () => {
  it("shows the screen for a signed-in founder", async () => {
    const app = await renderApp({ path: "/app/approvals" })
    expect(await app.findByRole("heading", { name: "Approvals" })).toBeTruthy()
    expect(app.getByRole("navigation", { name: "Primary" })).toBeTruthy()
  })

  it("signed out goes to /app/sign-in?next=%2Fapprovals and signs in back to /app/approvals", async () => {
    const hq = createFakeHq({ caller: "signed-out" })
    const app = await renderApp({ path: "/app/approvals", hq })
    await app.findByLabelText("Email")
    expect(app.router.history.location.pathname).toBe("/app/sign-in")
    expect(app.router.history.location.search).toBe("?next=%2Fapprovals")
    expect(app.queryByRole("navigation", { name: "Primary" })).toBeNull()

    await app.user.type(app.getByLabelText("Email"), hq.state.user.email)
    await app.user.type(app.getByLabelText("Password"), hq.state.password)
    await app.user.click(app.getByRole("button", { name: "Sign in" }))
    expect(await app.findByRole("heading", { name: "Approvals" })).toBeTruthy()
    expect(app.router.history.location.pathname).toBe("/app/approvals")
  })

  it("a non-founder sees the explanation and Sign out and no screen", async () => {
    const hq = createFakeHq({
      caller: "non-founder",
      user: { id: "user-2", email: "visitor@example.com", name: "Visitor" },
    })
    const app = await renderApp({ path: "/app/approvals", hq })
    expect(await app.findByText("Founders only")).toBeTruthy()
    expect(await app.findByText(/visitor@example\.com/)).toBeTruthy()
    expect(app.getByRole("button", { name: "Sign out" })).toBeTruthy()
    expect(app.queryByRole("navigation", { name: "Primary" })).toBeNull()
    expect(app.queryByRole("heading", { name: "Approvals" })).toBeNull()
    // Nothing but the probe and the session lookup was sent: no screen data for a non-founder.
    expect(hq.sent.map((s) => s.path).sort()).toEqual(["/api/auth/get-session", "/v1/status"])
  })

  it("a non-founder can sign out from the panel and lands on sign-in", async () => {
    const hq = createFakeHq({ caller: "non-founder" })
    const app = await renderApp({ path: "/app/digest", hq })
    await app.user.click(await app.findByRole("button", { name: "Sign out" }))
    expect(await app.findByLabelText("Email")).toBeTruthy()
    expect(app.router.history.location.pathname).toBe("/app/sign-in")
    expect(hq.sent.filter((s) => s.path === "/api/auth/sign-out")).toHaveLength(1)
  })

  it("a non-founder panel still works when the session lookup fails", async () => {
    const hq = createFakeHq({ caller: "non-founder" })
    const original = hq.fetch
    hq.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (urlOf(input).includes("get-session")) return new Response("boom", { status: 500 })
      return original(input, init)
    }) as typeof fetch
    const app = await renderApp({ path: "/app/digest", hq, queryClient: fastQueryClient() })
    expect(await app.findByText("Founders only")).toBeTruthy()
    expect(app.getByRole("button", { name: "Sign out" })).toBeTruthy()
  })

  it("a refused hq shows the refusal panel with Retry, not a sign-in loop", async () => {
    const hq = createFakeHq({ caller: "refused" })
    const app = await renderApp({ path: "/app/approvals", hq })
    expect(await app.findByText("hq refused to start")).toBeTruthy()
    expect(app.getByText(/nothing is wrong with your account/i)).toBeTruthy()
    expect(app.router.history.location.pathname).toBe("/app/approvals")
    expect(app.queryByLabelText("Email")).toBeNull()
    const before = hq.sent.length

    hq.state.caller = "founder"
    await app.user.click(app.getByRole("button", { name: "Retry" }))
    expect(await app.findByRole("heading", { name: "Approvals" })).toBeTruthy()
    expect(hq.sent.length).toBeGreaterThan(before)
  })

  it("an unreachable hq shows the error block with Retry", async () => {
    const hq = createFakeHq()
    let down = true
    const original = hq.fetch
    hq.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (down) throw new TypeError("fetch failed")
      return original(input, init)
    }) as typeof fetch
    const app = await renderApp({ path: "/app/digest", hq, queryClient: fastQueryClient() })
    expect(await app.findByText("Could not reach the server")).toBeTruthy()
    down = false
    await app.user.click(app.getByRole("button", { name: "Retry" }))
    expect(await app.findByRole("heading", { name: "Digest" })).toBeTruthy()
  })

  it("a server error shows the error block with Retry", async () => {
    const hq = createFakeHq()
    let broken = true
    const original = hq.fetch
    hq.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (broken) return new Response("boom", { status: 500 })
      return original(input, init)
    }) as typeof fetch
    const app = await renderApp({ path: "/app/digest", hq, queryClient: fastQueryClient() })
    expect(await app.findByText("hq had a problem")).toBeTruthy()
    broken = false
    await app.user.click(app.getByRole("button", { name: "Retry" }))
    expect(await app.findByRole("heading", { name: "Digest" })).toBeTruthy()
  })

  it("a 401 on a later query sends the founder back to sign-in", async () => {
    const hq = createFakeHq()
    const app = await renderApp({ path: "/app/approvals", hq })
    await app.findByRole("heading", { name: "Approvals" })

    hq.state.caller = "signed-out"
    const client = app.router.options.context.client
    await expect(
      app.queryClient.fetchQuery({
        queryKey: hqKeys.proposals(),
        queryFn: () => client.listProposals(),
      }),
    ).rejects.toBeInstanceOf(HqError)

    expect(await app.findByLabelText("Email")).toBeTruthy()
    expect(app.router.history.location.pathname).toBe("/app/sign-in")
    expect(app.router.history.location.search).toBe("?next=%2Fapprovals")
  })

  it("a signed-out visitor probes the status once, never in a loop", async () => {
    const hq = createFakeHq({ caller: "signed-out" })
    const app = await renderApp({ path: "/app/digest", hq })
    await app.findByLabelText("Email")
    expect(hq.sent.filter((s) => s.path === "/v1/status")).toHaveLength(1)
  })
})
