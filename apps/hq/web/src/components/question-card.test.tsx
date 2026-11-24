// @vitest-environment jsdom
import { expectNoA11yViolations } from "@proof/ui/a11y"
import { render } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import type { QuestionView } from "../api/schemas"
import { questionFixture } from "../test/fixtures"
import { QuestionCard } from "./question-card"

const answered = (overrides: Partial<QuestionView> = {}): QuestionView =>
  questionFixture({
    status: "answered",
    answeredOptionId: "up",
    answeredBy: "founder-1",
    answeredAt: "2026-11-17T12:01:00.000Z",
    ...overrides,
  })

function setup(question: QuestionView, pending = false) {
  const onAnswer = vi.fn()
  const view = render(<QuestionCard question={question} onAnswer={onAnswer} pending={pending} />)
  return { view, onAnswer, user: userEvent.setup() }
}

describe("QuestionCard", () => {
  it("shows the prompt, lettered options in hq's order, the default marked and 'waits for your answer'", () => {
    const { view } = setup(questionFixture())
    expect(view.getByText("Round half up, or half to even as the ledger does?")).toBeTruthy()
    const buttons = view.getAllByRole("button")
    expect(buttons).toHaveLength(2)
    expect(buttons[0]?.textContent).toContain("A")
    expect(buttons[0]?.textContent).toContain("Half up")
    expect(buttons[0]?.textContent).toContain("default")
    expect(buttons[1]?.textContent).toContain("B")
    expect(buttons[1]?.textContent).toContain("Half to even")
    expect(buttons[1]?.textContent).not.toContain("default")
    expect(view.getByText("What customers expect on a receipt.")).toBeTruthy()
    expect(view.getByText("waits for your answer")).toBeTruthy()
    // the default is a recommendation: nothing says it applies on its own
    expect(view.getByText(/recommendation/).textContent).toContain("Nothing applies it for you")
    for (const button of buttons) expect(button.className).toContain("min-h-touch")
  })

  it("keeps hq's order even when the recommended option is not first", () => {
    const { view } = setup(questionFixture({ defaultOptionId: "even" }))
    const buttons = view.getAllByRole("button")
    expect(buttons[0]?.textContent).toContain("Half up")
    expect(buttons[0]?.textContent).not.toContain("default")
    expect(buttons[1]?.textContent).toContain("Half to even")
    expect(buttons[1]?.textContent).toContain("default")
  })

  it("shows no recommendation line and no default mark when hq names none", () => {
    const { view } = setup(questionFixture({ defaultOptionId: null }))
    expect(view.queryByText(/default/)).toBeNull()
    expect(view.queryByText(/recommendation/)).toBeNull()
  })

  it("calls onAnswer once per click with the option id, and nothing else", async () => {
    const { view, onAnswer, user } = setup(questionFixture())
    await user.click(view.getAllByRole("button")[1] as HTMLElement)
    expect(onAnswer).toHaveBeenCalledTimes(1)
    expect(onAnswer).toHaveBeenCalledWith("even")
  })

  it("disables the buttons while a write is on its way", async () => {
    const { view, onAnswer, user } = setup(questionFixture(), true)
    for (const button of view.getAllByRole("button")) {
      expect((button as HTMLButtonElement).disabled).toBe(true)
      await user.click(button)
    }
    expect(onAnswer).not.toHaveBeenCalled()
  })

  it("after an answer says 'You answered A' and shows no buttons", () => {
    const { view } = setup(answered())
    expect(view.getByText("You answered A")).toBeTruthy()
    expect(view.queryByRole("button")).toBeNull()
    expect(view.queryByText("waits for your answer")).toBeNull()
    // the options are still listed, lettered, with the default marked
    const items = view.getAllByRole("listitem")
    expect(items).toHaveLength(2)
    expect(items[0]?.textContent).toContain("A")
    expect(items[0]?.textContent).toContain("default")
  })

  it("letters the answer by hq's option order, not by the recommendation", () => {
    const { view } = setup(answered({ answeredOptionId: "even" }))
    expect(view.getByText("You answered B")).toBeTruthy()
  })

  it("invents no letter when the answered option is not among the options", () => {
    const { view } = setup(answered({ answeredOptionId: "gone" }))
    expect(view.getByText("Answered")).toBeTruthy()
    expect(view.queryByText(/You answered/)).toBeNull()
  })

  it("a withdrawn question has no buttons and says no answer is needed", () => {
    const { view } = setup(questionFixture({ status: "withdrawn" }))
    expect(view.queryByRole("button")).toBeNull()
    expect(view.getByText("Withdrawn. No answer is needed.")).toBeTruthy()
  })

  it("a question prompt of 40 000 characters or HTML renders as text, cut with Show all, answers still visible", async () => {
    const prompt = `<img src=x onerror=alert(1)> <script>alert(1)</script> [x](https://evil.example) ${"P".repeat(40_000)}`
    const { view, onAnswer, user } = setup(
      questionFixture({
        prompt,
        options: [
          { id: "up", label: "<b>Half up</b>", detail: `<i>d</i> ${"D".repeat(500)}` },
          { id: "even", label: "Half to even" },
        ],
      }),
    )
    expect(view.container.querySelector("img")).toBeNull()
    expect(view.container.querySelector("script")).toBeNull()
    expect(view.container.querySelector("b")).toBeNull()
    expect(view.container.querySelector("i")).toBeNull()
    expect(view.container.querySelector("a")).toBeNull()
    expect(view.container.textContent).toContain(prompt)
    expect(view.container.textContent).toContain("<b>Half up</b>")
    const toggle = view.getByRole("button", { name: /Show all/ })
    expect(toggle.className).toContain("min-h-touch")
    const article = view.container.querySelector("article") as HTMLElement
    expect(article.className).toContain("min-w-0")
    expect(article.className).toContain("overflow-hidden")
    // an option button wraps long text and stays inside the card
    const first = view.getAllByRole("button").find((b) => b.textContent?.includes("Half up"))
    expect(first?.className).toContain("whitespace-normal")
    expect(first?.className).toContain("wrap-anywhere")
    await user.click(first as HTMLElement)
    expect(onAnswer).toHaveBeenCalledWith("up")
  })

  it("has no inline style and no accessibility violations, open or answered", async () => {
    const open = setup(questionFixture({ prompt: "x".repeat(2000) }))
    expect(open.view.container.querySelector("[style]")).toBeNull()
    await expectNoA11yViolations(open.view.container.innerHTML)
    open.view.unmount()
    const done = setup(answered())
    expect(done.view.container.querySelector("[style]")).toBeNull()
    await expectNoA11yViolations(done.view.container.innerHTML)
  })
})
