// @vitest-environment jsdom
import { expectNoA11yViolations } from "@proof/ui/a11y"
import { render } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { HqError } from "../api/errors"
import { Transcript, type TranscriptState } from "./transcript"

describe("Transcript", () => {
  it("reads Not connected / Phase 2 sessions when not recorded", () => {
    const view = render(<Transcript state={{ kind: "not-recorded" }} attemptNumber={3} />)
    expect(view.getByRole("heading", { name: "Attempt 3 transcript" })).toBeTruthy()
    expect(view.getByText("Not connected")).toBeTruthy()
    expect(view.getByText("the attempt transcript")).toBeTruthy()
    expect(view.getByText(/Phase 2 sessions/)).toBeTruthy()
    // nothing is shown as a transcript
    expect(view.queryAllByRole("listitem")).toHaveLength(0)
  })

  it("renders ready events as plain text, time, tool and text", () => {
    const view = render(
      <Transcript
        state={{
          kind: "ready",
          events: [
            { at: "0:02", tool: "Read", text: "src/checkout/Summary.tsx" },
            { at: "0:05", tool: "Grep", text: '"plan" in src/checkout · 14 matches' },
          ],
        }}
        attemptNumber={3}
      />,
    )
    const rows = view.getAllByRole("listitem")
    expect(rows).toHaveLength(2)
    expect(rows[0]?.textContent).toBe("0:02Readsrc/checkout/Summary.tsx")
    expect(rows[1]?.textContent).toContain("14 matches")
  })

  it("renders hostile event text as text, with no markup and no link", () => {
    const hostile = `<img src=x onerror=alert(1)> [x](https://evil.example) https://evil.example ${"T".repeat(100_000)}`
    const view = render(
      <Transcript
        state={{
          kind: "ready",
          events: [{ at: "<b>0:02</b>", tool: "<i>Read</i>", text: hostile }],
        }}
        attemptNumber={1}
      />,
    )
    expect(view.container.querySelector("img")).toBeNull()
    expect(view.container.querySelector("a")).toBeNull()
    expect(view.container.querySelector("b")).toBeNull()
    expect(view.container.querySelector("i")).toBeNull()
    const row = view.getByRole("listitem")
    expect(row.textContent).toContain(hostile)
    expect(row.className).toContain("min-w-0")
    expect(row.querySelector(".wrap-anywhere")).not.toBeNull()
    expect(view.getByRole("button", { name: /Show all/ })).toBeTruthy()
  })

  it("says when a ready transcript has no events", () => {
    const view = render(<Transcript state={{ kind: "ready", events: [] }} attemptNumber={1} />)
    expect(view.getByText("The transcript has no events.")).toBeTruthy()
    expect(view.queryAllByRole("listitem")).toHaveLength(0)
  })

  it("has a loading state", () => {
    const view = render(<Transcript state={{ kind: "loading" }} attemptNumber={2} />)
    expect(view.getByRole("heading", { name: "Attempt 2 transcript" })).toBeTruthy()
    expect(view.getByText("Loading the transcript")).toBeTruthy()
    expect(view.queryByText("Not connected")).toBeNull()
  })

  it("has an error state in the app's words", () => {
    const error = new HqError({ kind: "server", status: 500, message: "boom" })
    const view = render(<Transcript state={{ kind: "error", error }} attemptNumber={2} />)
    expect(view.getByRole("alert").textContent).toContain("hq had a problem")
    expect(view.queryByText("Not connected")).toBeNull()
  })

  it("has no inline style and no accessibility violations in any state", async () => {
    const states: TranscriptState[] = [
      { kind: "not-recorded" },
      { kind: "loading" },
      { kind: "error", error: new HqError({ kind: "unreachable", status: 0, message: "x" }) },
      { kind: "ready", events: [{ at: "0:02", tool: "Read", text: "a file" }] },
      { kind: "ready", events: [] },
    ]
    for (const state of states) {
      const view = render(<Transcript state={state} attemptNumber={1} />)
      expect(view.container.querySelector("[style]")).toBeNull()
      await expectNoA11yViolations(view.container.innerHTML)
      view.unmount()
    }
  })
})
