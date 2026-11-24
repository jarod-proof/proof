// @vitest-environment jsdom
import { expectNoA11yViolations } from "@proof/ui/a11y"
import { render } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { VerificationChart } from "./verification-chart"

const MERGED = "2026-11-17T08:00:00.000Z"
const HALF_HOUR = 30 * 60 * 1000

/** 24 buckets before the merge, then `after` from the merge on (the shape hq sends). */
function buckets(before: number[], after: number[]) {
  const start = new Date(MERGED).getTime() - 24 * HALF_HOUR
  const all = [...before, ...after]
  return all.map((count, i) => ({ at: new Date(start + i * HALF_HOUR).toISOString(), count }))
}
const pad = (values: number[], n: number) => [...values, ...Array(n - values.length).fill(0)]

const FAC141 = buckets(pad([22, 28, 25, 31, 26], 24), [4, 1, 0, 0, 0, 0, 0])

describe("VerificationChart", () => {
  it("is a figure with a text alternative around an aria-hidden svg of 24 or more rects, no style attribute and the three captions", () => {
    const view = render(<VerificationChart buckets={FAC141} mergedAt={MERGED} />)
    const figure = view.getByRole("figure")
    const svg = figure.querySelector("svg") as SVGElement
    // the picture is decoration: the figcaption is its text alternative
    expect(svg.getAttribute("aria-hidden")).toBe("true")
    expect(svg.getAttribute("role")).toBeNull()
    expect(view.queryByRole("img")).toBeNull()
    const rects = svg.querySelectorAll("rect")
    expect(rects.length).toBeGreaterThanOrEqual(24)
    expect(rects).toHaveLength(FAC141.length)
    expect(view.container.querySelector("[style]")).toBeNull()
    for (const rect of rects) {
      expect(rect.getAttribute("height")).toMatch(/^\d+(\.\d+)?$/)
      expect(rect.getAttribute("y")).toMatch(/^\d+(\.\d+)?$/)
    }
    // the captions: the range starts 12 h before the merge (not "12 h ago"), the merge, and now
    expect(view.getByText("12 h before the merge")).toBeTruthy()
    expect(view.getByText("merged")).toBeTruthy()
    expect(view.getByText("now")).toBeTruthy()
  })

  it("says the label with the totals before the merge and since", () => {
    const view = render(<VerificationChart buckets={FAC141} mergedAt={MERGED} />)
    const figure = view.getByRole("figure", {
      name: /^Signals per 30 minutes: 132 before the merge, 5 since\./,
    })
    const caption = figure.querySelector("figcaption") as HTMLElement
    expect(caption.className).toContain("sr-only")
    expect(caption.textContent).toBe(
      "Signals per 30 minutes: 132 before the merge, 5 since. Each bar is one half hour: red before the merge, green from the merge on.",
    )
  })

  it("puts the figcaption first in the figure (HTML allows it only first or last)", () => {
    const view = render(<VerificationChart buckets={FAC141} mergedAt={MERGED} />)
    const figure = view.getByRole("figure")
    expect(figure.firstElementChild?.tagName).toBe("FIGCAPTION")
    expect(figure.querySelectorAll("figcaption")).toHaveLength(1)
  })

  it("colours bars before the merge text-destructive and after it text-success, and the bucket at the merge is after", () => {
    const view = render(<VerificationChart buckets={FAC141} mergedAt={MERGED} />)
    const rects = [...view.getByRole("figure").querySelectorAll("rect")]
    rects.forEach((rect, i) => {
      expect(rect.getAttribute("fill")).toBe("currentColor")
      const expected = i < 24 ? "text-destructive" : "text-success"
      expect(rect.getAttribute("class"), `bucket ${i}`).toContain(expected)
    })
    // the bucket that starts at the merge counts since it
    expect(FAC141[24]?.at).toBe(MERGED)
  })

  it("scales the bars to the tallest one and draws a zero as a hairline", () => {
    const view = render(<VerificationChart buckets={FAC141} mergedAt={MERGED} />)
    const rects = [...view.getByRole("figure").querySelectorAll("rect")]
    const height = (i: number) => Number(rects[i]?.getAttribute("height"))
    expect(height(3)).toBeGreaterThan(height(0))
    expect(height(3)).toBeGreaterThan(height(25))
    expect(height(30)).toBeLessThanOrEqual(1)
    expect(height(30)).toBeGreaterThan(0)
    for (const rect of rects) {
      expect(Number(rect.getAttribute("y")) + Number(rect.getAttribute("height"))).toBe(56)
    }
    expect(view.getByText("Tallest bar: 31 signals in 30 minutes")).toBeTruthy()
  })

  it("makes no NaN for all-zero buckets and says there were no signals", () => {
    const zeros = buckets(pad([], 24), pad([], 6))
    const view = render(<VerificationChart buckets={zeros} mergedAt={MERGED} />)
    const html = view.container.innerHTML
    expect(html).not.toContain("NaN")
    expect(view.getByRole("figure").querySelector("figcaption")?.textContent).toMatch(
      /^Signals per 30 minutes: 0 before the merge, 0 since\./,
    )
    expect(view.getByText("No signals in this range")).toBeTruthy()
  })

  it("marks the merge in the chart where the first bucket since the merge starts", () => {
    const view = render(<VerificationChart buckets={FAC141} mergedAt={MERGED} />)
    const marker = view.getByRole("figure").querySelector("line")
    expect(marker).not.toBeNull()
    expect(marker?.getAttribute("class")).toContain("text-faint")
    expect(marker?.getAttribute("stroke")).toBe("currentColor")
  })

  it("names the end of the range 'window end' when the window is not running", () => {
    const view = render(
      <VerificationChart buckets={FAC141} mergedAt={MERGED} through="window end" />,
    )
    expect(view.getByText("window end")).toBeTruthy()
    expect(view.queryByText("now")).toBeNull()
  })

  it("derives the first caption from the data: a range cut short reads in hours before the merge", () => {
    const short = FAC141.slice(20)
    const view = render(<VerificationChart buckets={short} mergedAt={MERGED} />)
    expect(view.getByText("2 h before the merge")).toBeTruthy()
    expect(view.queryByText("12 h before the merge")).toBeNull()
  })

  it("a range cut to start after the merge says 'start of range', not 'merged'", () => {
    const afterMerge = FAC141.slice(26)
    const view = render(<VerificationChart buckets={afterMerge} mergedAt={MERGED} />)
    expect(view.getByText("start of range")).toBeTruthy()
    expect(view.queryByText("merged")).toBeNull()
    expect(view.queryByText(/before the merge$/)).toBeNull()
    const rects = [...view.getByRole("figure").querySelectorAll("rect")]
    for (const rect of rects) expect(rect.getAttribute("class")).toContain("text-success")
    expect(view.getByRole("figure").querySelector("line")).toBeNull()
  })

  it("for a range cut to start after the merge the screen-reader text says so and never reports 0 before the merge", () => {
    // 25 starts half an hour after the merge: 1 signal in the range, nothing measured before it.
    const view = render(<VerificationChart buckets={FAC141.slice(25)} mergedAt={MERGED} />)
    const caption = view.getByRole("figure").querySelector("figcaption") as HTMLElement
    expect(caption.textContent).toBe(
      "Signals per 30 minutes: 1 in this range, which starts after the merge. Each bar is one half hour.",
    )
    expect(caption.textContent).not.toMatch(/before the merge/)
    expect(caption.textContent).not.toMatch(/red/)
    expect(view.getByRole("figure", { name: /which starts after the merge/ })).toBeTruthy()
  })

  it("a range that starts exactly at the merge says 'merged' on its left edge and reports nothing before it", () => {
    const view = render(<VerificationChart buckets={FAC141.slice(24)} mergedAt={MERGED} />)
    expect(view.getByText("merged")).toBeTruthy()
    expect(view.queryByText("start of range")).toBeNull()
    const caption = view.getByRole("figure").querySelector("figcaption") as HTMLElement
    expect(caption.textContent).toBe(
      "Signals per 30 minutes: 5 since the merge. Each bar is one half hour.",
    )
  })

  it("without a merge, shows every bar as before and names no merge", () => {
    const view = render(<VerificationChart buckets={FAC141.slice(0, 24)} mergedAt={null} />)
    const rects = [...view.getByRole("figure").querySelectorAll("rect")]
    for (const rect of rects) expect(rect.getAttribute("class")).toContain("text-destructive")
    expect(view.getByRole("figure").querySelector("figcaption")?.textContent).toBe(
      "Signals per 30 minutes: 132 so far, no merge yet. Each bar is one half hour.",
    )
    expect(view.queryByText("merged")).toBeNull()
    expect(view.getByRole("figure").querySelector("line")).toBeNull()
  })

  it("draws no chart when hq sent no buckets (an item without a recurrence key)", () => {
    const view = render(<VerificationChart buckets={[]} mergedAt={MERGED} />)
    expect(view.queryByRole("figure")).toBeNull()
    expect(view.container.querySelector("svg")).toBeNull()
    expect(view.getByText("No occurrence counts: this item has no recurrence key.")).toBeTruthy()
  })

  it("has no inline style and no accessibility violations", async () => {
    const view = render(<VerificationChart buckets={FAC141} mergedAt={MERGED} />)
    expect(view.container.querySelector("[style]")).toBeNull()
    await expectNoA11yViolations(view.container.innerHTML)
  })
})
