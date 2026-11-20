// @vitest-environment jsdom
import { expectNoA11yViolations } from "@proof/ui/a11y"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { ConnectedAccountsSection, type ConnectedAccountsSectionProps } from "./connected-accounts"

const ROWS: ConnectedAccountsSectionProps["rows"] = [
  { accountId: "acc-gh", provider: "github", label: "GitHub", connectedAt: "2026-09-02T10:00:00Z" },
  { accountId: null, provider: "google", label: "Google", connectedAt: null },
]

function renderSection(overrides: Partial<ConnectedAccountsSectionProps> = {}) {
  const props: ConnectedAccountsSectionProps = {
    rows: ROWS,
    onConnect: vi.fn(async () => undefined),
    onDisconnect: vi.fn(async () => undefined),
    ...overrides,
  }
  render(<ConnectedAccountsSection {...props} />)
  return props
}

describe("ConnectedAccountsSection", () => {
  it("shows a disconnect for a connected provider and a connect for one not connected", () => {
    renderSection()
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Connect" })).toBeTruthy()
  })

  it("disconnects an account only after the confirm", async () => {
    const props = renderSection()
    await userEvent.click(screen.getByRole("button", { name: "Disconnect" }))
    expect(props.onDisconnect).not.toHaveBeenCalled()
    const confirm = await screen.findByRole("alertdialog")
    expect(within(confirm).getByText("Disconnect GitHub?")).toBeTruthy()
    await userEvent.click(within(confirm).getByRole("button", { name: "Disconnect GitHub" }))
    await waitFor(() => expect(props.onDisconnect).toHaveBeenCalledWith("acc-gh"))
  })

  it("connects a provider that is not connected yet", async () => {
    const props = renderSection()
    await userEvent.click(screen.getByRole("button", { name: "Connect" }))
    await waitFor(() => expect(props.onConnect).toHaveBeenCalledWith("google"))
  })

  it("has no accessibility violations", async () => {
    const { container } = render(
      <ConnectedAccountsSection
        rows={ROWS}
        onConnect={vi.fn(async () => undefined)}
        onDisconnect={vi.fn(async () => undefined)}
      />,
    )
    await expectNoA11yViolations(container.innerHTML)
  })
})
