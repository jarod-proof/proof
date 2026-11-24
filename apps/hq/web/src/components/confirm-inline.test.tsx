// @vitest-environment jsdom
import { expectNoA11yViolations } from "@proof/ui/a11y"
import { render } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { ConfirmInline } from "./confirm-inline"

function setup(props: { pending?: boolean } = {}) {
  const onConfirm = vi.fn()
  const view = render(
    <ConfirmInline
      label="Approve merge"
      confirmLabel="Confirm"
      onConfirm={onConfirm}
      pending={props.pending ?? false}
    >
      <span>Head aaaaaaa</span>
    </ConfirmInline>,
  )
  return { view, onConfirm, user: userEvent.setup() }
}

describe("ConfirmInline", () => {
  it("shows only the label until it is clicked, and clicking it sends nothing", async () => {
    const { view, onConfirm, user } = setup()
    expect(view.queryByText("Head aaaaaaa")).toBeNull()
    await user.click(view.getByRole("button", { name: "Approve merge" }))
    expect(view.getByText("Head aaaaaaa")).toBeTruthy()
    expect(view.getByRole("group", { name: "Approve merge" })).toBeTruthy()
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it("Confirm calls onConfirm once per click and Cancel closes without calling it", async () => {
    const { view, onConfirm, user } = setup()
    await user.click(view.getByRole("button", { name: "Approve merge" }))
    await user.click(view.getByRole("button", { name: "Cancel" }))
    expect(onConfirm).not.toHaveBeenCalled()
    expect(view.queryByRole("group")).toBeNull()
    await user.click(view.getByRole("button", { name: "Approve merge" }))
    await user.click(view.getByRole("button", { name: "Confirm" }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it("is disabled while pending", async () => {
    const { view, user } = setup({ pending: true })
    const open = view.getByRole("button", { name: "Approve merge" }) as HTMLButtonElement
    expect(open.disabled).toBe(true)
    await user.click(open)
    expect(view.queryByRole("group")).toBeNull()
  })

  it("every control is min-h-touch and the markup has no inline style or a11y violation", async () => {
    const { view, user } = setup()
    await user.click(view.getByRole("button", { name: "Approve merge" }))
    for (const button of view.container.querySelectorAll("button")) {
      expect(button.className).toContain("min-h-touch")
    }
    expect(view.container.querySelector("[style]")).toBeNull()
    await expectNoA11yViolations(view.container.innerHTML)
  })
})
