// @vitest-environment jsdom
import { expectNoA11yViolations } from "@proof/ui/a11y"
import { render } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import type { AttemptView } from "../api/schemas"
import { workItemFixture } from "../test/fixtures"
import { AttemptCard, formatDuration } from "./attempt-card"

const base = (): AttemptView => ({
  ...(workItemFixture().attemptList[1] as AttemptView),
  number: 2,
  kind: "fix",
  status: "finished",
  result: "approved",
  startedAt: "2026-11-17T06:12:00.000Z",
  finishedAt: "2026-11-17T06:13:48.000Z",
  durationMs: 108_000,
  files: ["src/a.ts", "src/b.ts"],
  note: "Wrapped the failing call.",
  costUsd: null,
  costEstimated: false,
  endReason: null,
})
const attempt = (overrides: Partial<AttemptView> = {}): AttemptView => ({ ...base(), ...overrides })

describe("AttemptCard", () => {
  it("shows the title, the kind chip, the result in its colour, the meta line and the note", () => {
    const view = render(<AttemptCard attempt={attempt()} />)
    expect(view.getByRole("heading", { name: "Attempt 2" })).toBeTruthy()
    expect(view.getByText("fix").className).toContain("font-mono")
    const result = view.getByText("Approved by reviewer")
    expect(result.className).toContain("text-success")
    expect(view.getByText(/06:12/).textContent).toBe(
      "06:12 UTC · 1m48s · 2 files changed · cost Not reported",
    )
    expect(view.getByText("Wrapped the failing call.")).toBeTruthy()
  })

  it("shows the pinned result labels in their colours", () => {
    const cases: [Partial<AttemptView>, string, string][] = [
      [{ kind: "investigate", result: "investigated" }, "Investigated", "text-success"],
      [{ result: "approved" }, "Approved by reviewer", "text-success"],
      [{ result: "rejected" }, "Rejected by reviewer", "text-destructive"],
      [{ result: "failed" }, "Failed", "text-destructive"],
      [{ result: "abandoned", endReason: "lease_expired" }, "Stopped reporting", "text-solar"],
      [{ result: "needs_answer" }, "Waiting for your answer", "text-solar"],
    ]
    for (const [overrides, label, color] of cases) {
      const view = render(<AttemptCard attempt={attempt(overrides)} />)
      expect(view.getByText(label).className, label).toContain(color)
      view.unmount()
    }
  })

  it("words an abandoned attempt by why it ended: only a lease that ran out is 'Stopped reporting'", () => {
    const lease = render(
      <AttemptCard attempt={attempt({ result: "abandoned", endReason: null })} />,
    )
    expect(lease.getByText("Stopped reporting")).toBeTruthy()
    lease.unmount()
    const merged = render(
      <AttemptCard attempt={attempt({ result: "abandoned", endReason: "merged" })} />,
    )
    expect(merged.queryByText("Stopped reporting")).toBeNull()
    expect(merged.getByText("Ended: the pull request was merged")).toBeTruthy()
    merged.unmount()
    const stopped = render(
      <AttemptCard attempt={attempt({ result: "abandoned", endReason: "stopped" })} />,
    )
    expect(stopped.queryByText("Stopped reporting")).toBeNull()
    expect(stopped.getByText("Ended: the item was stopped")).toBeTruthy()
  })

  it("words an attempt with no result by its status", () => {
    const running = render(
      <AttemptCard
        attempt={attempt({ status: "running", result: null, durationMs: null, finishedAt: null })}
      />,
    )
    expect(running.getByText("Running")).toBeTruthy()
    // no duration is invented for an attempt that has not ended
    expect(running.getByText(/06:12/).textContent).not.toMatch(/\d+m\d+s|\d+s/)
    running.unmount()
    const requested = render(
      <AttemptCard
        attempt={attempt({
          status: "requested",
          result: null,
          startedAt: null,
          durationMs: null,
          finishedAt: null,
          files: [],
        })}
      />,
    )
    expect(requested.getByText("Requested, not started")).toBeTruthy()
    expect(requested.container.textContent).not.toMatch(/\d\d:\d\d/)
    expect(requested.container.textContent).not.toContain("files changed")
    expect(requested.container.textContent).not.toContain("cost")
  })

  it("shows the cost only when known: a figure, an estimate, or 'Not reported' and never $0", () => {
    const known = render(<AttemptCard attempt={attempt({ costUsd: 0.4231 })} />)
    expect(known.getByText(/06:12/).textContent).toContain("$0.42")
    expect(known.getByText(/06:12/).textContent).not.toContain("Not reported")
    known.unmount()
    const estimated = render(
      <AttemptCard attempt={attempt({ costUsd: 1.5, costEstimated: true })} />,
    )
    expect(estimated.getByText(/06:12/).textContent).toContain("$1.50 (estimated)")
    estimated.unmount()
    const none = render(<AttemptCard attempt={attempt({ costUsd: null })} />)
    expect(none.getByText(/06:12/).textContent).toContain("cost Not reported")
    expect(none.getByText(/06:12/).textContent).not.toContain("$")
    none.unmount()
    const tiny = render(<AttemptCard attempt={attempt({ costUsd: 0.004 })} />)
    expect(tiny.getByText(/06:12/).textContent).toContain("less than $0.01")
  })

  it("a running attempt that has reported no files says so and never '0 files changed'", () => {
    const none = render(
      <AttemptCard
        attempt={attempt({
          status: "running",
          result: null,
          durationMs: null,
          finishedAt: null,
          files: [],
        })}
      />,
    )
    expect(none.getByText(/06:12/).textContent).toContain("no files reported yet")
    expect(none.container.textContent).not.toContain("0 files changed")
    none.unmount()
    const some = render(
      <AttemptCard
        attempt={attempt({
          status: "running",
          result: null,
          durationMs: null,
          finishedAt: null,
          files: ["a.ts", "b.ts"],
        })}
      />,
    )
    expect(some.getByText(/06:12/).textContent).toContain("2 files changed")
    some.unmount()
    // a finished attempt with none really changed none
    const finished = render(<AttemptCard attempt={attempt({ files: [] })} />)
    expect(finished.getByText(/06:12/).textContent).toContain("0 files changed")
  })

  it("says '1 file changed' for one file and shows no note paragraph without a note", () => {
    const view = render(<AttemptCard attempt={attempt({ files: ["a.ts"], note: null })} />)
    expect(view.getByText(/06:12/).textContent).toContain("1 file changed")
    expect(view.container.querySelectorAll("p")).toHaveLength(0)
  })

  it("formats durations", () => {
    expect(formatDuration(0)).toBe("0s")
    expect(formatDuration(48_000)).toBe("48s")
    expect(formatDuration(130_000)).toBe("2m10s")
    expect(formatDuration(3_900_000)).toBe("1h05m")
  })

  it("a 100 000 character note stays inside its card, cut with a way to read it all", () => {
    const note = `<img src=x onerror=alert(1)> ${"N".repeat(100_000)}`
    const view = render(<AttemptCard attempt={attempt({ note })} />)
    const card = view.container.querySelector("article") as HTMLElement
    expect(card.className).toContain("min-w-0")
    expect(card.className).toContain("overflow-hidden")
    expect(view.container.querySelector("img")).toBeNull()
    expect(card.textContent).toContain(note)
    const toggle = view.getByRole("button", { name: /Show all/ })
    expect(toggle.className).toContain("min-h-touch")
    expect(card.querySelector(".wrap-anywhere")).not.toBeNull()
  })

  it("has no inline style and no accessibility violations", async () => {
    const view = render(<AttemptCard attempt={attempt({ note: "x".repeat(2000) })} />)
    expect(view.container.querySelector("[style]")).toBeNull()
    await expectNoA11yViolations(view.container.innerHTML)
  })
})
