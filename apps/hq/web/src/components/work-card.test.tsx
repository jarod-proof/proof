// @vitest-environment jsdom
import { expectNoA11yViolations } from "@proof/ui/a11y"
import { describe, expect, it } from "vitest"

import { renderInRouter } from "../test/render"
import { workSummaryFixture } from "../test/fixtures"
import { WorkCard } from "./work-card"

describe("WorkCard", () => {
  it("shows the id, the source, a title that links to the item page, the meta, the state and its detail", async () => {
    const view = await renderInRouter(
      <WorkCard
        item={workSummaryFixture({
          card: { label: "watching", tone: "teal", detail: "verifier · 2h14m left" },
          attention: null,
        })}
      />,
    )
    expect(view.getByText("FAC-6")).toBeTruthy()
    expect(view.getByText("GitHub")).toBeTruthy()
    const link = view.getByRole("link", { name: "Empty cart crashes the checkout" })
    expect(link.getAttribute("href")).toBe("/app/work/FAC-6")
    expect(link.className).toContain("min-h-touch")
    const state = view.getByText("watching")
    expect(state.className).toContain("text-success")
    expect(view.getByText("verifier · 2h14m left")).toBeTruthy()
    expect(view.getByText(/PR/).textContent).toContain("106")
  })

  it("maps each tone to a token and each source to its label and dot", async () => {
    const tones = [
      ["blue", "text-primary"],
      ["dim", "text-muted-foreground"],
      ["amber", "text-solar"],
      ["teal", "text-success"],
      ["coral", "text-destructive"],
    ] as const
    for (const [tone, expected] of tones) {
      const view = await renderInRouter(
        <WorkCard item={workSummaryFixture({ card: { label: "running", tone, detail: "x" } })} />,
      )
      expect(view.getByText("running").className).toContain(expected)
      view.unmount()
    }
    const sources = [
      ["github_issue", "GitHub", "bg-primary"],
      ["ci_failure", "CI", "bg-soft"],
      ["manual", "Manual", "bg-faint"],
    ] as const
    for (const [source, label, dot] of sources) {
      const view = await renderInRouter(<WorkCard item={workSummaryFixture({ source })} />)
      const text = view.getByText(label)
      expect(text).toBeTruthy()
      expect(text.parentElement?.querySelector(`.${dot}`), source).not.toBeNull()
      view.unmount()
    }
  })

  it("renders title and summary as plain text, bounded", async () => {
    const hostile = `<img src=x onerror=alert(1)> [x](https://evil.example) ${"B".repeat(5000)}`
    const view = await renderInRouter(
      <WorkCard item={workSummaryFixture({ title: hostile, summary: hostile })} />,
    )
    expect(view.container.querySelector("img")).toBeNull()
    expect(view.container.querySelectorAll("a")).toHaveLength(1)
    const article = view.container.querySelector("article") as HTMLElement
    expect(article.className).toContain("min-w-0")
    const link = article.querySelector("a") as HTMLElement
    expect(link.className).toContain("wrap-anywhere")
    expect(link.querySelector(".line-clamp-3")).not.toBeNull()
    expect(article.querySelector("p")?.className).toContain("wrap-anywhere")
    expect(view.container.querySelector("[style]")).toBeNull()
  })

  it("shows the fix attempts used of the limit when there is a limit, and nothing invented when not", async () => {
    const withLimit = await renderInRouter(
      <WorkCard item={workSummaryFixture({ attempts: { used: 1, limit: 3, running: false } })} />,
    )
    expect(withLimit.getByText(/1 of 3 fix attempts/)).toBeTruthy()
    withLimit.unmount()
    const none = await renderInRouter(
      <WorkCard
        item={workSummaryFixture({
          attempts: { used: 0, limit: null, running: false },
          pullRequest: null,
        })}
      />,
    )
    expect(none.container.textContent).not.toMatch(/fix attempts|PR/)
    await expectNoA11yViolations(none.container.innerHTML)
  })
})
