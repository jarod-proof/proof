// @vitest-environment jsdom
import { expectNoA11yViolations } from "@proof/ui/a11y"
import { render } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { NotConfigured } from "./not-configured"

describe("NotConfigured", () => {
  it("is a note that says what is not configured and when it arrives", () => {
    const view = render(<NotConfigured phase="Phase 5" what="the autonomy levels" />)
    const note = view.getByRole("note")
    expect(note.textContent).toBe("Not configured: the autonomy levels. Arrives in Phase 5.")
  })

  it("carries no inline style and passes the a11y check", async () => {
    const view = render(<NotConfigured phase="a later phase" what="the per-attempt sandbox" />)
    expect(view.container.querySelector("[style]")).toBeNull()
    await expectNoA11yViolations(view.container.innerHTML)
  })
})
