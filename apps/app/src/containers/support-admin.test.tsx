// @vitest-environment jsdom
import { expectNoA11yViolations } from "@proof/ui/a11y"
import { anchorLink } from "@proof/ui/dplus/shell/link"
import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import type { SupportApi, SupportQueueAccess } from "../lib/support-api"
import { adminSessionFixture, fakeAdminApi } from "../test/fake-admin"
import { fakeAuth } from "../test/fake-auth"
import { fakeFeatureFlagsApi } from "../test/fake-feature-flags"
import { renderWithClient } from "../test/render"
import { agentTicket, fakeSupportClient } from "../test/fake-support"
import type { AdminAccessApis } from "./admin-access"
import { AdminSupportContainer } from "./support-admin"

function supportApi(access: SupportQueueAccess | Error = "staff"): SupportApi {
  return {
    isStaff: vi.fn(async () => true),
    listStaff: vi.fn(async () => [
      { id: "user-1", name: "Ada", image: null },
      { id: "user-3", name: "Linus", image: null },
    ]),
    queueAccess: vi.fn(async () => {
      if (access instanceof Error) throw access
      return access
    }),
  }
}

function render(
  options: { support?: SupportApi; ticketId?: string; client?: boolean; operator?: string } = {},
) {
  const support = options.support ?? supportApi()
  const client = fakeSupportClient({
    queue: [agentTicket(), agentTicket({ id: "t2", number: 43, subject: "Billing question" })],
  })
  const apis: AdminAccessApis = {
    admin: fakeAdminApi({}, adminSessionFixture({ role: "user" })),
    flags: fakeFeatureFlagsApi({
      operatorOrganization: vi.fn(async () => options.operator ?? "org-op"),
    }),
    support,
  }
  const onNavigate = vi.fn()
  renderWithClient(
    <AdminSupportContainer
      auth={fakeAuth(options.client === false ? {} : { support: client })}
      apis={apis}
      support={support}
      ticketId={options.ticketId}
      onNavigate={onNavigate}
      renderLink={anchorLink}
      pollInterval={0}
    />,
  )
  return { client, support, onNavigate }
}

describe("AdminSupportContainer", () => {
  it("shows the support queue to support staff, with the staff in the pickers", async () => {
    const { support } = render()
    expect(await screen.findByText("Can't export runs")).toBeTruthy()
    expect(screen.getByText("Billing question")).toBeTruthy()
    // The console's tabs, with Support current; the queue in this app's words.
    expect(screen.getByRole("link", { name: "Support" }).getAttribute("href")).toBe(
      "/admin/support",
    )
    expect(screen.getByRole("link", { name: "Feature flags" })).toBeTruthy()
    expect(screen.getAllByText("Support queue").length).toBeGreaterThan(0)
    expect(support.listStaff).toHaveBeenCalledWith("org-op")
    await waitFor(() => expect(screen.getByRole("option", { name: "Linus" })).toBeTruthy())
  })

  it("has no accessibility violations", async () => {
    render()
    await screen.findByText("Can't export runs")
    await expectNoA11yViolations(document.body.innerHTML)
  })

  it("opens a ticket from the queue and puts it in the URL", async () => {
    const { client, onNavigate } = render()
    await userEvent.click(await screen.findByText("Billing question"))
    await waitFor(() =>
      expect(client.support.agent.ticket).toHaveBeenCalledWith({ query: { id: "t2" } }),
    )
    expect(onNavigate).toHaveBeenCalledWith("/admin/support/t2")
  })

  it("opens the ticket a link names, and Back returns the URL to the queue", async () => {
    const { client, onNavigate } = render({ ticketId: "t2" })
    await waitFor(() =>
      expect(client.support.agent.ticket).toHaveBeenCalledWith({ query: { id: "t2" } }),
    )
    // A ticket the URL opened is not reported back as a change.
    expect(onNavigate).not.toHaveBeenCalled()
    await userEvent.click(await screen.findByRole("button", { name: "Back" }))
    expect(onNavigate).toHaveBeenCalledWith("/admin/support")
  })

  it("tells anyone support refuses that the tab isn't theirs", async () => {
    const { client } = render({ support: supportApi("not-staff") })
    expect(await screen.findByRole("heading", { name: "Not available" })).toBeTruthy()
    expect(screen.getByText(/support staff/)).toBeTruthy()
    expect(client.support.agent.tickets).not.toHaveBeenCalled()
  })

  it("says not available when the app has no support client", async () => {
    render({ client: false })
    expect(await screen.findByRole("heading", { name: "Not available" })).toBeTruthy()
  })

  it("sends a signed-out visitor to sign-in, back to the ticket", async () => {
    const { onNavigate } = render({ support: supportApi("signed-out"), ticketId: "t1" })
    await waitFor(() =>
      expect(onNavigate).toHaveBeenCalledWith("/sign-in?next=%2Fadmin%2Fsupport%2Ft1"),
    )
  })

  it("offers a retry when the access check fails", async () => {
    const support = supportApi(new Error("offline"))
    render({ support })
    await userEvent.click(await screen.findByRole("button", { name: "Try again" }))
    await waitFor(() => expect(support.queueAccess).toHaveBeenCalledTimes(2))
  })

  it("still shows the queue when the staff list fails, and says what is missing", async () => {
    const support = supportApi()
    vi.mocked(support.listStaff).mockRejectedValue(new Error("offline"))
    render({ support })
    expect(await screen.findByText(/Could not load the support staff/)).toBeTruthy()
    expect(screen.getByText("Can't export runs")).toBeTruthy()
  })
})
