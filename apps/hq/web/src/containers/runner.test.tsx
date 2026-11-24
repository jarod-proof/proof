// @vitest-environment jsdom
import { within } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { createFakeHq, type FakeHq } from "../test/fake-hq"
import { factoryStatusFixture, policyFixture } from "../test/fixtures"
import { renderApp } from "../test/render"

/** A fake whose `/v1/policy` answers when the test says so, or fails once, and records the rest. */
function controlled(
  hq: FakeHq,
  mode: { hold?: Promise<void>; failOnce?: boolean; path?: string },
): FakeHq {
  let failed = false
  const fetchThrough: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      "http://localhost:3100",
    )
    if (url.pathname === (mode.path ?? "/v1/policy")) {
      if (mode.hold) await mode.hold
      if (mode.failOnce && !failed) {
        failed = true
        hq.sent.push({
          method: "GET",
          path: url.pathname,
          search: "",
          body: undefined,
          credentials: "same-origin",
        })
        return Response.json(
          {
            error: { code: "FORBIDDEN", message: "This brain is for the organization's founders" },
          },
          { status: 403 },
        )
      }
    }
    return hq.fetch(input, init)
  }
  return { ...hq, fetch: fetchThrough }
}

describe("the Runner and policy screen", () => {
  it("shows a loading block until get_policy answers, then the screen", async () => {
    let release: () => void = () => {}
    const hold = new Promise<void>((resolve) => {
      release = resolve
    })
    const hq = controlled(createFakeHq(), { hold })
    const app = await renderApp({ path: "/app/runner", hq })
    expect((await app.findByText("Loading runner and policy")).getAttribute("aria-busy")).toBe(
      "true",
    )
    expect(app.getByRole("heading", { level: 1, name: "Runner and policy" })).toBeTruthy()
    release()
    expect(await app.findByRole("heading", { name: "Approval rules today" })).toBeTruthy()
    expect(app.queryByText("Loading runner and policy")).toBeNull()
  })

  it("renders the values hq answered, not constants of the page", async () => {
    const hq = createFakeHq({
      policy: policyFixture({
        spend: { ...policyFixture().spend, dailyCapUsd: 17, grantedTodayUsd: 3 },
        founders: 4,
      }),
    })
    const app = await renderApp({ path: "/app/runner", hq })
    await app.findByRole("heading", { name: "Approval rules today" })
    expect(app.getByText("Daily Eve spend cap").closest("div")?.textContent).toContain("$17.00")
    expect(app.getByText("Granted today").closest("div")?.textContent).toContain("$3.00")
    expect(app.getByText("Founders").closest("div")?.textContent).toContain("4")
  })

  it("a failed get_policy shows the error with Retry, and Retry asks again", async () => {
    const hq = controlled(createFakeHq(), { failOnce: true })
    const app = await renderApp({ path: "/app/runner", hq })
    const alert = await app.findByRole("alert")
    expect(alert.textContent).toContain("Founders only")
    await app.user.click(app.getByRole("button", { name: "Retry" }))
    expect(await app.findByRole("heading", { name: "Approval rules today" })).toBeTruthy()
    expect(app.queryByRole("alert")).toBeNull()
  })

  it("a failed get_factory_status shows the error with Retry, and Retry asks again", async () => {
    const hq = controlled(createFakeHq(), { failOnce: true, path: "/v1/factory/status" })
    const app = await renderApp({ path: "/app/runner", hq })
    const alert = await app.findByRole("alert", {}, { timeout: 5000 })
    expect(alert.textContent).toContain("Founders only")
    expect(app.queryByRole("heading", { name: "Approval rules today" })).toBeNull()
    await app.user.click(app.getByRole("button", { name: "Retry" }))
    expect(await app.findByRole("heading", { name: "Approval rules today" })).toBeTruthy()
  })

  it("a fresh hq with no runs says none yet and not recorded, and a full cap", async () => {
    const base = factoryStatusFixture()
    const hq = createFakeHq({
      factoryStatus: {
        ...base,
        pendingProposals: 0,
        runners: base.runners.map((r) => ({ ...r, lastStartedAt: null, lastOutcome: null })),
        allowance: { ...base.allowance, spentUsd: 0, remainingUsd: 10 },
      },
    })
    const app = await renderApp({ path: "/app/runner", hq })
    await app.findByRole("heading", { name: "Approval rules today" })
    const items = within(app.getByRole("region", { name: "Local runner" })).getAllByRole("listitem")
    expect(items).toHaveLength(3)
    for (const item of items) {
      expect(item.textContent).toContain("none yet")
      expect(item.textContent).toContain("not recorded")
    }
    expect(
      app
        .getByRole("progressbar", { name: "Eve spend cap, not your Claude plan" })
        .getAttribute("value"),
    ).toBe("100")
    expect(app.getByText("no runs yet")).toBeTruthy()
  })

  it("asks for the factory status and the policy once each, and sends nothing but GETs", async () => {
    const hq = createFakeHq()
    const app = await renderApp({ path: "/app/runner", hq })
    await app.findByRole("heading", { name: "Approval rules today" })
    // The page and the sidebar share one factory-status query.
    expect(hq.sent.filter((s) => s.path === "/v1/factory/status")).toHaveLength(1)
    expect(hq.sent.filter((s) => s.path === "/v1/policy")).toHaveLength(1)
    expect(hq.sent.every((s) => s.method === "GET")).toBe(true)
    // Nothing on the page can be clicked into a write: every control is disabled.
    for (const button of app.getAllByRole("button")) {
      if (button.closest("main")) expect((button as HTMLButtonElement).disabled).toBe(true)
    }
  })

  it("keeps the sidebar's runner card and the page reading one cap", async () => {
    const app = await renderApp({ path: "/app/runner" })
    await app.findByRole("heading", { name: "Approval rules today" })
    expect(app.getByText("Eve spend cap 62% left")).toBeTruthy()
    expect(
      app
        .getByRole("progressbar", { name: "Eve spend cap, not your Claude plan" })
        .getAttribute("value"),
    ).toBe("62")
  })

  it("'Pause all agents' appears on no route", async () => {
    const ready: Record<string, (app: Awaited<ReturnType<typeof renderApp>>) => Promise<unknown>> =
      {
        "/app/digest": (app) => app.findByRole("heading", { level: 1, name: "Digest" }),
        "/app/approvals": (app) => app.findByRole("heading", { level: 1, name: "Approvals" }),
        "/app/runner": (app) => app.findByRole("heading", { name: "Approval rules today" }),
      }
    for (const [path, wait] of Object.entries(ready)) {
      const app = await renderApp({ path })
      await wait(app)
      // The sidebar loaded too, so this is not a page still waiting on its data.
      await app.findByText("eve · last run 4h ago")
      expect(document.body.textContent, path).not.toMatch(/pause all agents/i)
      expect(document.body.textContent, path).not.toMatch(/pause[^a-z]+agents/i)
      app.unmount()
    }
  })
})
