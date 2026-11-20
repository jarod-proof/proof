// @vitest-environment jsdom
import { expectNoA11yViolations } from "@proof/ui/a11y"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { ConfirmDialog } from "./confirm-dialog"

function renderDialog(props: Partial<Parameters<typeof ConfirmDialog>[0]> = {}) {
  const onConfirm = vi.fn()
  const onOpenChange = vi.fn()
  const view = render(
    <ConfirmDialog
      open
      onOpenChange={onOpenChange}
      title="Leave Acme?"
      description="You'll lose access right away."
      confirmLabel="Leave organization"
      pendingLabel="Leaving…"
      onConfirm={onConfirm}
      {...props}
    />,
  )
  return { onConfirm, onOpenChange, unmount: view.unmount }
}

describe("ConfirmDialog", () => {
  it("renders the title, the consequence and both buttons", () => {
    renderDialog()
    expect(screen.getByRole("alertdialog", { name: "Leave Acme?" })).toBeTruthy()
    expect(screen.getByText("You'll lose access right away.")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Leave organization" })).toBeTruthy()
  })

  it("calls back when confirmed", async () => {
    const { onConfirm } = renderDialog()
    await userEvent.click(screen.getByRole("button", { name: "Leave organization" }))
    expect(onConfirm).toHaveBeenCalledOnce()
  })

  it("disables confirm and shows the pending label while the action runs", () => {
    const { onConfirm } = renderDialog({ pending: true })
    const confirm = screen.getByRole("button", { name: "Leaving…" })
    expect(confirm.hasAttribute("disabled")).toBe(true)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it("disables confirm without pending when confirmDisabled is set", () => {
    renderDialog({ confirmDisabled: true })
    expect(
      screen.getByRole("button", { name: "Leave organization" }).hasAttribute("disabled"),
    ).toBe(true)
  })

  it("shows an error above the buttons", () => {
    renderDialog({ error: "Could not leave." })
    expect(screen.getByRole("alert").textContent).toBe("Could not leave.")
  })

  it("styles a destructive confirm with the red outline", () => {
    renderDialog({ destructive: true })
    const confirm = screen.getByRole("button", { name: "Leave organization" })
    expect(confirm.className).toContain("text-destructive")
    expect(confirm.className).toContain("border-destructive")
  })

  it("reports the close request when Cancel is pressed", async () => {
    const { onOpenChange, onConfirm } = renderDialog({ cancelLabel: "Keep plan" })
    await userEvent.click(screen.getByRole("button", { name: "Keep plan" }))
    expect(onOpenChange.mock.calls[0]?.[0]).toBe(false)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it("has no accessibility violations", async () => {
    // The helper writes its markup into document.body, where the portal lives: snapshot, unmount.
    const { unmount } = renderDialog({ destructive: true, error: "Could not leave." })
    const html = document.body.innerHTML
    unmount()
    await expectNoA11yViolations(html)
  })
})
