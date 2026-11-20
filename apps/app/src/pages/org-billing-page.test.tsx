// @vitest-environment jsdom
import { expectNoA11yViolations } from "@proof/ui/a11y"
import { screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { fixtureSnapshot } from "../lib/billing/fixture"
import { renderWithClient } from "../test/render"
import { type OrgBillingPageProps, OrgBillingPage } from "./org-billing-page"

const acme = { name: "Acme Inc", slug: "acme" }

function props(overrides: Partial<OrgBillingPageProps> = {}): OrgBillingPageProps {
  return {
    organization: acme,
    roleLabel: "Owner",
    canChange: true,
    mode: "stripe",
    snapshot: {
      ...fixtureSnapshot(),
      sample: false,
      paymentMethod: null,
      invoiceEmail: null,
      invoices: null,
    },
    usage: { day: "2026-10-16", total: 3, limit: 500 },
    seatsUsed: 4,
    pending: false,
    actionError: null,
    onOpenPortal: vi.fn(),
    onChangePlan: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  }
}

describe("OrgBillingPage", () => {
  it("shows the requests-today card with its progress, and hides it while loading", () => {
    const { unmount } = renderWithClient(<OrgBillingPage {...props()} />)
    expect(screen.getByText("Requests today: 3 of 500")).toBeTruthy()
    expect(screen.getByRole("progressbar")).toBeTruthy()
    unmount()
    renderWithClient(<OrgBillingPage {...props({ usage: null })} />)
    expect(screen.queryByText(/Requests today/)).toBeNull()
  })

  it("says unlimited, with an empty bar, when the plan has no request cap", () => {
    renderWithClient(
      <OrgBillingPage {...props({ usage: { day: "2026-10-16", total: 12_345, limit: null } })} />,
    )
    expect(screen.getByText("Requests today: 12345 (unlimited)")).toBeTruthy()
  })

  it("keeps the screen-reader text for the arrow in the intro", () => {
    renderWithClient(<OrgBillingPage {...props()} />)
    expect(screen.getByText("with an arrow")).toBeTruthy()
  })

  it("as owner on stripe: real controls, the seat meter, and the portal for invoices", () => {
    renderWithClient(<OrgBillingPage {...props()} />)
    expect(
      (screen.getByRole("button", { name: "Manage subscription" }) as HTMLButtonElement).disabled,
    ).toBe(false)
    expect(screen.getByText("4 of 15 seats used")).toBeTruthy()
    expect(screen.queryByText("[SAMPLE DATA]")).toBeNull()
    expect(screen.getByText("Invoices are listed in Stripe's portal.")).toBeTruthy()
  })

  it("on the fixture, shows the sample labels and the not-connected notice", () => {
    renderWithClient(
      <OrgBillingPage {...props({ mode: "fixture", snapshot: fixtureSnapshot() })} />,
    )
    expect(screen.getByText("Billing isn't connected yet.")).toBeTruthy()
    expect(screen.getAllByText("[SAMPLE DATA]").length).toBeGreaterThan(0)
    expect(screen.getAllByText("[PRICE] / seat").length).toBeGreaterThan(0)
    expect(screen.getByRole("table")).toBeTruthy()
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual([
      "Date",
      "Status",
      "Amount",
      "Links",
    ])
    expect(screen.getAllByText("[AMOUNT]")).toHaveLength(3)
    expect((screen.getByRole("button", { name: "Edit" }) as HTMLButtonElement).disabled).toBe(true)
  })

  it("as viewer: every change is disabled and the view-only notice names the owner", () => {
    renderWithClient(<OrgBillingPage {...props({ canChange: false, roleLabel: "Viewer" })} />)
    expect(screen.getByText("You have view-only access to Acme Inc.")).toBeTruthy()
    expect(
      (screen.getByRole("button", { name: "Change seats" }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect((screen.getByRole("button", { name: "Edit" }) as HTMLButtonElement).disabled).toBe(true)
  })

  it("asks before cancelling, and only then calls back", async () => {
    const onCancel = vi.fn()
    renderWithClient(<OrgBillingPage {...props({ onCancel })} />)
    await userEvent.click(screen.getByRole("button", { name: "Cancel plan" }))
    const dialog = screen.getByRole("alertdialog")
    expect(within(dialog).getByText(/Stripe asks you to confirm/)).toBeTruthy()
    await userEvent.click(within(dialog).getByRole("button", { name: "Keep plan" }))
    expect(onCancel).not.toHaveBeenCalled()
  })

  it("offers plan changes for other plans on the fixture, all disabled with the reason", () => {
    renderWithClient(
      <OrgBillingPage {...props({ mode: "fixture", snapshot: fixtureSnapshot() })} />,
    )
    const upgrade = screen.getByRole("button", { name: "Upgrade" }) as HTMLButtonElement
    const downgrade = screen.getByRole("button", { name: "Downgrade" }) as HTMLButtonElement
    expect(upgrade.disabled).toBe(true)
    expect(downgrade.disabled).toBe(true)
  })

  it("passes the axe checks on the owner's stripe view and the fixture view", async () => {
    const stripe = renderWithClient(<OrgBillingPage {...props()} />)
    await expectNoA11yViolations(stripe.container.innerHTML)
    stripe.unmount()
    const fixture = renderWithClient(
      <OrgBillingPage {...props({ mode: "fixture", snapshot: fixtureSnapshot() })} />,
    )
    await expectNoA11yViolations(fixture.container.innerHTML)
  })
})

describe("OrgBillingPage landmark", () => {
  it("leaves the landmark to the app shell rather than nesting a main", () => {
    renderWithClient(<OrgBillingPage {...props()} />)
    expect(document.querySelector("main")).toBeNull()
  })
})
