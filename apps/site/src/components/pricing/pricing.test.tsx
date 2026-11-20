// @vitest-environment jsdom
import { expectNoA11yViolations } from "@proof/ui/a11y"
import { describe, expect, it } from "vitest"

import { comparison, plans } from "../../data/plans"
import { render } from "../../test/render"
import { CompareTable } from "./compare-table"
import { Enterprise, Plans } from "./plans"

describe("Plans", () => {
  it("offers the billing period as a radio pair with annual chosen", async () => {
    const html = render(<Plans />)
    const radios = [...document.querySelectorAll<HTMLInputElement>("input[type=radio]")]
    expect(radios.map((r) => r.value)).toEqual(["monthly", "annual"])
    expect(radios.find((r) => r.checked)?.value).toBe("annual")
    expect(document.querySelector("legend")?.textContent).toBe("Billing period")
    await expectNoA11yViolations(html)
  })

  it("renders a card per plan with both prices", () => {
    render(<Plans />)
    const cards = [...document.querySelectorAll("section[aria-label=Plans] > div")]
    expect(cards).toHaveLength(plans.length)
    for (const [i, card] of cards.entries()) {
      expect(card.querySelector("h2")?.textContent).toBe(plans[i]?.name)
      expect(card.querySelectorAll("li")).toHaveLength(plans[i]?.items.length ?? -1)
    }
  })

  it("renders the enterprise band", async () => {
    const html = render(<Enterprise />)
    expect(document.querySelector("a")?.getAttribute("href")).toMatch(/^mailto:/)
    await expectNoA11yViolations(html)
  })
})

describe("CompareTable", () => {
  it("has a header per plan, a row per feature and words for ticks", async () => {
    const html = render(<CompareTable />)
    expect(document.querySelectorAll("thead th[scope=col]")).toHaveLength(plans.length + 1)
    const rows = comparison.flatMap((g) => g.rows)
    expect(document.querySelectorAll("tbody th[scope=row]")).toHaveLength(rows.length)
    expect(document.body.textContent).toContain("Included")
    expect(document.body.textContent).toContain("Not included")
    await expectNoA11yViolations(html)
  })

  it("compares API requests per day: Free 10,000, Pro 100,000, Team Unlimited", () => {
    const row = comparison.flatMap((g) => g.rows).find((r) => r.label === "API requests / day")
    expect(row?.cells).toEqual(["10,000", "100,000", "Unlimited"])
    render(<CompareTable />)
    expect(document.body.textContent).toContain("API requests / day")
  })
})
