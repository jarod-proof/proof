// @vitest-environment jsdom
import { expectNoA11yViolations } from "@proof/ui/a11y"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { type TwoFactorSectionProps, TwoFactorSection } from "./two-factor"

function renderSection(overrides: Partial<TwoFactorSectionProps> = {}) {
  const props: TwoFactorSectionProps = {
    enabled: true,
    enabledAt: "2026-09-02T10:00:00Z",
    backupCodesRemaining: 8,
    hasPassword: true,
    onEnable: vi.fn(async () => ({
      totpURI: "otpauth://totp/Acme:jordan?secret=ABCDEF",
      backupCodes: [],
    })),
    onConfirm: vi.fn(async () => undefined),
    onDisable: vi.fn(async () => undefined),
    onNewCodes: vi.fn(async () => ["aaaa-1111"]),
    ...overrides,
  }
  render(<TwoFactorSection {...props} />)
  return props
}

describe("TwoFactorSection", () => {
  it("offers to turn two-factor off and to make new codes when it is on", () => {
    renderSection()
    expect(screen.getByRole("button", { name: "Turn off" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Make new codes" })).toBeTruthy()
    expect(screen.getByText("8 of 10 left · each works once")).toBeTruthy()
  })

  it("offers to turn it on when it is off", () => {
    renderSection({ enabled: false, enabledAt: null, backupCodesRemaining: null })
    expect(screen.getByRole("button", { name: "Turn on" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Turn off" })).toBeNull()
  })

  it("turns it off only after the password is confirmed", async () => {
    const props = renderSection()
    await userEvent.click(screen.getByRole("button", { name: "Turn off" }))
    const dialog = await screen.findByRole("alertdialog")
    await userEvent.type(within(dialog).getByLabelText("Password"), "pw-123456789")
    await userEvent.click(within(dialog).getByRole("button", { name: "Turn off two-factor" }))
    await waitFor(() => expect(props.onDisable).toHaveBeenCalledWith("pw-123456789"))
  })

  it("asks for a password before turning it off and does not call disable without one", async () => {
    const props = renderSection()
    await userEvent.click(screen.getByRole("button", { name: "Turn off" }))
    const dialog = await screen.findByRole("alertdialog")
    await userEvent.click(within(dialog).getByRole("button", { name: "Turn off two-factor" }))
    expect(await within(dialog).findByText("Enter your password.")).toBeTruthy()
    expect(props.onDisable).not.toHaveBeenCalled()
  })

  it("has no accessibility violations", async () => {
    const { container } = render(
      <TwoFactorSection
        enabled
        enabledAt={null}
        backupCodesRemaining={8}
        hasPassword
        onEnable={vi.fn(async () => ({ totpURI: "", backupCodes: [] }))}
        onConfirm={vi.fn(async () => undefined)}
        onDisable={vi.fn(async () => undefined)}
        onNewCodes={vi.fn(async () => [])}
      />,
    )
    await expectNoA11yViolations(container.innerHTML)
  })
})
