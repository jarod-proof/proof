// @vitest-environment jsdom
import { expectNoA11yViolations } from "@proof/ui/a11y"
import { describe, expect, it } from "vitest"

import { linksNamed, render } from "../test/render"
import { ChangeEntry, ChangelogHeader } from "./changelog"
import { LegalPage } from "./legal-page"

describe("Changelog", () => {
  it("marks the current filter", async () => {
    const html = render(<ChangelogHeader kind="fixed" />)
    expect(linksNamed("Fixed")[0]?.getAttribute("aria-current")).toBe("page")
    expect(linksNamed("All")[0]?.hasAttribute("aria-current")).toBe(false)
    // buttonVariants on its own keeps the base's border-transparent: links merge it through cn.
    expect(linksNamed("RSS")[0]?.className).not.toContain("border-transparent")
    await expectNoA11yViolations(html)
  })

  it("renders an entry with its tags, date and post link", async () => {
    const html = render(
      <ChangeEntry
        id="v2-8"
        title="Agents can open pull requests"
        version="v2.8"
        date={new Date("2026-10-09T00:00:00Z")}
        kinds={["new", "improved", "fixed"]}
        post="agents-open-pull-requests"
      >
        <p>Notes</p>
      </ChangeEntry>,
    )
    expect(document.querySelector("article")?.id).toBe("v2-8")
    expect(document.querySelector("time")?.getAttribute("datetime")).toBe("2026-10-09")
    expect(document.body.textContent).toContain("NEWIMPROVEDFIXED")
    expect(linksNamed("Read the post")[0]?.getAttribute("href")).toBe(
      "/blog/agents-open-pull-requests",
    )
    await expectNoA11yViolations(html)
  })

  it("leaves out the post link when there is no post", () => {
    render(
      <ChangeEntry id="x" title="T" version="v1" date={new Date()} kinds={["fixed"]}>
        <p>Notes</p>
      </ChangeEntry>,
    )
    expect(linksNamed("Read the post")).toHaveLength(0)
  })
})

describe("LegalPage", () => {
  const tabs = [
    { slug: "terms", label: "Terms of Service" },
    { slug: "privacy", label: "Privacy Policy" },
  ]

  it("marks the current document and numbers the sections", async () => {
    const html = render(
      <LegalPage
        title="Terms of Service"
        effective="[DATE]"
        updated="[DATE]"
        summary={["Your content stays yours."]}
        tabs={tabs}
        current="terms"
        sections={[
          { slug: "who", text: "Who these terms cover" },
          { slug: "account", text: "Your account" },
        ]}
      >
        <h2 id="who">Who these terms cover</h2>
      </LegalPage>,
    )
    expect(linksNamed("Terms of Service")[0]?.getAttribute("aria-current")).toBe("page")
    expect(document.querySelector("#short-h")?.textContent).toBe("The short version")
    const numbers = [...document.querySelectorAll("nav[aria-label=Sections] li span")]
    expect(numbers.map((n) => n.textContent)).toEqual(["1", "2"])
    await expectNoA11yViolations(html)
  })

  it("leaves out the summary and sections when a document has none", () => {
    render(
      <LegalPage
        title="Cookies"
        effective="[DATE]"
        updated="[DATE]"
        summary={[]}
        tabs={tabs}
        current="cookies"
        sections={[]}
      >
        <p>Text</p>
      </LegalPage>,
    )
    expect(document.querySelector("#short-h")).toBeNull()
    expect(document.querySelector("nav[aria-label=Sections]")).toBeNull()
  })
})
