// @vitest-environment jsdom
import { expectNoA11yViolations } from "@proof/ui/a11y"
import { QueryClientProvider } from "@tanstack/react-query"
import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import type { AdminAction } from "../containers/admin-data"
import type { AdminSession, AdminUser } from "../lib/admin-api"
import { renderWithClient } from "../test/render"
import { AdminNotAvailable, AdminPage, type AdminPageProps } from "./admin-page"

const me: AdminSession = {
  userId: "me",
  name: "Ada Admin",
  email: "ada@acme.dev",
  role: "admin",
  impersonatedBy: null,
}

const user = (overrides: Partial<AdminUser> & { id: string; name: string }): AdminUser => ({
  email: `${overrides.name.toLowerCase().replace(/ /g, ".")}@acme.dev`,
  emailVerified: true,
  role: "user",
  banned: false,
  banReason: null,
  banExpires: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  ...overrides,
})

const users: AdminUser[] = [
  user({ id: "me", name: "Ada Admin", role: "admin" }),
  user({ id: "u2", name: "Grace Hopper" }),
  user({
    id: "u3",
    name: "Linus Spam",
    banned: true,
    banReason: "Spam",
    emailVerified: false,
  }),
  user({ id: "u4", name: "Root Admin", role: "admin" }),
]

function props(overrides: Partial<AdminPageProps> = {}): AdminPageProps {
  return {
    me,
    tabs: [
      { id: "users", label: "Users", href: "/admin/users" },
      { id: "flags", label: "Feature flags", href: "/admin/flags" },
    ],
    users,
    total: users.length,
    loading: false,
    error: null,
    search: "",
    onSearch: vi.fn(),
    offset: 0,
    onPage: vi.fn(),
    onAction: vi.fn(async (_action: AdminAction) => {}),
    ...overrides,
  }
}

describe("AdminPage", () => {
  it("keeps a user's open actions menu on that user when the list reorders under it", async () => {
    const actor = userEvent.setup()
    const { rerender, queryClient } = renderWithClient(<AdminPage {...props()} />)
    await actor.click(screen.getByRole("button", { name: "Actions for Grace Hopper" }))
    expect(await screen.findByRole("menuitem", { name: "Ban" })).toBeTruthy()

    // a search narrows the list: Grace moves from the second row to the first
    const graceOnly = users.filter((u) => u.id === "u2")
    rerender(
      <QueryClientProvider client={queryClient}>
        <AdminPage {...props({ users: graceOnly, total: 1 })} />
      </QueryClientProvider>,
    )
    await actor.click(await screen.findByRole("menuitem", { name: "Ban" }))
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText(/Grace Hopper/)).toBeTruthy()
  })

  it("shows each user with their verification, role and status word", () => {
    renderWithClient(<AdminPage {...props()} />)
    const grace = screen.getByRole("row", { name: /Grace Hopper/ })
    expect(within(grace).getByText("Verified")).toBeTruthy()
    expect(within(grace).getByText("Active")).toBeTruthy()
    const linus = screen.getByRole("row", { name: /Linus Spam/ })
    expect(within(linus).getByText("Banned")).toBeTruthy()
    expect(within(linus).getByText("Unverified")).toBeTruthy()
    expect(within(screen.getByRole("row", { name: /Root Admin/ })).getByText("Admin")).toBeTruthy()
    expect(screen.getByText("(you)")).toBeTruthy()
  })

  it("reports the page range and pages forward", async () => {
    const onPage = vi.fn()
    const user = userEvent.setup()
    renderWithClient(<AdminPage {...props({ total: 120, onPage })} />)
    expect(screen.getByText("Showing 1–50 of 120")).toBeTruthy()
    await user.click(screen.getByRole("button", { name: "Next" }))
    expect(onPage).toHaveBeenCalledWith(50)
  })

  it("passes search text up as the admin types", async () => {
    const onSearch = vi.fn()
    const user = userEvent.setup()
    renderWithClient(<AdminPage {...props({ onSearch })} />)
    await user.type(screen.getByLabelText("Search by email"), "g")
    expect(onSearch).toHaveBeenCalledWith("g")
  })

  it("names the consequence of a ban and sends the reason and duration", async () => {
    const onAction = vi.fn(async (_action: AdminAction) => {})
    const user = userEvent.setup()
    renderWithClient(<AdminPage {...props({ onAction })} />)
    await user.click(screen.getByRole("button", { name: "Actions for Grace Hopper" }))
    await user.click(await screen.findByRole("menuitem", { name: "Ban" }))
    const dialog = await screen.findByRole("dialog")
    expect(
      within(dialog).getByText("Signs them out everywhere and blocks sign-in until the ban ends."),
    ).toBeTruthy()
    await user.type(within(dialog).getByLabelText("Reason (optional)"), "Spam")
    await user.selectOptions(within(dialog).getByLabelText("Ban for"), "week")
    await user.click(within(dialog).getByRole("button", { name: "Ban user" }))
    await waitFor(() => expect(onAction).toHaveBeenCalledTimes(1))
    expect(onAction).toHaveBeenCalledWith({
      kind: "ban",
      userId: "u2",
      reason: "Spam",
      expiresInSeconds: 604_800,
    })
  })

  it("says what impersonating does before it starts", async () => {
    const onAction = vi.fn(async (_action: AdminAction) => {})
    const user = userEvent.setup()
    renderWithClient(<AdminPage {...props({ onAction })} />)
    await user.click(screen.getByRole("button", { name: "Actions for Grace Hopper" }))
    await user.click(await screen.findByRole("menuitem", { name: "Impersonate" }))
    const dialog = await screen.findByRole("dialog")
    expect(
      within(dialog).getByText(
        "You act as them. OAuth consent, device approval and API keys are blocked while impersonating.",
      ),
    ).toBeTruthy()
    await user.click(within(dialog).getByRole("button", { name: "Impersonate" }))
    await waitFor(() =>
      expect(onAction).toHaveBeenCalledWith({ kind: "impersonate", userId: "u2" }),
    )
  })

  it("keeps an admin's own account and other admins out of impersonation", async () => {
    const user = userEvent.setup()
    renderWithClient(<AdminPage {...props()} />)
    await user.click(screen.getByRole("button", { name: "Actions for Root Admin" }))
    expect(
      (await screen.findByRole("menuitem", { name: "Impersonate" })).getAttribute("aria-disabled"),
    ).toBe("true")
  })

  it("asks before sending a role change, and only offers it when it differs", async () => {
    const onAction = vi.fn(async (_action: AdminAction) => {})
    const user = userEvent.setup()
    renderWithClient(<AdminPage {...props({ onAction })} />)
    await user.click(screen.getByRole("button", { name: "Actions for Grace Hopper" }))
    await user.click(await screen.findByRole("menuitem", { name: "Make admin" }))
    const dialog = await screen.findByRole("dialog")
    const setRole = within(dialog).getByRole("button", { name: "Set role" })
    expect(setRole).toHaveProperty("disabled", true)
    await user.selectOptions(within(dialog).getByLabelText("Platform role"), "admin")
    await user.click(setRole)
    await waitFor(() =>
      expect(onAction).toHaveBeenCalledWith({ kind: "role", userId: "u2", role: "admin" }),
    )
  })

  it("shows a refusal from the server in the dialog and keeps it open", async () => {
    const onAction = vi.fn(async () => {
      throw new Error("You cannot impersonate admins")
    })
    const user = userEvent.setup()
    renderWithClient(<AdminPage {...props({ onAction })} />)
    await user.click(screen.getByRole("button", { name: "Actions for Grace Hopper" }))
    await user.click(await screen.findByRole("menuitem", { name: "Impersonate" }))
    const dialog = await screen.findByRole("dialog")
    await user.click(within(dialog).getByRole("button", { name: "Impersonate" }))
    expect(await within(dialog).findByRole("alert")).toHaveProperty(
      "textContent",
      "You cannot impersonate admins",
    )
  })

  it("has no axe violations", async () => {
    renderWithClient(<AdminPage {...props()} />)
    await expectNoA11yViolations(document.body.innerHTML)
  })
})

describe("AdminNotAvailable", () => {
  it("says the page is not available, with a way back", () => {
    renderWithClient(<AdminNotAvailable />)
    expect(screen.getByRole("heading", { name: "Not available" })).toBeTruthy()
    expect(screen.getByRole("link", { name: "Back to the app" }).getAttribute("href")).toBe("/")
  })
})

describe("AdminPage with a long list", () => {
  it("windows the rows in a scrollable region once the page is long", () => {
    const many = Array.from({ length: 30 }, (_, index) =>
      user({ id: `m${index}`, name: `Member ${index}` }),
    )
    renderWithClient(<AdminPage {...props({ users: many, total: 30 })} />)
    expect(screen.getByRole("region", { name: "Users, scrollable" })).toBeTruthy()
  })
})
