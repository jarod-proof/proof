// @vitest-environment jsdom

import type { createClient } from "@proof/auth/client"
import { expectNoA11yViolations } from "@proof/ui/a11y"
import { QueryClientProvider } from "@tanstack/react-query"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { BillingAdapter, BillingSnapshot, BillingUsage } from "../lib/billing/adapter"
import { fixtureBillingAdapter, fixtureSnapshot } from "../lib/billing/fixture"
import { billingAdapterOnce } from "../lib/billing/select"
import type { OrgSettingsApi } from "../lib/org-settings-api"
import { fakeAuth } from "../test/fake-auth"
import { renderWithClient } from "../test/render"
import { OrgBillingContainer } from "./org-billing"

const acme = { id: "org-a", name: "Acme Inc", slug: "acme" }
const USAGE: BillingUsage = { day: "2026-10-16", total: 3, limit: 500 }

// The catalog's rules: owners and admins manage the subscription; members and viewers have no grant.
const ALLOWED: Record<string, string[]> = {
  owner: ["subscription:read", "subscription:update"],
  admin: ["subscription:read", "subscription:update"],
  member: [],
  viewer: [],
}

function fakeApi(): OrgSettingsApi {
  return {
    getOrganization: vi.fn(),
    listMembers: vi.fn(async () => ({
      total: 4,
      members: [{ id: "m-self", userId: "user-1", role: "owner", name: "Ada", email: "a@x.dev" }],
    })),
    updateOrganization: vi.fn(),
    updateMemberRole: vi.fn(),
    leaveOrganization: vi.fn(),
    deleteOrganization: vi.fn(),
    countApiKeys: vi.fn(),
    roleAllows: vi.fn((role: string, permissions: Record<string, string[]>) => {
      const granted = role.split(",").flatMap((part) => ALLOWED[part.trim()] ?? [])
      return Object.entries(permissions).every(([resource, actions]) =>
        actions.every((action: string) => granted.includes(`${resource}:${action}`)),
      )
    }),
  }
}

function stripeAdapter(
  snapshot: BillingSnapshot = { ...fixtureSnapshot(), sample: false },
): BillingAdapter {
  return {
    mode: "stripe",
    load: vi.fn(async () => snapshot),
    usage: vi.fn(async () => USAGE),
    openPortal: vi.fn(async () => ({ url: "https://billing.test/portal" })),
    changePlan: vi.fn(async () => ({ url: "https://billing.test/checkout" })),
    cancel: vi.fn(async () => ({ url: "https://billing.test/cancel" })),
  }
}

function setup(options: { role?: string; adapter?: BillingAdapter } = {}) {
  const auth = fakeAuth({ memberRole: vi.fn(async () => options.role ?? "owner") })
  // The fixture's usage is the API's (a real fetch); tests stub it so no request leaves jsdom.
  const adapter = options.adapter ?? { ...fixtureBillingAdapter, usage: vi.fn(async () => USAGE) }
  const rendered = renderWithClient(
    <OrgBillingContainer auth={auth} api={fakeApi()} organization={acme} adapter={adapter} />,
  )
  return { auth, adapter, ...rendered }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("OrgBillingContainer as owner, fixture", () => {
  it("shows the board's sample plan with [PRICE] and the sample labels", async () => {
    setup()
    expect(await screen.findByRole("heading", { name: "Pro" })).toBeTruthy()
    expect(screen.getByText("Acme Inc · you are Owner")).toBeTruthy()
    expect(screen.getAllByText("[SAMPLE DATA]").length).toBeGreaterThan(0)
    expect(screen.getAllByText(/\[PRICE\]/).length).toBeGreaterThan(0)
    expect(screen.getByText("Card ending 4242 · expires 08/28")).toBeTruthy()
    expect(screen.getByText("Oct 1, 2026")).toBeTruthy()
  })

  it("disables every provider control and says why", async () => {
    setup()
    const manage = await screen.findByRole("button", { name: "Manage subscription" })
    expect((manage as HTMLButtonElement).disabled).toBe(true)
    const describedBy = manage.getAttribute("aria-describedby")
    expect(describedBy).toBeTruthy()
    expect(document.getElementById(describedBy ?? "")?.textContent).toBe(
      "Billing isn't connected yet",
    )
    expect(screen.getByText("Billing isn't connected yet.")).toBeTruthy()
  })
})

describe("OrgBillingContainer usage", () => {
  it("shows today's metered requests against the limit, without a sample label", async () => {
    setup({ adapter: stripeAdapter() })
    expect(await screen.findByText("Requests today: 3 of 500")).toBeTruthy()
    expect(
      screen.getByText("Counted per UTC day (2026-10-16). Resets at midnight UTC."),
    ).toBeTruthy()
  })
})

describe("OrgBillingContainer as admin", () => {
  it("sees the page and can manage the subscription, as an owner does", async () => {
    const adapter = stripeAdapter()
    setup({ role: "admin", adapter })
    expect(await screen.findByText("Acme Inc · you are Admin")).toBeTruthy()
    const manage = await screen.findByRole("button", { name: "Manage subscription" })
    await waitFor(() => expect((manage as HTMLButtonElement).disabled).toBe(false))
    expect(screen.queryByText("You have view-only access to Acme Inc.")).toBeNull()
  })
})

describe("OrgBillingContainer as member or viewer", () => {
  it.each(["member", "viewer"])("%s sees the plain notice, and no billing data", async (role) => {
    const adapter = stripeAdapter()
    setup({ role, adapter })
    expect(
      await screen.findByText("Billing isn't available for your role. Ask an owner or admin."),
    ).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Manage subscription" })).toBeNull()
    expect(screen.queryByText("You have view-only access to Acme Inc.")).toBeNull()
    expect(adapter.load).not.toHaveBeenCalled()
    expect(adapter.usage).not.toHaveBeenCalled()
    await expectNoA11yViolations(document.body.innerHTML)
  })
})

describe("OrgBillingContainer with the stripe adapter", () => {
  it("opens the portal in a new tab after the provider answers", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null)
    const adapter = stripeAdapter()
    setup({ adapter })
    const manage = await screen.findByRole("button", { name: "Manage subscription" })
    await userEvent.click(manage)
    await waitFor(() =>
      expect(open).toHaveBeenCalledWith("https://billing.test/portal", "_blank", "noopener"),
    )
    expect(adapter.openPortal).toHaveBeenCalledWith("org-a")
  })

  it("confirms a cancellation before asking the provider", async () => {
    const adapter = stripeAdapter()
    vi.spyOn(window, "open").mockImplementation(() => null)
    setup({ adapter })
    await userEvent.click(await screen.findByRole("button", { name: "Cancel plan" }))
    const dialog = await screen.findByRole("alertdialog")
    expect(within(dialog).getByText(/stays on until the end of the current period/)).toBeTruthy()
    expect(adapter.cancel).not.toHaveBeenCalled()
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel plan" }))
    await waitFor(() => expect(adapter.cancel).toHaveBeenCalledWith("org-a"))
  })

  it("shows the provider's refusal as an alert", async () => {
    const adapter = stripeAdapter()
    adapter.openPortal = vi.fn(async () => {
      throw new Error("Only the owner can manage billing")
    })
    setup({ adapter })
    await userEvent.click(await screen.findByRole("button", { name: "Manage subscription" }))
    expect(await screen.findByRole("alert")).toBeTruthy()
    expect(screen.getByText("Only the owner can manage billing")).toBeTruthy()
  })
})

describe("OrgBillingContainer when the billing mode cannot be checked", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("shows the error, not the sample plan, and asks again on the next visit", async () => {
    const signInMethods = vi
      .fn()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValue({ data: { stripe: true }, error: null })
    // The Stripe adapter loads the organization's subscriptions through the client; none is active here.
    const list = vi.fn(async () => ({ data: [], error: null }))
    // The real adapter choice (lib/billing/select) runs; only the client it asks the server through is faked.
    const chooseAdapter = billingAdapterOnce(
      () =>
        ({ signInMethods, subscription: { list } }) as unknown as ReturnType<typeof createClient>,
    )
    // The Stripe adapter's usage is the API's own counter (GET /v1/whoami).
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ usage: USAGE })),
    )
    const view = (
      <OrgBillingContainer
        auth={fakeAuth()}
        api={fakeApi()}
        organization={acme}
        chooseAdapter={chooseAdapter}
      />
    )

    const first = renderWithClient(view)
    expect(await screen.findByText("Could not load billing for this organization.")).toBeTruthy()
    expect(screen.queryByText("[SAMPLE DATA]")).toBeNull()
    first.unmount()

    // The same client, as a later visit to the page: the failed check is not kept.
    render(<QueryClientProvider client={first.queryClient}>{view}</QueryClientProvider>)
    expect(await screen.findByText("Acme Inc · you are Owner")).toBeTruthy()
    expect(screen.queryByText("[SAMPLE DATA]")).toBeNull()
    expect(signInMethods).toHaveBeenCalledTimes(2)
    expect(list).toHaveBeenCalled()
  })
})

describe("OrgBillingContainer and the plan the API enforces", () => {
  it("shows the plan, its seats (viewers free) and agents beside today's requests", async () => {
    const usage: BillingUsage = {
      ...USAGE,
      plan: { planId: "free", planName: "Free", seatLimit: 3, agentLimit: 2, degraded: false },
    }
    const adapter = { ...fixtureBillingAdapter, usage: vi.fn(async () => usage) }
    setup({ adapter })
    const card = await screen.findByRole("region", { name: "Plan usage" })
    expect(within(card).getByText("Free")).toBeTruthy()
    expect(
      within(card).getByText("1 of 3 seats used · viewers are free · up to 2 agents"),
    ).toBeTruthy()
  })

  it("refreshes the plan on return from checkout, then drops the marker from the address", async () => {
    window.history.replaceState(null, "", "/acme/settings/billing?checkout=success")
    const refresh = vi.fn(async () => {})
    const adapter = { ...stripeAdapter(), refresh }
    setup({ adapter })
    await waitFor(() => expect(refresh).toHaveBeenCalledWith("org-a"))
    expect(window.location.search).toBe("")
  })

  it("doesn't refresh on an ordinary visit", async () => {
    window.history.replaceState(null, "", "/acme/settings/billing")
    const refresh = vi.fn(async () => {})
    setup({ adapter: { ...stripeAdapter(), refresh } })
    await screen.findByRole("heading", { name: "Pro" })
    expect(refresh).not.toHaveBeenCalled()
  })
})
