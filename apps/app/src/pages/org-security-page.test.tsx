// @vitest-environment jsdom
import { expectNoA11yViolations } from "@proof/ui/a11y"
import { fireEvent, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { render } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import type { SsoProvider } from "../lib/org-security-api"
import { OrgSecurityPage, type OrgSecurityPageProps } from "./org-security-page"

const provider: SsoProvider = {
  providerId: "acme-com-1",
  type: "oidc",
  issuer: "https://login.acme.com",
  domain: "acme.com",
  organizationId: "org-a",
  domainVerified: false,
}

function props(overrides: Partial<OrgSecurityPageProps> = {}): OrgSecurityPageProps {
  return {
    organization: { name: "Acme Inc", slug: "acme" },
    origin: "https://app.example.com",
    roleLabel: "Owner",
    canRead: true,
    canChange: true,
    providers: [provider],
    providersError: false,
    scimToken: null,
    onRegister: vi.fn(async () => undefined),
    onDelete: vi.fn(async () => undefined),
    onRequestVerification: vi.fn(async () => ({
      name: "_better-auth-token-acme-com-1.acme.com",
      value: "tok_domain_1",
    })),
    onCheckVerification: vi.fn(async () => undefined),
    onGenerateScim: vi.fn(async () => undefined),
    onDismissScim: vi.fn(),
    ...overrides,
  }
}

describe("OrgSecurityPage", () => {
  it("lists the providers with their domain, protocol, issuer and verification", () => {
    render(<OrgSecurityPage {...props()} />)
    const row = screen.getByRole("listitem", { name: "acme.com" })
    expect(within(row).getByText("OpenID Connect")).toBeTruthy()
    expect(within(row).getByText("Domain not verified")).toBeTruthy()
    expect(within(row).getByText("https://login.acme.com")).toBeTruthy()
  })

  it("says so when there are no providers yet", () => {
    render(<OrgSecurityPage {...props({ providers: [] })} />)
    expect(screen.getByText(/No providers yet/)).toBeTruthy()
  })

  it("shows loading and error states", () => {
    const { unmount } = render(<OrgSecurityPage {...props({ providers: undefined })} />)
    expect(screen.getByText("Loading…")).toBeTruthy()
    unmount()
    render(<OrgSecurityPage {...props({ providers: undefined, providersError: true })} />)
    expect(screen.getByRole("alert").textContent).toContain("Could not load")
  })

  it("names the consequence of deleting, and deletes only after confirmation", async () => {
    const user = userEvent.setup()
    const onDelete = vi.fn(async () => undefined)
    render(<OrgSecurityPage {...props({ onDelete })} />)
    const row = screen.getByRole("listitem", { name: "acme.com" })
    expect(within(row).getByText("People at acme.com can no longer sign in with SSO.")).toBeTruthy()
    await user.click(within(row).getByRole("button", { name: "Delete provider" }))
    const dialog = await screen.findByRole("alertdialog")
    expect(
      within(dialog).getByText("People at acme.com can no longer sign in with SSO."),
    ).toBeTruthy()
    expect(onDelete).not.toHaveBeenCalled()
    await user.click(within(dialog).getByRole("button", { name: "Delete provider" }))
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith("acme-com-1"))
  })

  it("shows the domain as unverified with a Verify domain action, and verified with none", () => {
    const { unmount } = render(<OrgSecurityPage {...props()} />)
    const row = screen.getByRole("listitem", { name: "acme.com" })
    expect(within(row).getByText("Domain not verified")).toBeTruthy()
    expect(within(row).getByRole("button", { name: "Verify domain" })).toBeTruthy()
    unmount()
    render(<OrgSecurityPage {...props({ providers: [{ ...provider, domainVerified: true }] })} />)
    const verified = screen.getByRole("listitem", { name: "acme.com" })
    expect(within(verified).getByText("Domain verified")).toBeTruthy()
    expect(within(verified).queryByRole("button", { name: "Verify domain" })).toBeNull()
  })

  it("shows the TXT record for the domain, and checks it on request", async () => {
    const user = userEvent.setup()
    const onCheckVerification = vi.fn(async () => undefined)
    const onRequestVerification = vi.fn(async () => ({
      name: "_better-auth-token-acme-com-1.acme.com",
      value: "tok_domain_1",
    }))
    render(<OrgSecurityPage {...props({ onCheckVerification, onRequestVerification })} />)
    await user.click(screen.getByRole("button", { name: "Verify domain" }))
    expect(onRequestVerification).toHaveBeenCalledWith("acme-com-1")
    const panel = await screen.findByRole("region", { name: "Domain verification" })
    expect(within(panel).getByLabelText("Record name")).toHaveProperty(
      "value",
      "_better-auth-token-acme-com-1.acme.com",
    )
    expect(within(panel).getByLabelText("Record value")).toHaveProperty("value", "tok_domain_1")
    await user.click(within(panel).getByRole("button", { name: "Check now" }))
    await waitFor(() => expect(onCheckVerification).toHaveBeenCalledWith("acme-com-1"))
  })

  it("validates the form before adding an OIDC provider, then sends the values", async () => {
    const user = userEvent.setup()
    const onRegister = vi.fn(async () => undefined)
    render(<OrgSecurityPage {...props({ providers: [], onRegister })} />)
    await user.click(screen.getByRole("button", { name: "Add a provider" }))
    await user.type(screen.getByLabelText("Email domain"), "globex.io")
    await user.type(screen.getByLabelText("Issuer URL"), "https://login.globex.io")
    await user.type(screen.getByLabelText("Client ID"), "client-123")
    await user.type(screen.getByLabelText("Client secret"), "s3cret")
    await user.click(screen.getByRole("button", { name: "Add provider" }))
    await waitFor(() =>
      expect(onRegister).toHaveBeenCalledWith(
        expect.objectContaining({
          protocol: "oidc",
          domain: "globex.io",
          clientId: "client-123",
          clientSecret: "s3cret",
        }),
      ),
    )
  })

  it("adds a provider once when Add provider is clicked twice", async () => {
    const user = userEvent.setup()
    let finish!: () => void
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    const onRegister = vi.fn(() => pending)
    render(<OrgSecurityPage {...props({ providers: [], onRegister })} />)
    await user.click(screen.getByRole("button", { name: "Add a provider" }))
    await user.type(screen.getByLabelText("Email domain"), "globex.io")
    await user.type(screen.getByLabelText("Issuer URL"), "https://login.globex.io")
    await user.type(screen.getByLabelText("Client ID"), "client-123")
    await user.type(screen.getByLabelText("Client secret"), "s3cret")
    const submit = screen.getByRole("button", { name: "Add provider" }) as HTMLButtonElement
    await user.click(submit)
    await waitFor(() => expect(submit.disabled).toBe(true))
    fireEvent.click(submit)
    expect(onRegister).toHaveBeenCalledTimes(1)
    finish()
  })

  it("shows field errors and does not submit an invalid domain", async () => {
    const user = userEvent.setup()
    const onRegister = vi.fn(async () => undefined)
    render(<OrgSecurityPage {...props({ providers: [], onRegister })} />)
    await user.click(screen.getByRole("button", { name: "Add a provider" }))
    await user.type(screen.getByLabelText("Email domain"), "localhost")
    await user.click(screen.getByRole("button", { name: "Add provider" }))
    expect(await screen.findByText(/Enter a domain such as acme.com/)).toBeTruthy()
    expect(onRegister).not.toHaveBeenCalled()
  })

  it("switches to the SAML fields", async () => {
    const user = userEvent.setup()
    render(<OrgSecurityPage {...props({ providers: [] })} />)
    await user.click(screen.getByRole("button", { name: "Add a provider" }))
    await user.selectOptions(screen.getByLabelText("Protocol"), "saml")
    expect(screen.getByLabelText("Single sign-on URL")).toBeTruthy()
    expect(screen.getByLabelText("Signing certificate")).toBeTruthy()
    expect(screen.queryByLabelText("Client secret")).toBeNull()
  })

  it("shows the SCIM token once, with the base URL, and dismisses it", async () => {
    const user = userEvent.setup()
    const onDismissScim = vi.fn()
    const { rerender } = render(<OrgSecurityPage {...props()} />)
    expect(screen.getByLabelText("SCIM base URL")).toHaveProperty(
      "value",
      "https://app.example.com/api/auth/scim/v2",
    )
    await user.click(screen.getByRole("button", { name: "Generate SCIM token" }))
    rerender(
      <OrgSecurityPage
        {...props({ scimToken: { token: "scim_tok_123", expiresInDays: 365 }, onDismissScim })}
      />,
    )
    expect(screen.getByText("You won't see it again. Copy it now.")).toBeTruthy()
    expect(screen.getByLabelText("SCIM token")).toHaveProperty("value", "scim_tok_123")
    await user.click(screen.getByRole("button", { name: "I've copied it" }))
    expect(onDismissScim).toHaveBeenCalled()
  })

  it("states the SCIM gaps plainly", () => {
    render(<OrgSecurityPage {...props()} />)
    expect(screen.getByText("Provisioned users don't join this organization yet.")).toBeTruthy()
  })

  it("shows only the view-only notice to people who cannot read provider settings", () => {
    render(
      <OrgSecurityPage
        {...props({ canRead: false, canChange: false, providers: undefined, roleLabel: "Admin" })}
      />,
    )
    expect(screen.getByRole("region", { name: "View-only access" })).toBeTruthy()
    expect(screen.queryByRole("heading", { name: "Single sign-on" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Generate SCIM token" })).toBeNull()
  })

  it("disables delete for a reader who can see providers but not change them", () => {
    render(<OrgSecurityPage {...props({ canChange: false })} />)
    const row = screen.getByRole("listitem", { name: "acme.com" })
    expect(
      within(row).getByRole("button", { name: "Delete provider" }).hasAttribute("disabled"),
    ).toBe(true)
    expect(screen.queryByRole("button", { name: "Add a provider" })).toBeNull()
  })

  it("has no accessibility violations (owner view)", async () => {
    render(<OrgSecurityPage {...props()} />)
    await expectNoA11yViolations(document.body.innerHTML)
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

describe("OrgSecurityPage delete dialog", () => {
  it("keeps the provider's domain in the title while the dialog animates out after cancel", async () => {
    const user = userEvent.setup()
    render(<OrgSecurityPage {...props()} />)
    await user.click(
      within(screen.getByRole("listitem", { name: "acme.com" })).getByRole("button", {
        name: "Delete provider",
      }),
    )
    const dialog = await screen.findByRole("alertdialog")
    const release = holdExitAnimations()
    try {
      await user.click(within(dialog).getByRole("button", { name: "Cancel" }))
      expect(within(dialog).getByRole("heading").textContent).toBe("Delete the acme.com provider?")
    } finally {
      release()
    }
  })

  it("keeps the provider's domain in the title while the dialog animates out after a delete", async () => {
    const user = userEvent.setup()
    render(<OrgSecurityPage {...props()} />)
    await user.click(
      within(screen.getByRole("listitem", { name: "acme.com" })).getByRole("button", {
        name: "Delete provider",
      }),
    )
    const dialog = await screen.findByRole("alertdialog")
    const release = holdExitAnimations()
    try {
      await user.click(within(dialog).getByRole("button", { name: "Delete provider" }))
      expect(within(dialog).getByRole("heading").textContent).toBe("Delete the acme.com provider?")
    } finally {
      release()
    }
  })

  it("leaves the landmark to the app shell rather than nesting a main", () => {
    render(<OrgSecurityPage {...props()} />)
    expect(document.querySelector("main")).toBeNull()
  })
})
