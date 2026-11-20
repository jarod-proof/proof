// @vitest-environment jsdom
import { anchorLink } from "@proof/ui/dplus/shell/link"
import { screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { adminSessionFixture, fakeAdminApi } from "../test/fake-admin"
import { fakeAuth } from "../test/fake-auth"
import { fakeFeatureFlagsApi } from "../test/fake-feature-flags"
import { renderWithClient } from "../test/render"
import type { AdminAccessApis } from "./admin-access"
import { AdminFlagsContainer } from "./admin-flags"

function apis(operatorOrganization: string | null, role = "user"): AdminAccessApis {
  return {
    admin: fakeAdminApi({}, adminSessionFixture({ role })),
    flags: fakeFeatureFlagsApi({ operatorOrganization: vi.fn(async () => operatorOrganization) }),
  }
}

describe("AdminFlagsContainer", () => {
  it("moves the session to the operator organization and lists its flags", async () => {
    const auth = fakeAuth()
    const access = apis("org-b")
    renderWithClient(<AdminFlagsContainer auth={auth} apis={access} renderLink={anchorLink} />)
    // The session is on org-a; the rollouts are org-b's, so it switches first.
    await waitFor(() => expect(auth.setActiveOrganization).toHaveBeenCalledWith("org-b"))
  })

  it("lists the flags once the session is on the operator organization", async () => {
    const access = apis("org-a", "admin")
    renderWithClient(
      <AdminFlagsContainer auth={fakeAuth()} apis={access} renderLink={anchorLink} />,
    )
    expect(await screen.findByRole("button", { name: "Manage new-search" })).toBeTruthy()
    expect(access.flags.list).toHaveBeenCalledWith("org-a")
    // A platform admin in the operator organization gets both tabs.
    expect(screen.getByRole("link", { name: "Users" }).getAttribute("href")).toBe("/admin/users")
    expect(screen.getByText("As Analytical Ltd · you are Owner")).toBeTruthy()
  })

  it("tells anyone outside the operator organization the tab isn't theirs", async () => {
    const access = apis(null)
    renderWithClient(
      <AdminFlagsContainer auth={fakeAuth()} apis={access} renderLink={anchorLink} />,
    )
    expect(await screen.findByRole("heading", { name: "Not available" })).toBeTruthy()
    expect(screen.getByText(/members of the operator organization/)).toBeTruthy()
    expect(access.flags.list).not.toHaveBeenCalled()
  })
})
