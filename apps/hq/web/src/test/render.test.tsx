// @vitest-environment jsdom
import { describe, expect, it } from "vitest"

import { createFakeHq } from "./fake-hq"
import { renderApp } from "./render"

describe("renderApp", () => {
  it("mounts the app's route tree under /app against the fake hq", async () => {
    const hq = createFakeHq()
    const app = await renderApp({ path: "/app/approvals", hq })
    expect(app.router.history.location.pathname).toBe("/app/approvals")
    expect(await app.findByRole("heading", { name: "Approvals" })).toBeTruthy()
    expect(app.hq).toBe(hq)
    // A request through the router's own client reaches the fake, not the network.
    const before = hq.sent.length
    expect(await app.router.options.context.client.status()).toEqual({ ok: true, version: "0.0.0" })
    expect(hq.sent.length).toBe(before + 1)
    expect(hq.sent.at(-1)?.path).toBe("/v1/status")
    // The gate's probe, the sidebar's session lookup and runner card, and the call above (the
    // Approvals screen's own list reads are not counted here).
    await app.findByText("eve · last run 4h ago")
    const own = (path: string) => path !== "/v1/proposals"
    expect(
      hq.sent
        .map((s) => s.path)
        .filter(own)
        .sort(),
    ).toEqual(["/api/auth/get-session", "/v1/factory/status", "/v1/status", "/v1/status"])
  })

  it("defaults to /app/digest with a signed-in founder", async () => {
    const app = await renderApp()
    expect(app.router.history.location.pathname).toBe("/app/digest")
    expect(app.hq.state.caller).toBe("founder")
  })
})
