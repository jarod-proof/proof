// @vitest-environment jsdom
import { expectNoA11yViolations } from "@proof/ui/a11y"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeAll, describe, expect, it, vi } from "vitest"

import type { InvitationPreview } from "../lib/invitation-preview"
import { WebError } from "../lib/web-auth"
import { fakeAuth } from "../test/fake-auth"
import { InvitationPage } from "./invitation-page"

const preview = (overrides: Partial<InvitationPreview> = {}): InvitationPreview => ({
  organizationName: "Babbage Labs",
  role: "member",
  status: "pending",
  expiresAt: new Date(Date.now() + 5 * 86_400_000).toISOString(),
  inviterName: "Charles",
  email: "ada@example.com",
  ...overrides,
})

const signedOut = () => fakeAuth({ getSession: vi.fn(async () => null) })

// input-otp and the org-settings client need nothing from jsdom beyond this.
beforeAll(() => {
  if (!document.elementFromPoint) document.elementFromPoint = () => null
})

describe("InvitationPage", () => {
  it("offers sign-in or sign-up with the invited address when signed out", async () => {
    const auth = fakeAuth({ getSession: vi.fn(async () => null) })
    const { container } = render(<InvitationPage auth={auth} invitationId="inv-1" />)
    expect(await screen.findByRole("group", { name: "Sign in or create an account" })).toBeTruthy()
    expect(screen.getByText(/sent to/i)).toBeTruthy()
    await expectNoA11yViolations(container.innerHTML)
  })

  it("accepts the invitation once signed in", async () => {
    const auth = fakeAuth()
    const { container } = render(<InvitationPage auth={auth} invitationId="inv-1" />)
    const accept = await screen.findByRole("button", { name: "Accept" })
    await userEvent.setup().click(accept)
    expect(await screen.findByRole("heading", { name: "You have joined" })).toBeTruthy()
    expect(auth.acceptInvitation).toHaveBeenCalledWith("inv-1")
    // Last: the axe check replaces document.body, which detaches the rendered tree.
    await expectNoA11yViolations(container.innerHTML)
  })

  it("signs in from the form and then shows the invitation", async () => {
    let signedIn = false
    const auth = fakeAuth({
      getSession: vi.fn(async () =>
        signedIn
          ? {
              user: { id: "u1", email: "ada@example.com", name: "Ada" },
              activeOrganizationId: null,
            }
          : null,
      ),
      signIn: vi.fn(async () => {
        signedIn = true
        return undefined
      }),
    })
    render(<InvitationPage auth={auth} invitationId="inv-1" />)
    const user = userEvent.setup()
    await user.type(await screen.findByLabelText("Email"), "ada@example.com")
    await user.type(screen.getByLabelText("Password"), "correct-horse")
    await user.click(screen.getByRole("button", { name: "Sign in" }))

    expect(await screen.findByRole("button", { name: "Accept" })).toBeTruthy()
    expect(auth.signIn).toHaveBeenCalledTimes(1)
  })

  it("creates the account from the sign-up mode", async () => {
    let signedIn = false
    const auth = fakeAuth({
      getSession: vi.fn(async () =>
        signedIn
          ? {
              user: { id: "u2", email: "ada@example.com", name: "Ada" },
              activeOrganizationId: null,
            }
          : null,
      ),
      signUp: vi.fn(async () => {
        signedIn = true
        return undefined
      }),
    })
    render(<InvitationPage auth={auth} invitationId="inv-1" />)
    const user = userEvent.setup()
    await user.click(await screen.findByRole("button", { name: "Create an account" }))
    await user.type(screen.getByLabelText("Name"), "Ada")
    await user.type(screen.getByLabelText("Email"), "ada@example.com")
    await user.type(screen.getByLabelText("Password"), "correct-horse")
    await user.click(screen.getByRole("button", { name: "Create account" }))

    expect(await screen.findByRole("button", { name: "Accept" })).toBeTruthy()
    expect(auth.signUp).toHaveBeenCalledWith({
      name: "Ada",
      email: "ada@example.com",
      password: "correct-horse",
    })
  })

  it("explains an invitation that is no longer pending and blocks accepting it", async () => {
    const auth = fakeAuth({
      getInvitation: vi.fn(async () => ({
        id: "inv-1",
        organizationName: "Babbage Labs",
        email: "ada@example.com",
        role: "member",
        status: "canceled",
      })),
    })
    render(<InvitationPage auth={auth} invitationId="inv-1" />)
    expect(await screen.findByText("This invitation is canceled.")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Accept" })).toHaveProperty("disabled", true)
  })

  it("shows the server's message when accepting fails", async () => {
    const auth = fakeAuth({
      acceptInvitation: vi.fn(async () => {
        throw new Error("This invitation was sent to someone else")
      }),
    })
    render(<InvitationPage auth={auth} invitationId="inv-1" />)
    await userEvent.setup().click(await screen.findByRole("button", { name: "Accept" }))
    expect(await screen.findByText("This invitation was sent to someone else")).toBeTruthy()
  })

  it("shows an error when the invitation cannot be loaded", async () => {
    const auth = fakeAuth({
      getInvitation: vi.fn(async () => {
        throw new Error("This invitation could not be found")
      }),
    })
    render(<InvitationPage auth={auth} invitationId="nope" />)
    await waitFor(() => expect(screen.getByText("This invitation could not be found")).toBeTruthy())
  })

  it("lets the wrong account sign out and sign in as the invited address", async () => {
    let signedIn = true
    const auth = fakeAuth({
      getSession: vi.fn(async () =>
        signedIn
          ? {
              user: { id: "u1", email: "grace@example.com", name: "Grace" },
              activeOrganizationId: null,
            }
          : null,
      ),
      getInvitation: vi.fn(async () =>
        Promise.reject(new Error("This invitation could not be found")),
      ),
      signOut: vi.fn(async () => {
        signedIn = false
      }),
    })
    render(<InvitationPage auth={auth} invitationId="inv-1" />)
    await userEvent.setup().click(await screen.findByRole("button", { name: /sign out/i }))
    expect(await screen.findByRole("group", { name: "Sign in or create an account" })).toBeTruthy()
    expect(auth.signOut).toHaveBeenCalledTimes(1)
  })

  it("declines the invitation and says so", async () => {
    const rejectInvitation = vi.fn(async () => undefined)
    render(<InvitationPage auth={fakeAuth({ rejectInvitation })} invitationId="inv-1" />)
    await userEvent.setup().click(await screen.findByRole("button", { name: "Decline" }))
    expect(await screen.findByRole("heading", { name: "Invitation declined" })).toBeTruthy()
    expect(rejectInvitation).toHaveBeenCalledWith("inv-1")
  })

  it("shows what the role can and cannot do, and when the invitation expires", async () => {
    const auth = fakeAuth({
      getInvitation: vi.fn(async () => ({
        id: "inv-1",
        organizationName: "Babbage Labs",
        email: "ada@example.com",
        role: "viewer",
        status: "pending",
        expiresAt: new Date(Date.now() + 6 * 86_400_000).toISOString(),
      })),
    })
    render(<InvitationPage auth={auth} invitationId="inv-1" />)
    expect(await screen.findByText("Can't change settings")).toBeTruthy()
    expect(screen.getByText("See agents, runs and settings")).toBeTruthy()
    expect(screen.getByText(/expires in 6 days/)).toBeTruthy()
  })

  describe("with the invitation preview", () => {
    it("names the organization and opens on sign-up with the invited address locked in", async () => {
      const auth = signedOut()
      const { container } = render(
        <InvitationPage auth={auth} invitationId="inv-1" loadPreview={async () => preview()} />,
      )
      expect(await screen.findByRole("heading", { name: "Join Babbage Labs" })).toBeTruthy()
      expect(screen.getByText(/Charles invited you as/)).toBeTruthy()
      expect(
        screen.getByRole("button", { name: "Create an account" }).getAttribute("aria-pressed"),
      ).toBe("true")
      const email = screen.getByLabelText("Email") as HTMLInputElement
      expect(email.value).toBe("ada@example.com")
      expect(email.readOnly).toBe(true)
      await expectNoA11yViolations(container.innerHTML)
    })

    it("signs up with the invited address", async () => {
      const auth = signedOut()
      render(
        <InvitationPage auth={auth} invitationId="inv-1" loadPreview={async () => preview()} />,
      )
      const user = userEvent.setup()
      await user.type(await screen.findByLabelText("Name"), "Ada")
      await user.type(screen.getByLabelText("Password"), "correct-horse")
      await user.click(screen.getByRole("button", { name: "Create account" }))
      expect(auth.signUp).toHaveBeenCalledWith({
        name: "Ada",
        email: "ada@example.com",
        password: "correct-horse",
      })
    })

    it("keeps sign-in one click away for someone who already has an account", async () => {
      const auth = signedOut()
      render(
        <InvitationPage auth={auth} invitationId="inv-1" loadPreview={async () => preview()} />,
      )
      const user = userEvent.setup()
      await user.click(await screen.findByRole("button", { name: "I have an account" }))
      expect((screen.getByLabelText("Email") as HTMLInputElement).value).toBe("ada@example.com")
      await user.type(screen.getByLabelText("Password"), "correct-horse")
      await user.click(screen.getByRole("button", { name: "Sign in" }))
      expect(auth.signIn).toHaveBeenCalledWith({
        email: "ada@example.com",
        password: "correct-horse",
      })
    })

    it("sends someone whose invitation was already accepted to sign in", async () => {
      render(
        <InvitationPage
          auth={signedOut()}
          invitationId="inv-1"
          loadPreview={async () => preview({ status: "accepted", email: null })}
        />,
      )
      expect(await screen.findByText("This invitation has already been accepted.")).toBeTruthy()
      expect(screen.getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe("/sign-in")
    })

    it("offers no sign-in for an invitation that is no longer open", async () => {
      render(
        <InvitationPage
          auth={signedOut()}
          invitationId="inv-1"
          loadPreview={async () => preview({ status: "expired", email: null })}
        />,
      )
      expect(await screen.findByText(/This invitation has expired. Ask Charles/)).toBeTruthy()
      expect(screen.queryByLabelText("Email")).toBeNull()
    })

    it("says so when there is no such invitation", async () => {
      const auth = signedOut()
      render(
        <InvitationPage
          auth={auth}
          invitationId="nope"
          loadPreview={async () => {
            throw new WebError("This invitation could not be found", 404, "NOT_FOUND")
          }}
        />,
      )
      expect(await screen.findByRole("heading", { name: "Invitation unavailable" })).toBeTruthy()
      expect(screen.getByText("This invitation could not be found")).toBeTruthy()
    })

    it("keeps the plain sign-in page when the preview can't be read", async () => {
      render(
        <InvitationPage
          auth={signedOut()}
          invitationId="inv-1"
          loadPreview={async () => {
            throw new WebError("Something went wrong", 500)
          }}
        />,
      )
      expect(await screen.findByRole("heading", { name: "Accept your invitation" })).toBeTruthy()
      expect((screen.getByLabelText("Email") as HTMLInputElement).readOnly).toBe(false)
    })

    it("warns up front when signed in as another address, with no way to accept", async () => {
      let signedIn = true
      const auth = fakeAuth({
        getSession: vi.fn(async () =>
          signedIn
            ? {
                user: { id: "u1", email: "grace@example.com", name: "Grace" },
                activeOrganizationId: null,
              }
            : null,
        ),
        signOut: vi.fn(async () => {
          signedIn = false
        }),
      })
      const { container } = render(
        <InvitationPage auth={auth} invitationId="inv-1" loadPreview={async () => preview()} />,
      )
      expect((await screen.findByRole("alert")).textContent).toMatch(
        /sent to ada@example.com, but you are signed in as grace@example.com/,
      )
      expect(screen.queryByRole("button", { name: "Accept" })).toBeNull()
      expect(auth.getInvitation).not.toHaveBeenCalled()
      await userEvent
        .setup()
        .click(screen.getByRole("button", { name: "Sign out and use ada@example.com" }))
      expect(auth.signOut).toHaveBeenCalledTimes(1)
      expect(await screen.findByLabelText("Email")).toBeTruthy()
      // Last: the axe check replaces document.body, which detaches the rendered tree.
      await expectNoA11yViolations(container.innerHTML)
    })

    it("compares the address without regard to case", async () => {
      render(
        <InvitationPage
          auth={fakeAuth()}
          invitationId="inv-1"
          loadPreview={async () => preview({ email: "Ada@Example.com" })}
        />,
      )
      expect(await screen.findByRole("button", { name: "Accept" })).toBeTruthy()
    })
  })

  it("blocks accepting an invitation whose time has run out", async () => {
    const auth = fakeAuth({
      getInvitation: vi.fn(async () => ({
        id: "inv-1",
        organizationName: "Babbage Labs",
        email: "ada@example.com",
        role: "member",
        status: "pending",
        expiresAt: new Date(Date.now() - 86_400_000).toISOString(),
      })),
    })
    render(<InvitationPage auth={auth} invitationId="inv-1" />)
    expect(
      await screen.findByText("This invitation has expired.", { selector: "p.text-destructive" }),
    ).toBeTruthy()
    expect(screen.getByRole("button", { name: "Accept" })).toHaveProperty("disabled", true)
  })
})
