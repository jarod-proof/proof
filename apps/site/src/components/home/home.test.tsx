// @vitest-environment jsdom
import { expectNoA11yViolations } from "@proof/ui/a11y"
import { describe, expect, it } from "vitest"

import { homeFaqs } from "../../data/faqs"
import { plans } from "../../data/plans"
import { linksNamed, render } from "../../test/render"
import { FaqSection } from "../faq-list"
import { NotFound } from "../not-found"
import { Benefits } from "./benefits"
import { FinalCta } from "./final-cta"
import { HowItWorks } from "./how-it-works"
import { Inbox } from "./inbox"
import { PricingTeaser } from "./pricing-teaser"
import { Proof } from "./proof"
import { Security } from "./security"
import { Testimonial } from "./testimonial"

describe("home sections", () => {
  it.each([
    ["Proof", <Proof key="p" />],
    ["Benefits", <Benefits key="b" />],
    ["HowItWorks", <HowItWorks key="h" />],
    ["Inbox", <Inbox key="i" />],
    ["Testimonial", <Testimonial key="t" />],
    ["Security", <Security key="s" />],
    ["PricingTeaser", <PricingTeaser key="pt" />],
    ["FinalCta", <FinalCta key="f" />],
    ["NotFound", <NotFound key="n" />],
  ])("%s has no a11y violations", async (_, element) => {
    await expectNoA11yViolations(render(element))
  })

  it("gives the header's Product and Customers links their anchors", () => {
    render(<HowItWorks />)
    expect(document.getElementById("how-it-works")).not.toBeNull()
    render(<Proof logos={4} />)
    expect(document.getElementById("customers")).not.toBeNull()
    expect(document.querySelectorAll("#customers li")).toHaveLength(4)
  })

  it("numbers the steps in order", () => {
    render(<HowItWorks />)
    const numbers = [...document.querySelectorAll("ol > li > span")].map((s) => s.textContent)
    expect(numbers).toEqual(["1", "2", "3"])
  })

  it("teases every plan and marks the featured one", () => {
    render(<PricingTeaser />)
    const names = [...document.querySelectorAll("h3")].map((h) => h.textContent)
    expect(names).toEqual(plans.map((p) => p.name))
    expect(document.body.textContent).toContain("MOST TEAMS")
    expect(linksNamed("Compare all plans")[0]?.getAttribute("href")).toBe("/pricing")
  })

  it("names the inbox preview and hides its drawing", () => {
    render(<Inbox />)
    expect(document.querySelector("figcaption")?.textContent).toMatch(/three items/)
    expect(document.querySelector("figure > [aria-hidden=true]")).not.toBeNull()
  })
})

describe("FaqSection", () => {
  it("opens only the first question and keeps the closing line", async () => {
    const html = render(
      <FaqSection id="faq-h" title="Questions" faqs={homeFaqs}>
        <p>Still deciding?</p>
      </FaqSection>,
    )
    const details = [...document.querySelectorAll("details")]
    expect(details).toHaveLength(homeFaqs.length)
    expect(details.map((d) => d.open)).toEqual(homeFaqs.map((_, i) => i === 0))
    expect(document.body.textContent).toContain("Still deciding?")
    await expectNoA11yViolations(html)
  })
})
