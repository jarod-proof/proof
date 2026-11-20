// @vitest-environment jsdom
import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

// The catalog's roles, so the fake answers what the server would.
import { roles } from "@proof/auth/client"
import type { MembersApi, MemberSecurity, OrgInvitation } from "../lib/members-api"
import type { OrgSettingsApi } from "../lib/org-settings-api"
import { qk } from "../lib/query-keys"
import { fakeAuth } from "../test/fake-auth"
import { notFresh, renderWithReauth } from "../test/reauth"
import { MembersContainer } from "./members"

const acme = { id: "org-a", name: "Acme Inc", slug: "acme" }
const NOW = new Date("2026-10-16T12:00:00Z")
const FUTURE = new Date(NOW.getTime() + 5 * 86_400_000).toISOString()

const members = [
  { id: "m-self", userId: "user-1", role: "owner", name: "Ada", email: "ada@example.com" },
  { id: "m-bo", userId: "user-2", role: "admin", name: "Bo", email: "bo@example.com" },
  { id: "m-cy", userId: "user-3", role: "member", name: "Cy", email: "cy@example.com" },
]

const security: MemberSecurity[] = [
  {
    userId: "user-1",
    name: "Ada",
    email: "ada@example.com",
    role: "owner",
    twoFactorEnabled: true,
    lastActiveAt: NOW.toISOString(),
  },
  {
    userId: "user-2",
    name: "Bo",
    email: "bo@example.com",
    role: "admin",
    twoFactorEnabled: false,
    lastActiveAt: null,
  },
  {
    userId: "user-3",
    name: "Cy",
    email: "cy@example.com",
    role: "member",
    twoFactorEnabled: true,
    lastActiveAt: null,
  },
]

const invitations: OrgInvitation[] = [
  {
    id: "inv-1",
    email: "lee@acme.dev",
    role: "member",
    status: "pending",
    expiresAt: FUTURE,
    createdAt: new Date(NOW.getTime() - 86_400_000).toISOString(),
  },
]

/** The plugin's answer: a role string's parts, each checked against the catalog. */
const catalogAllows = (role: string, permission: Record<string, string[]>) =>
  role.split(",").some((part) => {
    const named = roles[part.trim() as keyof typeof roles]
    if (!named) return false
    return named.authorize(permission as never).success
  })

const settings = {
  getOrganization: vi.fn(async () => ({
    id: "org-a",
    name: "Acme Inc",
    slug: "acme",
    logo: null,
    metadata: { defaultInviteRole: "viewer" },
  })),
  listMembers: vi.fn(async () => ({ total: 3, members })),
  updateOrganization: vi.fn(),
  updateMemberRole: vi.fn(async () => undefined),
  leaveOrganization: vi.fn(),
  deleteOrganization: vi.fn(),
  countApiKeys: vi.fn(async () => 0),
  roleAllows: vi.fn(catalogAllows),
} as unknown as OrgSettingsApi

function fakeMembersApi(overrides: Partial<MembersApi> = {}): MembersApi {
  return {
    listSecurity: vi.fn(async () => security),
    resetTwoFactor: vi.fn(async () => undefined),
    listInvitations: vi.fn(async () => invitations),
    invite: vi.fn(async () => undefined),
    cancelInvitation: vi.fn(async () => undefined),
    removeMember: vi.fn(async () => undefined),
    ...overrides,
  }
}

function setup(
  options: { role?: string; membersApi?: MembersApi; settingsApi?: typeof settings } = {},
) {
  const auth = fakeAuth({ memberRole: vi.fn(async () => options.role ?? "owner") })
  const membersApi = options.membersApi ?? fakeMembersApi()
  const rendered = renderWithReauth(
    <MembersContainer
      auth={auth}
      api={options.settingsApi ?? settings}
      membersApi={membersApi}
      organization={acme}
      now={NOW}
    />,
  )
  rendered.queryClient.setQueryData(qk.organizations(), [acme])
  return { auth, membersApi, ...rendered }
}

describe("MembersContainer as owner", () => {
  it("lists members with their security state and the pending invitations", async () => {
    setup()
    expect(await screen.findByText("Cy")).toBeTruthy()
    expect(screen.getByText("Ada (you)")).toBeTruthy()
    expect(screen.getByText("lee@acme.dev · Member")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Role for Bo: Admin" })).toBeTruthy()
    // the owner's row is fixed
    expect(screen.queryByRole("button", { name: /Role for Ada/ })).toBeNull()
  })

  it("starts the invite form on the org's default invite role", async () => {
    setup()
    await screen.findByText("Cy")
    expect((screen.getByLabelText("Role") as HTMLSelectElement).value).toBe("viewer")
  })

  it("invites each address with the chosen role, then refreshes the invitations", async () => {
    const user = userEvent.setup()
    const { membersApi } = setup()
    await screen.findByText("Cy")
    await user.type(screen.getByLabelText("Invite by email"), "x@acme.dev, y@acme.dev")
    await user.click(screen.getByRole("button", { name: "Send invites" }))
    await waitFor(() => expect(membersApi.invite).toHaveBeenCalledTimes(2))
    expect(membersApi.invite).toHaveBeenCalledWith("org-a", {
      email: "x@acme.dev",
      role: "viewer",
    })
    expect(membersApi.invite).toHaveBeenCalledWith("org-a", {
      email: "y@acme.dev",
      role: "viewer",
    })
  })

  it("changes a role by membership id and refreshes the member lists", async () => {
    const user = userEvent.setup()
    const { membersApi } = setup()
    await screen.findByText("Cy")
    await user.click(screen.getByRole("button", { name: "Role for Cy: Member" }))
    await user.click(await screen.findByRole("menuitemradio", { name: "Viewer" }))
    await waitFor(() =>
      expect(settings.updateMemberRole).toHaveBeenCalledWith("org-a", "m-cy", "viewer"),
    )
    // The security list sits under the members prefix, so it refetches with the member list.
    await waitFor(() => expect(membersApi.listSecurity).toHaveBeenCalledTimes(2))
    expect(settings.listMembers).toHaveBeenCalledTimes(2)
    expect(membersApi.removeMember).not.toHaveBeenCalled()
  })

  it("offers the capability roles in the picker and assigns one", async () => {
    const user = userEvent.setup()
    const { membersApi } = setup()
    await screen.findByText("Cy")
    await user.click(screen.getByRole("button", { name: "Role for Cy: Member" }))
    const items = await screen.findAllByRole("menuitemradio")
    expect(items.map((item) => item.textContent)).toEqual([
      "Admin",
      "Member",
      "Viewer",
      "Approver",
      "Operator",
      "Billing",
    ])
    await user.click(screen.getByRole("menuitemradio", { name: "Approver" }))
    await waitFor(() =>
      expect(settings.updateMemberRole).toHaveBeenCalledWith("org-a", "m-cy", "approver"),
    )
    expect(membersApi.removeMember).not.toHaveBeenCalled()
  })

  it("offers the capability roles when inviting", async () => {
    setup()
    await screen.findByText("Cy")
    const select = screen.getByLabelText("Role") as HTMLSelectElement
    expect([...select.options].map((option) => option.value)).toEqual([
      "admin",
      "member",
      "viewer",
      "approver",
      "operator",
      "billing",
    ])
  })

  it("removes a member, naming the consequence first", async () => {
    const user = userEvent.setup()
    const { membersApi } = setup()
    await screen.findByText("Cy")
    await user.click(screen.getByRole("button", { name: "More actions for Cy" }))
    await user.click(await screen.findByRole("menuitem", { name: "Remove from organization" }))
    const dialog = await screen.findByRole("alertdialog")
    expect(
      within(dialog).getByText("Cy loses access now; their agent grants in this org end.", {
        exact: false,
      }),
    ).toBeTruthy()
    await user.click(within(dialog).getByRole("button", { name: "Remove member" }))
    await waitFor(() => expect(membersApi.removeMember).toHaveBeenCalledWith("org-a", "m-cy"))
  })

  it("turns off two-factor for a member by their user id", async () => {
    const user = userEvent.setup()
    const { membersApi } = setup()
    await screen.findByText("Cy")
    await user.click(screen.getByRole("button", { name: "More actions for Cy" }))
    await user.click(await screen.findByRole("menuitem", { name: "Reset two-factor" }))
    const dialog = await screen.findByRole("alertdialog")
    await user.click(within(dialog).getByRole("button", { name: "Reset two-factor" }))
    await waitFor(() => expect(membersApi.resetTwoFactor).toHaveBeenCalledWith("org-a", "user-3"))
  })

  it("resends an invitation, renewing its expiry", async () => {
    const user = userEvent.setup()
    const { membersApi } = setup()
    await screen.findByText("lee@acme.dev · Member")
    await user.click(screen.getByRole("button", { name: "Resend" }))
    await waitFor(() =>
      expect(membersApi.invite).toHaveBeenCalledWith("org-a", {
        email: "lee@acme.dev",
        role: "member",
        resend: true,
      }),
    )
  })
})

describe("MembersContainer as member or viewer", () => {
  it("shows the members read-only: no invite form, no menus, no security, no invitations", async () => {
    const membersApi = fakeMembersApi()
    setup({ role: "member", membersApi })
    expect(await screen.findByText("Cy")).toBeTruthy()
    expect(screen.getByText("You have view-only access to Acme Inc.")).toBeTruthy()
    expect(screen.queryByLabelText("Invite by email")).toBeNull()
    expect(screen.queryByRole("button", { name: /^Role for/ })).toBeNull()
    expect(screen.queryByRole("columnheader", { name: "Two-factor" })).toBeNull()
    expect(membersApi.listSecurity).not.toHaveBeenCalled()
    expect(membersApi.listInvitations).not.toHaveBeenCalled()
  })

  it("asks the person to confirm it's them when a role change is refused as not fresh, then retries it once", async () => {
    const user = userEvent.setup()
    const roleSettings = {
      ...settings,
      updateMemberRole: vi.fn().mockRejectedValueOnce(notFresh()).mockResolvedValueOnce(undefined),
    }
    const { reauth, membersApi } = setup({ settingsApi: roleSettings })
    await screen.findByText("Cy")
    await user.click(screen.getByRole("button", { name: "Role for Cy: Member" }))
    await user.click(await screen.findByRole("menuitemradio", { name: "Viewer" }))
    const dialog = await screen.findByRole("dialog", { name: "Confirm it's you" })
    await user.type(within(dialog).getByLabelText("Password"), "pw")
    await user.click(within(dialog).getByRole("button", { name: "Confirm" }))
    await waitFor(() => expect(roleSettings.updateMemberRole).toHaveBeenCalledTimes(2))
    expect(roleSettings.updateMemberRole).toHaveBeenLastCalledWith("org-a", "m-cy", "viewer")
    expect(reauth.signInWithPassword).toHaveBeenCalledTimes(1)
    expect(membersApi.resetTwoFactor).not.toHaveBeenCalled()
  })

  it("asks the person to confirm it's them when a two-factor reset is refused as not fresh, then retries it once", async () => {
    const user = userEvent.setup()
    const membersApi = fakeMembersApi({
      resetTwoFactor: vi.fn().mockRejectedValueOnce(notFresh()).mockResolvedValueOnce(undefined),
    })
    const { reauth } = setup({ membersApi })
    await screen.findByText("Cy")
    await user.click(screen.getByRole("button", { name: "More actions for Cy" }))
    await user.click(await screen.findByRole("menuitem", { name: "Reset two-factor" }))
    const alert = await screen.findByRole("alertdialog")
    await user.click(within(alert).getByRole("button", { name: "Reset two-factor" }))
    const dialog = await screen.findByRole("dialog", { name: "Confirm it's you" })
    await user.type(within(dialog).getByLabelText("Password"), "pw")
    await user.click(within(dialog).getByRole("button", { name: "Confirm" }))
    await waitFor(() => expect(membersApi.resetTwoFactor).toHaveBeenCalledTimes(2))
    expect(membersApi.resetTwoFactor).toHaveBeenLastCalledWith("org-a", "user-3")
    expect(reauth.signInWithPassword).toHaveBeenCalledTimes(1)
  })

  describe("MembersContainer when the session is not fresh", () => {
    it("asks the person to confirm it's them when an invite is refused, then sends it once more", async () => {
      const user = userEvent.setup()
      const membersApi = fakeMembersApi({
        invite: vi.fn().mockRejectedValueOnce(notFresh()).mockResolvedValueOnce(undefined),
      })
      const { reauth } = setup({ membersApi })
      await screen.findByText("Cy")
      await user.type(screen.getByLabelText("Invite by email"), "x@acme.dev")
      await user.click(screen.getByRole("button", { name: "Send invites" }))
      const dialog = await screen.findByRole("dialog", { name: "Confirm it's you" })
      await user.type(within(dialog).getByLabelText("Password"), "pw")
      await user.click(within(dialog).getByRole("button", { name: "Confirm" }))

      await waitFor(() => expect(membersApi.invite).toHaveBeenCalledTimes(2))
      expect(membersApi.invite).toHaveBeenLastCalledWith("org-a", {
        email: "x@acme.dev",
        role: "viewer",
      })
      expect(reauth.signInWithPassword).toHaveBeenCalledTimes(1)
    })

    it("cancelled invite: shows the refusal for that address and does not send again", async () => {
      const user = userEvent.setup()
      const membersApi = fakeMembersApi({ invite: vi.fn().mockRejectedValue(notFresh()) })
      setup({ membersApi })
      await screen.findByText("Cy")
      await user.type(screen.getByLabelText("Invite by email"), "x@acme.dev")
      await user.click(screen.getByRole("button", { name: "Send invites" }))
      const dialog = await screen.findByRole("dialog", { name: "Confirm it's you" })
      await user.click(within(dialog).getByRole("button", { name: "Cancel" }))

      expect(await screen.findByText(/Sign in again to continue/)).toBeTruthy()
      expect(membersApi.invite).toHaveBeenCalledTimes(1)
    })

    it("asks the person to confirm it's them when a resend is refused, then resends once more", async () => {
      const user = userEvent.setup()
      const membersApi = fakeMembersApi({
        invite: vi.fn().mockRejectedValueOnce(notFresh()).mockResolvedValueOnce(undefined),
      })
      setup({ membersApi })
      await screen.findByText("lee@acme.dev · Member")
      await user.click(screen.getByRole("button", { name: "Resend" }))
      const dialog = await screen.findByRole("dialog", { name: "Confirm it's you" })
      await user.type(within(dialog).getByLabelText("Password"), "pw")
      await user.click(within(dialog).getByRole("button", { name: "Confirm" }))

      await waitFor(() => expect(membersApi.invite).toHaveBeenCalledTimes(2))
      expect(membersApi.invite).toHaveBeenLastCalledWith("org-a", {
        email: "lee@acme.dev",
        role: "member",
        resend: true,
      })
    })
  })
})
