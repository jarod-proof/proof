// @vitest-environment jsdom
import { expectNoA11yViolations } from "@proof/ui/a11y"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { PasswordSection, type PasswordSectionProps } from "./password"

function renderSection(overrides: Partial<PasswordSectionProps> = {}) {
  const props: PasswordSectionProps = {
    hasPassword: true,
    changedAt: "2026-07-01T10:00:00Z",
    onChange: vi.fn(async () => undefined),
    ...overrides,
  }
  render(<PasswordSection {...props} />)
  return props
}

async function openDialog() {
  await userEvent.click(screen.getByRole("button", { name: "Change password" }))
  return screen.findByRole("dialog")
}

describe("PasswordSection", () => {
  it("disables the change action for an account with no password", () => {
    renderSection({ hasPassword: false, changedAt: null })
    expect(screen.getByRole("button", { name: "Change password" }).hasAttribute("disabled")).toBe(
      true,
    )
  })

  it("refuses a new password that does not match its confirmation", async () => {
    const props = renderSection()
    const dialog = await openDialog()
    await userEvent.type(within(dialog).getByLabelText("Current password"), "old-password-1")
    await userEvent.type(within(dialog).getByLabelText("New password"), "new-password-1")
    await userEvent.type(within(dialog).getByLabelText("Confirm new password"), "new-password-2")
    await userEvent.click(within(dialog).getByRole("button", { name: "Change password" }))
    expect(await within(dialog).findByText("The two passwords do not match.")).toBeTruthy()
    expect(props.onChange).not.toHaveBeenCalled()
  })

  it("changes the password with the current and new values", async () => {
    const props = renderSection()
    const dialog = await openDialog()
    await userEvent.type(within(dialog).getByLabelText("Current password"), "old-password-1")
    await userEvent.type(within(dialog).getByLabelText("New password"), "new-password-1")
    await userEvent.type(within(dialog).getByLabelText("Confirm new password"), "new-password-1")
    await userEvent.click(within(dialog).getByRole("button", { name: "Change password" }))
    await waitFor(() =>
      expect(props.onChange).toHaveBeenCalledWith({
        currentPassword: "old-password-1",
        newPassword: "new-password-1",
      }),
    )
  })

  it("has no accessibility violations", async () => {
    const { container } = render(
      <PasswordSection hasPassword changedAt={null} onChange={vi.fn(async () => undefined)} />,
    )
    await expectNoA11yViolations(container.innerHTML)
  })
})
