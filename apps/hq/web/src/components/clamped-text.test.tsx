// @vitest-environment jsdom
import { expectNoA11yViolations } from "@proof/ui/a11y"
import { render } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"

import { ClampedText } from "./clamped-text"

describe("ClampedText", () => {
  it("shows a short text whole, with no clamp and no toggle", () => {
    const view = render(<ClampedText text="A short note." what="the note" />)
    const text = view.getByText("A short note.")
    expect(text.className).not.toContain("line-clamp")
    expect(view.queryByRole("button")).toBeNull()
  })

  it("clamps a long text and offers Show all, which names the text it opens", async () => {
    const user = userEvent.setup()
    const long = "word ".repeat(200)
    const view = render(<ClampedText text={long} what="the note" />)
    const text = view.container.querySelector("p") as HTMLElement
    expect(text.className).toContain("line-clamp-6")
    const toggle = view.getByRole("button", { name: /Show all/ })
    expect(toggle.getAttribute("aria-expanded")).toBe("false")
    expect(toggle.getAttribute("aria-controls")).toBe(text.id)
    expect(toggle.className).toContain("min-h-touch")
    await user.click(toggle)
    expect(text.className).not.toContain("line-clamp")
    expect(view.getByRole("button", { name: /Show less/ }).getAttribute("aria-expanded")).toBe(
      "true",
    )
    // the whole text is in the DOM either way: a clamp hides lines, never characters
    expect(text.textContent).toBe(long)
  })

  it("counts lines too: a short text with many lines is cut and offers Show all", () => {
    const view = render(<ClampedText text={"a\n".repeat(10)} what="the note" />)
    expect(view.getByRole("button", { name: /Show all/ })).toBeTruthy()
  })

  it("keeps a hostile 100 000 character text inside its box as plain text", () => {
    const hostile = `<img src=x onerror=alert(1)> [x](https://evil.example) ${"B".repeat(100_000)}`
    const view = render(<ClampedText text={hostile} what="the note" />)
    expect(view.container.querySelector("img")).toBeNull()
    expect(view.container.querySelector("a")).toBeNull()
    const text = view.container.querySelector("p") as HTMLElement
    expect(text.className).toContain("wrap-anywhere")
    expect(text.className).toContain("min-w-0")
    expect(text.textContent).toBe(hostile)
    expect(view.container.querySelector("[style]")).toBeNull()
  })

  it("has no accessibility violations, collapsed or expanded", async () => {
    const user = userEvent.setup()
    const collapsed = render(<ClampedText text={"x".repeat(1000)} what="the note" />)
    await expectNoA11yViolations(collapsed.container.innerHTML)
    collapsed.unmount()
    const view = render(<ClampedText text={"x".repeat(1000)} what="the note" />)
    await user.click(view.getByRole("button", { name: /Show all/ }))
    await expectNoA11yViolations(view.container.innerHTML)
  })
})
