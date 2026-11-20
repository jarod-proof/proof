// @vitest-environment jsdom
import { expectNoA11yViolations } from "@proof/ui/a11y"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { PasskeysSection, type PasskeysSectionProps } from "./passkeys"

function renderSection(overrides: Partial<PasskeysSectionProps> = {}) {
  const props: PasskeysSectionProps = {
    passkeys: [{ id: "pk-1", name: "MacBook Pro", createdAt: "2026-09-02T10:00:00Z" }],
    onAdd: vi.fn(async () => undefined),
    onRename: vi.fn(async () => undefined),
    onRemove: vi.fn(async () => undefined),
    ...overrides,
  }
  render(<PasskeysSection {...props} />)
  return props
}

describe("PasskeysSection", () => {
  it("lists the passkeys with a rename and a remove for each", () => {
    renderSection()
    expect(screen.getByText("MacBook Pro")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Rename MacBook Pro" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Remove MacBook Pro" })).toBeTruthy()
  })

  it("says so when there are none", () => {
    renderSection({ passkeys: [] })
    expect(screen.getByText("No passkeys yet.")).toBeTruthy()
  })

  it("adds a passkey under the name typed in the dialog", async () => {
    const props = renderSection()
    await userEvent.click(screen.getByRole("button", { name: "Add a passkey" }))
    const dialog = await screen.findByRole("dialog")
    const name = within(dialog).getByLabelText("Passkey name")
    await userEvent.clear(name)
    await userEvent.type(name, "Work laptop")
    await userEvent.click(within(dialog).getByRole("button", { name: "Continue" }))
    await waitFor(() => expect(props.onAdd).toHaveBeenCalledWith("Work laptop"))
  })

  it("refuses an empty passkey name without calling add", async () => {
    const props = renderSection()
    await userEvent.click(screen.getByRole("button", { name: "Add a passkey" }))
    const dialog = await screen.findByRole("dialog")
    await userEvent.clear(within(dialog).getByLabelText("Passkey name"))
    await userEvent.click(within(dialog).getByRole("button", { name: "Continue" }))
    expect(await within(dialog).findByText("Enter a name for this passkey.")).toBeTruthy()
    expect(props.onAdd).not.toHaveBeenCalled()
  })

  it("removes a passkey only after the confirm", async () => {
    const props = renderSection()
    await userEvent.click(screen.getByRole("button", { name: "Remove MacBook Pro" }))
    expect(props.onRemove).not.toHaveBeenCalled()
    const confirm = await screen.findByRole("alertdialog")
    await userEvent.click(within(confirm).getByRole("button", { name: "Remove passkey" }))
    await waitFor(() => expect(props.onRemove).toHaveBeenCalledWith("pk-1"))
  })

  it("has no accessibility violations", async () => {
    const { container } = render(
      <PasskeysSection
        passkeys={[{ id: "pk-1", name: "MacBook Pro", createdAt: null }]}
        onAdd={vi.fn(async () => undefined)}
        onRename={vi.fn(async () => undefined)}
        onRemove={vi.fn(async () => undefined)}
      />,
    )
    await expectNoA11yViolations(container.innerHTML)
  })
})
