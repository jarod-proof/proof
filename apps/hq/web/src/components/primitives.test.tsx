// @vitest-environment jsdom
import { expectNoA11yViolations } from "@proof/ui/a11y"
import { render } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { AppFrame } from "./app-frame"
import { KpiCard } from "./kpi-card"
import { PageHeader } from "./page-header"
import { Section } from "./section"

describe("page primitives", () => {
  it("PageHeader renders the title as the page's h1, a subtitle and actions", () => {
    const view = render(
      <PageHeader
        title="Approvals"
        subtitle="2 waiting"
        actions={<button type="button">Go</button>}
      />,
    )
    expect(view.getByRole("heading", { level: 1, name: "Approvals" })).toBeTruthy()
    expect(view.getByText("2 waiting")).toBeTruthy()
    expect(view.getByRole("button", { name: "Go" })).toBeTruthy()
    view.rerender(<PageHeader title="Digest" />)
    expect(view.queryByText("2 waiting")).toBeNull()
  })

  it("Section is a region labelled by its heading, with an optional count and description", () => {
    const view = render(
      <Section id="needs-you" title="Needs you" count={4} tone="attention" description="Waiting">
        <p>body</p>
      </Section>,
    )
    const region = view.getByRole("region", { name: /Needs you/ })
    expect(region.querySelector("h2")?.id).toBe("needs-you")
    expect(region.textContent).toContain("4")
    expect(view.getByText("Waiting")).toBeTruthy()
    expect(view.getByText("body")).toBeTruthy()
  })

  it("Section without a count shows none", () => {
    const view = render(
      <Section id="plain" title="Plain">
        <p>x</p>
      </Section>,
    )
    expect(view.getByRole("region", { name: "Plain" })).toBeTruthy()
  })

  it("KpiCard shows label, value, status and note, with a tone class per tone", () => {
    const tones = {
      default: "text-foreground",
      ok: "text-success",
      attention: "text-solar",
      bad: "text-destructive",
    } as const
    for (const [tone, cls] of Object.entries(tones)) {
      const view = render(
        <KpiCard
          label="Spend"
          value="$3.80"
          status="38%"
          note="of $10"
          tone={tone as keyof typeof tones}
        />,
      )
      expect(view.getByText("$3.80").className).toContain(cls)
      expect(view.getByText("Spend")).toBeTruthy()
      expect(view.getByText("38%")).toBeTruthy()
      expect(view.getByText("of $10")).toBeTruthy()
      view.unmount()
    }
    const bare = render(<KpiCard label="Runs" value="3" />)
    expect(bare.getByText("3").className).toContain("text-foreground")
  })

  it("AppFrame holds the sidebar and the main panel and wraps on a narrow screen", () => {
    const view = render(
      <AppFrame sidebar={<nav aria-label="Primary">side</nav>}>
        <p>content</p>
      </AppFrame>,
    )
    const main = view.getByRole("main")
    expect(main.textContent).toBe("content")
    expect(view.getByRole("navigation", { name: "Primary" })).toBeTruthy()
    expect(view.container.firstElementChild?.className).toContain("flex-wrap")
    expect(view.container.querySelector("[style]")).toBeNull()
  })

  it("AppFrame packs wrapped lines at the top, so no gap opens above the runner card", () => {
    const view = render(
      <AppFrame sidebar={<nav aria-label="Primary">side</nav>}>
        <p>content</p>
      </AppFrame>,
    )
    const classes = (view.container.firstElementChild?.className ?? "").split(/\s+/)
    // Wrapped (a phone), the spare viewport height must not be shared between the two lines: the
    // sidebar's spacer would push the runner card down by the share. Side by side (one line
    // spanning the sidebar's 232px and the panel's 560px basis) the line still fills the viewport.
    expect(classes).toContain("content-start")
    expect(classes).toContain("min-[792px]:content-stretch")
    expect(classes).toContain("min-h-screen")
  })

  it("has no a11y violations", async () => {
    const view = render(
      <AppFrame sidebar={<nav aria-label="Primary">side</nav>}>
        <PageHeader title="Digest" subtitle="s" />
        <Section id="a" title="A" count={1}>
          <KpiCard label="l" value="v" note="n" />
        </Section>
      </AppFrame>,
    )
    await expectNoA11yViolations(view.container.innerHTML)
  })
})
