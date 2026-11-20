// @vitest-environment jsdom
import { expectNoA11yViolations } from "@proof/ui/a11y"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { detailFixture, flagFixture } from "../test/fake-feature-flags"
import { FeatureFlagsPage, type FeatureFlagsPageProps } from "./feature-flags-page"

function props(overrides: Partial<FeatureFlagsPageProps> = {}): FeatureFlagsPageProps {
  return {
    organization: { name: "Acme Inc" },
    roleLabel: "Owner",
    tabs: [
      { id: "users", label: "Users", href: "/admin/users" },
      { id: "flags", label: "Feature flags", href: "/admin/flags" },
    ],
    flags: [
      flagFixture(),
      flagFixture({
        key: "old-banner",
        status: "orphaned",
        inCatalog: false,
        description: null,
        stale: ["orphaned"],
      }),
    ],
    flagsError: null,
    onRetry: vi.fn(),
    selectedKey: null,
    onSelect: vi.fn(),
    detail: undefined,
    detailError: null,
    onUpdate: vi.fn(async () => undefined),
    onTarget: vi.fn(async () => undefined),
    onUntarget: vi.fn(async () => undefined),
    onReclaim: vi.fn(async () => undefined),
    onDelete: vi.fn(async () => undefined),
    ...overrides,
  }
}

function renderPage(overrides: Partial<FeatureFlagsPageProps> = {}) {
  const p = props(overrides)
  render(<FeatureFlagsPage {...p} />)
  return p
}

describe("FeatureFlagsPage", () => {
  it("lists flags with status, rollout, evaluations and stale signals", async () => {
    const p = renderPage()
    const table = screen.getByRole("table", { name: "Feature flags" })
    const row = within(table).getByText("new-search").closest("tr") as HTMLElement
    expect(within(row).getByText("Ramping")).toBeTruthy()
    expect(within(row).getByText("25%")).toBeTruthy()
    expect(within(row).getByText("1 on")).toBeTruthy()
    const orphan = within(table).getByText("old-banner").closest("tr") as HTMLElement
    expect(within(orphan).getByText("Not in code")).toBeTruthy()
    expect(within(orphan).getByText("Delete rollout")).toBeTruthy()
    // The console's Feature flags tab is current.
    expect(screen.getByRole("link", { name: "Feature flags" }).getAttribute("aria-current")).toBe(
      "page",
    )
    await userEvent.setup().click(within(row).getByRole("button", { name: "Manage new-search" }))
    expect(p.onSelect).toHaveBeenCalledWith("new-search")
    await expectNoA11yViolations(document.body.innerHTML)
  })

  it("shows a failed list with a retry", async () => {
    const p = renderPage({ flags: undefined, flagsError: "Could not load. Try later." })
    await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }))
    expect(p.onRetry).toHaveBeenCalled()
  })

  it("ramps, sets a percentage, pauses and validates", async () => {
    const user = userEvent.setup()
    const p = renderPage({ selectedKey: "new-search", detail: detailFixture() })
    const detail = screen.getByRole("region", { name: "new-search" })
    await user.click(within(detail).getByRole("button", { name: "50%" }))
    expect(p.onUpdate).toHaveBeenCalledWith("new-search", { percentage: 50 })
    const input = within(detail).getByLabelText("Percentage")
    await user.clear(input)
    await user.type(input, "150")
    await user.click(within(detail).getByRole("button", { name: "Set percentage" }))
    expect(await within(detail).findByText("Enter a whole number from 0 to 100.")).toBeTruthy()
    await user.clear(input)
    await user.type(input, "10")
    await user.click(within(detail).getByRole("button", { name: "Set percentage" }))
    await waitFor(() => expect(p.onUpdate).toHaveBeenCalledWith("new-search", { percentage: 10 }))
    await user.click(within(detail).getByRole("button", { name: /Pause/ }))
    expect(p.onUpdate).toHaveBeenCalledWith("new-search", { enabled: false })
    await expectNoA11yViolations(document.body.innerHTML)
  })

  it("adds and removes targets, and shows the server's refusal", async () => {
    const user = userEvent.setup()
    const p = renderPage({
      selectedKey: "new-search",
      detail: detailFixture(),
      onTarget: vi.fn(async () => {
        throw new Error("No organization with id or slug: nope Pass ids or slugs that exist.")
      }),
    })
    const detail = screen.getByRole("region", { name: "new-search" })
    await user.click(within(detail).getByRole("button", { name: "Remove Beta Co from new-search" }))
    expect(p.onUntarget).toHaveBeenCalledWith("new-search", "org-b")
    await user.type(within(detail).getByLabelText("Organizations"), "acme, nope")
    await user.selectOptions(within(detail).getByLabelText("Turn the flag"), "off")
    await user.click(within(detail).getByRole("button", { name: "Add targets" }))
    await waitFor(() =>
      expect(p.onTarget).toHaveBeenCalledWith("new-search", ["acme", "nope"], false),
    )
    expect(await within(detail).findByText(/Pass ids or slugs that exist/)).toBeTruthy()
  })

  it("reclaims only after confirming, naming the value", async () => {
    const user = userEvent.setup()
    const p = renderPage({ selectedKey: "new-search", detail: detailFixture() })
    await user.click(screen.getByRole("button", { name: "Reclaim as on" }))
    const dialog = await screen.findByRole("alertdialog")
    expect(within(dialog).getByText(/can't be undone/)).toBeTruthy()
    expect(p.onReclaim).not.toHaveBeenCalled()
    await user.click(within(dialog).getByRole("button", { name: "Reclaim as on" }))
    await waitFor(() => expect(p.onReclaim).toHaveBeenCalledWith("new-search", true))
  })

  it("freezes a reclaimed flag, and deletes only an orphaned rollout", async () => {
    const user = userEvent.setup()
    renderPage({
      selectedKey: "new-search",
      detail: detailFixture({ status: "reclaimed", reclaimedValue: true }),
    })
    const detail = screen.getByRole("region", { name: "new-search" })
    expect(within(detail).getByText(/every organization gets on/)).toBeTruthy()
    expect(within(detail).queryByRole("button", { name: "50%" })).toBeNull()
    expect(within(detail).queryByRole("button", { name: /Remove Beta Co/ })).toBeNull()
    expect(
      (within(detail).getByRole("button", { name: "Delete rollout" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)

    const orphan = detailFixture({
      key: "old-banner",
      status: "orphaned",
      inCatalog: false,
      description: null,
      targets: [],
    })
    const p = renderPage({ selectedKey: "old-banner", detail: orphan })
    const orphanDetail = screen.getByRole("region", { name: "old-banner" })
    await user.click(within(orphanDetail).getByRole("button", { name: "Delete rollout" }))
    const dialog = await screen.findByRole("alertdialog")
    await user.click(within(dialog).getByRole("button", { name: "Delete rollout" }))
    await waitFor(() => expect(p.onDelete).toHaveBeenCalledWith("old-banner"))
  })

  it("says while the selected flag loads, or why it can't", () => {
    renderPage({ selectedKey: "new-search", detail: undefined })
    expect(screen.getByText("Loading new-search…")).toBeTruthy()
  })

  it("shows a detail failure", () => {
    renderPage({ selectedKey: "new-search", detail: undefined, detailError: "Not found" })
    expect(screen.getByRole("alert").textContent).toBe("Not found")
  })

  it("explains an empty catalog", () => {
    renderPage({ flags: [] })
    expect(screen.getByText("No feature flags yet")).toBeTruthy()
  })
})
