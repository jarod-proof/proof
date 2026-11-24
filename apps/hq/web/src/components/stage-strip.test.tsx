// @vitest-environment jsdom
import { expectNoA11yViolations } from "@proof/ui/a11y"
import { render } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import type { WorkItemDetail } from "../api/schemas"
import { triageItemFixture, verifyingItemFixture } from "../test/fixtures"
import { StageStrip } from "./stage-strip"

const names = ["Signal", "Triage", "Plan", "Attempt", "Review", "Deploy", "Verify"]

function rows(view: ReturnType<typeof render>) {
  return view.getAllByRole("listitem").map((li) => li.textContent ?? "")
}

describe("StageStrip", () => {
  it("is the ordered list Progress of seven stages numbered 01 to 07", () => {
    const item = verifyingItemFixture()
    const view = render(<StageStrip stages={item.stages} cycle={item.cycle} />)
    const list = view.getByRole("list", { name: "Progress" })
    expect(list.tagName).toBe("OL")
    const items = rows(view)
    expect(items).toHaveLength(7)
    names.forEach((name, i) => {
      expect(items[i]).toContain(`0${i + 1}`)
      expect(items[i]).toContain(name)
    })
  })

  it("marks the first five done, Deploy as assumed and Verify now", () => {
    const item = verifyingItemFixture()
    const view = render(<StageStrip stages={item.stages} cycle={item.cycle} />)
    const items = view.getAllByRole("listitem")
    for (const li of items.slice(0, 5)) expect(li.textContent).toContain("done")
    // a deploy is not observed: its "done" is an assumption and the strip says so
    expect(items[5]?.textContent).toContain("assumed")
    expect(items[5]?.textContent).not.toMatch(/\bdone\b(?! is assumed)/)
    expect(items[5]?.textContent).toContain("deploy not observed")
    expect(items[6]?.textContent).toContain("now")
    expect(items[6]?.getAttribute("aria-current")).toBe("step")
    expect(items.filter((li) => li.getAttribute("aria-current") === "step")).toHaveLength(1)
  })

  it("leaves a later stage with no tag at all", () => {
    const item = triageItemFixture()
    const view = render(<StageStrip stages={item.stages} cycle={item.cycle} />)
    const items = rows(view)
    expect(items[1]).toContain("now")
    expect(items[2]).toBe("03Plan")
    expect(items[6]).toBe("07Verify")
  })

  it("shows a reopened item with Triage as now and the tag 'cycle 2'", () => {
    const stages: WorkItemDetail["stages"] = [
      { stage: "signal", status: "done" },
      { stage: "triage", status: "now" },
      { stage: "plan", status: "todo" },
      { stage: "attempt", status: "todo" },
      { stage: "review", status: "todo" },
      { stage: "deploy", status: "todo" },
      { stage: "verify", status: "todo" },
    ]
    const view = render(<StageStrip stages={stages} cycle={2} />)
    const items = view.getAllByRole("listitem")
    expect(items[1]?.textContent).toContain("now")
    expect(items[1]?.textContent).toContain("cycle 2")
    expect(items[1]?.getAttribute("aria-current")).toBe("step")
    // the tag sits on the current stage only
    expect(view.getAllByText(/cycle 2/)).toHaveLength(1)
  })

  it("shows no cycle tag in the first cycle", () => {
    const item = verifyingItemFixture()
    const view = render(<StageStrip stages={item.stages} cycle={1} />)
    expect(view.queryByText(/cycle/)).toBeNull()
  })

  it("uses the stages in the order hq sends them and invents none", () => {
    const view = render(<StageStrip stages={[{ stage: "triage", status: "now" }]} cycle={1} />)
    const items = view.getAllByRole("listitem")
    expect(items).toHaveLength(1)
    // numbered by the stage's place in the pipeline, not by its place in the list
    expect(items[0]?.textContent).toContain("02")
  })

  it("has no inline style and no accessibility violations", async () => {
    const item = verifyingItemFixture()
    const view = render(<StageStrip stages={item.stages} cycle={2} />)
    expect(view.container.querySelector("[style]")).toBeNull()
    await expectNoA11yViolations(view.container.innerHTML)
  })
})
