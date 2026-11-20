// @vitest-environment jsdom
import { expectNoA11yViolations } from "@proof/ui/a11y"
import { describe, expect, it } from "vitest"

import { linksNamed, render } from "../test/render"
import { Hero } from "./home/hero"
import { SiteFooter } from "./site-footer"
import { SiteHeader } from "./site-header"

describe("SiteHeader", () => {
  it("marks the current page and links the CTAs to the app", async () => {
    const html = render(<SiteHeader active="pricing" />)
    expect(document.querySelector('[aria-current="page"]')?.getAttribute("href")).toBe("/pricing")
    expect(document.querySelectorAll("[aria-current]")).toHaveLength(1)
    expect(linksNamed("Sign in")[0]?.getAttribute("href")).toMatch(/\/sign-in$/)
    await expectNoA11yViolations(html)
  })

  it("shows the announcement bar unless a page turns it off", () => {
    expect(render(<SiteHeader />)).toContain("Read the post")
    expect(render(<SiteHeader announce={false} />)).not.toContain("Read the post")
  })
})

describe("SiteFooter", () => {
  it("renders the link columns and the year", async () => {
    const html = render(<SiteFooter year={2031} />)
    await expectNoA11yViolations(html)
    expect(html).toContain("© 2031")
    expect(html).toContain('href="/legal/privacy"')
  })
})

describe("Hero", () => {
  it("names the preview for screen readers and hides its drawing", async () => {
    const html = render(<Hero />)
    expect(document.querySelector("figcaption")?.textContent).toContain("approval waiting")
    expect(document.querySelectorAll("h1")).toHaveLength(1)
    await expectNoA11yViolations(html)
  })
})
