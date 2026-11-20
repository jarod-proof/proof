// @vitest-environment jsdom
import { expectNoA11yViolations } from "@proof/ui/a11y"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import {
  type AccountOrganization,
  type AccountProfilePageProps,
  AccountProfilePage,
} from "./account-profile-page"

const personal: AccountOrganization = {
  id: "org-p",
  name: "Jordan's workspace",
  slug: "personal-user-1",
  roleLabel: "Owner",
  personal: true,
  owner: true,
}
const acme: AccountOrganization = {
  id: "org-a",
  name: "Acme Inc",
  slug: "acme",
  roleLabel: "Owner",
  personal: false,
  owner: true,
}
const northwind: AccountOrganization = {
  id: "org-n",
  name: "Northwind Labs",
  slug: "northwind",
  roleLabel: "Viewer",
  personal: false,
  owner: false,
}

function props(overrides: Partial<AccountProfilePageProps> = {}): AccountProfilePageProps {
  return {
    profile: { name: "Jordan Lee", email: "jordan@acme.dev", emailVerified: true },
    pendingEmail: null,
    deleteRequestedTo: null,
    organizations: [personal, northwind],
    rolesReady: true,
    onSaveName: vi.fn(async () => undefined),
    onChangeEmail: vi.fn(async () => undefined),
    onResendChange: vi.fn(async () => undefined),
    onCancelChange: vi.fn(),
    onLeave: vi.fn(async () => undefined),
    onRequestDelete: vi.fn(async () => undefined),
    ...overrides,
  }
}

describe("AccountProfilePage", () => {
  it("shows the name, the verified email and the organizations with their roles", () => {
    render(<AccountProfilePage {...props()} />)
    expect(screen.getByRole("heading", { name: "Personal settings" })).toBeTruthy()
    expect(screen.getByLabelText("Name")).toHaveProperty("value", "Jordan Lee")
    expect(screen.getByText("jordan@acme.dev")).toBeTruthy()
    expect(screen.getByText("Verified · used to sign in and for notices")).toBeTruthy()
    expect(screen.getByText("Personal · Owner")).toBeTruthy()
    expect(screen.getByText("Viewer")).toBeTruthy()
  })

  it("disables the photo upload while uploads are off, and says why", () => {
    render(<AccountProfilePage {...props()} />)
    const upload = screen.getByRole("button", { name: "Upload photo" })
    expect(upload).toHaveProperty("disabled", true)
    expect(screen.queryByRole("button", { name: "Use initials" })).toBeNull()
    expect(
      screen.getByText("Photo upload is off on this server, so your initials are shown."),
    ).toBeTruthy()
  })

  it("shows the photo and offers to go back to initials once there is one", async () => {
    const limits = { maxBytes: 1024 * 1024, contentTypes: ["image/png"] }
    const onRemove = vi.fn(async () => undefined)
    const { container } = render(
      <AccountProfilePage
        {...props({
          profile: {
            name: "Ada Lovelace",
            email: "ada@example.com",
            emailVerified: true,
            image: "https://files.example.com/a.png",
          },
          avatar: { limits, onUpload: vi.fn(async () => undefined), onRemove },
        })}
      />,
    )
    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      "https://files.example.com/a.png",
    )
    expect(screen.getByRole("button", { name: "Upload photo" })).toHaveProperty("disabled", false)
    expect(screen.getByText("A square photo works best. PNG, up to 1 MB.")).toBeTruthy()
    await userEvent.setup().click(screen.getByRole("button", { name: "Use initials" }))
    expect(onRemove).toHaveBeenCalledOnce()
    await expectNoA11yViolations(container.innerHTML)
  })

  it("saves a changed name and not an unchanged one", async () => {
    const user = userEvent.setup()
    const onSaveName = vi.fn(async () => undefined)
    render(<AccountProfilePage {...props({ onSaveName })} />)
    const save = screen.getByRole("button", { name: "Save" })
    expect(save).toHaveProperty("disabled", true)
    const input = screen.getByLabelText("Name")
    await user.clear(input)
    await user.type(input, "Jo Lee")
    await user.click(save)
    await waitFor(() => expect(onSaveName).toHaveBeenCalledWith("Jo Lee"))
    expect(await screen.findByText("Saved.")).toBeTruthy()
  })

  it("asks for a new address, then shows the pending state until it is cancelled", async () => {
    const user = userEvent.setup()
    const onChangeEmail = vi.fn(async () => undefined)
    const onCancelChange = vi.fn()
    const { rerender } = render(
      <AccountProfilePage {...props({ onChangeEmail, onCancelChange })} />,
    )
    await user.click(screen.getByRole("button", { name: "Change email" }))
    const dialog = await screen.findByRole("dialog")
    await user.type(within(dialog).getByLabelText("New email"), "not-an-email")
    await user.click(within(dialog).getByRole("button", { name: "Send confirmation link" }))
    expect(await within(dialog).findByText(/Enter an email address/)).toBeTruthy()
    expect(onChangeEmail).not.toHaveBeenCalled()

    await user.clear(within(dialog).getByLabelText("New email"))
    await user.type(within(dialog).getByLabelText("New email"), "jordan@northwind.io")
    await user.click(within(dialog).getByRole("button", { name: "Send confirmation link" }))
    await waitFor(() => expect(onChangeEmail).toHaveBeenCalledWith("jordan@northwind.io"))

    rerender(
      <AccountProfilePage
        {...props({ onChangeEmail, onCancelChange, pendingEmail: "jordan@northwind.io" })}
      />,
    )
    const status = screen.getByRole("status")
    expect(within(status).getByText("jordan@northwind.io")).toBeTruthy()
    expect(
      within(status).getByText(/Your email stays jordan@acme.dev until you click it/),
    ).toBeTruthy()
    await user.click(within(status).getByRole("button", { name: "Cancel change" }))
    expect(onCancelChange).toHaveBeenCalled()
  })

  it("leaves a non-owned organization after confirming, and marks the owned one as needing a transfer", async () => {
    const user = userEvent.setup()
    const onLeave = vi.fn(async () => undefined)
    render(
      <AccountProfilePage {...props({ onLeave, organizations: [personal, acme, northwind] })} />,
    )
    expect(screen.getByRole("link", { name: "Transfer first" }).getAttribute("href")).toBe(
      "/acme/settings/general",
    )
    await user.click(screen.getByRole("button", { name: "Leave" }))
    const confirm = await screen.findByRole("alertdialog")
    expect(
      within(confirm).getByText(
        "You'll lose access to Northwind Labs right away. An admin can invite you again.",
      ),
    ).toBeTruthy()
    await user.click(within(confirm).getByRole("button", { name: "Leave organization" }))
    await waitFor(() => expect(onLeave).toHaveBeenCalledWith("org-n"))
  })

  it("blocks account deletion while the person owns an organization", () => {
    render(<AccountProfilePage {...props({ organizations: [personal, acme, northwind] })} />)
    expect(screen.getByRole("button", { name: "Delete my account" })).toHaveProperty(
      "disabled",
      true,
    )
    expect(screen.getByText("Blocked")).toBeTruthy()
    expect(screen.getByText("You own Acme Inc.")).toBeTruthy()
    expect(
      screen.getByRole("link", { name: "Transfer or delete it first" }).getAttribute("href"),
    ).toBe("/acme/settings/general")
  })

  it("names what deletion removes, emails the link and reports where it went", async () => {
    const user = userEvent.setup()
    const onRequestDelete = vi.fn(async () => undefined)
    const { rerender } = render(<AccountProfilePage {...props({ onRequestDelete })} />)
    expect(
      screen.getByText(/removes you from Northwind Labs\. We email a confirmation link/),
    ).toBeTruthy()
    await user.click(screen.getByRole("button", { name: "Delete my account" }))
    const confirm = await screen.findByRole("alertdialog")
    await user.click(within(confirm).getByRole("button", { name: "Email me the link" }))
    await waitFor(() => expect(onRequestDelete).toHaveBeenCalled())

    rerender(
      <AccountProfilePage {...props({ onRequestDelete, deleteRequestedTo: "jordan@acme.dev" })} />,
    )
    expect(screen.getByRole("status").textContent).toContain(
      "We emailed a confirmation link to jordan@acme.dev",
    )
  })

  it("holds back the owner-only actions until every organization's role is known", () => {
    render(
      <AccountProfilePage {...props({ organizations: [personal, acme], rolesReady: false })} />,
    )
    expect(screen.getByRole("button", { name: "Delete my account" })).toHaveProperty(
      "disabled",
      true,
    )
    expect(screen.getByText("Checking your organizations…")).toBeTruthy()
    expect(screen.queryByRole("link", { name: "Transfer first" })).toBeNull()
  })

  it("has no axe violations", async () => {
    const { container } = render(
      <AccountProfilePage {...props({ organizations: [personal, acme, northwind] })} />,
    )
    await expectNoA11yViolations(container.innerHTML)
  })
})

describe("AccountProfilePage landmark", () => {
  it("leaves the landmark to the app shell rather than nesting a main", () => {
    render(<AccountProfilePage {...props()} />)
    expect(document.querySelector("main")).toBeNull()
  })
})
