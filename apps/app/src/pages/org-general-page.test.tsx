// @vitest-environment jsdom
import { expectNoA11yViolations } from "@proof/ui/a11y"
import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { renderWithClient } from "../test/render"
import { type OrgGeneralPageProps, OrgGeneralPage } from "./org-general-page"

const acme = { id: "org-a", name: "Acme Inc", slug: "acme" }

function props(overrides: Partial<OrgGeneralPageProps> = {}): OrgGeneralPageProps {
  return {
    organization: acme,
    host: "app.example.com",
    roleLabel: "Owner",
    canEdit: true,
    isOwner: true,
    soleOwner: false,
    defaultInviteRole: "member",
    counts: { members: 12, apiKeys: 3 },
    admins: [{ memberId: "m-bo", label: "Bo" }],
    checkSlug: vi.fn(async () => true),
    onSave: vi.fn(async () => undefined),
    onTransfer: vi.fn(async () => undefined),
    onLeave: vi.fn(async () => undefined),
    onDelete: vi.fn(async () => undefined),
    ...overrides,
  }
}

describe("OrgGeneralPage as owner", () => {
  it("shows the editable fields, the org id, and the danger zone with live counts", async () => {
    renderWithClient(<OrgGeneralPage {...props()} />)
    expect(screen.getByRole("heading", { name: "Organization settings" })).toBeTruthy()
    expect(screen.getByText("Acme Inc · you are Owner")).toBeTruthy()
    expect(
      (screen.getByRole("textbox", { name: "Organization name" }) as HTMLInputElement).disabled,
    ).toBe(false)
    const inviteRole = screen.getByLabelText("Default role for new invites") as HTMLSelectElement
    expect([...inviteRole.options].map((option) => option.textContent)).toEqual([
      "Admin",
      "Member",
      "Viewer",
      "Approver",
      "Operator",
      "Billing",
    ])
    expect((screen.getByLabelText("URL") as HTMLInputElement).value).toBe("acme")
    expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy()
    expect(screen.getByRole("heading", { name: "Danger zone" })).toBeTruthy()
    expect(screen.getByText(/removes 12 members/)).toBeTruthy()
    expect(screen.getByText(/3 API keys \(they stop working\)/)).toBeTruthy()
    expect(screen.getByText(/\[PLACEHOLDER\] agents/)).toBeTruthy()
    await expectNoA11yViolations(document.body.innerHTML)
  })

  it("uses the singular for one agent, one API key and one member", () => {
    renderWithClient(
      <OrgGeneralPage {...props({ counts: { agents: 1, apiKeys: 1, members: 1 } })} />,
    )
    expect(
      screen.getByText(
        "Permanently deletes 1 agent, 1 API key (they stop working) and all run history, removes 1 member. Cancel any subscription in Billing first. You'll type the organization name to confirm.",
      ),
    ).toBeTruthy()
  })

  it("names a reserved address as reserved, not as a malformed one", async () => {
    const user = userEvent.setup()
    renderWithClient(<OrgGeneralPage {...props()} />)
    const url = screen.getByLabelText("URL")
    await user.clear(url)
    await user.type(url, "admin")
    expect(screen.getByText("That address is reserved. Choose another.")).toBeTruthy()
    expect(screen.queryByText(/Use lowercase letters/)).toBeNull()
    expect(url.getAttribute("aria-invalid")).toBe("true")
  })

  it("leaves the landmark to the app shell rather than nesting a main", () => {
    renderWithClient(<OrgGeneralPage {...props()} />)
    expect(document.querySelector("main")).toBeNull()
  })

  it("keeps Save and Discard off until something changes", async () => {
    const user = userEvent.setup()
    renderWithClient(<OrgGeneralPage {...props()} />)
    const save = screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement
    const discard = screen.getByRole("button", { name: "Discard" }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    expect(discard.disabled).toBe(true)

    const name = screen.getByRole("textbox", { name: "Organization name" })
    await user.type(name, " Labs")
    expect(save.disabled).toBe(false)
    expect(discard.disabled).toBe(false)

    await user.click(discard)
    expect((name as HTMLInputElement).value).toBe("Acme Inc")
    expect(save.disabled).toBe(true)
  })

  it("warns that a slug change breaks links to the old address, and saves the new values", async () => {
    const user = userEvent.setup()
    const onSave = vi.fn(async () => undefined)
    renderWithClient(<OrgGeneralPage {...props({ onSave })} />)
    const slug = screen.getByLabelText("URL")
    await user.clear(slug)
    await user.type(slug, "acme-labs")
    expect(
      screen.getByText("Changing this breaks existing links to app.example.com/acme."),
    ).toBeTruthy()
    await user.click(screen.getByRole("button", { name: "Save changes" }))
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({
        name: "Acme Inc",
        slug: "acme-labs",
        defaultInviteRole: "member",
      }),
    )
  })

  it("asks for the typed name before deleting", async () => {
    const user = userEvent.setup()
    const onDelete = vi.fn(async () => undefined)
    renderWithClient(<OrgGeneralPage {...props({ onDelete })} />)
    await user.click(screen.getByRole("button", { name: "Delete organization" }))
    const dialog = within(screen.getByRole("alertdialog"))
    const confirm = dialog.getByRole("button", { name: "Delete organization" }) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    await user.type(dialog.getByLabelText("Type Acme Inc to confirm"), "Acme Inc")
    expect(confirm.disabled).toBe(false)
    await user.click(confirm)
    await waitFor(() => expect(onDelete).toHaveBeenCalledTimes(1))
  })

  it("explains why the sole owner cannot leave", () => {
    renderWithClient(<OrgGeneralPage {...props({ soleOwner: true })} />)
    expect(screen.getByText(/only owner, so you can't leave/)).toBeTruthy()
    expect(
      (screen.getByRole("button", { name: "Leave organization" }) as HTMLButtonElement).disabled,
    ).toBe(true)
  })

  it("explains why transfer is unavailable when there is no admin", () => {
    renderWithClient(<OrgGeneralPage {...props({ admins: [] })} />)
    expect(screen.getByText(/Make another member an admin first/)).toBeTruthy()
  })
})

describe("OrgGeneralPage as viewer", () => {
  it("is read-only, with the view-only notice, and offers leaving", async () => {
    const onLeave = vi.fn(async () => undefined)
    renderWithClient(
      <OrgGeneralPage
        {...props({ roleLabel: "Viewer", canEdit: false, isOwner: false, onLeave })}
      />,
    )
    expect(screen.getByText("You have view-only access to Acme Inc.")).toBeTruthy()
    expect(screen.getByText("Ask an owner or admin to change these settings.")).toBeTruthy()
    expect(
      (screen.getByRole("textbox", { name: "Organization name" }) as HTMLInputElement).disabled,
    ).toBe(true)
    expect((screen.getByLabelText("URL") as HTMLInputElement).disabled).toBe(true)
    expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull()
    expect(screen.queryByRole("region", { name: "Danger zone" })).toBeNull()
    expect(screen.queryByText("Danger zone")).toBeNull()
    await expectNoA11yViolations(document.body.innerHTML)
  })
})
