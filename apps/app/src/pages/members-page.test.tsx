// @vitest-environment jsdom
import { expectNoA11yViolations } from "@proof/ui/a11y"
import { fireEvent, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { MatrixRowView } from "../lib/members"
import { renderWithClient } from "../test/render"
import {
  type InvitationView,
  type MemberView,
  type MembersPageProps,
  MembersPage,
} from "./members-page"

const NOW = new Date("2026-10-16T12:00:00Z")

function member(overrides: Partial<MemberView> & { name: string }): MemberView {
  const { name } = overrides
  return {
    id: `m-${name}`,
    userId: `u-${name}`,
    email: `${name.toLowerCase()}@acme.dev`,
    initials: name.slice(0, 2).toUpperCase(),
    role: "member",
    roleLabel: "Member",
    isSelf: false,
    canChangeRole: false,
    canRemove: false,
    canResetTwoFactor: false,
    ...overrides,
  }
}

const members: MemberView[] = [
  member({
    name: "Jordan Lee",
    role: "owner",
    roleLabel: "Owner",
    isSelf: true,
    twoFactorEnabled: true,
    lastActiveAt: NOW.toISOString(),
  }),
  member({
    name: "Priya Shah",
    role: "admin",
    roleLabel: "Admin",
    canChangeRole: true,
    canRemove: true,
    twoFactorEnabled: true,
    lastActiveAt: new Date(NOW.getTime() - 2 * 3_600_000).toISOString(),
  }),
  member({
    name: "Ana Ruiz",
    role: "member",
    roleLabel: "Member",
    canChangeRole: true,
    canRemove: true,
    canResetTwoFactor: true,
    twoFactorEnabled: false,
    lastActiveAt: null,
  }),
]

const invitations: InvitationView[] = [
  {
    id: "inv-1",
    email: "lee@acme.dev",
    role: "member",
    roleLabel: "Member",
    expired: false,
    createdAt: new Date(NOW.getTime() - 2 * 86_400_000).toISOString(),
    expiresAt: new Date(NOW.getTime() + 5 * 86_400_000).toISOString(),
  },
  {
    id: "inv-2",
    email: "finance@acme.dev",
    role: "viewer",
    roleLabel: "Viewer",
    expired: true,
    createdAt: new Date(NOW.getTime() - 9 * 86_400_000).toISOString(),
    expiresAt: new Date(NOW.getTime() - 2 * 86_400_000).toISOString(),
  },
]

const matrix: MatrixRowView[] = [
  {
    label: "Invite and manage members",
    cells: {
      owner: true,
      admin: true,
      member: false,
      viewer: false,
      approver: false,
      operator: false,
      billing: false,
    },
  },
]

function props(overrides: Partial<MembersPageProps> = {}): MembersPageProps {
  return {
    organization: { id: "org-a", name: "Acme Inc", slug: "acme" },
    roleLabel: "Owner",
    canInvite: true,
    showSecurity: true,
    invitations,
    defaultInviteRole: "member",
    members,
    matrix,
    now: NOW,
    onInvite: vi.fn(async () => ({ failed: [] })),
    onChangeRole: vi.fn(async () => undefined),
    onRemove: vi.fn(async () => undefined),
    onResetTwoFactor: vi.fn(async () => undefined),
    onResend: vi.fn(async () => undefined),
    onCancel: vi.fn(async () => undefined),
    ...overrides,
  }
}

describe("MembersPage as owner", () => {
  it("shows the invite form with the stored default role, and the members with their security state", async () => {
    renderWithClient(<MembersPage {...props()} />)
    expect(screen.getByRole("heading", { name: "Organization settings" })).toBeTruthy()
    expect(screen.getByText("Acme Inc · you are Owner")).toBeTruthy()
    const role = screen.getByLabelText("Role") as HTMLSelectElement
    expect(role.value).toBe("member")
    const rows = within(screen.getAllByRole("table")[0] as HTMLElement).getAllByRole("row")
    // header + three members
    expect(rows).toHaveLength(4)
    const ana = within(rows[3] as HTMLElement)
    expect(ana.getByText("Ana Ruiz")).toBeTruthy()
    expect(ana.getByText("Off")).toBeTruthy()
    expect(ana.getByText("Never")).toBeTruthy()
    expect(within(rows[1] as HTMLElement).getByText("On")).toBeTruthy()
    expect(within(rows[1] as HTMLElement).getByText("Now")).toBeTruthy()
    expect(within(rows[2] as HTMLElement).getByText("2 hours ago")).toBeTruthy()
  })

  it("fixes the owner row and offers the role menu only on editable rows", () => {
    renderWithClient(<MembersPage {...props()} />)
    expect(screen.queryByRole("button", { name: /Role for Jordan Lee/ })).toBeNull()
    expect(screen.getByRole("button", { name: "Role for Priya Shah: Admin" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "More actions for Ana Ruiz" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "More actions for Jordan Lee" })).toBeNull()
  })

  it("lists pending and expired invitations, with the right actions for each", () => {
    renderWithClient(<MembersPage {...props()} />)
    expect(screen.getByText("lee@acme.dev · Member")).toBeTruthy()
    expect(screen.getByText("Sent 2 days ago · expires in 5 days")).toBeTruthy()
    expect(screen.getByText("Expired")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Revoke" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Remove" })).toBeTruthy()
    expect(screen.getAllByRole("button", { name: "Resend" })).toHaveLength(2)
  })

  it("shows the role matrix from the rows it is given", () => {
    renderWithClient(<MembersPage {...props()} />)
    const table = screen.getByRole("heading", { name: "What each role can do" }).parentElement
    const row = within(table as HTMLElement).getByRole("rowheader", {
      name: "Invite and manage members",
    })
    const cells = within(row.closest("tr") as HTMLElement)
    // owner and admin hold it; the other five columns do not
    expect(cells.getAllByText("Yes")).toHaveLength(2)
    expect(cells.getAllByText("No")).toHaveLength(5)
  })

  it("hides the security columns when the caller cannot read member security", () => {
    renderWithClient(<MembersPage {...props({ showSecurity: false })} />)
    expect(screen.queryByRole("columnheader", { name: "Two-factor" })).toBeNull()
    expect(screen.queryByRole("columnheader", { name: "Last active" })).toBeNull()
  })

  it("says so when the invitations could not be loaded", () => {
    renderWithClient(
      <MembersPage
        {...props({ invitations: [], invitationsError: "Could not load the invitations" })}
      />,
    )
    expect(screen.getByRole("alert").textContent).toContain("Could not load the invitations")
    expect(screen.queryByText("No pending invitations.")).toBeNull()
  })

  it("hides the pending invitations section when the caller cannot manage invitations", () => {
    renderWithClient(<MembersPage {...props({ invitations: undefined })} />)
    expect(screen.queryByRole("heading", { name: "Pending invitations" })).toBeNull()
  })

  it("passes axe for the owner's view", async () => {
    renderWithClient(<MembersPage {...props()} />)
    await expectNoA11yViolations(document.body.innerHTML)
  })
})

describe("MembersPage actions", () => {
  it("sends one invite per address with the chosen role", async () => {
    const user = userEvent.setup()
    const onInvite = vi.fn(async () => ({ failed: [] }))
    renderWithClient(<MembersPage {...props({ onInvite })} />)
    await user.type(screen.getByLabelText("Invite by email"), "sam@contractor.io, ana@acme.dev")
    await user.selectOptions(screen.getByLabelText("Role"), "viewer")
    await user.click(screen.getByRole("button", { name: "Send invites" }))
    await waitFor(() =>
      expect(onInvite).toHaveBeenCalledWith(["sam@contractor.io", "ana@acme.dev"], "viewer"),
    )
  })

  it("refuses to send when a typed address is not one", async () => {
    const user = userEvent.setup()
    const onInvite = vi.fn(async () => ({ failed: [] }))
    renderWithClient(<MembersPage {...props({ onInvite })} />)
    await user.type(screen.getByLabelText("Invite by email"), "not-an-address")
    await user.click(screen.getByRole("button", { name: "Send invites" }))
    expect(await screen.findByText("Check these addresses: not-an-address")).toBeTruthy()
    expect(onInvite).not.toHaveBeenCalled()
  })

  it("names each address the server refused", async () => {
    const user = userEvent.setup()
    const onInvite = vi.fn(async () => ({
      failed: [{ email: "ana@acme.dev", message: "Already a member" }],
    }))
    renderWithClient(<MembersPage {...props({ onInvite })} />)
    await user.type(screen.getByLabelText("Invite by email"), "ana@acme.dev")
    await user.click(screen.getByRole("button", { name: "Send invites" }))
    expect(await screen.findByText("ana@acme.dev: Already a member")).toBeTruthy()
  })

  it("removes a member only after the dialog names the consequence", async () => {
    const user = userEvent.setup()
    const onRemove = vi.fn(async () => undefined)
    renderWithClient(<MembersPage {...props({ onRemove })} />)
    await user.click(screen.getByRole("button", { name: "More actions for Ana Ruiz" }))
    await user.click(await screen.findByRole("menuitem", { name: "Remove from organization" }))
    const dialog = await screen.findByRole("alertdialog")
    expect(
      within(dialog).getByText("Ana Ruiz loses access now; their agent grants in this org end.", {
        exact: false,
      }),
    ).toBeTruthy()
    expect(onRemove).not.toHaveBeenCalled()
    await user.click(within(dialog).getByRole("button", { name: "Remove member" }))
    await waitFor(() => expect(onRemove).toHaveBeenCalledWith(members[2]))
  })

  it("resets two-factor for a member after confirming", async () => {
    const user = userEvent.setup()
    const onResetTwoFactor = vi.fn(async () => undefined)
    renderWithClient(
      <MembersPage
        {...props({
          onResetTwoFactor,
          members: [
            member({
              name: "Sam Okafor",
              role: "viewer",
              roleLabel: "Viewer",
              canResetTwoFactor: true,
              twoFactorEnabled: true,
              lastActiveAt: null,
            }),
          ],
        })}
      />,
    )
    await user.click(screen.getByRole("button", { name: "More actions for Sam Okafor" }))
    await user.click(await screen.findByRole("menuitem", { name: "Reset two-factor" }))
    const dialog = await screen.findByRole("alertdialog")
    await user.click(within(dialog).getByRole("button", { name: "Reset two-factor" }))
    await waitFor(() => expect(onResetTwoFactor).toHaveBeenCalledTimes(1))
  })

  it("changes a role from the menu", async () => {
    const user = userEvent.setup()
    const onChangeRole = vi.fn(async () => undefined)
    renderWithClient(<MembersPage {...props({ onChangeRole })} />)
    await user.click(screen.getByRole("button", { name: "Role for Ana Ruiz: Member" }))
    await user.click(await screen.findByRole("menuitemradio", { name: "Admin" }))
    await waitFor(() => expect(onChangeRole).toHaveBeenCalledWith(members[2], "admin"))
  })

  it("resends and revokes invitations", async () => {
    const user = userEvent.setup()
    const onResend = vi.fn(async () => undefined)
    const onCancel = vi.fn(async () => undefined)
    renderWithClient(<MembersPage {...props({ onResend, onCancel })} />)
    await user.click(screen.getAllByRole("button", { name: "Resend" })[0] as HTMLElement)
    await waitFor(() => expect(onResend).toHaveBeenCalledWith(invitations[0]))
    await user.click(screen.getByRole("button", { name: "Revoke" }))
    const dialog = await screen.findByRole("alertdialog")
    await user.click(within(dialog).getByRole("button", { name: "Revoke invitation" }))
    await waitFor(() => expect(onCancel).toHaveBeenCalledWith(invitations[0]))
  })
})

describe("MembersPage as admin, member and viewer", () => {
  it("offers no invite form to a viewer, only the view-only notice", () => {
    renderWithClient(
      <MembersPage
        {...props({
          roleLabel: "Viewer",
          canInvite: false,
          showSecurity: false,
          invitations: undefined,
          members: members.map((m) => ({
            ...m,
            canChangeRole: false,
            canRemove: false,
            canResetTwoFactor: false,
            twoFactorEnabled: undefined,
            lastActiveAt: undefined,
          })),
        })}
      />,
    )
    expect(screen.getByText("You have view-only access to Acme Inc.")).toBeTruthy()
    expect(screen.queryByLabelText("Invite by email")).toBeNull()
    expect(screen.queryByRole("button", { name: /^Role for/ })).toBeNull()
    expect(screen.queryByRole("button", { name: /^More actions/ })).toBeNull()
    expect(screen.queryByRole("heading", { name: "Pending invitations" })).toBeNull()
  })
})

describe("MembersPage with a long list", () => {
  const many = Array.from({ length: 60 }, (_, i) =>
    member({ name: `Member ${i + 1}`, email: `m${i + 1}@acme.dev` }),
  )

  // jsdom lays nothing out; the virtualizer reads the scroll element's offset size.
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(480)
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(800)
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("shows eight rows, then all of them on request, and virtualizes past the long-list size", async () => {
    const user = userEvent.setup()
    renderWithClient(<MembersPage {...props({ members: many, invitations: undefined })} />)
    const membersTable = () => within(screen.getAllByRole("table")[0] as HTMLElement)
    // header + eight preview rows
    expect(membersTable().getAllByRole("row")).toHaveLength(9)
    await user.click(screen.getByRole("button", { name: "Show all 60 members" }))
    // Virtualized: the scroll region holds only the rows in view, not all 60.
    expect(screen.getByRole("region", { name: "Members, scrollable" })).toBeTruthy()
    const rendered = membersTable().getAllByRole("row").length - 1
    expect(rendered).toBeGreaterThan(0)
    expect(rendered).toBeLessThan(60)
  })
})

/**
 * Holds a closing popup mounted. Base UI waits for an element's animations before it unmounts, so one
 * that has not finished keeps the exit on screen the way a real transition does. Call the result to
 * let it finish.
 */
function holdExitAnimations(): () => void {
  let finish!: () => void
  const finished = new Promise<void>((resolve) => {
    finish = resolve
  })
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [{ finished, playState: "running" }],
  })
  return () => {
    finish()
    Reflect.deleteProperty(Element.prototype, "getAnimations")
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe("MembersPage confirmations", () => {
  it("sends a removal once when its confirm button is clicked twice", async () => {
    const user = userEvent.setup()
    const pending = deferred()
    const onRemove = vi.fn(() => pending.promise)
    renderWithClient(<MembersPage {...props({ onRemove })} />)
    await user.click(screen.getByRole("button", { name: "More actions for Ana Ruiz" }))
    await user.click(await screen.findByRole("menuitem", { name: "Remove from organization" }))
    const confirm = within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Remove member",
    })
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    expect(onRemove).toHaveBeenCalledTimes(1)
    pending.resolve()
  })

  it("sends a two-factor reset once when its confirm button is clicked twice", async () => {
    const user = userEvent.setup()
    const pending = deferred()
    const onResetTwoFactor = vi.fn(() => pending.promise)
    renderWithClient(<MembersPage {...props({ onResetTwoFactor })} />)
    await user.click(screen.getByRole("button", { name: "More actions for Ana Ruiz" }))
    await user.click(await screen.findByRole("menuitem", { name: "Reset two-factor" }))
    const confirm = within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Reset two-factor",
    })
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    expect(onResetTwoFactor).toHaveBeenCalledTimes(1)
    pending.resolve()
  })

  it("sends an invitation revoke once when its confirm button is clicked twice", async () => {
    const user = userEvent.setup()
    const pending = deferred()
    const onCancel = vi.fn(() => pending.promise)
    renderWithClient(<MembersPage {...props({ onCancel })} />)
    await user.click(screen.getByRole("button", { name: "Revoke" }))
    const confirm = within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Revoke invitation",
    })
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    expect(onCancel).toHaveBeenCalledTimes(1)
    pending.resolve()
  })

  it("keeps the member's name in the reset dialog while it animates out", async () => {
    const user = userEvent.setup()
    renderWithClient(
      <MembersPage
        {...props({
          members: [
            member({
              name: "Ana Ruiz",
              role: "member",
              roleLabel: "Member",
              canResetTwoFactor: true,
              twoFactorEnabled: true,
              lastActiveAt: null,
            }),
          ],
        })}
      />,
    )
    await user.click(screen.getByRole("button", { name: "More actions for Ana Ruiz" }))
    await user.click(await screen.findByRole("menuitem", { name: "Reset two-factor" }))
    const dialog = await screen.findByRole("alertdialog")
    const release = holdExitAnimations()
    try {
      await user.click(within(dialog).getByRole("button", { name: "Cancel" }))
      expect(within(dialog).getByRole("heading").textContent).toBe("Reset two-factor for Ana Ruiz?")
    } finally {
      release()
    }
  })

  it("keeps the invitation's address in the revoke dialog while it animates out", async () => {
    const user = userEvent.setup()
    renderWithClient(<MembersPage {...props()} />)
    await user.click(screen.getByRole("button", { name: "Revoke" }))
    const dialog = await screen.findByRole("alertdialog")
    const release = holdExitAnimations()
    try {
      await user.click(within(dialog).getByRole("button", { name: "Cancel" }))
      expect(within(dialog).getByRole("heading").textContent).toBe(
        "Revoke the invitation for lee@acme.dev?",
      )
    } finally {
      release()
    }
  })

  it("leaves the landmark to the app shell rather than nesting a main", () => {
    renderWithClient(<MembersPage {...props()} />)
    expect(document.querySelector("main")).toBeNull()
  })
})
