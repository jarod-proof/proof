// @vitest-environment jsdom
import { expectNoA11yViolations } from "@proof/ui/a11y"
import { describe, expect, it } from "vitest"

import { factoryStatusFixture } from "../test/fixtures"
import { renderInRouter } from "../test/render"
import { RunnerCard } from "./runner-card"

describe("RunnerCard", () => {
  it("says 'Runner status not reported' and never 'online'", async () => {
    const view = await renderInRouter(<RunnerCard state="ready" status={factoryStatusFixture()} />)
    expect(view.getByText("Runner status not reported")).toBeTruthy()
    expect(view.container.textContent?.toLowerCase()).not.toContain("online")
  })

  it("shows the newest run's runner and a relative time, from the status clock", async () => {
    const view = await renderInRouter(<RunnerCard state="ready" status={factoryStatusFixture()} />)
    // now 12:00, eve started 08:00
    expect(view.getByText("eve · last run 4h ago")).toBeTruthy()
  })

  it("says 'no runs yet' when no runner has started", async () => {
    const base = factoryStatusFixture()
    const status = {
      ...base,
      runners: base.runners.map((r) => ({ ...r, lastStartedAt: null, lastOutcome: null })),
    }
    const view = await renderInRouter(<RunnerCard state="ready" status={status} />)
    expect(view.getByText("no runs yet")).toBeTruthy()
  })

  it("shows the Eve cap left as a progress element and '62% left' (spent 3.8 of 10)", async () => {
    const view = await renderInRouter(<RunnerCard state="ready" status={factoryStatusFixture()} />)
    const bar = view.getByRole("progressbar", { name: "Eve spend cap left" })
    expect(bar.tagName).toBe("PROGRESS")
    expect(bar.getAttribute("value")).toBe("62")
    expect(bar.getAttribute("max")).toBe("100")
    expect(view.getByText("Eve spend cap 62% left")).toBeTruthy()
  })

  it("counts a grant into the cap and clamps to 0..100", async () => {
    const base = factoryStatusFixture()
    const granted = {
      ...base,
      allowance: { ...base.allowance, capUsd: 10, grantedUsd: 10, spentUsd: 5, remainingUsd: 15 },
    }
    const a = await renderInRouter(<RunnerCard state="ready" status={granted} />)
    expect(a.getByText("Eve spend cap 75% left")).toBeTruthy()
    a.unmount()
    const over = {
      ...base,
      allowance: { ...base.allowance, capUsd: 0, grantedUsd: 0, remainingUsd: -1 },
    }
    const b = await renderInRouter(<RunnerCard state="ready" status={over} />)
    expect(b.getByText("Eve spend cap 0% left")).toBeTruthy()
  })

  it("clamps the percent into 0..100 when remaining is below 0 or above the total", async () => {
    const base = factoryStatusFixture()
    const below = {
      ...base,
      allowance: { ...base.allowance, capUsd: 10, grantedUsd: 0, remainingUsd: -1 },
    }
    const a = await renderInRouter(<RunnerCard state="ready" status={below} />)
    expect(a.getByText("Eve spend cap 0% left")).toBeTruthy()
    expect(a.getByRole("progressbar").getAttribute("value")).toBe("0")
    a.unmount()
    const above = {
      ...base,
      allowance: { ...base.allowance, capUsd: 10, grantedUsd: 0, remainingUsd: 25 },
    }
    const b = await renderInRouter(<RunnerCard state="ready" status={above} />)
    expect(b.getByText("Eve spend cap 100% left")).toBeTruthy()
    expect(b.getByRole("progressbar").getAttribute("value")).toBe("100")
  })

  it("never reads a runner as online, busy, running or stuck, box included", async () => {
    const base = factoryStatusFixture()
    const status = {
      ...base,
      runners: [
        { runner: "eve" as const, lastStartedAt: null, lastOutcome: null },
        { runner: "sandbox" as const, lastStartedAt: null, lastOutcome: null },
        { runner: "box" as const, lastStartedAt: "2026-11-17T11:59:30.000Z", lastOutcome: null },
      ],
    }
    const view = await renderInRouter(<RunnerCard state="ready" status={status} />)
    const text = view.container.textContent?.toLowerCase() ?? ""
    expect(text).toContain("box · last run just now")
    for (const word of ["online", "busy", "running", "stuck", "idle", "active"]) {
      expect(text, word).not.toContain(word)
    }
  })

  it("loading and error states render without a progress element", async () => {
    const loading = await renderInRouter(<RunnerCard state="loading" status={undefined} />)
    expect(loading.container.querySelector("progress")).toBeNull()
    expect(loading.getByText("Runner status not reported")).toBeTruthy()
    expect(loading.getByText("Loading runner status")).toBeTruthy()
    loading.unmount()
    const failed = await renderInRouter(<RunnerCard state="error" status={undefined} />)
    expect(failed.container.querySelector("progress")).toBeNull()
    expect(failed.getByText("Runner status unavailable")).toBeTruthy()
  })

  it("has no accessibility violations in the ready, loading and error states", async () => {
    const ready = await renderInRouter(<RunnerCard state="ready" status={factoryStatusFixture()} />)
    await expectNoA11yViolations(ready.container.innerHTML)
    ready.unmount()
    const loading = await renderInRouter(<RunnerCard state="loading" status={undefined} />)
    await expectNoA11yViolations(loading.container.innerHTML)
    loading.unmount()
    const failed = await renderInRouter(<RunnerCard state="error" status={undefined} />)
    await expectNoA11yViolations(failed.container.innerHTML)
  })

  it("links to /app/runner and has no inline style", async () => {
    const view = await renderInRouter(<RunnerCard state="ready" status={factoryStatusFixture()} />)
    const link = view.getByRole("link")
    expect(link.getAttribute("href")).toBe("/app/runner")
    expect(link.className).toContain("min-h-touch")
    expect(view.container.querySelector("[style]")).toBeNull()
  })
})
